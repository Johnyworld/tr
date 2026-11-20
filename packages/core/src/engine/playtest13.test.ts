import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeMissionOf, evaluateMission } from "../game/missions.ts";
import { stanceOf } from "../game/fame.ts";
import { createSeededRng } from "../rng.ts";
import { storyletAllowed } from "../story/storylets.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { maybeInfect } from "./body.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { hostileHere, hostileZone, maskUnknownNames } from "./storyletTools.ts";
import { recordDeed } from "./reputationTools.ts";
import { pickFee } from "./body.ts";
import { formatAgo, START_TIME } from "../rules/time.ts";

/** 긴 판 열 (플레이 테스트 13, docs/playtests/2026-11-20-mcp-13-long.md)의 확실한 버그 */
const content = loadRealContent();
const choice = { name: "서진", gender: "female" as const, abilities: null, portrait: null, traits: [] };

function world(roleId: string, seed = 5) {
  const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt13-")), content, rngFactory: () => createSeededRng(seed) });
  return m.create("mcp", roleId, choice);
}

const act = (input: Record<string, unknown> = {}) => ({
  intent: "행동", check: null, activity: null, deed: null, target: null, narration_summary: null, for_mission: false, ...input,
});

describe("플레이 테스트 13 버그", () => {
  it("물린 감염은 레벨의 버팀으로 막지 못한다", () => {
    const w = world("role_d_medic");
    const s = w.state();
    s.characters[s.playerId]!.level = 30;
    const track = content.scenario.body!.infection!.track;
    maybeInfect({ ...w.ctx(), rng: () => 0 }, "bite");
    expect(w.state().characters[s.playerId]!.conditions[track]).not.toBe(content.scenario.condition_tracks.find((t) => t.id === track)!.levels[0]!.id);
  });

  it("무소속에게 중립 거점은 적대하는 땅이 아니고, 낯선 사람을 잡아가는 무리의 땅은 적대하는 땅이다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const prey = content.scenario.helpless!.prey_on_strangers;
    const neutralBase = Object.values(content.locations).find((l) => l.kind === "base" && l.owner && !prey.includes(l.owner))!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: neutralBase });
    expect(hostileHere(ctx)).toBe(false);
    const preyZone = Object.keys(content.locations).find((z) => prey.includes(w.state().zones[z]?.owner ?? ""))!;
    ctx.store.append({ type: "zone_moved", from: neutralBase, to: preyZone });
    expect(hostileHere(ctx)).toBe(true);
  });

  it("꼭 열려야 하는 이야기는 급한 이야기의 하루 상한에도 막히지 않는다", () => {
    const w = world("role_t_visitor");
    const s = structuredClone(w.state());
    const essential = Object.values(content.storylets).find((x) => x.essential)!;
    const urgent = Object.values(content.storylets).filter((x) => x.urgent && !x.essential).slice(0, 5);
    for (const u of urgent) s.storyletLog[u.id] = { fired: 1, lastFiredAt: s.time };
    expect(storyletAllowed(s, content, essential, "urgent_only", s.time)).toBe(true);
  });

  it("얼굴을 맞댄 사람은 소문으로만 아는 팬이 아니다", () => {
    const w = world("role_a_grunt");
    const s = w.state();
    const commander = content.roles.role_a_grunt!.commander!;
    w.ctx().store.append({ type: "relation_changed", from: commander, to: s.playerId, delta: { trust: 0, affection: 5, respect: 5 }, reason: "테스트" });
    recordDeed(w.ctx(), { summary: "임무 완수", tags: ["diligence"], severity: 1, privacy: "public", noisy: false }, { npcId: commander, source: "report" });
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    expect(stanceOf(w.state(), content, commander)).toBeNull();
  });

  it("거절된 행동의 요약은 일지에 남지 않는다", () => {
    const w = world("role_a_grunt");
    const r = w.executeTool("take_action", act({ move_to: "없는_구역", narration_summary: "구시가로 빠져나왔다" }));
    expect(r.ok).toBe(false);
    expect(w.summaries().some((x) => x.text.includes("빠져나왔다"))).toBe(false);
  });

  it("바닥에 내려놓은 물건은 그 구역에 남는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const here = w.state().playerZone!;
    const next = content.locations[here]!.adjacent[0]!;
    const item = Object.keys(w.state().characters[w.state().playerId]!.inventory)[0]!;
    expect(w.executeTool("transfer_item", { from: w.state().playerId, to: "scene", item_id: item, quantity: 1 }).ok).toBe(true);
    ctx.store.append({ type: "zone_moved", from: here, to: next });
    expect(w.state().scene.items[item] ?? 0).toBe(0);
    ctx.store.append({ type: "zone_moved", from: next, to: here });
    expect(w.state().scene.items[item]).toBe(1);
  });

  it("임무 기한에 오가는 시간이 얹힌다 (맞닿음이 한쪽에만 적혀 있어도)", () => {
    const w = world("role_d_medic");
    const commander = content.roles.role_d_medic!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["d_riverside_wounded"] });
    const r = w.executeTool("assign_mission", { template_id: "d_riverside_wounded" });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    expect((m.deadline - m.assignedAt) / 60).toBeGreaterThan(content.missions.d_riverside_wounded!.deadline_hours);
  });

  it("이야기 글에서 만난 적 없고 장면에도 없는 사람은 누군가다", () => {
    const w = world("role_l_wanderer");
    const npc = Object.values(content.npcs).find((n) => !(w.state().known[w.state().playerId] ?? []).includes(n.id) && !(w.state().met[w.state().playerId] ?? []).includes(n.id))!;
    expect(maskUnknownNames(w.state(), content, `${npc.name}을 몰아세운다`, { story: true })).toBe("누군가를 몰아세운다");
  });
});

