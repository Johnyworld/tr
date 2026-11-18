import { describe, expect, it } from "vitest";
import { InMemoryGameStore } from "../game/store.ts";
import { createWorldEvent } from "../game/state.ts";
import { TEST_CONTENT } from "../testing.ts";
import { grantRewards } from "./rewards.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 포상 (12-171) */
const content = {
  ...TEST_CONTENT,
  factions: {
    ...TEST_CONTENT.factions,
    faction_a: { ...TEST_CONTENT.factions.faction_a!, rewards: { every: 6, hungry_days: 3, items: [{ id: "rope", qty: 2, line: "밧줄을 건넨다" }] } },
  },
};

function setup() {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_test", "world_test")]);
  const ctx = { store, content, rng: () => 0 };
  runAfterTimeAdvance(ctx);
  const me = () => store.getState().characters[store.getState().playerId]!;
  const merit = (delta: number) => store.append({ type: "merit_awarded", characterId: me().id, delta, reason: "테스트" });
  return { store, ctx, me, merit };
}

describe("포상", () => {
  it("공적이 문턱을 새로 넘을 때마다 하나, 같은 몫은 두 번 주지 않는다", () => {
    const { ctx, me, merit, store } = setup();
    merit(5);
    expect(grantRewards(ctx, me().id, "npc_leader")).toEqual([]);
    merit(1);
    expect(grantRewards(ctx, me().id, "npc_leader")[0]).toContain("포상: 밧줄을 건넨다");
    expect(me().inventory.rope).toBe(2);
    expect(grantRewards(ctx, me().id, "npc_leader")).toEqual([]);
    merit(-3);
    merit(3);
    expect(grantRewards(ctx, me().id, "npc_leader")).toEqual([]);
    merit(12); // 18: 두 번 몫
    expect(grantRewards(ctx, me().id, "npc_leader")).toHaveLength(2);
    expect(store.getState().rewardsGiven[me().id]).toBe(3);
  });

  it("무리 식량이 바닥이면 말뿐인 포상 (존중 +1)", () => {
    const { ctx, me, merit, store } = setup();
    const food = store.getState().factions.faction_a!.resources.food ?? 0;
    store.append({ type: "faction_resource_changed", factionId: "faction_a", resource: "food", delta: -food });
    merit(6);
    expect(grantRewards(ctx, me().id, "npc_leader")[0]).toContain("말로 공을 치하한다");
    expect(me().inventory.rope ?? 0).toBe(0);
    expect(store.getState().relations.npc_leader?.[me().id]?.respect).toBe(1);
  });

  it("포상 목록이 없는 무리는 주지 않는다", () => {
    const store = new InMemoryGameStore([createWorldEvent(TEST_CONTENT, "role_test", "world_test")]);
    const id = store.getState().playerId;
    store.append({ type: "merit_awarded", characterId: id, delta: 12, reason: "테스트" });
    expect(grantRewards({ store, content: TEST_CONTENT, rng: () => 0 }, id, "npc_leader")).toEqual([]);
  });
});
