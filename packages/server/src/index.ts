import { serve } from "@hono/node-server";
import { createClaudeNarrationModel, DEFAULT_GM_MODEL, type NarrationModel } from "@trpg/core";
import { createApp } from "./app.ts";

const port = Number(process.env.SERVER_PORT ?? 8787);
const modelId = process.env.GM_MODEL ?? DEFAULT_GM_MODEL;
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const MISSING_KEY_MESSAGE =
  "Claude API 키가 설정되지 않았습니다. 루트의 .env.example을 .env로 복사해 ANTHROPIC_API_KEY를 넣고 서버를 다시 시작하세요.";

/** 키가 없으면 요청마다 안내 메시지만 돌려주는 모델로 대체한다. */
const missingKeyModel: NarrationModel = async function* () {
  yield { type: "error", message: MISSING_KEY_MESSAGE };
};

if (!hasApiKey) console.warn(`[server] ${MISSING_KEY_MESSAGE}`);

const app = createApp(hasApiKey ? createClaudeNarrationModel({ model: modelId }) : missingKeyModel);

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`[server] http://127.0.0.1:${info.port} (GM 모델: ${modelId})`);
});
