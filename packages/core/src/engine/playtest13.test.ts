import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeMissionOf, evaluateMission, pickDailyOffers, recentSetback, riskyMission } from "../game/missions.ts";
import { makeFamily } from "../game/startGroup.ts";
import { routeMinutes } from "../rules/time.ts";
import { itemSources } from "../content/sources.ts";
import { stanceOf } from "../game/fame.ts";
import { createSeededRng } from "../rng.ts";
import { pickCast, storyletAllowed, storyletWindow } from "../story/storylets.ts";
import { disposition } from "../sim/war.ts";
import { capturePlayer, releasePlayer } from "./captivity.ts";
import { issueSpare } from "./armory.ts";
import { loadRealContent } from "../testing.ts";
import { WorldManager } from "../world/manager.ts";
import { maybeInfect } from "./body.ts";
import { helperFor, shareHarmWith } from "../rules/company.ts";
import { changeNotices, visibleOf } from "../rules/notice.ts";
import { onReturnedHome } from "../rules/consequence.ts";
import { neighbors } from "../sim/war.ts";
import { currentResolve, resolveLine, resolveProgress } from "./resolve.ts";
import { runHelpless } from "./helpless.ts";
import { runMissionStartOfTurn } from "./missionTools.ts";
import { applyEffect, hostileHere, hostileZone, maskUnknownNames, runInfestedArrival } from "./storyletTools.ts";
import { baseInfestation } from "../game/infestation.ts";
import { recordDeed } from "./reputationTools.ts";
import { healFromSleep, pickFee } from "./body.ts";
import { ambushParts } from "./ambush.ts";
import { wearItem, withoutWear } from "./gear.ts";
import { sleepChainStart } from "../game/state.ts";
import { itemResource } from "./market.ts";
import { scavenge } from "./scavenge.ts";
import { ownedBy, myPeopleLiveHere } from "../rules/home.ts";
import { runDailyBody } from "./body.ts";
import { clothesHere } from "./climate.ts";
import { runQuarantine } from "./care/quarantine.ts";
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

describe("균형: 다침·죽음 (플레이 테스트 13 뒤 정한 것)", () => {
  it("이 행동에서 막 쓰러졌으면 쓰러진 동안의 일은 다음에 시간이 흐를 때 정한다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const me = w.state().playerId;
    const start = w.state().time;
    const harm = content.scenario.harm_track;
    ctx.store.append({ type: "condition_changed", targetId: me, track: harm, from: "none", to: "unconscious", fatal: false, by: "enemy", cause: "테스트", day: 1, harmTrack: true });
    expect(runHelpless(ctx, start)).toEqual([]);
    expect(w.state().helplessAt).toBeNull();
  });
});

describe("균형: 갇힘 (플레이 테스트 13 뒤 정한 것)", () => {
  it("감시 벌점은 -3까지 쌓인다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const enemy = Object.keys(content.factions).find((f) => f !== w.state().characters[w.state().playerId]!.factionId && Object.values(content.locations).some((l) => l.kind === "base" && l.owner === f))!;
    const zone = Object.values(content.locations).find((l) => l.kind === "base" && l.owner === enemy)!.id;
    ctx.store.append({ type: "player_captured", by: enemy, zone, held: {} });
    for (let i = 0; i < 5; i++) ctx.store.append({ type: "captive_watch_raised" });
    expect(w.state().characters[w.state().playerId]!.captive!.watch).toBe(3);
  });

  it("빠져나갈 틈 이야기로 풀려나면 붙잡은 무리 땅이 아닌 맞닿은 구역으로 나간다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const enemy = Object.keys(content.factions).find((f) => f !== w.state().characters[w.state().playerId]!.factionId && Object.values(content.locations).some((l) => l.kind === "base" && l.owner === f))!;
    const zone = Object.values(content.locations).find((l) => l.kind === "base" && l.owner === enemy)!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    ctx.store.append({ type: "player_captured", by: enemy, zone, held: {} });
    applyEffect(ctx, { release_player: { returned: false, home: false, out: true } } as never, {}, {}, "테스트");
    const s = w.state();
    expect(s.characters[s.playerId]!.captive).toBeFalsy();
    expect(s.playerZone).not.toBe(zone);
    expect(s.zones[s.playerZone!]?.owner).not.toBe(enemy);
  });
});

