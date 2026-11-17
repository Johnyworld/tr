import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { MINUTES_PER_DAY, dayOf } from "../rules/time.ts";
import { seasonAt } from "../sim/season.ts";
import { initialWarWorld } from "../sim/war.ts";
import { runResidentBodies } from "./residents.ts";
import { loadRealContent } from "../testing.ts";

/** 거점에 사는 사람들의 몸 (12-125) */
const content = loadRealContent();

function setup(season = "겨울") {
  const store = new InMemoryGameStore([createWorldEvent(content, "role_l_wanderer", "world_residents", () => 0.5)]);
  const ctx = { store, rng: () => 0.99, content };
  const s = store.getState();
  const w = initialWarWorld(content);
  s.factions = w.factions;
  s.zones = w.zones;
  let day = Math.floor(s.time / MINUTES_PER_DAY);
  while (seasonAt(content.scenario, day * MINUTES_PER_DAY)?.label !== season) day++;
  s.time = day * MINUTES_PER_DAY + 12 * 60;
  s.weather = null;
  s.companions = [];
  const member = Object.values(s.characters).find((c) => c.factionId === "faction_a" && c.id !== s.playerId && !c.captive && !c.dead)!.id;
  return { store, ctx, member, day: () => dayOf(store.getState().time) };
}

describe("거점 사람들의 허기·추위", () => {
  it("배급이 끊기면 그 무리 사람들이 굶주린다. 굶주림까지만, 죽지 않는다", () => {
    const { store, ctx, member, day } = setup("여름");
    store.getState().factions.faction_a!.resources.food = 0;
    for (let i = 0; i < 10; i++) runResidentBodies(ctx, day());
    const c = store.getState().characters[member]!;
    expect(c.conditions.hunger).toBe(content.scenario.body!.residents!.hunger_max);
    expect(c.dead).toBe(false);
    // 다시 정량이 되면 나아진다
    store.getState().factions.faction_a!.resources.food = 999999;
    runResidentBodies(ctx, day());
    expect(store.getState().characters[member]!.conditions.hunger).not.toBe(content.scenario.body!.residents!.hunger_max);
  });

  it("겨울에 연료가 바닥나 불을 못 때면 떤다. 오한까지만, 불을 때면 풀린다", () => {
    const { store, ctx, member, day } = setup("겨울");
    store.getState().factions.faction_a!.resources.fuel = 0;
    for (let i = 0; i < 10; i++) runResidentBodies(ctx, day());
    expect(store.getState().characters[member]!.conditions.cold).toBe(content.scenario.body!.residents!.cold_max);
    store.getState().factions.faction_a!.resources.fuel = 999999;
    runResidentBodies(ctx, day());
    expect(store.getState().characters[member]!.conditions.cold).not.toBe(content.scenario.body!.residents!.cold_max);
  });

  it("주인공과 함께 다니는 사람, 갇힌 사람은 빠진다", () => {
    const { store, ctx, member, day } = setup("여름");
    store.getState().factions.faction_a!.resources.food = 0;
    store.getState().companions = [member];
    for (let i = 0; i < 5; i++) runResidentBodies(ctx, day());
    expect(store.getState().characters[member]!.conditions.hunger).toBe("fed");
  });
});
