import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BgeM3Embedder, ContentError, loadContent, LoreLibrary, WorldManager } from "@trpg/core";
import { createMcpServer } from "./server.ts";

/**
 * MCP 서버 진입점 (stdio). Claude 데스크톱 / Claude Code가 GM, 이 프로세스가 게임 엔진이다.
 * stdout은 MCP 프로토콜 전용이다. 로그는 반드시 stderr(console.error)로 쓴다 (원칙 12).
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const scenarioId = process.env.SCENARIO ?? "post_apoc";
const contentDir = resolve(ROOT, process.env.CONTENT_DIR ?? `content/scenarios/${scenarioId}`);
const savesDir = resolve(ROOT, process.env.SAVES_DIR ?? "saves");

let app: ReturnType<typeof createMcpServer>;
try {
  const content = loadContent(contentDir);
  // RAG: 임베딩 모델은 lore와 memory가 함께 쓴다. 모델 로딩·임베딩은 백그라운드로 (RAG=off면 끈다)
  const embedder = process.env.RAG === "off" ? null : new BgeM3Embedder({ cacheDir: resolve(ROOT, ".cache/models") });
  const lore = embedder
    ? LoreLibrary.open({
        indexPath: resolve(ROOT, `.cache/rag/${content.scenario.id}-lore.db`),
        loreDir: resolve(contentDir, "lore"),
        embedder,
      })
    : null;
  app = createMcpServer(new WorldManager({ savesDir, content, lore, memoryEmbedder: embedder }));
} catch (err) {
  console.error(`[mcp] ${err instanceof ContentError ? err.message : String(err)}`);
  process.exit(1);
}

const transport = new StdioServerTransport();
transport.onclose = () => shutdown();
await app.server.connect(transport);
console.error(`[mcp] 준비됨 (시나리오 ${scenarioId}, 세이브 ${savesDir})`);

function shutdown() {
  app.close(); // 세이브와 잠금을 정리한다
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
