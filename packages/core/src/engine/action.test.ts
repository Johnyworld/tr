import { describe, expect, it } from "vitest";
import type { Rng } from "../rng.ts";
import { createWorldEvent, type GameState } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { TEST_CONTENT, TEST_SCENARIO } from "../testing.ts";
import { harmSteps, takeAction, type TakeActionInput } from "./action.ts";
import { executeTool, gmToolSpecs } from "./tools.ts";

/** 주사위 눈을 그대로 지정하는 RNG (끼어들기·숨은 목격자 확률도 같은 값으로 굴려진다) */
function diceRng(...faces: number[]): Rng {
  let i = 0;
  return () => (faces[i++ % faces.length]! - 1) / 6 + 0.01;
}

function setup(rng: Rng, mutate?: (s: GameState) => void) {
  const store = new InMemoryGameStore([createWorldEvent(TEST_CONTENT, "role_test", "world_test")]);
  mutate?.(store.getState());
  return { store, ctx: { store, rng, content: TEST_CONTENT } };
}

const act = (overrides: Partial<TakeActionInput> = {}): TakeActionInput => ({
  intent: "사물함을 뒤진다",
  check: null,
  activity: null,
  deed: null,
  target: null,
  narration_summary: null, for_mission: false,
  ...overrides,
});

const search = (harm: "none" | "light" | "heavy" = "none") => ({
  move: "search",
  stat: "sense",
  difficulty: "normal" as const,
  harm_on_failure: harm,
  harm_cause: harm === "none" ? "" : "녹슨 철판에 베임",
});

describe("take_action: 한 턴", () => {
  it("판정 없이도 턴이 시작되고 잠깐의 시간이 흐른다", () => {
    const { store, ctx } = setup(diceRng(6));
    const result = takeAction(act(), ctx);
    expect(result.ok).toBe(true);
    expect(store.getState().turn).toBe(1);
    expect(store.getState().time).toBe(330 + 5);
  });

  it("능력치·난이도·상태 보정을 더해 판정한다", () => {
    const { store, ctx } = setup(diceRng(4, 3), (s) => {
      s.characters.player!.conditions.harm = "light"; // -1
    });
    takeAction(act({ check: { ...search(), difficulty: "hard" } }), ctx);
    // 4 + 3 + 감각(+1) + 어려움(-1) + 경상(-1) = 6 → 실패
    expect(store.events().find((e) => e.type === "check_rolled")).toMatchObject({
      dice: [4, 3],
      modifiers: { stat: 1, difficulty: -1, condition: -1 },
      total: 6,
      outcome: "miss",
    });
  });

  it("행동에 맞지 않는 능력치는 거부한다", () => {
    const { ctx } = setup(diceRng(6));
    const result = takeAction(act({ check: { ...search(), stat: "strength" } }), ctx);
    expect(result.ok).toBe(false);
  });

  it("장면에 없는 상대는 거부한다", () => {
    const { ctx } = setup(diceRng(6));
    expect(takeAction(act({ target: "npc_leader" }), ctx).ok).toBe(false);
  });
});

describe("take_action: 판정 전에 선언한 위험", () => {
  it("실패 + heavy는 2단계, 대가 있는 성공은 1단계, 성공은 피해 없음", () => {
    const miss = setup(diceRng(1, 1));
    takeAction(act({ check: search("heavy") }), miss.ctx);
    expect(miss.store.getState().characters.player?.conditions.harm).toBe("serious");

    const partial = setup(diceRng(3, 4)); // 3+4+1 = 8
    takeAction(act({ check: search("heavy") }), partial.ctx);
    expect(partial.store.getState().characters.player?.conditions.harm).toBe("light");

    const success = setup(diceRng(6, 6));
    takeAction(act({ check: search("heavy") }), success.ctx);
    expect(success.store.getState().characters.player?.conditions.harm).toBe("none");
    expect(harmSteps("partial", "heavy")).toBe(1);
  });

  it("위험을 선언하지 않으면 실패해도 몸은 다치지 않는다 (AI가 결과를 보고 피해를 정하지 않는다)", () => {
    const { store, ctx } = setup(diceRng(1, 1));
    takeAction(act({ check: search("none") }), ctx);
    expect(store.getState().characters.player?.conditions.harm).toBe("none");
    expect(executeTool("apply_harm", {}, ctx).ok).toBe(false); // 피해만 따로 주는 tool은 없다
  });

  it("사망은 부상 트랙을 따라서만 일어나고, 사망하면 턴이 멈춘다", () => {
    const { store, ctx } = setup(diceRng(1, 1), (s) => {
      s.characters.player!.conditions.harm = "critical";
    });
    const result = takeAction(act({ check: search("light"), activity: { kind: "rest", until: null } }), ctx);
    expect(result.ok && result.dead).toBe(true);
    expect(store.getState().characters.player?.dead).toBe(true);
    expect(store.events().some((e) => e.type === "time_advanced")).toBe(false);
    expect(takeAction(act(), ctx).ok).toBe(false);
  });
});

