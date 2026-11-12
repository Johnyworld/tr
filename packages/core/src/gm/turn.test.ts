import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { createTestStore, TEST_CONTENT } from "../testing.ts";
import type { LanguageModel, ModelRequest, ModelResponse } from "./model.ts";
import {
  buildHistoryMessages,
  InvalidPlayerInputError,
  runTurn,
  type TranscriptEntry,
  type TurnEvent,
} from "./turn.ts";

type Script = { text?: string[]; response: ModelResponse };

/** 정해진 응답을 차례로 돌려주는 가짜 모델. 받은 요청을 기록한다 */
function scriptedModel(scripts: Script[]) {
  const requests: ModelRequest[] = [];
  const model: LanguageModel = async function* (request) {
    requests.push(structuredClone(request));
    const script = scripts[requests.length - 1];
    if (!script) throw new Error("스크립트가 끝났습니다");
    for (const t of script.text ?? []) yield t;
    return script.response;
  };
  return { model, requests };
}

const fixedDice: Rng = (() => {
  const faces = [5, 5];
  let i = 0;
  return () => (faces[i++ % 2]! - 1) / 6 + 0.01;
})();

async function run(model: LanguageModel, input = "사물함을 뒤진다", transcript: TranscriptEntry[] = []) {
  const store = createTestStore();
  const gen = runTurn({ model, store, content: TEST_CONTENT, transcript, input, rng: fixedDice });
  const events: TurnEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { store, events, entries: step.value };
}

const checkCall = {
  type: "tool_call" as const,
  id: "toolu_1",
  name: "request_check",
  input: { move: "search", stat: "sense", difficulty: "normal", intent: "사물함을 뒤진다" },
};

describe("runTurn", () => {
  it("tool을 실행하고 결과를 돌려준 뒤 서술을 이어 간다", async () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, checkCall];
    const { model, requests } = scriptedModel([
      { text: ["녹슨 사물함에 손을 댄다."], response: { stopReason: "tool_use", content: [checkCall], raw } },
      { text: ["문이 열린다."], response: { stopReason: "end", content: [{ type: "text", text: "문이 열린다." }] } },
    ]);

    const { store, events, entries } = await run(model);

    expect(events.map((e) => e.type)).toEqual(["text", "tool", "text", "done"]);
    expect(events[1]).toMatchObject({ type: "tool", display: { type: "check", total: 11, outcome: "success" } });
    expect(store.events().map((e) => e.type)).toEqual([
      "world_created",
      "turn_started",
      "missions_offered", // 턴 시작 처리: 오늘의 임무 후보
      "check_rolled",
      "time_advanced", // GM이 시간을 쓰지 않아 잠깐의 행동으로 처리
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["player", "gm", "tool", "gm"]);

    // 두 번째 호출: 원본 응답(thinking 포함)을 그대로 돌려보내고 tool 결과를 붙인다
    const second = requests[1]!;
    expect(second.messages.at(-2)).toMatchObject({ role: "assistant", raw });
    expect(second.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "toolu_1" }],
    });
    // 같은 턴 안에서 system과 tools는 바뀌지 않는다
    expect(second.system).toBe(requests[0]!.system);
    expect(second.tools).toEqual(requests[0]!.tools);
  });

  it("상태와 입력을 user 메시지에 함께 넣는다", async () => {
    const { model, requests } = scriptedModel([{ response: { stopReason: "end", content: [] } }]);
    await run(model, "숨을 고른다");
    const prompt = requests[0]!.messages[0]!;
    expect(prompt.role).toBe("user");
    const text = prompt.content[0]!.type === "text" ? prompt.content[0]!.text : "";
    expect(text).toContain("부엌칼(kitchen_knife) ×1");
    expect(text).toContain("<플레이어 입력>\n숨을 고른다\n</플레이어 입력>");
  });

  it("검증에 실패한 tool 호출은 오류로 돌려주고 상태를 바꾸지 않는다", async () => {
    const bad = { ...checkCall, input: { ...checkCall.input, stat: "strength" } };
    const { model, requests } = scriptedModel([
      { response: { stopReason: "tool_use", content: [bad] } },
      { response: { stopReason: "end", content: [] } },
    ]);
    const { store, events } = await run(model);
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(store.events().map((e) => e.type)).toEqual([
      "world_created",
      "turn_started",
      "missions_offered",
      "time_advanced",
    ]);
    expect(requests[1]!.messages.at(-1)).toMatchObject({
      content: [{ type: "tool_result", isError: true }],
    });
  });

  it("잘린 응답(max_tokens)의 tool 호출은 실행하지 않는다", async () => {
    const { model, requests } = scriptedModel([{ response: { stopReason: "max_tokens", content: [checkCall] } }]);
    const { store, events } = await run(model);
    expect(requests).toHaveLength(1);
    expect(store.events().some((e) => e.type === "check_rolled")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "max_tokens" });
  });

  it("tool 호출이 끝없이 이어지면 멈춘다", async () => {
    const loop = Array.from({ length: 10 }, () => ({
      response: { stopReason: "tool_use" as const, content: [] },
    }));
    const { model, requests } = scriptedModel(loop);
    const { events } = await run(model);
    expect(requests.length).toBeLessThanOrEqual(6);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("모델 오류는 error 이벤트로 바꾸고 그때까지의 기록을 돌려준다", async () => {
    const model: LanguageModel = async function* () {
      yield "총성이";
      throw new Error("연결 끊김");
    };
    const { events, entries } = await run(model);
    expect(events.at(-1)).toEqual({ type: "error", message: "연결 끊김" });
    // 끊기기 전까지 받은 서술도 기록에 남는다
    expect(entries).toMatchObject([{ kind: "player" }, { kind: "gm", text: "총성이" }]);
  });

  it("빈 입력과 사망한 캐릭터는 턴을 시작하지 않는다", async () => {
    const { model } = scriptedModel([]);
    await expect(run(model, "  ")).rejects.toThrow(InvalidPlayerInputError);

    const store = createTestStore();
    store.getState().characters.player!.injury = "dead";
    const gen = runTurn({ model, store, content: TEST_CONTENT, transcript: [], input: "일어난다", rng: fixedDice });
    await expect(gen.next()).rejects.toThrow("사망");
  });
});

