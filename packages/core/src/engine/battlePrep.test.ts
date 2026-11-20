import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent, teachSkills } from "../testing.ts";
import { barrierRise, infestationDay } from "../game/infestation.ts";
import { resolveRound } from "../sim/battle.ts";

/** 전투 준비물 늘리기 (12-176): 모래주머니 엄폐·사격 자리. 바리케이드는 12-184부터 거점 시설 */
// 소음이 다음 날에 오르는 하루 틱을 본다 (몰려드는 시간 swarm_hours는 플레이 테스트 12의 테스트에서)
const real0 = loadRealContent();
const content = { ...real0, storylets: {}, scenario: { ...real0.scenario, infestation: { ...real0.scenario.infestation!, swarm_hours: undefined } } };
/** 목공은 전문 기술이라 배워 둔다 (4.2.1) */
const make = (roll = 0.99) => {
  const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-prep-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
  teachSkills(w, ["carpentry"]);
  return w;
};
const chk = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const act = (w: GameWorld, input: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
const prepare = (w: GameWorld, id: string) => act(w, { prepare: id, check: chk("carpentry", "strength") });
/** 바리케이드는 거점 시설이다 (12-184) */
const barricade = (w: GameWorld) => act(w, { build: "barricade", check: chk("carpentry", "intellect") });
const give = (w: GameWorld, item: string, n: number) => expect(w.runCheat(`~give ${item} ${n}`).ok).toBe(true);

describe("전투 준비물", () => {
  it("모래주머니는 재료를 다 써야 깔리고, 엄폐하고 버티기는 써도 남는다", () => {
    const w = make();
    const zone = w.state().playerZone!;
    give(w, "cloth", 1);
    expect(prepare(w, "sandbags").ok).toBe(false); // 천이 모자라다
    give(w, "cloth", 1);
    const r = prepare(w, "sandbags");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().preparations[zone]).toContain("sandbags");
    expect(w.state().characters[w.state().playerId]!.inventory.cloth ?? 0).toBe(0);
    expect(w.runCheat("~battle").ok).toBe(true);
    expect(w.sceneForGm()).toContain("cover_hold 엄폐하고 버티기");
    const hit = act(w, { check: chk("fight", "strength"), battle: { effect: "cover_hold", objective: null } });
    expect(hit.ok, hit.ok ? "" : hit.error).toBe(true);
    expect(w.state().preparations[zone]).toContain("sandbags");
  });

  it("바리케이드 시설은 지키는 전투에서 막기를 주고 부서진다. 같은 구역에 둘은 못 짓는다", () => {
    const w = make();
    const zone = w.state().playerZone!;
    give(w, "planks", 6);
    give(w, "scrap_metal", 4);
    const r = barricade(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(barricade(w).ok).toBe(false);
    const fort = w.state().zones[zone]?.fort ?? 0;
    expect(w.runCheat("~battle").ok).toBe(true);
    expect(w.state().battle?.holds).toBe(2);
    expect(w.state().facilities[zone] ?? []).not.toContain("barricade");
    expect(w.state().zones[zone]?.fort ?? 0).toBe(fort - 1);
  });

  it("거점 밖 우리 땅에도 바리케이드를 짓는다", () => {
    const w = make();
    const post = Object.keys(content.locations).find((z) => z !== w.state().playerZone && w.state().zones[z]?.owner === "faction_a" && content.locations[z]?.kind !== "base")!;
    expect(w.runCheat(`~goto ${post}`).ok).toBe(true);
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    const r = barricade(w);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().facilities[post]).toContain("barricade");
    expect(w.state().zones[post]?.fort ?? 0).toBeGreaterThan(0);
  });

  it("막기가 남아 있으면 배경 교전에서 밀려도 전세와 사람을 잃지 않는다", () => {
    const w = make();
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    barricade(w);
    w.runCheat("~battle");
    const b = w.state().battle!;
    const lose = () => 0.999; // 배경 교전에서 늘 진다
    const r1 = resolveRound(content, b, null, { ours: 0, theirs: 0 }, lose);
    expect(r1.battle.momentum).toBe(b.momentum);
    expect(r1.battle.holds).toBe(1);
    expect(r1.battle.ours.losses).toBe(b.ours.losses);
    const r3 = resolveRound(content, resolveRound(content, r1.battle, null, { ours: 0, theirs: 0 }, lose).battle, null, { ours: 0, theirs: 0 }, lose);
    expect(r3.battle.holds).toBe(0);
    expect(r3.battle.momentum).toBe(b.momentum - 1);
  });

  it("바리케이드가 선 구역은 감염체 압력이 덜 오른다", () => {
    const w = make();
    const zone = w.state().playerZone!;
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    barricade(w);
    expect(barrierRise(content, w.state(), zone)).toBe(0.5);
    const noisy = { ...w.state(), zoneNoise: { [zone]: { day: 1, level: 3 } } };
    expect(infestationDay(content, noisy, 2, [], () => 0.9).some((c) => c.zone === zone)).toBe(false);
    expect(infestationDay(content, noisy, 2, [], () => 0.1).some((c) => c.zone === zone)).toBe(true);
  });
});