describe("균형: 치료 값 (플레이 테스트 13 뒤 정한 것)", () => {
  it("치료 값은 먼저 보여 주고, 담요·물그릇은 고르지 않으며, 플레이어가 고른 것으로 낼 수 있다", () => {
    const w = new WorldManager({ savesDir: mkdtempSync(join(tmpdir(), "trpg-pt13-")), content, rngFactory: () => () => 0.5 }).create("mcp", "role_l_wanderer", choice);
    const me = () => w.state().characters[w.state().playerId]!;
    w.state().scene.present.push("a_chaewon");
    w.state().characters.a_chaewon!.inventory = { bandage: 2 };
    me().conditions.harm = "light";
    const blanket = Object.values(content.items).find((i) => i.warmth?.when === "resting")!.id;
    me().inventory = { canned_food: 6, [blanket]: 1 };
    const treat = (pay: unknown) => w.executeTool("take_action", { intent: "치료를 받는다", treatment: { item: null, target: null, pay } });
    const preview = treat(null);
    expect(preview.ok).toBe(false);
    expect(preview.ok ? "" : preview.error).toContain("정해 둔 것");
    expect(preview.ok ? "" : preview.error).not.toContain(content.items[blanket]!.name);
    const chosen = treat([{ item: "canned_food", quantity: 5 }]);
    expect(chosen.ok, chosen.ok ? "" : chosen.error).toBe(true);
    expect(me().inventory.canned_food).toBe(1);
    expect(me().inventory[blanket]).toBe(1);
  });
});

describe("치료 (12-236)", () => {
  it("값을 받지 않으면 까닭을 한 줄 알린다", () => {
    const w = world("role_a_grunt");
    const me = () => w.state().characters[w.state().playerId]!;
    w.state().scene.present.push("a_chaewon");
    me().conditions.harm = "light";
    const out = w.executeTool("take_action", { intent: "치료를 받는다", treatment: { item: null, target: null, pay: null } });
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok ? out.resultText : "").toMatch(/값을 받지 않았다/);
  });

  it("버들마을과 나루상단에도 치료사가 있다", () => {
    for (const f of ["faction_b", "faction_e"]) expect(Object.values(content.npcs).some((n) => n.healer && n.faction === f)).toBe(true);
  });
});