describe("runTurn 시간", () => {
  it("GM이 시간을 쓰지 않으면 최소 시간이 흐른다", async () => {
    const { model } = scriptedModel([{ response: { stopReason: "end", content: [] } }]);
    const { store } = await run(model, "숨을 고른다");
    expect(store.getState().time).toBe(330 + 5);
  });

  it("spend_time을 쓰면 최소 시간을 더하지 않는다", async () => {
    const call = {
      type: "tool_call" as const,
      id: "t1",
      name: "spend_time",
      input: { activity: "eat", until: null },
    };
    const { model } = scriptedModel([
      { response: { stopReason: "tool_use", content: [call] } },
      { response: { stopReason: "end", content: [] } },
    ]);
    const { store, events } = await run(model, "밥을 먹는다");
    expect(store.getState().time).toBe(330 + 30);
    expect(events.find((e) => e.type === "tool")).toMatchObject({
      display: { type: "time", activityLabel: "식사", durationLabel: "30분" },
    });
  });

  it("프롬프트에 현재 시각이 들어간다", async () => {
    const { model, requests } = scriptedModel([{ response: { stopReason: "end", content: [] } }]);
    await run(model);
    const first = requests[0]!.messages[0]!.content[0]!;
    expect(first.type === "text" && first.text).toContain("시각: 1일차 05:30 (새벽)");
  });
});

describe("buildHistoryMessages", () => {
  it("당시 보낸 프롬프트를 그대로 쓰고 tool 기록은 뺀다", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "gm", text: "오프닝" },
      { kind: "player", text: "뒤진다", prompt: "<상태>…</상태> 뒤진다" },
      { kind: "gm", text: "손을 넣는다." },
      {
        kind: "tool",
        display: { type: "item", fromName: "장면", toName: "신병", itemName: "물병", quantity: 1 },
      },
      { kind: "gm", text: "물병이 잡힌다." },
    ];
    expect(buildHistoryMessages(transcript)).toEqual([
      { role: "user", content: [{ type: "text", text: "<상태>…</상태> 뒤진다" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "손을 넣는다." },
          { type: "text", text: "물병이 잡힌다." },
        ],
      },
    ]);
  });
});

describe("buildHistoryMessages 길이 제한", () => {
  it("최근 MAX_HISTORY_TURNS 턴만 남기고 user로 시작한다", async () => {
    const { MAX_HISTORY_TURNS } = await import("./turn.ts");
    const transcript: TranscriptEntry[] = [];
    for (let i = 0; i < MAX_HISTORY_TURNS + 5; i++) {
      transcript.push({ kind: "player", text: `${i}`, prompt: `p${i}` });
      transcript.push({ kind: "gm", text: `g${i}` });
    }
    const messages = buildHistoryMessages(transcript);
    expect(messages).toHaveLength(MAX_HISTORY_TURNS * 2);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "p5" }] });
  });
});
