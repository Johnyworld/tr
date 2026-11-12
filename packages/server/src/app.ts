import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  InvalidPlayerInputError,
  MAX_INPUT_LENGTH,
  narrate,
  normalizePlayerInput,
  type NarrationModel,
} from "@trpg/core";

const chatRequestSchema = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["player", "gm"]),
        text: z.string().max(20000),
      }),
    )
    .max(500),
  input: z.string().max(MAX_INPUT_LENGTH * 2),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * HTTP 레이어. core를 감싸기만 하고 게임 로직은 두지 않는다.
 * 2단계에서는 대화 기록을 클라이언트가 들고 온다. 4단계(세이브)에서 서버 저장으로 옮긴다.
 */
export function createApp(model: NarrationModel) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post("/api/chat", async (c) => {
    const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "요청 형식이 올바르지 않습니다." }, 400);
    }
    const { history, input } = parsed.data;

    // 입력 검증은 스트림을 열기 전에 해서 400으로 돌려준다
    try {
      normalizePlayerInput(input);
    } catch (err) {
      if (err instanceof InvalidPlayerInputError) return c.json({ error: err.message }, 400);
      throw err;
    }

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      for await (const event of narrate(model, history, input, { signal: abort.signal })) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  return app;
}