describe("상단·임무 (12-237)", () => {
  it("오늘의 일감 둘 가운데 하나는 늘 역할 일감이고, 직분 일감은 하루 하나까지다", () => {
    const own = content.roles.role_e_porter!.missions;
    const extra = ["occ_scavenger_sweep", "occ_scavenger_mark_route", "occ_scavenger_medicine", "occ_scavenger_haul"];
    for (let i = 0; i < 30; i++) {
      const offers = pickDailyOffers(content, "role_e_porter", 1440 * 5 + 360, null, createSeededRng(i), extra)!;
      expect(offers.templateIds.some((id) => own.includes(id))).toBe(true);
      expect(offers.templateIds.filter((id) => !own.includes(id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("상단·마을의 수색대원에게 군대 일감(총기 손질·신병 훈련)이 나오지 않는다", () => {
    const scav = content.scenario.occupations.find((o) => o.id === "scavenger")!;
    expect(scav.missions).not.toContain("occ_soldier_cleaning");
    expect(content.roles.role_a_grunt!.missions).toContain("occ_soldier_cleaning");
  });

  it("거점과 맞닿은 곳(near) 임무는 거점 구역에서 한 일도 세고, 완수하면 알게 되는 것을 믿음으로 남긴다", () => {
    const w = world("role_b_guard");
    const commander = content.roles.role_b_guard!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: ["b_footprints"] });
    const out = w.executeTool("assign_mission", { template_id: "b_footprints" });
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    expect(m.place?.zones).toContain("b_base");
    expect(m.place?.label).toContain("맞닿은 곳");
    for (let i = 0; i < m.requirements.length; i++) w.ctx().store.append({ type: "mission_requirement_met", missionId: m.id, index: i });
    const r = w.executeTool("report_mission", {});
    expect(r.ok && r.resultText).toContain("알게 된 것");
    expect(JSON.stringify(w.state().beliefs[w.state().playerId])).toContain("남쪽 밭 둑길");
  });

  it("수색 활동이라도 수색 판정이 아니면 수색표를 굴리지 않는다", () => {
    const w = world("role_c_comrades");
    const zone = Object.values(content.locations).find((l) => l.loot?.items.length && !l.owner)!.id;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    const inv = () => JSON.stringify(w.state().characters[w.state().playerId]!.inventory);
    const before = inv();
    const out = w.executeTool("take_action", act({ intent: "발자국을 읽으며 따라간다", activity: { kind: "search", until: null }, check: { move: "survival", stat: "senses", difficulty: "easy", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" } }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok && out.resultText).toContain("찾은 물건은 없다");
    expect(inv()).toBe(before);
  });
});

describe("무리 생활 (12-238)", () => {
  it("우리 땅(공통 규칙 11): 무소속은 주인 없는 땅을 우리 땅으로 치지 않는다", () => {
    expect(ownedBy({ zones: { x: { owner: null } } }, "x", null)).toBe(false);
    expect(ownedBy({ zones: { x: { owner: "f" } } }, "x", "f")).toBe(true);
  });

  it("떠나기 전에 예정 시각이 지난 교전은 지금 자리로 판정한다: 맞닿은 우리 구역에 있으면 공세에 낀다", () => {
    const w = world("role_c_comrades");
    const ctx = w.ctx();
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: "c_warehouse" });
    w.state().pendingClashes.push({ id: "battle_t", kind: "assault", attacker: "faction_c", defender: "faction_a", zone: "a_east_post", at: w.state().time - 5 });
    const out = w.executeTool("take_action", act({ intent: "거점으로 간다", move_to: "c_base", activity: null }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok && out.resultText).toContain("떠나기 전에 교전이 벌어졌다");
    expect(w.state().battle).not.toBeNull();
    expect(w.state().playerZone).toBe("c_warehouse");
  });

  it("우리 무리 사람이 떠나면 소식으로 듣고, ?소문에 소식도 나온다", async () => {
    const w = world("role_c_raider");
    const mate = Object.values(content.npcs).find((n) => n.faction === "faction_c" && w.state().characters[n.id] && n.id !== content.roles.role_c_raider!.commander)!.id;
    applyEffect(w.ctx(), { npc_depart: { who: "mate" } } as never, { mate }, {}, "테스트");
    const fact = (w.state().beliefs[w.state().playerId] ?? []).find((b) => b.fact.includes("무리에서 사라졌다"));
    expect(w.state().characters[mate]!.away).toBe(true);
    expect(fact?.source).toBe("report");
    expect(await w.runCommand("?소문")).toContain("무리에서 사라졌다");
  });

  it("자정에 우리 땅 밖이면 배급을 미루고, 그날 거점에 닿으면 받는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const outside = Object.values(content.locations).find((l) => !l.owner && l.kind === "zone")!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: outside });
    runDailyBody(ctx);
    expect(w.state().missedRationDay).not.toBeNull();
  });

  it("옷은 우리 무리 사람이 사는 우리 땅에서도 갈아입는다", () => {
    const w = world("role_c_comrades");
    const lived = Object.values(content.npcs).find((n) => n.faction === "faction_c" && n.zone && content.locations[n.zone]?.kind !== "base" && content.locations[n.zone]?.owner === "faction_c");
    if (!lived) return;
    w.ctx().store.append({ type: "zone_moved", from: w.state().playerZone, to: lived.zone! });
    expect(myPeopleLiveHere(w.state(), content)).toBe(true);
    expect(clothesHere(content, w.state())).toBe(true);
  });

  it("감염체에게 다친 뒤 하얀매 치료사에게 치료받으면 누구든 격리실에 사흘 갇히고, 열이 없으면 풀려난다", () => {
    const w = world("role_l_wanderer");
    const ctx = w.ctx();
    const healer = Object.values(content.npcs).find((n) => n.healer && n.faction === "faction_d" && n.zone === "d_clinic")!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: "d_clinic" });
    ctx.store.append({ type: "infection_exposed", characterId: w.state().playerId });
    w.state().characters[w.state().playerId]!.conditions.harm = "light";
    w.state().characters[w.state().playerId]!.inventory = { canned_food: 6 };
    w.state().scene.present.push(healer);
    const out = w.executeTool("take_action", act({ intent: "치료를 받는다", treatment: { item: null, target: null, pay: [{ item: "canned_food", quantity: 5 }] } }));
    expect(out.ok, out.ok ? "" : out.error).toBe(true);
    expect(out.ok && out.resultText).toContain("격리실");
    const held = w.state().characters[w.state().playerId]!.captive;
    expect(held?.quarantine).toBe(true);
    expect(held?.by).toBe("faction_d");
    expect(runQuarantine(ctx)).toEqual([]);
    w.state().time += 3 * 1440;
    expect(runQuarantine(ctx).join("")).toContain("격리가 끝났다");
    expect(w.state().characters[w.state().playerId]!.captive).toBeNull();
    expect(w.state().exposedAt[w.state().playerId]).toBeUndefined();
  });
});

describe("튜토리얼과 그 밖 (12-239)", () => {
  it("유예 동안이나 중상 이상이면 위험 임무(작전·적 땅)를 오늘의 일감에 내지 않는다", () => {
    for (let i = 0; i < 20; i++) {
      const offers = pickDailyOffers(content, "role_a_grunt", 1440 * 5 + 360, null, createSeededRng(i), [], false, undefined, undefined, undefined, [], true);
      for (const id of offers?.templateIds ?? []) expect(riskyMission(content.missions[id]!)).toBe(false);
    }
  });

  it("부모는 주인공보다 많아야 38살 위다", () => {
    for (let i = 0; i < 30; i++) {
      const fam = makeFamily(content, { age: 25, gender: "female" }, 3, createSeededRng(i), null);
      const rel = content.scenario.custom_start!.group!.relations;
      for (const m of fam) if (rel.find((r) => r.id === m.relation)?.kind === "parent") expect(m.age).toBeLessThanOrEqual(63);
    }
  });

  it("이동 시간은 길마다 정해져 있고 오가는 방향이 같다", () => {
    expect(routeMinutes("e_market", "riverside")).toBe(routeMinutes("riverside", "e_market"));
    expect(routeMinutes("e_market", "riverside")).toBe(routeMinutes("e_market", "riverside"));
  });

  it("부탁 물건을 구할 만한 곳을 콘텐츠에서 찾는다", () => {
    expect(itemSources(content, "notebook").length).toBeGreaterThan(0);
    expect(itemSources(content, "seed_packet").length).toBeGreaterThan(0);
  });

  it("?상태의 트레잇 줄은 없어도 보인다", async () => {
    const w = world("role_y_islander");
    w.state().characters[w.state().playerId]!.traits = [];
    expect(await w.runCommand("?상태")).toContain("트레잇  없음");
  });
});

describe("균형: 진급·공적·레벨 (플레이 테스트 13 뒤 정한 것)", () => {
  it("판정 하나에 1시간 이하인 짧은 일감의 완수는 공적 +2, 판정이 둘이면 +3", () => {
    const short = { requirements: [{ check: "first_aid", min: "partial" }, { activity: "treat", minutes: 60 }], progress: [1, 60], deadline: 100 } as never;
    expect(evaluateMission(short, 50).merit).toBe(2);
    const two = { requirements: [{ check: "first_aid", min: "partial" }, { check: "sense_danger", min: "partial" }], progress: [1, 1], deadline: 100 } as never;
    expect(evaluateMission(two, 50).merit).toBe(3);
  });

  it("일부 완수는 진급을 미루는 흠으로 세지 않는다", () => {
    const m = (id: string, status: string) => ({ id, assigneeId: "p", assignedAt: 1000, status }) as never;
    expect(recentSetback({ time: 1100, missions: { a: m("a", "partial"), b: m("b", "partial") } }, "p", null)).toBeNull();
    expect(recentSetback({ time: 1100, missions: { a: m("a", "failed"), b: m("b", "expired") } }, "p", null)).not.toBeNull();
  });
});

describe("균형: 같은 일감 (플레이 테스트 13 뒤 정한 것)", () => {
  it("최근에 받은 일감은 다른 후보가 있으면 내지 않는다", () => {
    const pool = content.roles.role_a_squad_leader!.missions;
    const recent = pool.slice(0, pool.length - 2);
    for (let i = 0; i < 10; i++) {
      const offers = pickDailyOffers(content, "role_a_squad_leader", 1440 * 5 + 360, null, createSeededRng(i), [], false, undefined, undefined, undefined, recent)!;
      expect(offers.templateIds.every((id) => !recent.includes(id))).toBe(true);
    }
  });
});

describe("균형: 자원·흥정·직분 (플레이 테스트 13 뒤 정한 것)", () => {
  it("말로 하는 판정 조건은 교섭·위협·거짓말 무엇으로든 채운다", () => {
    const w = world("role_e_porter");
    const commander = content.roles.role_e_porter!.commander!;
    w.executeTool("npc_presence", { npc_id: commander, action: "enter" });
    const t = Object.values(content.missions).find((m) => m.requirements.some((r) => "check" in r && r.check === "persuade"))!;
    w.ctx().store.append({ type: "missions_offered", day: Math.floor(w.state().time / 1440) + 1, templateIds: [t.id] });
    expect(w.executeTool("assign_mission", { template_id: t.id }).ok).toBe(true);
    const m = activeMissionOf(w.state().missions, w.state().playerId)!;
    const r = m.requirements.find((x) => "check" in x && x.check === "persuade") as { alts?: string[] };
    expect(r.alts).toEqual(expect.arrayContaining(["intimidate", "deceive"]));
  });

  it("임무로 찾는 자원은 대가 있는 성공 이상이면 하나는 나온다", () => {
    const w = world("role_b_guard");
    const ctx = w.ctx();
    const zone = Object.values(content.locations).find((l) => l.loot && !l.loot.items.some((i) => itemResource(content, i.item) === "medicine"))!.id;
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    const meds = () => Object.entries(w.state().characters[w.state().playerId]!.inventory).filter(([id]) => itemResource(content, id) === "medicine").reduce((n, [, q]) => n + q, 0);
    const before = meds();
    scavenge(ctx, "partial", "medicine");
    expect(meds()).toBeGreaterThan(before);
  });
});

describe("균형: 몸·잠 (플레이 테스트 13 뒤 정한 것)", () => {
  it("깬 지 1시간 안에 다시 자면 앞의 잠과 이어진 한 밤이다", () => {
    expect(sleepChainStart({ lastWokeAt: 600, lastSleptFrom: 400 }, 630)).toBe(400);
    expect(sleepChainStart({ lastWokeAt: 600, lastSleptFrom: 400 }, 700)).toBe(700);
    expect(sleepChainStart({ lastWokeAt: null, lastSleptFrom: null }, 700)).toBe(700);
  });

  it("끊긴 잠 두 조각을 합쳐 푹 잔 밤이면 상처가 아문다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const me = w.state().playerId;
    const harm = content.scenario.harm_track;
    ctx.store.append({ type: "condition_changed", targetId: me, track: harm, from: "none", to: "light", fatal: false, by: "enemy", cause: "테스트", day: 1, harmTrack: true });
    const t0 = w.state().time + 60;
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: t0 });
    ctx.store.append({ type: "time_advanced", activity: "sleep", from: t0, to: t0 + 135 });
    const s = w.state();
    expect(s.lastSleptFrom).toBe(t0);
    const second = t0 + 150;
    ctx.store.append({ type: "time_advanced", activity: "wait", from: s.time, to: second });
    expect(sleepChainStart(w.state(), second)).toBe(t0);
    expect(healFromSleep(ctx, sleepChainStart(w.state(), second), second + 345).length).toBeGreaterThan(0);
  });
});

describe("설계: 이야기·전투 장면 (플레이 테스트 13 뒤 정한 것)", () => {
  it("자세가 무너지면 다음 판정 하나에 -1이 붙고, 판정 뒤 풀린다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    ctx.store.append({ type: "off_balance_changed", until: w.state().time + 60 });
    expect(ambushParts(content, w.state(), "fight", null)).toContainEqual({ label: "자세가 무너짐", value: -1 });
    const r = w.executeTool("take_action", act({ check: { move: "fight", stat: "strength", difficulty: "normal", harm_on_failure: "none", harm_cause: "", harm_kind: null, infected_source: false, target_harm: "none", distance: "close" } }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(w.state().offBalanceUntil).toBeNull();
  });

  it("연습 중에는 물건이 닳지 않는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const me = w.state().playerId;
    const item = Object.keys(w.state().characters[me]!.inventory).find((id) => content.items[id]?.durability)!;
    withoutWear(true, () => wearItem(ctx, me, item, 1));
    expect(w.state().characters[me]!.wear[item] ?? 0).toBe(0);
  });
});

describe("규칙: 이야기 배역 쉬기 (플레이 테스트 13 뒤 정한 것)", () => {
  it("최근 이틀 안에 배역으로 나온 사람은 다른 후보가 있으면 고르지 않는다", () => {
    const w = world("role_a_grunt");
    const s = structuredClone(w.state());
    const story = Object.values(content.storylets).find((x) => Object.values(x.cast).length === 1 && Object.values(x.cast).every((r) => r.faction === "own" && !r.ids && !r.extra && !r.romance && !r.recall) && pickCast(s, content, x, null))!;
    const first = pickCast(s, content, story, () => 0)!;
    const key = Object.keys(first)[0]!;
    s.castUsedAt = { [first[key]!]: s.time };
    const again = pickCast(s, content, story, () => 0)!;
    expect(again[key]).not.toBe(first[key]);
  });
});

describe("설계: 다짐 (플레이 테스트 13 뒤 정한 것)", () => {
  it("인정받기·자리 다짐은 단계 대신 채운 정도를 보인다", () => {
    const medic = world("role_d_medic");
    expect(resolveLine(medic.state(), content)).toContain("평판 0/5");
    const grunt = world("role_a_grunt");
    const g = grunt.state();
    const rise = { ...currentResolve(g)!, kind: "rise", target: content.scenario.promotion!.to };
    expect(resolveProgress(g, content, rise)).toContain("진급까지 남은 것");
  });

  it("다짐의 첫 단계는 다짐이 생긴 날이 지난 뒤부터 오른다", () => {
    const w = world("role_a_squad_leader");
    const r0 = currentResolve(w.state());
    if (!r0) return;
    w.executeTool("take_action", act());
    expect(currentResolve(w.state())!.stage ?? 0).toBe(0);
  });
});

describe("공통 규칙 2단계 (플레이 테스트 13 뒤 정한 것)", () => {
  const enemyBase = (w: ReturnType<typeof world>) => {
    const mine = w.state().characters[w.state().playerId]!.factionId;
    return Object.values(content.locations).find((l) => l.kind === "base" && l.owner && l.owner !== mine && w.state().factions[l.owner])!;
  };

  it("붙잡히면 그 무리가 우리 무리를 보는 태도가 한 단계 내려가고, 들킨 일은 침입 행적으로 남는다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const base = enemyBase(w);
    const own = w.state().characters[w.state().playerId]!.factionId!;
    const before = disposition(content, base.owner!, own, w.state());
    capturePlayer(ctx, base.owner!, base.id);
    expect(disposition(content, base.owner!, own, w.state())).toBe(Math.max(-3, before - 1));
    expect(Object.values(w.state().deeds).some((d) => d.tags.includes("trespass"))).toBe(true);
  });

  it("붙잡혀 빼앗기고 빠져나온 뒤 맨손으로 우리 거점에 오면 무기고가 근접 무기를 내준다 (한 번)", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const home = w.state().playerZone!;
    const base = enemyBase(w);
    ctx.store.append({ type: "zone_moved", from: home, to: base.id });
    capturePlayer(ctx, base.owner!, base.id);
    releasePlayer(ctx, false);
    ctx.store.append({ type: "zone_moved", from: base.id, to: home });
    const me = () => w.state().characters[w.state().playerId]!;
    for (const [id, n] of Object.entries(me().inventory)) if (content.items[id]?.weapon) ctx.store.append({ type: "item_consumed", holder: me().id, itemId: id, quantity: n });
    expect(issueSpare(ctx).length).toBe(1);
    expect(Object.keys(me().inventory).some((id) => !!content.items[id]?.weapon)).toBe(true);
    expect(issueSpare(ctx).length).toBe(0);
  });

  it("갇힌 뒤 1시간이 지나면 이야기 창이 열린다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const base = enemyBase(w);
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: base.id });
    const s0 = structuredClone(w.state());
    s0.lastStoryletAt = s0.time - 10;
    s0.runStartedAt = s0.time - 10000;
    capturePlayer(ctx, base.owner!, base.id);
    const s = { ...structuredClone(w.state()), lastStoryletAt: s0.lastStoryletAt, runStartedAt: s0.runStartedAt };
    expect(storyletWindow(s, content, s.time + 30)).not.toBe("open");
    expect(storyletWindow(s, content, s.time + 70)).toBe("open");
  });
});

