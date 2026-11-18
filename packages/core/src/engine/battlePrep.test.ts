import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent } from "../testing.ts";
import { barrierRise, infestationDay } from "../game/infestation.ts";
import { resolveRound } from "../sim/battle.ts";

/** 전투 준비물 늘리기 (12-176): 모래주머니 엄폐·사격 자리·바리케이드 */
const content = { ...loadRealContent(), storylets: {} };
const make = (roll = 0.99) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-prep-")), content, rngFactory: () => () => roll }).create("mcp", "role_a_grunt");
const chk = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const act = (w: GameWorld, input: Record<string, unknown>) =>
  w.executeTool("take_action", { intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input });
const prepare = (w: GameWorld, id: string) => act(w, { prepare: id, check: chk("carpentry", "strength") });
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

  it("바리케이드는 지키는 전투에서 막기를 얻고 부서진다. 같은 구역에 둘은 못 깐다", () => {
    const w = make();
    const zone = w.state().playerZone!;
    give(w, "planks", 6);
    give(w, "scrap_metal", 4);
    expect(prepare(w, "road_barricade").ok).toBe(true);
    expect(prepare(w, "road_barricade").ok).toBe(false);
    expect(w.runCheat("~battle").ok).toBe(true);
    expect(w.state().battle?.holds).toBe(2);
    expect(w.state().preparations[zone] ?? []).not.toContain("road_barricade");
  });

  it("막기가 남아 있으면 배경 교전에서 밀려도 전세와 사람을 잃지 않는다", () => {
    const w = make();
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    prepare(w, "road_barricade");
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
    prepare(w, "road_barricade");
    expect(barrierRise(content, w.state(), zone)).toBe(0.5);
    const noisy = { ...w.state(), zoneNoise: { [zone]: { day: 1, level: 3 } } };
    expect(infestationDay(content, noisy, 2, [], () => 0.9).some((c) => c.zone === zone)).toBe(false);
    expect(infestationDay(content, noisy, 2, [], () => 0.1).some((c) => c.zone === zone)).toBe(true);
  });
});
