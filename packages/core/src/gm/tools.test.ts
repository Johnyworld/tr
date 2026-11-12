import { describe, expect, it } from "vitest";
import { createSeededRng, type Rng } from "../rng.ts";
import { createWorldEvent, type GameState } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { TEST_CONTENT } from "../testing.ts";
import { executeTool, GM_TOOL_SPECS, harmSteps, STRICT_UNSUPPORTED_KEYS } from "./tools.ts";

/** 주사위 눈을 그대로 지정하는 RNG */
function diceRng(...faces: number[]): Rng {
  let i = 0;
  return () => (faces[i++ % faces.length]! - 1) / 6 + 0.01;
}

function setup(rng: Rng = createSeededRng(1), mutate?: (s: GameState) => void) {
  const store = new InMemoryGameStore([
    createWorldEvent(TEST_CONTENT, "role_test", "world_test"),
    { type: "turn_started", turn: 1, input: "" },
  ]);
  mutate?.(store.getState());
  return { store, ctx: { store, rng, content: TEST_CONTENT } };
}

/** setup이 넣은 이벤트(world_created, turn_started) 이후의 이벤트 */
const newEvents = (store: InMemoryGameStore) => store.events().slice(2);

const check = (overrides: Record<string, unknown> = {}) => ({
  move: "search",
  stat: "sense",
  difficulty: "normal",
  intent: "사물함을 뒤진다",
  ...overrides,
});

