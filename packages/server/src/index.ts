import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  archiveSave,
  ContentError,
  createClaudeModel,
  DEFAULT_GM_MODEL,
  loadContent,
  SqliteRepository,
  type LanguageModel,
} from "@trpg/core";
import { createApp } from "./app.ts";
import { GameSession } from "./session.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.SERVER_PORT ?? 8787);
const modelId = process.env.GM_MODEL ?? DEFAULT_GM_MODEL;
const contentDir = resolve(ROOT, process.env.CONTENT_DIR ?? "content");
const savePath = resolve(ROOT, process.env.SAVE_PATH ?? "saves/world.db");
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const MISSING_KEY_MESSAGE =
  "Claude API 키가 설정되지 않았습니다. 루트의 .env.example을 .env로 복사해 ANTHROPIC_API_KEY를 넣고 서버를 다시 시작하세요.";

/** 키가 없으면 요청마다 안내 메시지를 던지는 모델로 대체한다 */
const missingKeyModel: LanguageModel = async function* () {
  throw new Error(MISSING_KEY_MESSAGE);
};

if (!hasApiKey) console.warn(`[server] ${MISSING_KEY_MESSAGE}`);

let content;
try {
  content = loadContent(contentDir);
} catch (err) {
  if (err instanceof ContentError) {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const session = new GameSession({
  model: hasApiKey ? createClaudeModel({ model: modelId }) : missingKeyModel,
  content,
  roleId: "role_a_grunt",
  openRepository: () => SqliteRepository.open(savePath),
  archiveRepository: () => {
    const archived = archiveSave(savePath);
    if (archived) console.log(`[server] 이전 세계를 보관했습니다: ${archived}`);
  },
});
const app = createApp(session);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`[server] http://127.0.0.1:${info.port} (GM 모델: ${modelId}, 세이브: ${savePath})`);
});

function shutdown() {
  server.close();
  session.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