describe("플레이 테스트 13 뒤 정한 것", () => {
  it("조건을 기한 안에 다 채웠으면 활동이 기한을 넘겨 끝나도 기한 초과가 아니다", () => {
    const w = world("role_a_grunt");
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const guard = Object.values(content.missions).find((m) => content.roles.role_a_grunt!.missions.includes(m.id) && m.requirements.every((r) => "activity" in r && r.activity === "guard_duty") && !m.where)
      ?? Object.values(content.missions).find((m) => m.requirements.every((r) => "activity" in r && r.activity === "guard_duty") && !m.where)!;
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [guard.id] });
    expect(w.executeTool("assign_mission", { template_id: guard.id }).ok).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    const need = (m.requirements[0] as { minutes: number }).minutes;
    const ctx = w.ctx();
    // 조건이 찬 시각은 기한 안, 활동은 기한 뒤까지
    const start = m.deadline - need - 10;
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: start });
    ctx.store.append({ type: "time_advanced", activity: "guard_duty", from: start, to: m.deadline + 60, forMission: m.id } as never);
    expect(w.state().missions[m.id]!.metAt).toBe(start + need);
    runMissionStartOfTurn(ctx);
    expect(w.state().missions[m.id]!.status).toBe("active");
    const r = w.executeTool("report_mission", {});
    expect(r.ok && r.resultText).not.toContain("기한을 넘겨");
  });
});

