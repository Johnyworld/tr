import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeMissionOf, atMissionPlace } from "../game/missions.ts";
import { createSeededRng } from "../rng.ts";
import { segmentOf } from "../rules/time.ts";
import { conditionsMet, pacingBlocks } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { pickFee } from "./body.ts";
import { runCompanions } from "./companionTools.ts";
import { handleTrap } from "./forage.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { maskUnknownNames, runAlarm } from "./storyletTools.ts";

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
    const others = Object.keys(content.storylets).filter((id) => !content.storylets[id]!.when.mission).slice(0, 10);
    for (const id of others) state.storyletLog[id] = { fired: 1, lastFiredAt: state.time };
    expect(pacingBlocks(state, content, content.storylets[others[0]!]!, state.time)).toBe(true);
    expect(pacingBlocks(state, content, content.storylets.tv_reunion ?? Object.values(content.storylets).find((s) => s.title === "다시 만난 사람들")!, state.time)).toBe(false);
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
