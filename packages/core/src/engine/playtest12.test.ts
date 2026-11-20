import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeMissionOf, atMissionPlace, pickDailyOffers } from "../game/missions.ts";
import { createSeededRng } from "../rng.ts";
import { segmentOf } from "../rules/time.ts";
import { castCandidates, conditionsMet, itemFlagsMet, pacingBlocks, storyletAllowed, storyletGapMinutes } from "../story/storylets.ts";
import { infestationOf } from "../game/infestation.ts";
import { personaOf } from "./persona.ts";
import { makeFamily } from "../game/startGroup.ts";
import { romanceAllowed } from "./romance.ts";
import { gearModifiers } from "./gear.ts";
import { runCommand } from "../commands/commands.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { pickFee } from "./body.ts";
import { runCompanions } from "./companionTools.ts";
import { handleTrap } from "./forage.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { hostileHere, maskUnknownNames, runAlarm, runSwarms } from "./storyletTools.ts";

/** 긴 판 열 (플레이 테스트 12, docs/playtests/2026-11-20-mcp-12-long.md)의 확실한 버그 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, seed = 5) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt12-")), content, rngFactory: () => createSeededRng(seed) });
  return m.create("mcp", roleId, choice);
}

function withMission(roleId: string, template: string) {
  const w = world(roleId);
  const commander = w.content.roles[roleId]!.commander!;
  w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
  w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [template] });
  const r = w.executeTool("assign_mission", { template_id: template });
  expect(r.ok, r.ok ? "" : r.error).toBe(true);
  const s = w.state();
  const mission = activeMissionOf(s.missions, s.playerId)!;
  const place = Object.keys(content.locations).find((z) => atMissionPlace(mission, z, s.zones, s.factions))!;
  return { w, mission, place };
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("플레이 테스트 12: 치료 값", () => {
  it("신표(완장·통행패)는 내지 않고, 먹고 마시는 것은 하나씩 남긴다", () => {
    const w = world("role_c_raider");
    const me = structuredClone(w.state().characters[w.state().playerId]!);
    me.equipped = { weapon: null, body: null, head: null, arms: null, outer: null };
    me.inventory = { c_armband: 1, trade_token: 1, water_bottle: 1, canned_food: 2 };
    expect(pickFee(w.ctx(), me, 3)?.get("canned_food")).toBe(1);
    expect(pickFee(w.ctx(), me, 4)).toBeNull(); // 통조림 하나(3)만 낼 수 있다
  });
});

describe("플레이 테스트 12: 임무 자리의 이야기", () => {
  it("결과 조건을 채우면 그 자리의 이야기가 다시 열리지 않는다", () => {
    const { w, mission, place } = withMission("role_d_medic", "d_riverside_wounded");
    const store = w.ctx().store;
    store.append({ type: "zone_moved", from: w.state().playerZone, to: place });
    const s = content.storylets.ms_riverside_wounded!;
    expect(conditionsMet(w.state(), content, s, w.state().time)).toBe(true);
    store.append({ type: "mission_requirement_met", missionId: mission.id, index: 0 });
    expect(conditionsMet(w.state(), content, s, w.state().time)).toBe(false);
  });

  it("꼭 열려야 하는 이야기(튜토리얼 엔딩)는 하루 상한에 막히지 않는다", () => {
    const w = world("role_t_visitor");
    const state = structuredClone(w.state());
    const capped = { ...content, scenario: { ...content.scenario, storylet_pacing: { ...content.scenario.storylet_pacing, per_day: 3 } } };
    const others = Object.keys(content.storylets).filter((id) => !content.storylets[id]!.when.mission).slice(0, 10);
    for (const id of others) state.storyletLog[id] = { fired: 1, lastFiredAt: state.time };
    expect(pacingBlocks(state, capped, content.storylets[others[0]!]!, state.time)).toBe(true);
    expect(pacingBlocks(state, capped, Object.values(content.storylets).find((s) => s.title === "다시 만난 사람들")!, state.time)).toBe(false);
  });
});

describe("플레이 테스트 12: 붙잡힘", () => {
  it("갇혀 있으면 기다리던 동행이 같은 구역이어도 합류하지 않고, 경보 이야기도 열리지 않는다", () => {
    const w = world("role_a_grunt");
    const store = w.ctx().store;
    const zone = w.state().playerZone!;
    const buddy = Object.values(w.state().characters).find((c) => c.id !== w.state().playerId && c.factionId === w.state().characters[w.state().playerId]!.factionId && !c.dead)!.id;
    store.append({ type: "companion_joined", characterId: buddy, kind: "purpose" });
    store.append({ type: "companion_parted", characterId: buddy, zone, until: null });
    store.append({ type: "player_captured", by: "faction_c", zone, held: {} });
    store.append({ type: "zone_moved", from: zone, to: zone });
    runCompanions(w.ctx());
    expect(w.state().companions).not.toContain(buddy);
    expect(runAlarm(w.ctx(), "stealth")).toEqual([]);
  });

  it("갇혀 있는 동안 임무 기한이 지나면 불복종이 아니다", () => {
    const { w, mission } = withMission("role_a_grunt", "front_recon");
    const store = w.ctx().store;
    store.append({ type: "player_captured", by: "faction_c", zone: w.state().playerZone!, held: {} });
    store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: mission.deadline + 10 });
    const before = w.state().characters[w.state().playerId]!.disobedience;
    const out = runMissionStartOfTurn(w.ctx());
    expect(w.state().missions[mission.id]!.status).not.toBe("active");
    expect(w.state().characters[w.state().playerId]!.disobedience).toBe(before);
    expect(JSON.stringify(out)).toContain("붙잡혀 못 마침");
  });
});

describe("플레이 테스트 12: 임무와 계승", () => {
  it("옮겨 가며 건 판정은 가는 곳이 임무 자리면 임무로 센다", () => {
    const { w, mission, place } = withMission("role_a_grunt", "front_recon");
    const i = mission.requirements.findIndex((r) => "check" in r);
    const move = (mission.requirements[i] as { check: string }).check;
    w.ctx().store.append({
      type: "check_rolled", checkId: "chk_x", turn: 1, actorId: w.state().playerId, move, stat: content.scenario.moves.find((s) => s.id === move)!.stats[0]!, difficulty: "normal",
      intent: "x", dice: [6, 6], modifiers: { stat: 0, skill: 0, difficulty: 0, condition: 0, trait: 0, gear: 0, opposition: 0 }, total: 12, outcome: "success", forMission: mission.id, dest: place,
    } as never);
    expect(w.state().missions[mission.id]!.progress[i]).toBe(1);
  });

  it("앞 주인공이 잃은 상관의 믿음은 계승한 주인공에게 남지 않는다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    s.trustDroppedAt = { someone: s.time };
    s.characters[s.playerId]!.dead = true;
    const heir = Object.values(s.characters).find((c) => c.id !== s.playerId && !c.dead && c.factionId === s.characters[s.playerId]!.factionId)!.id;
    w.ctx().store.append({ type: "character_switched", characterId: heir, known: [] });
    expect(w.state().trustDroppedAt).toEqual({});
  });
});

describe("플레이 테스트 12: 동행·덫·문구", () => {
  it("남겨 둔 동행은 그 자리를 한 번 떠났다 돌아와야 합류한다", () => {
    const w = world("role_a_grunt");
    const store = w.ctx().store;
    const zone = w.state().playerZone!;
    const other = Object.keys(content.locations).find((z) => z !== zone)!;
    const buddy = Object.values(w.state().characters).find((c) => c.id !== w.state().playerId && c.factionId === w.state().characters[w.state().playerId]!.factionId && !c.dead)!.id;
    store.append({ type: "companion_joined", characterId: buddy, kind: "purpose" });
    w.executeTool("companion_part", { target: buddy, how: "wait", hours: null });
    runCompanions(w.ctx());
    expect(w.state().companions).not.toContain(buddy);
    store.append({ type: "zone_moved", from: zone, to: other });
    store.append({ type: "zone_moved", from: other, to: zone });
    runCompanions(w.ctx());
    expect(w.state().companions).toContain(buddy);
  });

  it("덫 판정이 실패하면 덫을 놓지 못하고 재료가 남는다", () => {
    const w = world("role_l_wanderer");
    const trap = content.scenario.foraging!.trap!;
    const ctx = w.ctx();
    const zone = Object.keys(content.locations).find((z) => content.locations[z]!.kind !== "base")!;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    ctx.store.append({ type: "item_granted", to: w.state().playerId, itemId: trap.item, quantity: 1 });
    const had = w.state().characters[w.state().playerId]!.inventory[trap.item];
    const r = handleTrap(ctx, "set", "miss");
    expect(r.ok && r.lines.join(" ")).toContain("놓지 못했다");
    expect(w.state().traps).toEqual([]);
    expect(w.state().characters[w.state().playerId]!.inventory[trap.item]).toBe(had);
  });

  it("모르는 이름을 호칭으로 바꿀 때 직함이 겹치지 않고, 이름 자체가 내용이면 가린다", () => {
    const w = world("role_l_wanderer");
    const prof = Object.values(content.npcs).find((n) => n.name === "류경환")!;
    const masked = maskUnknownNames(w.state(), content, "캠퍼스 도서관의 류경환 교수와는 붕괴 전부터 알던 사이다");
    expect(masked).not.toContain("류경환");
    expect(masked).not.toMatch(/교수 교수/);
    expect(prof).toBeTruthy();
    const nurse = Object.values(content.npcs).find((n) => n.name === "윤채원")!;
    expect(maskUnknownNames(w.state(), content, `${nurse.name}이라는 이름을 들었다`)).toBe("어떤 사람의 이름을 들었다");
  });

  it("이야기 문장의 조사 자리는 받침 있는 꼴을 앞에 둔다 (과/와)", () => {
    for (const s of Object.values(content.storylets)) expect(JSON.stringify(s), s.id).not.toMatch(/:와\/과}/);
  });

  it("지금 시간대까지 기다리라고 하면 하루를 넘기지 않고 거절한다", () => {
    const w = world("role_a_grunt");
    const r = w.executeTool("take_action", act({ activity: { kind: "wait", until: segmentOf(w.state().time) } }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("이미");
  });
});

describe("플레이 테스트 12 뒤 정한 것", () => {
  it("이야기 사이 간격은 앞 이야기마다 6~12시간 사이로 정해진다", () => {
    const gaps = Array.from({ length: 50 }, (_, i) => storyletGapMinutes(content, 1000 + i * 137));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(6 * 60);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(12 * 60);
    expect(new Set(gaps).size).toBeGreaterThan(5);
  });

  it("한밤에 막 잠에서 깬 때는 급하지 않은 이야기가 열리지 않는다. 아침에 깬 것은 막지 않는다", () => {
    const w = world("role_a_grunt");
    const s = structuredClone(w.state());
    const calm = Object.values(content.storylets).find((x) => !x.urgent && !x.bedside && !x.when.activities)!;
    const night = s.time - (s.time % 1440) + 1440 + 60; // 다음 날 01:00
    const morning = night + 7 * 60; // 08:00
    s.lastActivity = "sleep";
    expect(storyletAllowed(s, content, calm, "open", night)).toBe(false);
    expect(storyletAllowed(s, content, calm, "open", morning)).toBe(true);
    s.lastActivity = "wait";
    expect(storyletAllowed(s, content, calm, "open", night)).toBe(true);
  });

  it("소리가 나면 1~5시간 뒤 몰려들고, 그때 그 구역에 있으면 마주침을 굴린다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const zone = w.state().playerZone!;
    const before = infestationOf(content, w.state(), zone);
    ctx.store.append({ type: "noise_made", zone, level: 3, day: Math.floor(w.state().time / 1440) + 1 });
    runSwarms(ctx);
    const swarm = w.state().swarms[zone]!;
    expect(swarm.at - w.state().time).toBeGreaterThanOrEqual(60);
    expect(swarm.at - w.state().time).toBeLessThanOrEqual(300);
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: swarm.at });
    runSwarms({ ...ctx, rng: () => 0 });
    expect(w.state().swarms[zone]!.done).toBe(true);
    expect(infestationOf(content, w.state(), zone)).toBe(Math.min(3, before + 1));
  });

  it("임무 기한에 오가는 시간이 얹힌다", () => {
    const { w, mission } = withMission("role_a_grunt", "front_recon");
    const hours = (mission.deadline - mission.assignedAt) / 60;
    expect(hours).toBeGreaterThan(content.missions.front_recon!.deadline_hours);
    expect(w).toBeTruthy();
  });

  it("적대하는 땅에서 시간을 들이는 일은 판정을 건다. 판정 없이는 거절, 실패하면 경보", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt12-")), content, rngFactory: () => () => 0 });
    const w = m.create("mcp", "role_a_grunt", choice);
    const ctx = w.ctx();
    const enemy = Object.keys(content.locations).find((z) => {
      ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: z });
      return hostileHere(ctx) && content.locations[z]!.kind === "base";
    });
    expect(enemy).toBeTruthy();
    const refused = w.executeTool("take_action", act({ activity: { kind: "search", until: null } }));
    expect(!refused.ok && refused.error).toContain("판정을 함께 건다");
    const r = w.executeTool("take_action", act({ activity: { kind: "search", until: null }, check: { move: "scavenge", stat: "senses", difficulty: "hard", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(content.storylets[w.state().activeStorylet?.id ?? ""]?.tags).toContain("alarm");
  });

  it("탈출에 실패하면 감시가 심해져 다음 탈출 판정이 어려워진다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const zone = w.state().playerZone!;
    ctx.store.append({ type: "player_captured", by: "faction_c", zone, held: {} });
    ctx.store.append({ type: "captive_watch_raised" });
    ctx.store.append({ type: "captive_watch_raised" });
    expect(w.state().characters[w.state().playerId]!.captive!.watch).toBe(2);
  });

  it("성격을 고르지 않은 주인공의 성격 축은 모두 0이다 (id로 뽑지 않는다)", () => {
    const w = world("role_a_grunt");
    expect(personaOf(content, w.state().characters[w.state().playerId]!)).toEqual({});
  });
});

describe("플레이 테스트 12의 확실한 버그 (둘째)", () => {
  it("알지만 지키는 것(keeps)은 카드에 따로 실리고 '물으면 말해 줄 수 있다'에 없다", () => {
    const w = world("role_c_raider");
    w.executeTool("npc_presence", { npc_id: "c_sangok", action: "enter" });
    const scene = w.sceneForGm();
    const knowsBlock = scene.split("이 인물이 아는 것 (물으면 말해 줄 수 있다)")[1]?.split("\n\n")[0] ?? "";
    expect(scene).toContain("알지만 지키는 것");
    expect(knowsBlock.split("알지만 지키는 것")[0]).not.toContain("밀고자다");
  });

  it("갇혀 있으면 우리 무리 소식·오늘의 임무가 보이지 않고 임무를 받을 수 없다", () => {
    const w = world("role_a_grunt");
    w.ctx().store.append({ type: "player_captured", by: "faction_c", zone: "c_base", held: {} });
    const scene = w.sceneForGm();
    expect(scene).not.toContain("무리 사람들 사이에 도는 말");
    expect(scene).not.toContain("오늘 받을 수 있는 임무");
    expect(scene).not.toContain("잠입할 수 있는 목표");
  });

  it("갇힌 주인공의 피는 붙잡은 쪽이 묶어 준다", () => {
    const w = world("role_a_grunt");
    w.ctx().store.append({ type: "player_captured", by: "faction_c", zone: "c_base", held: {} });
    expect(w.runCheat("~set bleeding bleeding").ok).toBe(true);
    w.executeTool("take_action", act({ activity: { kind: "wait", until: null } }));
    w.executeTool("take_action", act({ activity: { kind: "wait", until: null } }));
    expect(w.state().characters[w.state().playerId]!.conditions.bleeding).toBe("none");
  });

  it("임무 장소 밖에서 for_mission이면 시간을 쓰기 전에 거절한다", () => {
    const { w } = withMission("role_a_grunt", "front_recon");
    const before = w.state().time;
    const r = w.executeTool("take_action", act({ activity: { kind: "guard_duty", until: null }, for_mission: true }));
    expect(!r.ok && r.error).toContain("임무로 치지 않는다");
    expect(w.state().time).toBe(before);
  });

  it("?임무에 진급까지 남은 것이 보인다", () => {
    const w = world("role_a_grunt");
    const out = runCommand("?임무", { state: w.state(), content, summaries: [] });
    expect(out).toContain("진급까지");
  });

  it("가족끼리는 연애 대상이 아니다", () => {
    const w = world("role_t_visitor");
    const kin = w.state().family[0]!;
    expect(romanceAllowed(w.state(), content, kin, w.state().playerId)).toBe(false);
  });

  it("가족을 만들 때 두 부모는 다른 성별이고 이름(성 뺀)이 겹치지 않는다", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const fam = makeFamily(content, { age: 30, gender: "female" }, 3, createSeededRng(seed), "한");
      const parents = fam.filter((m) => m.relation === "parent");
      if (parents.length === 2) expect(parents[0]!.gender).not.toBe(parents[1]!.gender);
      const given = fam.map((m) => m.name.slice(1));
      expect(new Set(given).size).toBe(given.length);
    }
  });

  it("쌍안경은 멀리 살필 때만, 치료 판정은 쓰는 물건만 보정한다", () => {
    const w = world("role_a_grunt");
    const me = structuredClone(w.state().characters[w.state().playerId]!);
    me.inventory = { binoculars: 1, medkit: 1, bandage: 1 };
    expect(gearModifiers(content, me, "sense_danger", "close").skill).toBe(0);
    expect(gearModifiers(content, me, "sense_danger", "far").skill).toBe(1);
    expect(gearModifiers(content, me, "sense_danger", null, undefined, null, { activity: "guard_duty" }).skill).toBe(1);
    expect(gearModifiers(content, me, "first_aid", null, undefined, null, { item: null }).skill).toBe(0);
    expect(gearModifiers(content, me, "first_aid", null, undefined, null, { item: "bandage" }).skillLabel).toBe(content.items.bandage!.name);
  });
});

describe("플레이 테스트 12: 이야기와 배역 (코드)", () => {
  it("배역 필터: not_companion은 곁의 동행을, affection_lte는 주인공을 아끼는 사람을 뺀다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const mates = castCandidates(w.state(), content, { faction: "own", enter: false } as never);
    const buddy = mates[0]!;
    ctx.store.append({ type: "companion_joined", characterId: buddy, kind: "purpose" });
    expect(castCandidates(w.state(), content, { faction: "own", enter: false, not_companion: true } as never)).not.toContain(buddy);
    ctx.store.append({ type: "relation_changed", from: mates[1]!, to: w.state().playerId, delta: { trust: 0, affection: 3, respect: 0 }, reason: "테스트" });
    expect(castCandidates(w.state(), content, { faction: "own", enter: false, affection_lte: 0 } as never)).not.toContain(mates[1]);
  });

  it("곁의 동행이 가진 물건으로도 선택지가 열리고, 내주면 그 사람 것에서 나간다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const me = w.state().playerId;
    const had = w.state().characters[me]!.inventory.dry_ration ?? 0;
    if (had > 0) ctx.store.append({ type: "item_consumed", holder: me, itemId: "dry_ration", quantity: had });
    expect(itemFlagsMet(w.state(), { has_items: ["dry_ration"] } as never)).toBe(false);
    const buddy = castCandidates(w.state(), content, { faction: "own", enter: false } as never)[0]!;
    ctx.store.append({ type: "companion_joined", characterId: buddy, kind: "purpose" });
    ctx.store.append({ type: "item_granted", to: buddy, itemId: "dry_ration", quantity: 1 });
    expect(itemFlagsMet(w.state(), { has_items: ["dry_ration"] } as never)).toBe(true);
  });

  it("말투 예시가 다른 계급을 부르면 카드에 알린다", () => {
    const w = world("role_a_grunt");
    w.executeTool("npc_presence", { npc_id: "a_dongwook", action: "enter" });
    expect(w.sceneForGm()).toContain("그 자리의 사람에게 하는 말이다");
  });
});

describe("플레이 테스트 12: 설계 정한 것", () => {
  it("못 하는 전문 기술을 요구하는 일감은 오늘의 후보에 오르지 않는다", () => {
    const expertMissions = Object.values(content.missions).filter((m) => m.requirements.some((r) => "check" in r && content.scenario.moves.find((x) => x.id === r.check)?.kind === "expert"));
    expect(expertMissions.length).toBeGreaterThan(0);
    const roleId = Object.values(content.roles).find((r) => r.missions.some((id) => expertMissions.some((m) => m.id === id)))!.id;
    for (let seed = 1; seed <= 20; seed++) {
      const offers = pickDailyOffers(content, roleId, 1440 * seed, null, createSeededRng(seed), [], false, undefined, undefined, (move) => content.scenario.moves.find((x) => x.id === move)?.kind !== "expert");
      for (const id of offers?.templateIds ?? []) expect(expertMissions.map((m) => m.id)).not.toContain(id);
    }
  });

  it("빚 다짐은 빚을 갚을 때마다 한 단계 오른다", () => {
    const w = world("role_e_porter");
    const ctx = w.ctx();
    const me = w.state().playerId;
    w.executeTool("take_action", act({ activity: { kind: "wait", until: null } }));
    const r = w.state().resolves?.[me];
    expect(r?.kind).toBe("debt");
    ctx.store.append({ type: "debt_changed", characterId: me, factionId: r!.target!, delta: -1 });
    w.executeTool("take_action", act({ activity: { kind: "wait", until: null } }));
    expect(w.state().resolves?.[me]?.stage).toBeGreaterThan(0);
  });

  it("이미 있던 사람으로 이어 가면 그 사람의 처지에서 다짐을 받는다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const heir = Object.values(s.characters).find((c) => c.id !== s.playerId && !c.dead && c.factionId === s.characters[s.playerId]!.factionId && content.npcs[c.id])!.id;
    w.ctx().store.append({ type: "debt_changed", characterId: heir, factionId: "faction_e", delta: 4 });
    w.state().characters[w.state().playerId]!.dead = true;
    w.ctx().store.append({ type: "character_switched", characterId: heir, known: [], scenarioRole: "" });
    w.executeTool("take_action", act({ activity: { kind: "wait", until: null } }));
    expect(w.state().resolves?.[heir]?.kind).toBe("debt");
  });
});
