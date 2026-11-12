import { describe, expect, it } from "vitest";
import type { LanguageModel, Rng } from "@trpg/core";
import { createApp } from "./app.ts";
import { GameSession } from "./session.ts";

const sixes: Rng = () => 0.99;

/** 첫 호출에서 판정을 요청하고, 두 번째 호출에서 서술을 끝내는 가짜 모델 */
const fakeModel: LanguageModel = async function* (request) {
  const last = request.messages.at(-1)!;
  if (last.content.some((b) => b.type === "tool_result")) {
    yield "문이 열렸다.";
    return { stopReason: "end", content: [{ type: "text", text: "문이 열렸다." }] };
  }
  yield "문을 민다.";
  return {
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "t1",
        name: "request_check",
        input: { move: "fight", stat: "strength", difficulty: "normal", intent: "문을 부순다" },
      },
    ],
  };
};

function setup() {
  return createApp(new GameSession(fakeModel, () => sixes));
}

function postTurn(app: ReturnType<typeof setup>, input: string) {
  return app.request("/api/game/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

describe("게임 API", () => {
  it("턴을 SSE로 스트리밍하고 기록을 서버에 남긴다", async () => {
    const app = setup();
    const res = await postTurn(app, "문을 부순다");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('event: text\ndata: {"type":"text","text":"문을 민다."}');
    expect(body).toContain("event: tool");
    expect(body).toContain('"outcome":"success"');
    expect(body).toContain("event: player");
    expect(body).toContain('event: done\ndata: {"type":"done","stopReason":"end"}');

    const game = (await (await app.request("/api/game")).json()) as {
      transcript: { kind: string }[];
      player: { inventory: unknown[] };
    };
    expect(game.transcript.map((e) => e.kind)).toEqual(["player", "gm", "tool", "gm"]);
    expect(JSON.stringify(game)).not.toContain("<상태>"); // 프롬프트 원문은 UI로 보내지 않는다
    expect(game.player.inventory).toHaveLength(2);
  });

  it("빈 입력과 잘못된 요청은 400을 돌려준다", async () => {
    const app = setup();
    expect((await postTurn(app, "   ")).status).toBe(400);
    const res = await app.request("/api/game/turn", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("새 게임을 시작하면 기록이 비워진다", async () => {
    const app = setup();
    await (await postTurn(app, "문을 부순다")).text();
    const res = await app.request("/api/game/reset", { method: "POST" });
    const game = (await res.json()) as { transcript: unknown[] };
    expect(game.transcript).toEqual([]);
  });
});

describe("GameSession", () => {
  it("소비자가 중간에 멈춰도 그 턴의 기록을 남긴다", async () => {
    let calls = 0;
    const slowModel: LanguageModel = async function* (_request, options) {
      calls++;
      yield "첫 문장.";
      await new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) return reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { stopReason: "end", content: [] };
    };
    const session = new GameSession(slowModel, () => sixes);
    for await (const event of session.playTurn("기다린다")) {
      if (event.type === "text") break; // 연결이 끊긴 것처럼 중간에 멈춘다
    }
    expect(calls).toBe(1);
    expect(session.busy).toBe(false);
    expect(session.transcriptView()).toEqual([
      { kind: "player", text: "기다린다" },
      { kind: "gm", text: "첫 문장." },
    ]);
  });
});