describe("플레이 테스트 13의 남은 버그", () => {
  const enemyOf = (w: ReturnType<typeof world>) => {
    const me = w.state().characters[w.state().playerId]!;
    return Object.keys(content.factions).find((f) => f !== me.factionId && Object.values(content.locations).some((l) => l.kind === "base" && l.owner === f))!;
  };

  it("임무 보초는 남은 시간만큼만 선다", () => {
    const w = world("role_a_grunt");
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const guard = Object.values(content.missions).find((m) => m.requirements.length === 1 && m.requirements.every((r) => "activity" in r && r.activity === "guard_duty") && !m.where)!;
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [guard.id] });
    expect(w.executeTool("assign_mission", { template_id: guard.id }).ok).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    const need = (m.requirements[0] as { minutes: number }).minutes;
    const before = w.state().time;
    const r = w.executeTool("take_action", act({ activity: { kind: "guard_duty", until: null }, for_mission: true, ignore_story: true }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const spent = w.state().time - before;
    // 이야기에 끊기지 않았으면 요건만큼 (끊겼으면 그보다 짧다)
    expect(spent).toBeLessThanOrEqual(Math.max(need, 30) + 60);
  });

  it("붙잡혀 못 마친 임무는 공적·불복종·진급 셈에 들지 않고, 빼앗긴 빌린 장비도 탓하지 않는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const tid = w.state().offers!.templateIds[0]!;
    expect(w.executeTool("assign_mission", { template_id: tid }).ok).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    const merit = w.state().characters[w.state().playerId]!.merit;
    const enemy = enemyOf(w);
    const zone = Object.values(content.locations).find((l) => l.kind === "base" && l.owner === enemy)!.id;
    ctx.store.append({ type: "player_captured", by: enemy, zone, held: {} });
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: m.deadline + 30 });
    runMissionStartOfTurn(ctx);
    const after = w.state().missions[m.id]!;
    expect(after.status).toBe("expired");
    expect(after.excused).toContain("붙잡혀");
    expect(w.state().characters[w.state().playerId]!.merit).toBe(merit);
    expect(w.state().characters[w.state().playerId]!.disobedience).toBe(0);
  });

  it("갇혀 못 받은 그날 배급은 우리 거점에 닿으면 받는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const home = w.state().playerZone!;
    const hunger = content.scenario.body!.hunger!.track;
    const levels = content.scenario.condition_tracks.find((t) => t.id === hunger)!.levels;
    const me = w.state().playerId;
    ctx.store.append({ type: "condition_changed", targetId: me, track: hunger, from: levels[0]!.id, to: levels[2]!.id, fatal: false, by: "daily", cause: "테스트", day: 1, harmTrack: false });
    ctx.store.append({ type: "ration_missed", day: Math.floor(w.state().time / 1440) + 1 });
    expect(w.state().playerZone).toBe(home);
    const r = w.executeTool("take_action", act());
    expect(r.ok).toBe(true);
    expect(w.state().missedRationDay).toBeNull();
    expect(w.state().characters[me]!.conditions[hunger]).not.toBe(levels[2]!.id);
  });

  it("치료 값으로 무기고에서 빌린 것은 내지 않는다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const me = w.state().characters[w.state().playerId]!;
    const inv = Object.keys(me.inventory);
    ctx.store.append({ type: "armory_issued", missionId: "m_x", factionId: "x", items: Object.fromEntries(inv.map((i) => [i, me.inventory[i]!])), resource: "", cost: 0 });
    const now = w.state().characters[me.id]!;
    const pay = pickFee(ctx, now, 3) ?? new Map<string, number>();
    for (const [id, q] of pay) expect(q).toBeLessThanOrEqual((now.inventory[id] ?? 0) - (me.inventory[id] ?? 0));
  });

  it("긴 잠 뒤에는 동행이 아닌 사람이 장면에서 빠진다", () => {
    const w = world("role_a_grunt");
    const commander = content.roles.role_a_grunt!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const r = w.executeTool("take_action", act({ activity: { kind: "sleep", until: "night" }, ignore_story: true }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (w.state().time - 0 > 0 && !(r.ok && r.resultText.includes("끊겼다"))) expect(w.state().scene.present).not.toContain(commander);
  });

  it("적대하는 땅에서 드러내 놓고 말을 거는 것은 숨기 판정을 요구하지 않는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const zone = Object.values(content.locations).find((l) => l.kind === "base" && hostileZone({ ...w.state(), playerZone: l.id }, content))!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    expect(hostileHere(ctx)).toBe(true);
    const r = w.executeTool("take_action", act({ activity: { kind: "talk", until: null } }));
    expect(r.ok ? "" : r.error).not.toContain("적대하는 땅");
    const r2 = w.executeTool("take_action", act({ activity: { kind: "rest", until: null } }));
    expect(r2.ok).toBe(false);
  });

  it("세계가 시작되기 전의 기억(지난 삶)은 '어제'가 아니라 '오래전부터'다", () => {
    expect(formatAgo(START_TIME + 2 * 1440, START_TIME - 1)).toBe("오래전부터");
    expect(formatAgo(START_TIME + 1440, START_TIME)).toBe("어제");
  });
});