describe("tool 명세", () => {
  it("strict용 JSON Schema에 지원하지 않는 제약(숫자 범위, 배열 길이 등)이 없다", () => {
    const json = JSON.stringify(GM_TOOL_SPECS);
    for (const key of STRICT_UNSUPPORTED_KEYS) expect(json, key).not.toContain(`"${key}"`);
    for (const spec of GM_TOOL_SPECS) {
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("request_check", () => {
  it("능력치·난이도·부상 보정을 더해 판정하고 이벤트를 남긴다", () => {
    const { store, ctx } = setup(diceRng(4, 3), (s) => {
      s.characters.player!.injury = "light"; // -1
    });
    const out = executeTool("request_check", check({ difficulty: "hard" }), ctx);
    expect(out.ok).toBe(true);
    // 4 + 3 + 감각(+1) + 어려움(-1) + 경상(-1) = 6 → 실패
    const event = store.events().at(-1);
    expect(event).toMatchObject({
      type: "check_rolled",
      checkId: "chk_1",
      dice: [4, 3],
      modifiers: { stat: 1, difficulty: -1, injury: -1 },
      total: 6,
      outcome: "miss",
    });
    expect(store.getState().checks.chk_1?.outcome).toBe("miss");
    expect(store.getState().nextCheckNo).toBe(2);
  });

  it("행동에 맞지 않는 능력치는 거부한다", () => {
    const { store, ctx } = setup();
    const out = executeTool("request_check", check({ move: "search", stat: "strength" }), ctx);
    expect(out.ok).toBe(false);
    expect(newEvents(store)).toHaveLength(0);
  });

  it("스키마에 없는 값이나 추가 필드는 거부한다", () => {
    const { ctx } = setup();
    expect(executeTool("request_check", check({ difficulty: "impossible" }), ctx).ok).toBe(false);
    expect(executeTool("request_check", check({ bonus: 5 }), ctx).ok).toBe(false);
    expect(executeTool("no_such_tool", {}, ctx).ok).toBe(false);
  });
});

describe("apply_harm", () => {
  function failedCheck(outcomeDice: [number, number]) {
    const env = setup(diceRng(...outcomeDice));
    executeTool("request_check", check({ move: "fight", stat: "strength" }), env.ctx);
    return env;
  }
  const harm = (overrides: Record<string, unknown> = {}) => ({
    target: "player",
    check_id: "chk_1",
    severity: "heavy",
    cause: "칼에 베임",
    ...overrides,
  });

  it("실패한 판정 + heavy는 2단계 악화된다", () => {
    const { store, ctx } = failedCheck([1, 1]); // 1+1+1 = 3 → 실패
    const out = executeTool("apply_harm", harm(), ctx);
    expect(out.ok).toBe(true);
    expect(store.getState().characters.player?.injury).toBe("serious");
  });

  it("대가 있는 성공은 heavy여도 1단계만 악화된다", () => {
    const { store, ctx } = failedCheck([3, 4]); // 3+4+1 = 8 → 대가 있는 성공
    executeTool("apply_harm", harm(), ctx);
    expect(store.getState().characters.player?.injury).toBe("light");
    expect(harmSteps("partial", "heavy")).toBe(1);
  });

  it("성공한 판정, 없는 판정, 같은 판정 재사용은 거부한다", () => {
    const success = failedCheck([6, 6]);
    expect(executeTool("apply_harm", harm(), success.ctx).ok).toBe(false);

    const { ctx } = failedCheck([1, 1]);
    expect(executeTool("apply_harm", harm({ check_id: "chk_99" }), ctx).ok).toBe(false);
    expect(executeTool("apply_harm", harm(), ctx).ok).toBe(true);
    expect(executeTool("apply_harm", harm(), ctx).ok).toBe(false);
  });

  it("지난 턴의 판정은 근거로 쓸 수 없다", () => {
    const { store, ctx } = failedCheck([1, 1]);
    store.append({ type: "turn_started", turn: 2, input: "" });
    expect(executeTool("apply_harm", harm(), ctx).ok).toBe(false);
  });

  it("사망은 부상 트랙을 따라서만 일어난다", () => {
    const { store, ctx } = setup(diceRng(1, 1), (s) => {
      s.characters.player!.injury = "critical";
    });
    executeTool("request_check", check({ move: "fight", stat: "strength" }), ctx);
    executeTool("apply_harm", harm({ severity: "light" }), ctx);
    expect(store.getState().characters.player?.injury).toBe("dead");
    expect(executeTool("request_check", check(), ctx).ok).toBe(false);
  });
});

describe("transfer_item", () => {
  it("내려놓고 다시 줍는다", () => {
    const { store, ctx } = setup();
    const drop = { from: "player", to: "scene", item_id: "water_bottle", quantity: 1 };
    expect(executeTool("transfer_item", drop, ctx).ok).toBe(true);
    expect(store.getState().characters.player?.inventory.water_bottle).toBeUndefined();
    expect(store.getState().scene.items.water_bottle).toBe(1);

    const pick = { from: "scene", to: "player", item_id: "water_bottle", quantity: 1 };
    expect(executeTool("transfer_item", pick, ctx).ok).toBe(true);
    expect(store.getState().characters.player?.inventory.water_bottle).toBe(1);
  });

  it("없는 아이템, 부족한 수량, 알 수 없는 위치는 거부한다", () => {
    const { store, ctx } = setup();
    const base = { from: "player", to: "scene", item_id: "kitchen_knife", quantity: 1 };
    expect(executeTool("transfer_item", { ...base, item_id: "gold_bar" }, ctx).ok).toBe(false);
    expect(executeTool("transfer_item", { ...base, quantity: 2 }, ctx).ok).toBe(false);
    expect(executeTool("transfer_item", { ...base, quantity: 0 }, ctx).ok).toBe(false);
    expect(executeTool("transfer_item", { ...base, to: "nowhere" }, ctx).ok).toBe(false);
    // 장면에서 없는 것을 주워 아이템을 만들어 낼 수 없다
    expect(
      executeTool("transfer_item", { from: "scene", to: "player", item_id: "kitchen_knife", quantity: 1 }, ctx).ok,
    ).toBe(false);
    expect(newEvents(store)).toHaveLength(0);
  });
});

describe("spend_time", () => {
  const spend = (activity: string, until: string | null = null) => ({ activity, until });

  it("짧은 활동은 정해진 시간만큼 흐른다", () => {
    const { store, ctx } = setup();
    expect(executeTool("spend_time", spend("talk"), ctx).ok).toBe(true);
    expect(store.getState().time).toBe(330 + 10);
    expect(newEvents(store).at(-1)).toMatchObject({ type: "time_advanced", from: 330, to: 340 });
  });

  it("잠은 지정한 시간대까지 빨리감기한다 (끼어들기가 없으면)", () => {
    const noInterrupt = () => 0.999; // 확률 검사를 항상 통과하지 못함
    const { store, ctx } = setup(noInterrupt);
    executeTool("spend_time", spend("sleep", "night"), ctx); // 05:30 → 20:00
    expect(store.getState().time).toBe(20 * 60);
  });

  it("빨리감기가 끼어들기로 멈추면 그 시각까지만 흐르고 이유를 남긴다", () => {
    const alwaysInterrupt = () => 0; // 첫 틱에서 바로 끼어든다
    const { store, ctx } = setup(alwaysInterrupt);
    const out = executeTool("spend_time", spend("guard_duty"), ctx);
    expect(out.ok && out.display).toMatchObject({ type: "time", interruptDetail: expect.any(String) });
    const event = newEvents(store).at(-1);
    expect(event).toMatchObject({ type: "time_advanced", interrupt: { kind: "disturbance" } });
    expect(store.getState().time).toBeLessThan(330 + 240);
    expect(store.getState().time).toBeGreaterThan(330);
  });

  it("until은 sleep·wait에서만 쓸 수 있다", () => {
    const { store, ctx } = setup();
    expect(executeTool("spend_time", spend("search", "night"), ctx).ok).toBe(false);
    expect(executeTool("spend_time", spend("guard_duty", "night"), ctx).ok).toBe(false);
    expect(executeTool("spend_time", spend("wait", "morning"), ctx).ok).toBe(true);
    expect(store.getState().time).toBeLessThanOrEqual(6 * 60);
  });

  it("빨리감기는 하루를 넘지 않는다", () => {
    const { store, ctx } = setup(() => 0.999);
    executeTool("spend_time", spend("wait", "dawn"), ctx); // 05:30 → 다음 날 04:00
    expect(store.getState().time - 330).toBeLessThanOrEqual(24 * 60);
  });
});

describe("npc_presence", () => {
  it("인물을 등장시키고 내보낸다. 만난 인물은 알게 된다", () => {
    const { store, ctx } = setup();
    expect(executeTool("npc_presence", { npc_id: "npc_stranger", action: "enter" }, ctx).ok).toBe(true);
    expect(store.getState().scene.present).toEqual(["npc_stranger"]);
    expect(store.getState().known.player).toContain("npc_stranger");
    expect(executeTool("npc_presence", { npc_id: "npc_stranger", action: "leave" }, ctx).ok).toBe(true);
    expect(store.getState().scene.present).toEqual([]);
  });

  it("없는 인물, 플레이어, 중복 등장, 없는 인물 퇴장은 거부한다", () => {
    const { ctx } = setup();
    expect(executeTool("npc_presence", { npc_id: "made_up", action: "enter" }, ctx).ok).toBe(false);
    expect(executeTool("npc_presence", { npc_id: "player", action: "enter" }, ctx).ok).toBe(false);
    expect(executeTool("npc_presence", { npc_id: "npc_leader", action: "leave" }, ctx).ok).toBe(false);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    expect(executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx).ok).toBe(false);
  });
});

describe("transfer_item과 장면", () => {
  it("장면에 있는 NPC와만 물건을 주고받는다", () => {
    const { store, ctx } = setup();
    const give = { from: "player", to: "npc_leader", item_id: "water_bottle", quantity: 1 };
    expect(executeTool("transfer_item", give, ctx).ok).toBe(false);
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    expect(executeTool("transfer_item", give, ctx).ok).toBe(true);
    expect(store.getState().characters.npc_leader?.inventory.water_bottle).toBe(1);
  });
});

describe("add_belief", () => {
  it("플레이어의 기억에 진위 미확인으로 기록하고, 같은 내용은 거부한다", () => {
    const { store, ctx } = setup();
    const input = { fact: "강분대가 동쪽 초소 교대 시간을 알려 줬다", source: "report" };
    expect(executeTool("add_belief", input, ctx).ok).toBe(true);
    const last = store.getState().beliefs.player?.at(-1);
    expect(last).toMatchObject({ fact: input.fact, source: "report", accuracy: "unknown", learnedAt: 330 });
    expect(executeTool("add_belief", input, ctx).ok).toBe(false);
  });
});
