import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clash } from "../game/state.ts";
import { pickDailyOffers } from "../game/missions.ts";
import { createSeededRng } from "../rng.ts";
import { baseOfNow } from "../rules/home.ts";
import { MINUTES_PER_DAY } from "../rules/time.ts";
import { loadRealContent } from "../testing.ts";
import { buildPlayerView } from "../views/player.ts";
import { WorldManager } from "../world/manager.ts";
import { changeCondition } from "./body.ts";
import { runInfirmary, settleWarCause, warCauses, WOUNDED_DAYS } from "./warAftermath.ts";
import { afterClashes } from "./warTools.ts";

const content = loadRealContent();
const make = (seed = 3) => new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-aftermath-")), content, rngFactory: () => createSeededRng(seed) }).create("mcp", "role_a_grunt");
type W = ReturnType<typeof make>;
const clash = (over: Partial<Clash>): Clash => ({ kind: "raid", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", success: false, attackerLosses: 0, defenderLosses: 0, ...over });
const harmAt = (w: W, id: string) => w.state().characters[id]!.conditions[content.scenario.harm_track];

describe("파트 14 판도 알기", () => {
  it("땅 주인이 바뀐 남의 교전은 늘 소문으로 닿고 지도에 들은 대로 남는다. 자잘한 습격은 확률대로", () => {
    const w = make();
    const ctx = { ...w.ctx(), rng: () => 0.99 };
    afterClashes(ctx, [clash({ kind: "raid", attacker: "faction_c", defender: "faction_e", zone: "e_market", success: true, defenderLosses: 1 })], { facilities: false });
    expect(w.state().beliefs[w.state().playerId]!.some((b) => b.fact.includes("물자를 털어"))).toBe(false);
    afterClashes(ctx, [clash({ kind: "assault", attacker: "faction_c", defender: "faction_e", zone: "e_market", success: true, defenderLosses: 2 })], { facilities: false });
    expect(w.state().beliefs[w.state().playerId]!.some((b) => b.source === "rumor" && b.fact.includes("빼앗았다"))).toBe(true);
    expect(w.state().zoneSeen.e_market).toBe("faction_c");
    w.close();
  });

  it("상태 화면 세력 칸에 우리 계획의 단계와 최근 전황 세 줄이 있다", () => {
    const w = make();
    afterClashes(w.ctx(), [1, 2, 3, 4].map((i) => clash({ kind: "skirmish", success: i % 2 === 0, attackerLosses: i, defenderLosses: 0 })), { facilities: false });
    const f = buildPlayerView(w.state(), content).faction!;
    expect(f.plans.some((p) => p.startsWith("반격 준비"))).toBe(true);
    expect(f.war).toHaveLength(3);
    w.close();
  });
});

describe("파트 13 직분별 전쟁 임무", () => {
  it("우리 무리 사상자 일부가 의무실 부상자로 들어오고, 의무병 일감의 계기가 된다", () => {
    const w = make();
    const base = baseOfNow(w.state(), content, "faction_a")!;
    afterClashes(w.ctx(), [clash({ defenderLosses: 4 })], { facilities: false });
    const hurt = w.state().wounded;
    expect(hurt).toHaveLength(2);
    for (const h of hurt) {
      expect(h.zone).toBe(base);
      expect(harmAt(w, h.id)).toBe("serious");
      expect(w.state().scene.present).not.toContain(h.id);
    }
    expect(warCauses(w.state(), content, "faction_a").wounded).toBe(base);
    // 교전 흔적은 세계에 남은 교전 기록(recentClashes)에서
    const s = w.state();
    w.ctx().store.append({ type: "parties_advanced", factions: s.factions, zones: s.zones, clocks: Object.fromEntries(Object.entries(s.clocks).map(([id, c]) => [id, { filled: c.filled }])), parties: s.parties, partiesUpTo: s.time, clashes: [clash({ defenderLosses: 4 })], scheduled: [] });
    expect(warCauses(w.state(), content, "faction_a").traces).toBe("a_east_post");
    w.close();
  });

  it("나은 부상자는 돌아가 전투원이 되고, 사흘 동안 낫지 않으면 절반이 숨진다", () => {
    const w = make();
    afterClashes(w.ctx(), [clash({ defenderLosses: 4 })], { facilities: false });
    const [a, b] = w.state().wounded.map((x) => x.id);
    const before = { ...w.state().factions.faction_a! };
    changeCondition(w.ctx(), a!, content.scenario.harm_track, -1, "care", "test");
    runInfirmary(w.ctx());
    expect(w.state().wounded.map((x) => x.id)).toEqual([b]);
    expect(w.state().factions.faction_a!.combatants).toBe(before.combatants + 1);
    expect(w.state().factions.faction_a!.population).toBe(before.population + 1);
    const now = w.state().time;
    w.ctx().store.append({ type: "time_advanced", activity: "brief", from: now, to: now + WOUNDED_DAYS * MINUTES_PER_DAY });
    runInfirmary({ ...w.ctx(), rng: () => 0.1 });
    expect(w.state().wounded).toEqual([]);
    expect(w.state().characters[b!]!.dead).toBe(true);
    w.close();
  });

  it("부서진 시설·적 부대가 든 우리 땅이 계기가 되고, 보수 임무를 해내면 다시 선다", () => {
    const w = make();
    const base = baseOfNow(w.state(), content, "faction_a")!;
    w.ctx().store.append({ type: "facility_built", zone: base, facility: "barricade" });
    w.ctx().store.append({ type: "zone_fortified", zone: base, delta: 1 });
    w.ctx().store.append({ type: "facility_broken", zone: base, facility: "barricade" });
    w.ctx().store.append({ type: "zone_fortified", zone: base, delta: -1 });
    expect(warCauses(w.state(), content, "faction_a").repair).toBe(base);
    const mission = { id: "m_x", templateId: "occ_carpenter_war_repair", title: "부서진 것 다시 세우기", briefing: "", assigneeId: w.state().playerId, giverId: "x", assignedAt: 0, deadline: 0, requirements: [], place: { zone: base, notZone: null, enemyOf: null, label: "" }, progress: [], fails: [], status: "active" as const };
    expect(settleWarCause(w.ctx(), mission, "repair", "success").join()).toContain("다시 세웠다");
    expect(w.state().facilities[base]).toContain("barricade");
    expect(w.state().zones[base]!.fort).toBe(1);
    expect(warCauses(w.state(), content, "faction_a").repair).toBeUndefined();
    w.close();
  });

  it("전쟁 임무는 그 일이 있을 때만 후보에 오르고 직분 몫 자리에 먼저 선다", () => {
    const extra = content.scenario.occupations!.find((o) => o.id === "scavenger")!.missions;
    for (let seed = 1; seed <= 10; seed++) {
      const on = pickDailyOffers(content, "role_a_grunt", MINUTES_PER_DAY * 3, null, createSeededRng(seed), extra, false, undefined, "grunt", undefined, [], false, undefined, false, new Set(["traces"]))!;
      expect(on.templateIds).toContain("occ_scavenger_war_traces");
      const off = pickDailyOffers(content, "role_a_grunt", MINUTES_PER_DAY * 3, null, createSeededRng(seed), extra, false, undefined, "grunt", undefined, [], false, undefined, false, new Set())!;
      expect(off.templateIds).not.toContain("occ_scavenger_war_traces");
    }
  });
});
