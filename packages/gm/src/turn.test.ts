import { describe, expect, it } from "vitest";
import { createTestWorld } from "@trpg/core/testing";
import type { GameWorld, TranscriptEntry } from "@trpg/core";
import type { LanguageModel, ModelRequest, ModelResponse } from "./model.ts";
import type { Summarizer } from "./summarizer.ts";
import { buildHistoryMessages, needsRecap, runGmTurn, SCENE_SUMMARY_EVERY, type TurnEvent } from "./turn.ts";

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

async function run(world: GameWorld, model: LanguageModel, input = "사물함을 뒤진다", summarizer?: Summarizer) {
  const events: TurnEvent[] = [];
  for await (const e of runGmTurn({ model, world, input, ...(summarizer ? { summarizer } : {}) })) events.push(e);
  return events;
}

const takeAction = (id: string, input: Record<string, unknown>) => ({
  type: "tool_call" as const,
  id,
  name: "take_action",
  input: { check: null, activity: null, deed: null, target: null, narration_summary: null, ...input },
});

describe("runGmTurn", () => {
  it("take_action을 실행하고 결과를 돌려준 뒤 서술을 이어 간다", async () => {
    const world = createTestWorld("web", () => 0.99);
    const call = takeAction("t1", {
      intent: "사물함을 뒤진다",
      check: { move: "search", stat: "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" },
    });
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, call];
    const { model, requests } = scriptedModel([
      { text: ["녹슨 사물함에 손을 댄다."], response: { stopReason: "tool_use", content: [call], raw } },
      { text: ["문이 열린다."], response: { stopReason: "end", content: [{ type: "text", text: "문이 열린다." }] } },
    ]);

    const events = await run(world, model);
    // 판정 카드만 보인다 (활동이 없는 턴의 5분은 카드로 보여 주지 않는다)
    expect(events.map((e) => e.type)).toEqual(["text", "tool", "text", "done"]);
    expect(world.state().turn).toBe(1);
    expect(world.transcript().map((e) => e.kind)).toEqual(["player", "gm", "tool", "gm"]);
    // 두 번째 호출: 원본 응답(thinking 포함)을 그대로 돌려보내고 tool 결과를 붙인다
    expect(requests[1]!.messages.at(-2)).toMatchObject({ role: "assistant", raw });
    expect(requests[1]!.system).toBe(requests[0]!.system);
  });

  it("GM이 take_action을 부르지 않으면 잠깐의 행동으로 자동 처리한다 (시간이 멈추지 않음)", async () => {
    const world = createTestWorld("web");
    const { model } = scriptedModel([{ response: { stopReason: "end", content: [] } }]);
    await run(world, model, "숨을 고른다");
    expect(world.state().turn).toBe(1);
    expect(world.state().time).toBe(330 + 5);
  });

  it("검증에 실패한 tool 호출은 오류로 돌려주고, 턴은 자동 처리된다", async () => {
    const world = createTestWorld("web");
    const bad = takeAction("t1", { intent: "x", check: { move: "search", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "" } });
    const { model, requests } = scriptedModel([
      { response: { stopReason: "tool_use", content: [bad] } },
      { response: { stopReason: "end", content: [] } },
    ]);
    await run(world, model);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ content: [{ type: "tool_result", isError: true }] });
  });

  it("모델 오류는 error 이벤트로 바꾸고 그때까지의 서술을 남긴다", async () => {
    const world = createTestWorld("web");
    const model: LanguageModel = async function* () {
      yield "총성이";
      throw new Error("연결 끊김");
    };
    const events = await run(world, model);
    expect(events.at(-1)).toEqual({ type: "error", message: "연결 끊김" });
    expect(world.transcript().filter((e) => e.kind !== "tool")).toMatchObject([
      { kind: "player" },
      { kind: "gm", text: "총성이" },
    ]);
  });

  it("서술은 턴 요약으로 남고, 일정 수가 쌓이면 장면 요약을 만든다", async () => {
    const world = createTestWorld("web");
    const calls: string[][] = [];
    const summarizer: Summarizer = async (texts) => (calls.push(texts), "장면 요약");
    for (let i = 0; i < SCENE_SUMMARY_EVERY; i++) {
      const { model } = scriptedModel([{ text: [`서술 ${i}`], response: { stopReason: "end", content: [] } }]);
      await run(world, model, `행동 ${i}`, summarizer);
    }
    expect(world.summaries({ kind: "turn" })).toHaveLength(SCENE_SUMMARY_EVERY);
    expect(calls).toHaveLength(1);
    expect(world.summaries({ kind: "scene" })).toMatchObject([{ text: "장면 요약", mode: "web" }]);
  });

  it("상태와 입력을 user 메시지에 넣고, 첫 턴에는 지난 이야기가 있으면 함께 넣는다", async () => {
    const world = createTestWorld("web");
    world.recordSummary("scene", "MCP에서 분대장을 만났다.");
    const { model, requests } = scriptedModel([{ response: { stopReason: "end", content: [] } }]);
    await run(world, model, "숨을 고른다");
    const first = requests[0]!.messages[0]!.content[0]!;
    const text = first.type === "text" ? first.text : "";
    expect(text).toContain("<지난 이야기>");
    expect(text).toContain("MCP에서 분대장을 만났다.");
    expect(text).toContain("<플레이어 입력>\n숨을 고른다\n</플레이어 입력>");
  });

  it("사망한 캐릭터는 턴을 시작하지 않는다", async () => {
    const world = createTestWorld("web");
    world.state().characters.player!.dead = true;
    const { model } = scriptedModel([]);
    await expect(run(world, model)).rejects.toThrow("사망");
  });
});

describe("대화 기록과 모드 전환", () => {
  it("MCP 기록(prompt 없는 입력, 서술 요약)도 이어지게 메시지로 만든다", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "note", text: "새벽에 깨어났다." },
      { kind: "player", text: "식당에 간다" },
      { kind: "note", text: "식당에서 배급을 받았다." },
    ];
    expect(buildHistoryMessages(transcript)).toEqual([
      { role: "user", content: [{ type: "text", text: "식당에 간다" }] },
      { role: "assistant", content: [{ type: "text", text: "[서술 요약] 식당에서 배급을 받았다." }] },
    ]);
    expect(needsRecap(transcript)).toBe(true);
    expect(needsRecap([...transcript, { kind: "player", text: "x", prompt: "p" }, { kind: "gm", text: "y" }])).toBe(false);
  });
});