describe("take_action: 행적", () => {
  const theft = {
    summary: "통조림을 훔쳤다",
    tags: ["theft" as const],
    severity: 2,
    privacy: "private" as const,
    noisy: false,
  };

  it("on_success 행적은 판정이 실패하면 기록하지 않는다", () => {
    const { store, ctx } = setup(diceRng(1, 1));
    takeAction(act({ check: search(), deed: { ...theft, condition: "on_success" } }), ctx);
    expect(Object.keys(store.getState().deeds)).toHaveLength(0);
  });

  it("always 행적은 판정과 상관없이 기록하고, 장면에 있는 인물이 본다", () => {
    const { store, ctx } = setup(diceRng(6));
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    const result = takeAction(act({ deed: { ...theft, condition: "always" } }), ctx);
    expect(result.ok && result.displays).toContainEqual(
      expect.objectContaining({ type: "deed", visibleWitnesses: ["강분대"] }),
    );
    expect(store.getState().deedKnowledge.npc_leader).toEqual({ d_1: "seen" });
  });
});

describe("take_action: 시간", () => {
  it("활동만큼 시간이 흐른다", () => {
    const { store, ctx } = setup(diceRng(6));
    takeAction(act({ activity: { kind: "talk", until: null } }), ctx);
    expect(store.getState().time).toBe(330 + 10);
  });

  it("잠은 지정한 시간대까지 빨리감기한다 (끼어들기가 없으면)", () => {
    const { store, ctx } = setup(() => 0.999);
    takeAction(act({ activity: { kind: "sleep", until: "night" } }), ctx); // 05:30 → 20:00
    expect(store.getState().time).toBe(20 * 60);
  });

  it("빨리감기가 끼어들기로 멈추면 그 시각까지만 흐르고 이유를 남긴다", () => {
    const { store, ctx } = setup(() => 0);
    const result = takeAction(act({ activity: { kind: "guard_duty", until: null } }), ctx);
    expect(result.ok && result.displays).toContainEqual(expect.objectContaining({ type: "time", interruptDetail: expect.any(String) }));
    expect(store.getState().time).toBeLessThan(330 + 240);
  });

  it("until은 sleep·wait에서만 쓸 수 있다", () => {
    const { ctx } = setup(diceRng(6));
    expect(takeAction(act({ activity: { kind: "search", until: "night" } }), ctx).ok).toBe(false);
    expect(takeAction(act({ activity: { kind: "guard_duty", until: "night" } }), ctx).ok).toBe(false);
  });

  it("시간이 흐른 뒤 세계 처리(오늘의 임무 후보)가 끝나 있다", () => {
    const { store, ctx } = setup(diceRng(6));
    takeAction(act(), ctx);
    expect(store.getState().offers?.day).toBe(1);
  });
});

describe("tool 목록", () => {
  it("판정·피해·시간·행적은 take_action 하나로만 다룬다", () => {
    const names = gmToolSpecs(TEST_SCENARIO).map((t) => t.name);
    expect(names).toContain("take_action");
    for (const removed of ["request_check", "apply_harm", "spend_time", "record_deed"]) {
      expect(names).not.toContain(removed);
    }
  });
});
