import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BgeM3Embedder, ContentError, loadContent, loadContentPacks, LoreLibrary, WorldManager, type Content } from "@trpg/core";
import { createMcpServer } from "./server.ts";
import { startStatusServer } from "./statusServer.ts";

/**
 * MCP 서버 진입점 (stdio). Claude 데스크톱 / Claude Code가 GM, 이 프로세스가 게임 엔진이다.
 * stdout은 MCP 프로토콜 전용이다. 로그는 반드시 stderr(console.error)로 쓴다 (원칙 12).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// 저장소의 .env (git에 올라가지 않는 로컬 설정). 치트(개발 모드)는 TRPG_DEBUG=1로 켠다
try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // .env가 없으면 그대로
}
// 월드 팩: content/scenarios/ 아래 전부. SCENARIO로 하나만, CONTENT_DIR로 다른 폴더 하나만 고를 수 있다
const packsDir = resolve(ROOT, "content/scenarios");
const savesDir = resolve(ROOT, process.env.SAVES_DIR ?? "saves");

let app: ReturnType<typeof createMcpServer>;
/** 상태 화면 주소 (TRPG_STATUS=off면 띄우지 않는다). 못 띄워도 게임은 그대로 한다 */
let statusUrl: string | null = null;
let closeStatus: (() => Promise<void>) | null = null;
try {
  const packs: { content: Content; dir: string }[] = process.env.CONTENT_DIR
    ? [{ content: loadContent(resolve(ROOT, process.env.CONTENT_DIR)), dir: resolve(ROOT, process.env.CONTENT_DIR) }]
    : loadContentPacks(packsDir, process.env.SCENARIO).map((content) => ({ content, dir: resolve(packsDir, content.scenario.id) }));
  // RAG: 임베딩 모델은 lore와 memory가 함께 쓴다. 모델 로딩·임베딩은 백그라운드로 (RAG=off면 끈다)
  const embedder = process.env.RAG === "off" ? null : new BgeM3Embedder({ cacheDir: resolve(ROOT, ".cache/models") });
  // lore 색인은 월드마다 따로, 처음 쓸 때 연다
  const lores = new Map<string, LoreLibrary>();
  const lore = (packId: string): LoreLibrary | null => {
    const pack = packs.find((p) => p.content.scenario.id === packId);
    if (!embedder || !pack) return null;
    let library = lores.get(packId);
    if (!library) {
      library = LoreLibrary.open({ indexPath: resolve(ROOT, `.cache/rag/${packId}-lore.db`), loreDir: resolve(pack.dir, "lore"), embedder });
      lores.set(packId, library);
    }
    return library;
  };
  app = createMcpServer(
    new WorldManager({ savesDir, content: packs.map((p) => p.content), lore, memoryEmbedder: embedder }),
    { statusUrl: () => statusUrl, debug: process.env.TRPG_DEBUG === "1" },
  );
} catch (err) {
  console.error(`[mcp] ${err instanceof ContentError ? err.message : String(err)}`);
  process.exit(1);
}

const transport = new StdioServerTransport();
transport.onclose = () => shutdown();
await app.server.connect(transport);
console.error(`[mcp] 준비됨 (세이브 ${savesDir})`);

if (process.env.TRPG_STATUS !== "off") {
  const source = {
    get world() {
      return app.world;
    },
    get scenarioName() {
      return app.title;
    },
    get creating() {
      return app.creating;
    },
    get frozenStatus() {
      return app.frozenStatus;
    },
  };
  startStatusServer(source, Number(process.env.TRPG_STATUS_PORT ?? 8790))
    .then((s) => {
      statusUrl = s.url;
      closeStatus = s.close;
      console.error(`[mcp] 상태 화면: ${s.url}`);
    })
    .catch((err: unknown) => console.error(`[mcp] 상태 화면을 띄우지 못했습니다: ${String(err)}`));
}

function shutdown() {
  app.close(); // 세이브와 잠금을 정리한다
  void closeStatus?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