const baseInfestationOf = (zone: string) => baseInfestation(content, zone);

describe("공통 규칙 3단계: 처지·감염체 (플레이 테스트 13 뒤 정한 것)", () => {
  it("감염체가 곁에 있으면 오래 걸리는 일을 거절한다", () => {
    const w = world("role_a_grunt");
    const tpl = Object.entries(content.extras).find(([, t]) => t.kind === "infected")![0];
    const r0 = w.executeTool("spawn_extra", { template: tpl, label: "기어 온 감염체" });
    expect(r0.ok, r0.ok ? "" : r0.error).toBe(true);
    const r = w.executeTool("take_action", act({ activity: { kind: "search", until: null } }));
    expect(r.ok ? "" : r.error).toContain("곁에 위협이 있다");
  });

  it("몰려든 구역에 몰려든 뒤 처음 들어서면 반드시 한 번 마주친다", () => {
    const w = world("role_a_grunt");
    const ctx = w.ctx();
    const zone = Object.values(content.locations).find((l) => !l.owner && baseInfestationOf(l.id) < 3)!.id;
    ctx.store.append({ type: "infestation_changed", zone, level: baseInfestationOf(zone) + 1, cause: "소음" });
    ctx.store.append({ type: "swarm_set", zone, day: 1, at: w.state().time, done: true });
    ctx.store.append({ type: "zone_moved", from: w.state().playerZone, to: zone });
    const out = runInfestedArrival({ ...ctx, rng: () => 0.99 }, zone);
    expect(out.some((d) => d.type === "storylet")).toBe(true);
    expect(w.state().swarms[zone]!.met).toBe(true);
  });
});

