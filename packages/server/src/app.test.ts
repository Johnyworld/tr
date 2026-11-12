import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager, type Rng } from "@trpg/core";
import { TEST_CONTENT } from "@trpg/core/testing";
import type { LanguageModel } from "@trpg/gm";
import { createApp } from "./app.ts";
import { WebSession } from "./session.ts";

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
        name: "take_action",
        input: {
          intent: "문을 부순다",
          check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "light", harm_cause: "어깨" },
          activity: null,
          deed: null,
          target: null,
          narration_summary: null,
        },
      },
    ],
  };
};

function newSession(model: LanguageModel = fakeModel) {
  const manager = new WorldManager({
    savesDir: mkdtempSync(join(tmpdir(), "trpg-server-")),
    content: TEST_CONTENT,
    rngFactory: () => sixes,
  });
  return { manager, session: new WebSession(manager, model) };
}

function postTurn(app: ReturnType<typeof createApp>, input: string) {
  return app.request("/api/game/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
}

describe("게임 API", () => {
  it("턴을 SSE로 스트리밍하고 기록을 세이브에 남긴다", async () => {
    const { session } = newSession();
    const app = createApp(session);
    const res = await postTurn(app, "문을 부순다");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('event: text\ndata: {"type":"text","text":"문을 민다."}');
    expect(body).toContain('"outcome":"success"');
    expect(body).toContain("event: player");
    expect(body).toContain('event: done\ndata: {"type":"done","stopReason":"end"}');

    const game = (await (await app.request("/api/game")).json()) as {
      transcript: { kind: string }[];
      player: { inventory: unknown[] };
      opening: string;
    };
    expect(game.transcript.map((e) => e.kind)).toEqual(["player", "gm", "tool", "gm"]);
    expect(JSON.stringify(game)).not.toContain("<상태>"); // 프롬프트 원문은 UI로 보내지 않는다
    expect(game.opening).toBe("테스트 시작 장면.");
    session.close();
  });

  it("빈 입력과 잘못된 요청은 400을 돌려준다", async () => {
    const { session } = newSession();
    const app = createApp(session);
    expect((await postTurn(app, "   ")).status).toBe(400);
    expect((await app.request("/api/game/turn", { method: "POST", body: "not json" })).status).toBe(400);
    session.close();
  });

  it("새 게임은 새 세계를 만들고, 이전 세계는 목록에 남는다", async () => {
    const { session, manager } = newSession();
    const app = createApp(session);
    await (await postTurn(app, "문을 부순다")).text();
    const before = session.world.id;
    const game = (await (await app.request("/api/game/reset", { method: "POST" })).json()) as {
      transcript: unknown[];
      worldId: string;
    };
    expect(game.transcript).toEqual([]);
    expect(game.worldId).not.toBe(before);
    expect(manager.listWorlds().map((w) => w.id)).toContain(before);
    session.close();
  });
});

describe("WebSession", () => {
  it("소비자가 중간에 멈춰도 그 턴의 기록을 남기고 턴을 마친다", async () => {
    const slowModel: LanguageModel = async function* (_request, options) {
      yield "첫 문장.";
      await new Promise((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) return reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { stopReason: "end", content: [] };
    };
    const { session } = newSession(slowModel);
    for await (const event of session.playTurn("기다린다")) {
      if (event.type === "text") break; // 연결이 끊긴 것처럼 중간에 멈춘다
    }
    expect(session.busy).toBe(false);
    expect(session.world.transcriptView().filter((e) => e.kind !== "tool")).toEqual([
      { kind: "player", text: "기다린다" },
      { kind: "gm", text: "첫 문장." },
    ]);
    expect(session.world.state().turn).toBe(1); // 자동으로 잠깐의 행동이 처리됐다
    session.close();
  });
});
