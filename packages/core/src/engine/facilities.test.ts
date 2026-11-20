import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorldManager } from "../world/manager.ts";
import type { GameWorld } from "../world/world.ts";
import { loadRealContent, teachSkills } from "../testing.ts";
import { waterHere } from "./body.ts";
import { seasonAt } from "../sim/season.ts";
import { breakFacilities, campFactor, runFacilitiesDaily } from "./facilities.ts";

/** 거점 손보기 (12-167) */
const content = { ...loadRealContent(), storylets: {} };
const make = (role: string, roll = 0.99) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-facility-")), content, rngFactory: () => () => roll }).create("mcp", role);
const me = (w: GameWorld) => w.state().characters[w.state().playerId]!;
const chk = (move: string, stat: string) => ({ move, stat, difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" });
const build = (w: GameWorld, id: string, move: string, stat: string) => (
  teachSkills(w, [move]),
  w.executeTool("take_action", { intent: "짓는다", check: chk(move, stat), activity: null, deed: null, target: null, narration_summary: null, for_mission: false, build: id }));
const give = (w: GameWorld, item: string, n: number) => expect(w.runCheat(`~give ${item} ${n}`).ok).toBe(true);

function home(roll = 0.99) {
  const w = make("role_l_wanderer", roll);
  expect(w.executeTool("stash", { action: "settle", items: [] }).ok).toBe(true);
  return w;
}

describe("거점 손보기", () => {
  it("거처에 바리케이드를 지으면 재료가 들고, 야영 이야기가 줄고, GM 상태에 보인다", () => {
    const w = home();
    expect(w.sceneForGm()).toContain("지을 수 있는 시설");
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    const r = build(w, "barricade", "carpentry", "strength");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const zone = w.state().playerZone!;
    expect(w.state().facilities[zone]).toEqual(["barricade"]);
    expect(me(w).inventory.planks ?? 0).toBe(0);
    expect(campFactor(content, w.state(), zone)).toBeLessThan(1);
    expect(w.sceneForGm()).toContain("이 구역의 시설: 바리케이드");
  });

  it("거처도 거점도 아닌 곳, 재료가 모자라면, 판정이 맞지 않으면 짓지 못한다", () => {
    const w = make("role_l_wanderer");
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    expect(build(w, "barricade", "carpentry", "strength").ok).toBe(false);
    const h = home();
    expect(build(h, "barricade", "carpentry", "strength").ok).toBe(false); // 재료 없음
    give(h, "planks", 3);
    give(h, "scrap_metal", 2);
    expect(build(h, "barricade", "improvise", "intellect").ok).toBe(false); // 판정이 다르다
  });

  it("실패하면 재료 절반을 버리고 못 짓는다", () => {
    const w = home(0);
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    expect(build(w, "barricade", "carpentry", "strength").ok).toBe(true);
    expect(w.state().facilities[w.state().playerZone!] ?? []).toEqual([]);
    expect(me(w).inventory.planks).toBe(2);
  });

  it("빗물받이를 지으면 그곳이 물이 나는 곳이 된다", () => {
    const w = home();
    expect(waterHere(content, w.state())).toBeNull();
    give(w, "cloth", 2);
    give(w, "scrap_metal", 1);
    give(w, "duct_tape", 1);
    expect(build(w, "rain_catcher", "improvise", "intellect").ok).toBe(true);
    expect(waterHere(content, w.state())).toEqual({ kind: "spring", grant: "full" });
  });

  it("우리 거점에 바리케이드를 지으면 담이 단단해지고 행적이 남는다. 습격을 받으면 부서진다", () => {
    const w = make("role_a_grunt");
    const zone = w.state().playerZone!;
    const fort = w.state().zones[zone]?.fort ?? 0;
    give(w, "planks", 3);
    give(w, "scrap_metal", 2);
    expect(build(w, "barricade", "carpentry", "strength").ok).toBe(true);
    expect(w.state().zones[zone]?.fort ?? 0).toBe(fort + 1);
    expect(Object.values(w.state().deeds).some((d) => d.summary.includes("바리케이드"))).toBe(true);
    const broken = breakFacilities(w.ctx(), [{ kind: "raid", attacker: "faction_c", defender: "faction_a", zone, success: true, attackerLosses: 0, defenderLosses: 0 }]);
    expect(broken[0]?.line).toContain("부서졌다");
    expect(w.state().facilities[zone]).toEqual([]);
    expect(w.state().zones[zone]?.fort ?? 0).toBe(fort);
  });

  it("거처의 텃밭은 자라는 계절에 며칠마다 창고에 먹을 것을 남긴다", () => {
    const w = home();
    give(w, "seed_packet", 1);
    expect(build(w, "garden", "survival", "vitality").ok).toBe(true);
    const zone = w.state().playerZone!;
    runFacilitiesDaily(w.ctx(), 4);
    expect(w.state().stashes[me(w).id]?.[zone]?.potato).toBe(2);
  });

  it("가축 (12-175): 닭장은 산 닭이 재료로 들고, 겨울에도 이틀마다 달걀을 남긴다. 거점이면 무리 식량", () => {
    const w = home();
    give(w, "planks", 2);
    give(w, "wire_roll", 1);
    expect(build(w, "coop", "carpentry", "strength").ok).toBe(false); // 닭이 없다
    give(w, "hen", 2);
    expect(build(w, "coop", "carpentry", "strength").ok).toBe(true);
    expect(me(w).inventory.hen ?? 0).toBe(0);
    const zone = w.state().playerZone!;
    // 겨울 날 (텃밭은 자라지 않는 계절)
    let day = 2;
    while (seasonAt(content.scenario, (day - 1) * 24 * 60)?.id !== "winter" && day < 2000) day += 2;
    runFacilitiesDaily(w.ctx(), day);
    expect(w.state().stashes[me(w).id]?.[zone]?.egg).toBe(2);

    const b = make("role_a_grunt");
    give(b, "planks", 3);
    give(b, "wire_roll", 1);
    give(b, "goat", 1);
    expect(build(b, "goat_pen", "carpentry", "strength").ok).toBe(true);
    const food = b.state().factions.faction_a!.resources.food ?? 0;
    runFacilitiesDaily(b.ctx(), 3);
    expect(b.state().factions.faction_a!.resources.food).toBe(food + 1);
  });
});
