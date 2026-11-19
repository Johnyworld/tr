import { describe, expect, it } from "vitest";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { seasonAt } from "../sim/season.ts";
import { initialWarWorld, policyEffects, simulateWarDay } from "../sim/war.ts";
import { feelsLike } from "./climate.ts";
import { loadRealContent } from "../testing.ts";

/** 분배 방침 (12-128): 탄약·의약품·연료를 어디에 더 쓰고 어디를 아낄지 */
const content = loadRealContent();

describe("분배 방침", () => {
  it("방침 효과가 합쳐진다: 화력·탄약 소모·돌봄·난방", () => {
    const f = initialWarWorld(content).factions.faction_a!;
    expect(policyEffects(content, f)).toMatchObject({ firepower: 1, ammoUse: 1, care: 1, heated: 0 });
    const set = { ...f, policy: { ammo: "front", medicine: "generous", fuel: "save" } };
    expect(policyEffects(content, set)).toMatchObject({ firepower: 1.2, ammoUse: 1.5, care: 2, heated: -6 });
  });

  it("탄약을 전선에 몰면 교전마다 더 쓰고, 아끼면 덜 쓴다", () => {
    const spent = (option: string) => {
      const world = initialWarWorld(content);
      for (const f of Object.values(world.factions)) f.policy = { ...(f.policy ?? {}), ammo: option };
      let w = world;
      let used = 0;
      for (let day = 0; day < 20; day++) {
        const before = Object.values(w.factions).reduce((n, f) => n + (f.resources.ammo ?? 0), 0);
        const r = simulateWarDay(w, content, () => 0.3);
        const after = Object.values(r.factions).reduce((n, f) => n + (f.resources.ammo ?? 0), 0);
        if (r.clashes.length) used += before - after;
        w = r;
      }
      return used;
    };
    expect(spent("front")).toBeGreaterThan(spent("normal"));
    expect(spent("save")).toBeLessThan(spent("normal"));
  });

  it("연료를 아끼면 그 무리 거점의 불 땐 거처가 덜 따뜻하다", () => {
    const store = new InMemoryGameStore([createWorldEvent(content, "role_a_grunt", "world_alloc", () => 0.5)]);
    const s = store.getState();
    const w = initialWarWorld(content);
    s.factions = w.factions;
    s.zones = w.zones;
    let day = Math.floor(s.time / MINUTES_PER_DAY);
    while (seasonAt(content.scenario, day * MINUTES_PER_DAY)?.label !== "겨울") day++;
    s.time = day * MINUTES_PER_DAY + 2 * 60;
    s.weather = null;
    s.playerZone = "a_base";
    const heated = content.scenario.body!.cold!.climate!.heated;
    expect(feelsLike(content, s, "sleep")!.value).toBeGreaterThanOrEqual(heated);
    s.factions.faction_a!.policy = { fuel: "save" };
    const saved = feelsLike(content, s, "sleep")!;
    expect(saved.parts.some((p) => p.startsWith("불 땐 거처"))).toBe(true);
    expect(saved.value).toBe(heated - 6);
  });
});
