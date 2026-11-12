import { describe, expect, it } from "vitest";
import { createSeededRng, type Rng } from "../rng.ts";
import { createWorldEvent, type GameState } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { TEST_CONTENT } from "../testing.ts";
import { executeTool, GM_TOOL_SPECS, harmSteps } from "./tools.ts";

/** 주사위 눈을 그대로 지정하는 RNG */
function diceRng(...faces: number[]): Rng {
  let i = 0;
  return () => (faces[i++ % faces.length]! - 1) / 6 + 0.01;
}

function setup(rng: Rng = createSeededRng(1), mutate?: (s: GameState) => void) {
  const store = new InMemoryGameStore([
    createWorldEvent(TEST_CONTENT.roles.role_test!, "world_test"),
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
  it("strict용 JSON Schema에 $schema와 숫자 범위가 없다", () => {
    const json = JSON.stringify(GM_TOOL_SPECS);
    expect(json).not.toContain("$schema");
    expect(json).not.toContain("minimum");
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