describe("플레이 테스트 13 뒤 정한 것 (둘째)", () => {
  it("앓는 사람은 응급처치 판정으로 간호한다: 성공하면 병이 한 단계 가라앉는다", () => {
    const m = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt13-")), content, rngFactory: () => () => 0.99 });
    const w = m.create("mcp", "role_d_medic", choice);
    const ctx = w.ctx();
    const me = w.state().playerId;
    const disease = content.scenario.body!.disease!.track;
    const levels = content.scenario.condition_tracks.find((t) => t.id === disease)!.levels;
    const shown = levels.findIndex((l) => !l.hidden && levels.indexOf(l) > 0);
    ctx.store.append({ type: "condition_changed", targetId: me, track: disease, from: levels[0]!.id, to: levels[Math.max(1, shown)]!.id, fatal: false, by: "daily", cause: "테스트", day: 1, harmTrack: false });
    const move = content.scenario.wounds!.staunch_move;
    const stat = content.scenario.moves.find((m) => m.id === move)!.stats[0]!;
    const before = w.state().characters[me]!.conditions[disease];
    const r = w.executeTool("take_action", act({ treatment: { item: null, target: null }, check: { move, stat, difficulty: "easy", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.ok && r.resultText).toContain("열을 내렸다");
    expect(w.state().characters[me]!.conditions[disease]).not.toBe(before);
  });

  it("들키지 않기가 조건인 임무는 들키면 조건을 다 채워도 일부 완수다", () => {
    const m = { requirements: [{ check: "stealth", min: "partial" }], progress: [1], deadline: 100, unseen: true, spotted: true } as never;
    expect(evaluateMission(m, 50).outcome).toBe("partial");
    const ok = { requirements: [{ check: "stealth", min: "partial" }], progress: [1], deadline: 100, unseen: true } as never;
    expect(evaluateMission(ok, 50).outcome).toBe("success");
  });
});

describe("연인 관계 (플레이 테스트 13 뒤 정한 것)", () => {
  it("카드에 숨은 연인이 있는 사람을 이어받으면 진짜 연인이 되고, 주인공이 그것을 안다", () => {
    const w = world("role_a_squad_leader");
    const ctx = w.ctx();
    const lover = content.npcs.a_seoyeon!.ties!.find((t) => t.kind === "lover")!.to;
    // 주인공이 그 사람으로 바뀐 셈 (계승)
    ctx.store.append({ type: "condition_changed", targetId: w.state().playerId, track: content.scenario.harm_track, from: w.state().characters[w.state().playerId]!.conditions[content.scenario.harm_track]!, to: content.scenario.condition_tracks.find((t) => t.id === content.scenario.harm_track)!.levels.at(-1)!.id, fatal: true, by: "enemy", cause: "테스트", day: 1, harmTrack: true });
    const r = w.chooseNextCharacter(lover, null);
    expect(r.ok, r.ok ? "" : (r as { error: string }).error).toBe(true);
    const s = w.state();
    expect(s.playerId).toBe(lover);
    expect(s.romances[[lover, "a_seoyeon"].sort().join("|")]?.stage).toBe("lovers");
    expect(s.relations.a_seoyeon?.[lover]?.affection).toBeGreaterThanOrEqual(3);
    expect((s.beliefs[lover] ?? []).some((b) => b.fact.includes("연인"))).toBe(true);
  });
});