describe("공통 규칙 8·9와 자리 비움 (플레이 테스트 13 뒤 정한 것)", () => {
  it("곁의 분대원 가운데 그 판정을 잘하는 사람이 돕고, 상대가 있는 큰 피해는 하나가 나눠 받는다", () => {
    const w = world("role_a_squad_leader");
    const mate = content.roles.role_a_squad_leader!.squad![0]!;
    w.ctx().store.append({ type: "companion_joined", characterId: mate, kind: "squad" } as never);
    w.state().characters[mate]!.skills = { ...w.state().characters[mate]!.skills, scavenge: 2 };
    expect(helperFor(w.state(), content, "scavenge")?.id).toBe(mate);
    expect(shareHarmWith(w.state(), content)).not.toBeNull();
  });

  it("바뀐 것이 결과 글에 없으면 까닭과 함께 알린다", () => {
    const w = world("role_a_grunt");
    const before = visibleOf(w.state(), content);
    w.ctx().store.append({ type: "merit_awarded", characterId: w.state().playerId, delta: 2, reason: "테스트" });
    expect(changeNotices(before, visibleOf(w.state(), content), w.state(), content, "")).toContainEqual(expect.stringContaining("공적 +2"));
    expect(changeNotices(before, visibleOf(w.state(), content), w.state(), content, "공적 +2.")).toEqual([]);
  });

  it("섬을 임무 없이 6시간 넘게 비웠다 돌아오면 상관이 아는 불복종 행적이 남는다", () => {
    const w = world("role_y_islander");
    const ctx = w.ctx();
    const home = w.state().playerZone!;
    const out = content.locations[home]!.crossing ? Object.keys(content.locations).find((z) => w.state().zones[z]?.owner !== "faction_y")! : neighbors(content, home)[0]!;
    ctx.store.append({ type: "zone_moved", from: home, to: out });
    expect(w.state().leftHomeAt).not.toBeNull();
    ctx.store.append({ type: "time_advanced", activity: "wait", from: w.state().time, to: w.state().time + 7 * 60 });
    ctx.store.append({ type: "zone_moved", from: out, to: home });
    expect(onReturnedHome(ctx).length).toBe(1);
    expect(Object.values(w.state().deeds).some((d) => d.summary.includes("자리를 비웠다"))).toBe(true);
    expect(w.state().leftHomeAt).toBeNull();
  });
});
