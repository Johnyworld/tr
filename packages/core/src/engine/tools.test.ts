import { describe, expect, it } from "vitest";
import { createSeededRng, type Rng } from "../rng.ts";
import { createWorldEvent, type GameState } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { TEST_CONTENT } from "../testing.ts";
import { executeTool, gmToolSpecs, STRICT_UNSUPPORTED_KEYS } from "./tools.ts";
import { TEST_SCENARIO } from "../testing.ts";

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



describe("tool 명세", () => {
  it("strict용 JSON Schema에 지원하지 않는 제약(숫자 범위, 배열 길이 등)이 없다", () => {
    const json = JSON.stringify(gmToolSpecs(TEST_SCENARIO));
    for (const key of STRICT_UNSUPPORTED_KEYS) expect(json, key).not.toContain(`"${key}"`);
    for (const spec of gmToolSpecs(TEST_SCENARIO)) {
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema.additionalProperties).toBe(false);
    }
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
