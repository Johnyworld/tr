import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { COMMANDS, InvalidPlayerInputError, MAX_INPUT_LENGTH, normalizePlayerInput } from "@trpg/core";
import { TurnInProgressError, type WebSession } from "./session.ts";

const turnRequestSchema = z.object({
  input: z.string().max(MAX_INPUT_LENGTH * 2),
});

/**
 * HTTP 어댑터. core와 gm을 감싸기만 하고 게임 로직은 두지 않는다 (원칙 9).
 * 게임 상태와 대화 기록은 세이브에 있다. 클라이언트는 입력(의도)만 보낸다.
 */
export function createApp(session: WebSession) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/game", (c) => c.json(session.view()));

  // 정보 명령어 (읽기 전용, 시간이 흐르지 않는다). 처리는 core가 한다
  app.get("/api/commands", (c) =>
    c.json(COMMANDS.map((cmd) => ({ name: cmd.name, args: cmd.args ?? "", description: cmd.description }))),
  );

  app.post("/api/command", async (c) => {
    const parsed = z.object({ input: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "요청 형식이 올바르지 않습니다." }, 400);
    return c.json({ output: session.world.runCommand(parsed.data.input) });
  });

  app.post("/api/game/reset", (c) => {
    try {
      session.newWorld();
    } catch (err) {
      if (err instanceof TurnInProgressError) return c.json({ error: "턴이 진행 중입니다." }, 409);
      throw err;
    }
    return c.json(session.view());
  });

  app.post("/api/game/turn", async (c) => {
    const parsed = turnRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "요청 형식이 올바르지 않습니다." }, 400);
    const { input } = parsed.data;

    // 스트림을 열기 전에 막을 수 있는 것은 상태 코드로 돌려준다
    try {
      normalizePlayerInput(input);
    } catch (err) {
      if (err instanceof InvalidPlayerInputError) return c.json({ error: err.message }, 400);
      throw err;
    }
    if (session.busy) return c.json({ error: "이전 턴이 아직 진행 중입니다." }, 409);
    if (session.world.isPlayerDead()) return c.json({ error: "캐릭터가 사망했습니다. 새 게임을 시작하세요." }, 409);

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      try {
        for await (const event of session.playTurn(input, abort.signal)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "tool") {
            await stream.writeSSE({ event: "player", data: JSON.stringify(session.world.playerView()) });
          }
        }
      } catch (err) {
        // 검사와 시작 사이에 다른 턴이 끼어든 경우
        const message = err instanceof TurnInProgressError ? "이전 턴이 아직 진행 중입니다." : String(err);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message }) });
      }
    });
  });

  return app;
}
