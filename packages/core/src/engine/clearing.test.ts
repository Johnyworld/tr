import { describe, expect, it } from "vitest";
import type { Content } from "../content/schemas.ts";
import { createWorldEvent } from "../game/state.ts";
import { InMemoryGameStore } from "../game/store.ts";
import { baseInfestation, infestationOf } from "../game/infestation.ts";
import { pickDailyOffers } from "../game/missions.ts";
import { loadRealContent, TEST_CONTENT } from "../testing.ts";
import { executeTool } from "./tools.ts";
import { runAfterTimeAdvance } from "./turnStart.ts";

/** 소탕 임무 (12-120): 우리 땅에 감염체가 몰려든 날만 후보에 오르고, 완수하면 가장 몰려든 곳이 조용해진다 */
describe("소탕 임무", () => {
  it("우리 땅에 감염체가 몰려든 날에만 오늘의 후보에 오른다", () => {
    const real = loadRealContent();
    const clearing = Object.values(real.missions).filter((m) => m.clears).map((m) => m.id);
    expect(clearing.length).toBeGreaterThan(0);
    for (let seed = 0; seed < 20; seed++) {
      const calm = pickDailyOffers(real, "role_a_grunt", 1440, null, () => (seed + 0.5) / 20, [], false)!;
      expect(calm.templateIds.some((id) => clearing.includes(id))).toBe(false);
    }
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      for (const id of pickDailyOffers(real, "role_a_grunt", 1440, null, () => (seed + 0.5) / 20, [], true)!.templateIds) seen.add(id);
    }
    expect(clearing.some((id) => seen.has(id))).toBe(true);
  });

  it("완수하면 임무를 준 무리 땅에서 가장 많이 몰려든 구역의 압력이 내려간다", () => {
    const c: Content = structuredClone(TEST_CONTENT);
    c.scenario.infestation = { noise_at: 2, corpses_at: 2, settle: 0, yields_cut: 0, morale_chance: 0 };
    for (const f of Object.values(c.factions)) f.aggression = 0;
    c.missions.m_scout!.clears = 1;
    const store = new InMemoryGameStore([createWorldEvent(c, "role_test", "world_clear")]);
    const ctx = { store, rng: () => 0.99, content: c };
    runAfterTimeAdvance(ctx);
    const zone = Object.values(c.locations).find((l) => store.getState().zones[l.id]?.owner === "faction_a")!.id;
    const high = Math.min(3, baseInfestation(c, zone) + 2);
    store.append({ type: "infestation_changed", zone, level: high, cause: "소음" });
    store.append({ type: "missions_offered", day: 1, templateIds: ["m_scout"] });
    executeTool("npc_presence", { npc_id: "npc_leader", action: "enter" }, ctx);
    executeTool("assign_mission", { template_id: "m_scout" }, ctx);
    const check = (move: string) => ({ move, stat: move === "stealth" ? "agility" : "sense", difficulty: "normal", harm_on_failure: "none", harm_cause: "" });
    const act = (move: string) => ({ intent: "정찰", check: check(move), activity: null, deed: null, target: null, narration_summary: null, for_mission: true });
    executeTool("take_action", act("sense_danger"), ctx);
    executeTool("take_action", act("stealth"), ctx);
    const out = executeTool("report_mission", {}, ctx);
    expect(out.ok && out.resultText).toContain("쓸어 냈다");
    expect(infestationOf(c, store.getState(), zone)).toBe(high - 1);
  });
});
