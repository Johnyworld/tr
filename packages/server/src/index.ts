import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { BgeM3Embedder, ContentError, loadContent, LoreLibrary, WorldLockedError, WorldManager } from "@trpg/core";
import {
  createClaudeModel,
  createClaudeSummarizer,
  DEFAULT_GM_MODEL,
  DEFAULT_SUMMARY_MODEL,
  type LanguageModel,
} from "@trpg/gm";
import { createApp } from "./app.ts";
import { WebSession } from "./session.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.SERVER_PORT ?? 8787);
const modelId = process.env.GM_MODEL ?? DEFAULT_GM_MODEL;
const summaryModelId = process.env.SUMMARY_MODEL ?? DEFAULT_SUMMARY_MODEL;
const scenarioId = process.env.SCENARIO ?? "post_apoc";
const contentDir = resolve(ROOT, process.env.CONTENT_DIR ?? `content/scenarios/${scenarioId}`);
const savesDir = resolve(ROOT, process.env.SAVES_DIR ?? "saves");
// 웹 앱 모드는 API 키만 쓴다 (원칙 10: 구독 로그인을 연결하지 않는다)
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

const MISSING_KEY_MESSAGE =
  "Claude API 키가 설정되지 않았습니다. 루트의 .env.example을 .env로 복사해 ANTHROPIC_API_KEY를 넣고 서버를 다시 시작하세요.";

/** 키가 없으면 요청마다 안내 메시지를 던지는 모델로 대체한다 */
const missingKeyModel: LanguageModel = async function* () {
  throw new Error(MISSING_KEY_MESSAGE);
};

if (!hasApiKey) console.warn(`[server] ${MISSING_KEY_MESSAGE}`);

let session: WebSession;
try {
  const content = loadContent(contentDir);
  // RAG lore 색인: 모델 로딩·임베딩은 백그라운드로 (RAG=off면 끈다)
  const lore =
    process.env.RAG === "off"
      ? null
      : LoreLibrary.open({
          indexPath: resolve(ROOT, `.cache/rag/${content.scenario.id}-lore.db`),
          loreDir: resolve(contentDir, "lore"),
          embedder: new BgeM3Embedder({ cacheDir: resolve(ROOT, ".cache/models") }),
        });
  const manager = new WorldManager({ savesDir, content, lore });
  session = new WebSession(
    manager,
    hasApiKey ? createClaudeModel({ model: modelId }) : missingKeyModel,
    hasApiKey ? createClaudeSummarizer({ model: summaryModelId }) : undefined,
  );
} catch (err) {
  if (err instanceof ContentError || err instanceof WorldLockedError) {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = createApp(session);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(
    `[server] http://127.0.0.1:${info.port} (GM 모델: ${modelId}, 요약 모델: ${summaryModelId}, 세계: ${session.world.id})`,
  );
});

function shutdown() {
  server.close();
  session.close(); // 세이브와 잠금을 정리한다
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
