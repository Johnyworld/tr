import { soak } from "./climate.ts";
import { currentPlace, placeIndoor } from "../rules/place.ts";
import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { idleDays } from "../game/missions.ts";
import { waterFacilityHere } from "./facilities.ts";
import { drinkDirty, fireHere } from "./forage.ts";
import { resistSteps } from "./growth.ts";
import { turnIntoInfected } from "./turning.ts";
import { fatigueBlocksRecovery } from "./fatigue.ts";
import { onPersonDeath } from "./people.ts";
import { lightFire } from "./climate.ts";
import { hasAccess } from "../game/culture.ts";
import type { GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { bodyTraits, habitsOf, traitIdsOf } from "./traits.ts";
import { dayOf } from "../rules/time.ts";
import { harmIncapacitates, incapacitatingSymptom, shownLevel, trackOf, visibleSymptoms } from "../scenario/scenario.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { josa } from "../text.ts";
import { recordDeath } from "./succession.ts";
import { type CheckOutcome } from "../rules/check.ts";
import { rollPlayerCheck } from "./checks.ts";
import { DEATH_GUIDE, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";
export { selfTreatmentProblem, applyTreatment, isFirstAidItem, treatmentProblem, firstAidProblem, nurse, firstAidCheck } from "./care/kinds.ts";
import { selfTreatmentProblem, applyTreatment, isFirstAidItem, treatmentProblem, firstAidProblem, nurse, firstAidCheck } from "./care/kinds.ts";
export { type FeeChoice, planHealerPay, keptForLiving, payableCount, pickFee, payHealer } from "./care/fee.ts";
import { type FeeChoice, planHealerPay, keptForLiving, payableCount, pickFee, payHealer } from "./care/fee.ts";
export { needsSurgery, canOperate, surgeonRoll, operate } from "./care/surgery.ts";
import { needsSurgery, canOperate, surgeonRoll, operate } from "./care/surgery.ts";
export { runNaturalRecovery, sleepHealBlocker, healFromSleep, runNpcRecovery } from "./care/recovery.ts";
import { runNaturalRecovery, sleepHealBlocker, healFromSleep, runNpcRecovery } from "./care/recovery.ts";
import { ownCount } from "../rules/entrusted.ts";
import { onOwnLand, ownedBy } from "../rules/home.ts";
import { resist } from "../rules/damage.ts";

/**
 * 몸 상태 (기획서 4.4, 4.5): 부상 회복, 소모품, 허기, 감염. 수치는 시나리오(recovery, consumables, body)에서 온다.
 * - 사망은 상태 트랙의 fatal 단계로만 (원칙 3, 코드가 정한다). 부상 외에 허기·추위·감염도 끝까지 가면 죽는다 (12-74)
 * - 숨은 단계(감염 잠복기)는 캐릭터도 GM도 모른다. 보이는 단계가 바뀔 때만 화면에 알린다
 */

export type Change = { line: string; display: ToolDisplayEvent | null; died: boolean };

/** 상태 트랙을 steps만큼 바꾼다 (양수 = 나빠짐, 음수 = 나아짐). 바뀌지 않으면 null */
export function changeCondition(ctx: ToolContext, characterId: string, trackId: string, steps: number, by: string, cause: string): Change | null {
  const state = ctx.store.getState();
  const character = state.characters[characterId];
  if (!character || character.dead || steps === 0) return null;
  const track = trackOf(ctx.content.scenario, trackId);
  const index = Math.max(0, track.levels.findIndex((l) => l.id === character.conditions[trackId]));
  // 버팀 (12-109): 나빠지는 단계마다 레벨만큼 피한다. 치트는 그대로
  // 피로는 깨어 있은 시간에서 바로 정해지므로 버티지 않는다 (12-114)
  // 감염은 버티지 못한다 (플레이 테스트 13: 레벨의 버팀이 물림 감염을 소리 없이 막았다. 잠복은 숨은 단계라 알림도 없었다)
  // harm: 공통 규칙 13(rules/damage.ts)으로 이미 셈한 피해라 다시 버티지 않는다
  if (steps > 0 && by !== "cheat" && by !== "fatigue" && by !== "habit" && by !== "put_down" && by !== "infection" && by !== "harm") {
    const r = resist(ctx, characterId, steps);
    if (r.steps === 0) {
      const would = track.levels[Math.min(track.levels.length - 1, index + steps)]!;
      // 숨은 단계로 가는 것(잠복)은 버텨도 알리지 않는다
      const visible = shownLevel(track, would.id).id !== shownLevel(track, track.levels[index]!.id).id;
      return { line: visible ? `${r.line} (${josa(track.label, "이/가")} 나빠지지 않았다)` : "", display: null, died: false };
    }
    steps = r.steps;
  }
  const nextIndex = Math.max(0, Math.min(track.levels.length - 1, index + steps));
  if (nextIndex === index) return null;
  const from = track.levels[index]!;
  const to = track.levels[nextIndex]!;
  const isHarm = trackId === ctx.content.scenario.harm_track;
  ctx.store.append({
    type: "condition_changed",
    targetId: characterId,
    track: trackId,
    from: from.id,
    to: to.id,
    fatal: to.fatal === true,
    by,
    cause,
    day: dayOf(state.time),
    harmTrack: isHarm,
  });
  if (to.fatal && characterId === state.playerId) recordDeath(ctx, cause, null);
  // 감염으로 죽으면 그 자리에 감염체로 남는다 (12-117)
  if (to.fatal && trackId === ctx.content.scenario.body?.infection?.track) turnIntoInfected(ctx, characterId);
  // 이름 있는 인물이 죽으면 가족·친구가 듣는다 (기획서 7.10)
  if (to.fatal && characterId !== state.playerId) onPersonDeath(ctx, characterId, by);
  const shownFrom = shownLevel(track, from.id);
  const shownTo = shownLevel(track, to.id);
  if (shownFrom.id === shownTo.id) return { line: "", display: null, died: false }; // 캐릭터는 아직 모른다
  const better = nextIndex < index;
  const called = playerCalls(state, ctx.content, characterId);
  return {
    line: `${called}의 ${track.label}: ${shownFrom.label} → ${shownTo.label} (${cause}).${to.fatal && characterId === state.playerId ? DEATH_GUIDE : ""}`,
    display: better
      ? { type: "heal", targetName: called, trackLabel: track.label, fromLabel: shownFrom.label, toLabel: shownTo.label, byLabel: cause }
      : { type: "harm", targetName: called, trackLabel: track.label, severityLabel: cause, fatal: to.fatal === true, fromLabel: shownFrom.label, toLabel: shownTo.label, cause },
    died: to.fatal === true,
  };
}

export function levelIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, track.levels.findIndex((l) => l.id === state.characters[characterId]?.conditions[trackId]));
}

/** 캐릭터가 아는 단계의 위치 (숨은 단계는 그 앞의 보이는 단계로). 쓸 필요가 있는지를 이걸로 정해야 잠복기가 새지 않는다 */
export function shownIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return track.levels.indexOf(shownLevel(track, state.characters[characterId]?.conditions[trackId] ?? track.levels[0]!.id));
}

/** 무력화됐는지 (부상이 scenario.combat.incapacitated_at 이상이거나 사망). 규칙이 없으면 사망만 */
export function isIncapacitated(content: Content, c: Character): boolean {
  if (c.dead) return true;
  return harmIncapacitates(content.scenario, c);
}

/** 지금 보이는 증상의 묶음 (같은 증상을 여러 원인이 쓴다, 12-74) */
export function symptomGroupsShown(content: Content, c: Character | undefined): Set<string> {
  if (!c || !content.scenario.symptoms?.length) return new Set();
  return new Set(visibleSymptoms(content.scenario, c).map((x) => x.group ?? x.id));
}

/** 이 트랙이 띄우는 증상의 묶음 */
export function trackSymptomGroups(content: Content, trackId: string): string[] {
  const byId = new Map((content.scenario.symptoms ?? []).map((x) => [x.id, x]));
  const ids = content.scenario.condition_tracks.find((t) => t.id === trackId)?.levels.flatMap((l) => l.symptoms ?? []) ?? [];
  return [...new Set(ids.map((id) => byId.get(id)?.group ?? id))];
}

/** 이 물건을 지금 쓸 수 없는 까닭 (판정·시간 전에 본다, 플레이 테스트 11). 모닥불 연료는 보지 않는다. 쓸 수 있으면 null */
export function itemUseProblem(ctx: ToolContext, item: string, targetId?: string | null): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const player = state.characters[state.playerId]!;
  const name = content.items[item]?.name ?? item;
  // 감염: 늦추는 약(항생제)과 떼는 약(혈청, 잠복에도 듣는다) (12-106)
  const infection = content.scenario.body?.infection;
  const cure = !!infection?.cure?.includes(item);
  const slow = !!infection?.slow?.includes(item);
  const effects = content.scenario.consumables[item] ?? {};
  if (!content.scenario.consumables[item] && !cure && !slow) {
    const usable = [...new Set([...Object.keys(content.scenario.consumables), ...(infection?.slow ?? []), ...(infection?.cure ?? [])])];
    return `${josa(name, "은/는")} 써서 몸이 나아지는 물건이 아니다 (가능: ${usable.join(", ")}).`;
  }
  if ((player.inventory[item] ?? 0) < 1) return `${josa(name, "이/가")} 없다.`;
  // 구급상자·붕대는 응급처치 판정으로 쓴다 (플레이 테스트 11, A9)
  if (isFirstAidItem(content, item)) return `${josa(name, "은/는")} 응급처치로 쓴다: treatment {item: "${item}"}와 check(move: ${content.scenario.wounds!.staunch_move})를 함께 선언한다.`;
  // 다른 사람에게 쓴다 (12-52): 장면에 있는 살아 있는 사람만
  const target = targetId && targetId !== player.id ? targetId : player.id;
  if (target !== player.id && (!state.scene.present.includes(target) || state.characters[target]?.dead)) return "그 사람이 장면에 없다.";
  // 겉으로 드러난 것만 본다 (숨은 잠복기는 주인공도 모른다)
  // 혈청은 걸렸는지 몰라도 쓸 수 있다 (안 걸렸으면 버린 셈이다. 쓸 수 있느냐로 잠복이 새지 않게)
  // 기운을 올리는 것(술·진통제·각성제, 12-157)은 나아질 데가 없어도 쓴다
  const wearOff = content.scenario.body?.wear_off ?? {};
  // 증상이 같은 다른 원인(감염의 몸살 기운에 해열제)이어도 써 본다: 쓸 수 있느냐로 원인이 새지 않게 (B3, 플레이 테스트 9)
  const shown = symptomGroupsShown(content, state.characters[target]);
  const needed =
    cure ||
    Object.entries(effects).some(([t, n]) => (n > 0 && (shownIndex(ctx, state, target, t) > 0 || trackSymptomGroups(content, t).some((g) => shown.has(g)))) || (n < 0 && wearOff[t] !== undefined)) ||
    (slow && shownIndex(ctx, state, target, infection!.track) > 0);
  if (!needed) {
    // 무엇에 듣는지, 지금 앓는 것에는 무엇이 듣는지 (플레이 테스트 11: 질병에 항생제를 거절당하고 고칠 길을 몰랐다)
    const label = (t: string) => content.scenario.condition_tracks.find((x) => x.id === t)?.label ?? t;
    const forWhat = Object.entries(effects).filter(([, n]) => n > 0).map(([t]) => label(t));
    const ailing = content.scenario.condition_tracks.filter((t) => shownIndex(ctx, state, target, t.id) > 0);
    const helps = ailing
      .map((t) => {
        const items = Object.entries(content.scenario.consumables).filter(([, e]) => (e[t.id] ?? 0) > 0).map(([id]) => content.items[id]?.name ?? id);
        return items.length ? `${t.label}에는 ${items.join("·")}` : "";
      })
      .filter(Boolean);
    const why = [forWhat.length ? `${josa(name, "은/는")} ${forWhat.join("·")}에 듣는다` : "", helps.length ? `지금 앓는 것: ${helps.join(", ")}` : ""].filter(Boolean);
    return `지금은 ${josa(name, "을/를")} 쓸 필요가 없다${why.length ? ` (${why.join(". ")})` : ""}.`;
  }
  return null;
}

/** 소모품을 쓴다 (구급상자, 항생제, 통조림 등). 나아질 데가 없으면 쓰지 않는다 */
export function useItem(ctx: ToolContext, item: string, targetId?: string | null): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const player = state.characters[state.playerId]!;
  const name = content.items[item]?.name ?? item;
  // 모닥불 연료 (12-98)
  const fire = lightFire(ctx, item);
  if (fire) return fire.ok ? { ok: true, lines: fire.lines, displays: [] } : fire;
  const problem = itemUseProblem(ctx, item, targetId);
  if (problem) return { ok: false, error: problem };
  const infection = content.scenario.body?.infection;
  const cure = !!infection?.cure?.includes(item);
  const slow = !!infection?.slow?.includes(item);
  const effects = content.scenario.consumables[item] ?? {};
  const target = targetId && targetId !== player.id ? targetId : player.id;
  store.append({ type: "item_consumed", holder: player.id, itemId: item, quantity: 1 });
  // 끓이지 않은 물 (12-131): 불이 없으면 탈이 날 수 있다 (자기가 마실 때만)
  const dirty = content.items[item]?.contaminated;
  const boiled = dirty && target === player.id ? drinkDirty(ctx, dirty) : null;
  const leftover = content.items[item]?.used_into;
  if (leftover) store.append({ type: "item_granted", to: player.id, itemId: leftover, quantity: 1 });
  const lines = [target === player.id ? `${josa(name, "을/를")} 썼다.` : `${playerCalls(state, content, target)}에게 ${josa(name, "을/를")} 썼다.`];
  if (boiled) lines.push(boiled);
  const displays: ToolDisplayEvent[] = [];
  let eased = false;
  for (const [t, steps] of Object.entries(effects)) {
    const c = changeCondition(ctx, target, t, -steps, item, name);
    if (c) eased = true;
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  if (!eased && !cure && !slow && Object.values(effects).some((n) => n > 0)) lines.push("먹었지만 나아지는 것 같지 않다.");
  // 의존 (12-157): 쓸 때마다 버릇이 붙을 수 있다
  const hooked = dependOn(ctx, target, item);
  if (hooked) lines.push(hooked);
  if (infection && slow) {
    store.append({ type: "infection_slowed", targetId: target, day: dayOf(store.getState().time) + 1 });
    if (shownIndex(ctx, store.getState(), target, infection.track) > 0) lines.push("약이 듣는 하루 동안은 감염이 더디게 퍼진다.");
  }
  if (infection && cure) {
    const c = changeCondition(ctx, target, infection.track, -levelIndex(ctx, store.getState(), target, infection.track), item, name);
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  return { ok: true, lines, displays };
}

/**
 * 감염이 하루치 퍼진다 (걸려 있을 때만 부른다). 마지막 단계면 부상.
 * 늦추는 약이 듣는 동안은 하루 멈추고 하루 퍼진다: 절반 속도 (12-106)
 */
function spreadInfection(ctx: ToolContext, characterId: string, day: number): Change | null {
  const infection = ctx.content.scenario.body!.infection!;
  const state = ctx.store.getState();
  const slowed = state.recovery.slowDay[characterId] === day;
  const heldYesterday = state.recovery.heldDay[characterId] === day - 1;
  if (slowed && !heldYesterday) {
    ctx.store.append({ type: "infection_held", targetId: characterId, day });
    return null;
  }
  const track = trackOf(ctx.content.scenario, infection.track);
  if (levelIndex(ctx, state, characterId, track.id) < track.levels.length - 1) return changeCondition(ctx, characterId, track.id, 1, "infection", "감염이 퍼진다");
  return infection.worst_harm > 0 ? changeCondition(ctx, characterId, ctx.content.scenario.harm_track, infection.worst_harm, "infection", "감염") : null;
}

/** 감염체에게 다쳤을 때 감염되는지 (상처 종류별 확률, 12-106). kind가 없으면 가장 위험한 종류(물려 뜯김 같은)로 본다 */
export function maybeInfect(ctx: ToolContext, kind: string | null): Change | null {
  const infection = ctx.content.scenario.body?.infection;
  if (!infection) return null;
  const chance = kind ? (infection.chance[kind] ?? 0) : Math.max(0, ...Object.values(infection.chance));
  if (chance <= 0) return null;
  // 다친 것 자체가 격리의 근거다 (감염이 됐는지와 따로, 12-238)
  ctx.store.append({ type: "infection_exposed", characterId: ctx.store.getState().playerId });
  const state = ctx.store.getState();
  if (levelIndex(ctx, state, state.playerId, infection.track) > 0) return null;
  const me = state.characters[state.playerId];
  const factor = me ? bodyTraits(ctx.content, me).infection : 1;
  if (ctx.rng() >= Math.min(1, chance * factor)) return null;
  return changeCondition(ctx, state.playerId, infection.track, 1, "infection", "감염체에게 입은 상처");
}

/** 갇혀서 못 받은 그날 배급을 우리 거점에 닿으면 받는다 (플레이 테스트 13) */
export function runLateRation(ctx: ToolContext): ToolDisplayEvent[] {
  const { content } = ctx;
  const state = ctx.store.getState();
  const body = content.scenario.body;
  const war = content.scenario.war;
  if (state.missedRationDay === null || !body?.hunger || !war) return [];
  const me = state.characters[state.playerId];
  if (!me || me.dead) return [];
  if (state.missedRationDay !== dayOf(state.time)) {
    ctx.store.append({ type: "ration_missed", day: null });
    return [];
  }
  if (pausedWhileHeld(state, "ration") || !me.factionId || !hasAccess(content, state, "ration")) return [];
  if (!state.playerZone || !ownedBy(state, state.playerZone, me.factionId) || content.locations[state.playerZone]?.kind !== "base") return [];
  ctx.store.append({ type: "ration_missed", day: null });
  const own = state.factions[me.factionId];
  const level = own ? rationLevel(content, own) : undefined;
  const delta = level?.hunger ?? 0;
  if (delta >= 0) return [];
  const c = changeCondition(ctx, me.id, body.hunger.track, delta, "daily", `늦게 받은 그날 배급 (${level?.label ?? ""})`);
  return c?.display ? [c.display] : [];
}

/**
 * 하루가 지날 때의 몸 (전쟁 틱과 함께 하루에 한 번):
 * - 허기: 우리 무리의 배급 수준만큼 바뀐다. 마지막 단계면 굶주림으로 부상
 * - 감염: 걸려 있으면 한 단계 나빠진다. 마지막 단계면 부상
 * - 추위: 계절·날씨만큼 (거점의 불, 방한 장비가 막는다). 마지막 단계면 부상
 * - 질병: 확률로 걸리고(잠복), 드러나고, 배부르고 따뜻하면 확률로 낫고 아니면 깊어진다. 마지막 단계면 부상
 */
export function runDailyBody(ctx: ToolContext, day: number = dayOf(ctx.store.getState().time)): ToolDisplayEvent[] {
  const { content } = ctx;
  const body = content.scenario.body;
  const war = content.scenario.war;
  if (!body) return [];
  const displays: ToolDisplayEvent[] = [];
  const push = (c: Change | null) => {
    if (c?.display) displays.push(c.display);
    return c?.died ?? false;
  };
  const player = () => ctx.store.getState().characters[ctx.store.getState().playerId];
  const harm = content.scenario.harm_track;

  if (body.hunger && war) {
    const state = ctx.store.getState();
    // 배급 권한이 있어야 무리의 배급을 받는다 (역할의 access, 기획서 9.9)
    // 갇혀 있으면 우리 무리의 배급을 못 받는다 (붙잡은 쪽이 겨우 먹인다, 12-55)
    // 격리는 먹이는 쪽이 끼니를 제대로 준다 (12-238): 붙잡힌 것으로 치지 않는다
    const captive = !!heldOf(player()!) && !heldOf(player()!)!.quarantine;
    // 배급은 우리 땅에서 받는다: 자정에 우리 땅 밖이면 미루고, 그날 거점에 닿으면 받는다 (공통 규칙 11, 12-238: 성당 지하에서 밤을 보내도 배급을 먹은 셈이었다)
    const away = !captive && hasAccess(content, state, "ration") && !!player()!.factionId && !onOwnLand(state);
    const own = !captive && !away && hasAccess(content, state, "ration") ? state.factions[player()!.factionId] : undefined;
    // 쓸모 (G1): 무리의 문화가 일하지 않는 입을 줄이면, 임무를 끝내지 않은 날이 쌓인 사람의 배급이 한 단계 내려간다
    const idleRule = own ? content.factions[player()!.factionId!]?.culture?.idle_ration_days : undefined;
    const idle = !!idleRule && idleDays(state, state.playerId) >= idleRule;
    const fair = own ? rationLevel(content, own) : undefined;
    const lower = fair && idle ? war.ration.levels[war.ration.levels.indexOf(fair) + 1] : undefined;
    const level = lower ?? fair;
    const track = trackOf(content.scenario, body.hunger.track);
    let delta = level?.hunger ?? 1; // 배급을 받지 못하면 배가 고파진다
    if (delta > 0 && level?.hunger_max) {
      // 이 배급으로는 이 단계보다 더 배고파지지 않는다
      const cap = track.levels.findIndex((l) => l.id === level.hunger_max);
      delta = Math.max(0, Math.min(delta, cap - levelIndex(ctx, state, state.playerId, track.id)));
    }
    // 트레잇: 정량이 아니면 대식가는 더, 소식가는 덜 배고파진다
    const hungerTrait = bodyTraits(content, player()!).hunger;
    if (hungerTrait !== 0 && level !== war.ration.levels[0]) delta = Math.max(0, delta + hungerTrait);
    const floor = captive && content.scenario.captivity?.hunger_floor ? track.levels.findIndex((l) => l.id === content.scenario.captivity!.hunger_floor) : -1;
    if (floor >= 0 && delta > 0) delta = Math.max(0, Math.min(delta, floor - levelIndex(ctx, state, state.playerId, track.id)));
    // 바닥보다 더 굶었으면(이야기 효과 등) 붙잡은 쪽이 바닥까지는 먹인다 (12-262, PT17 졸병: 기아에서 엿새 동안 내려오지 않았다)
    if (floor >= 0 && levelIndex(ctx, state, state.playerId, track.id) > floor) delta = floor - levelIndex(ctx, state, state.playerId, track.id);
    if ((captive || away) && hasAccess(content, state, "ration")) ctx.store.append({ type: "ration_missed", day });
    if (push(changeCondition(ctx, state.playerId, body.hunger.track, delta, "daily", captive ? "갇힌 곳의 끼니" : away ? "우리 땅 밖에서 밤을 보내 배급을 못 받았다 (오늘 거점에 닿으면 받는다)" : !own ? "하루가 지나 배가 고프다" : lower ? `일하지 않아 배급이 줄었다 (${lower.label})` : delta < 0 ? `배급 (${level?.label ?? ""})` : `배급 부족 (${level?.label ?? "없음"})`))) return displays;
    // 배가 고프면 지닌 먹을 것을 하나 먹는다 (플레이 테스트 11: 날생선을 지니고 자도 아침에 굶었다). 갇혀 있으면 빼앗긴 셈이다
    if (!captive && levelIndex(ctx, ctx.store.getState(), state.playerId, track.id) > 0) {
      const inv = player()!.inventory;
      const food = Object.entries(content.scenario.consumables)
        .filter(([id, e]) => ownCount(ctx.store.getState(), state.playerId, id) > 0 && (e[track.id] ?? 0) > 0 && content.items[id]?.kind === "food" && !content.items[id]?.contaminated)
        .sort(([, a], [, b]) => (a[track.id] ?? 0) - (b[track.id] ?? 0))[0];
      if (food) {
        const ate = useItem(ctx, food[0]);
        if (ate.ok) displays.push(...ate.displays);
      }
    }
    if (levelIndex(ctx, ctx.store.getState(), state.playerId, track.id) === track.levels.length - 1 && body.hunger.starving_harm > 0) {
      if (push(changeCondition(ctx, state.playerId, harm, body.hunger.starving_harm, "daily", "굶주림"))) return displays;
    }
  }
  if (body.thirst && push(dailyThirst(ctx, body.thirst))) return displays;
  for (const c of dailyHabits(ctx)) push(c);
  if (body.infection) {
    const state = ctx.store.getState();
    const track = trackOf(content.scenario, body.infection.track);
    const index = levelIndex(ctx, state, state.playerId, track.id);
    if (index > 0 && push(spreadInfection(ctx, state.playerId, day))) return displays;
  }
  // 기온이 있는 월드는 시간대마다 냉기를 쌓는다 (climate.ts, 12-98). 하루 단위 추위는 없는 월드만
  if (body.cold && !body.cold.climate) {
    const cold = body.cold;
    const state = ctx.store.getState();
    const me = player()!;
    const delta = dailyCold(ctx, state);
    if (push(changeCondition(ctx, me.id, cold.track, delta.steps, "cold", delta.cause))) return displays;
    const track = trackOf(content.scenario, cold.track);
    if (delta.steps >= 0 && levelIndex(ctx, ctx.store.getState(), me.id, track.id) === track.levels.length - 1 && cold.worst_harm > 0) {
      if (push(changeCondition(ctx, me.id, harm, cold.worst_harm, "cold", "저체온"))) return displays;
    }
  }
  if (body.nerves) displays.push(...runDailyNerves(ctx));
  if (body.disease) {
    const disease = body.disease;
    const state = ctx.store.getState();
    const me = player()!;
    const track = trackOf(content.scenario, disease.track);
    const index = levelIndex(ctx, state, me.id, track.id);
    const vitality = me.stats[disease.resist.ability] ?? 0;
    const suffering = sufferingOf(ctx, state);
    if (index === 0) {
      let chance = disease.chance.base;
      if (suffering.starving) chance += disease.chance.starving;
      if (suffering.cold) chance += disease.chance.cold;
      if (suffering.thirst) chance += disease.chance.thirst;
      chance *= Math.max(0.1, 1 - disease.resist.per_point * vitality);
      chance *= bodyTraits(content, me).disease;
      if (ctx.rng() < chance) push(changeCondition(ctx, me.id, track.id, 1, "disease", "병에 걸렸다"));
    } else if (track.levels[index]!.hidden) {
      push(changeCondition(ctx, me.id, track.id, 1, "disease", "병이 드러났다"));
    } else {
      // 배부르고 따뜻하고, 지치지 않았으면 (12-115: 자야 낫는다)
      const resting = !suffering.starving && !suffering.cold && !fatigueBlocksRecovery(content, me);
      const recover = resting ? Math.max(0, disease.recover.chance + disease.recover.per_point * vitality + bodyTraits(content, me).diseaseRecover) : 0;
      const roll = ctx.rng();
      if (roll < recover) {
        // 나으면 숨은 단계를 건너뛰고 한 단계씩 (위중 → 앓음 → 없음)
        const steps = track.levels[index - 1]?.hidden ? -2 : -1;
        push(changeCondition(ctx, me.id, track.id, steps, "disease", "몸이 이겨 냈다"));
      } else if (index < track.levels.length - 1) {
        if (roll < recover + disease.worsen) push(changeCondition(ctx, me.id, track.id, 1, "disease", "병이 깊어진다"));
      } else if (disease.worst_harm > 0) {
        if (push(changeCondition(ctx, me.id, harm, disease.worst_harm, "disease", "병"))) return displays;
      }
    }
  }
  return displays;
}

/**
 * NPC의 하루 몸 (기획서 7.7): 감염된 인물은 하루에 한 단계 나빠지고, 마지막 단계면 부상을 입는다 (죽을 수 있다, 코드가 정한다).
 * 장면에 있는 사람의 보이는 변화만 화면에 알린다
 */
export function runDailyNpcBody(ctx: ToolContext, day: number = dayOf(ctx.store.getState().time)): ToolDisplayEvent[] {
  const infection = ctx.content.scenario.body?.infection;
  if (!infection) return [];
  const track = trackOf(ctx.content.scenario, infection.track);
  const displays: ToolDisplayEvent[] = [];
  const start = ctx.store.getState();
  for (const c of Object.values(start.characters)) {
    if (c.id === start.playerId || c.dead || c.away) continue;
    const index = Math.max(0, track.levels.findIndex((l) => l.id === c.conditions[track.id]));
    if (index === 0) continue;
    const change = spreadInfection(ctx, c.id, day);
    if (change?.display && ctx.store.getState().scene.present.includes(c.id)) displays.push(change.display);
  }
  return displays;
}

/** 지금 몸이 괴로운가 (질병에 걸리기 쉽고 낫기 어렵다): 굶주림·추위는 판정 보정이 있는 단계부터, 목마름은 무리의 물이 하루치보다 적을 때 */
/** 이 트랙 때문에 판정 보정 -2 이상을 받고 있는가 (굶주림, 오한) */
function severe(ctx: ToolContext, me: Character, trackId: string | undefined): boolean {
  if (!trackId) return false;
  const track = trackOf(ctx.content.scenario, trackId);
  return (track.levels.find((l) => l.id === me.conditions[trackId])?.penalty ?? 0) <= -2;
}

function sufferingOf(ctx: ToolContext, state: GameState): { starving: boolean; cold: boolean; thirst: boolean } {
  const s = ctx.content.scenario;
  const me = state.characters[state.playerId]!;
  const hurting = (trackId: string | undefined) => {
    if (!trackId) return false;
    const track = trackOf(s, trackId);
    return (track.levels.find((l) => l.id === me.conditions[trackId])?.penalty ?? 0) < 0;
  };
  const own = state.factions[me.factionId];
  const thirstResource = s.body?.disease?.thirst_resource;
  const thirst = s.body?.thirst;
  const parched = (() => {
    if (!thirst?.suffering_from) return false;
    const track = trackOf(s, thirst.track);
    return track.levels.findIndex((l) => l.id === me.conditions[thirst.track]) >= track.levels.findIndex((l) => l.id === thirst.suffering_from);
  })();
  return {
    starving: hurting(s.body?.hunger?.track),
    cold: hurting(s.body?.cold?.track),
    thirst: thirst ? parched : !!thirstResource && !!own && daysOfStock(ctx.content, own, thirstResource) < 1,
  };
}

type ThirstRules = NonNullable<NonNullable<Content["scenario"]["body"]>["thirst"]>;

/**
 * 지금 있는 곳의 물 (12-97).
 * - spring: 물이 나는 바깥 구역(강·우물·정수장), 또는 끓이지 않은 물을 뜰 곳(location.stream, where). 마음껏 마시고 채운다
 * - supply: 우리 거점(우리 땅이면서 거점). 무리의 물 보급을 받는다: 넉넉하면 full, 하루치도 안 남으면 limited(조금만), 바닥이거나 배급 권한이 없으면 refused
 */
export type WaterSource = { kind: "spring" | "supply"; grant: "full" | "limited" | "refused"; where?: string };

export function waterHere(content: Content, state: GameState): WaterSource | null {
  const rules = content.scenario.body?.thirst;
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!rules || !me || me.dead || heldOf(me) || !zone) return null;
  // 빗물받이 (12-167): 그 구역이 물이 나는 곳이 된다
  if (waterFacilityHere(content, state)) return { kind: "spring", grant: "full" };
  const loc = content.locations[zone];
  const base = (loc?.kind === "base" || !!loc?.water_supply) && ownedBy(state, zone, me.factionId);
  if (base) {
    const own = state.factions[me.factionId];
    if (!own || !hasAccess(content, state, "ration")) return { kind: "supply", grant: "refused" };
    const days = daysOfStock(content, own, rules.resource);
    return { kind: "supply", grant: days >= rules.min_days ? "full" : (own.resources[rules.resource] ?? 0) >= 1 ? "limited" : "refused" };
  }
  if ((content.locations[zone]?.yields[rules.resource] ?? 0) > 0) return { kind: "spring", grant: "full" };
  // 끓이지 않은 물을 뜰 곳 (12-251): 개천·빗물 고인 곳
  return loc?.stream ? { kind: "spring", grant: "full", where: loc.stream } : null;
}

type WaterResult = { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string };

function waterSource(ctx: ToolContext): { rules: ThirstRules; source: WaterSource } | { error: string } {
  const rules = ctx.content.scenario.body?.thirst;
  if (!rules) return { error: "이 월드에는 갈증 규칙이 없다." };
  const source = waterHere(ctx.content, ctx.store.getState());
  if (!source) return { error: "여기에는 물이 없다. 물병을 쓰거나(use_item) 물이 나는 곳·우리 거점으로 간다." };
  if (source.grant === "refused") return { error: "물 보급을 거절당했다: 무리의 물이 바닥났거나 받을 자격이 없다. 보급 담당 NPC가 거절하는 장면으로 서술한다." };
  return { rules, source };
}

/** 물을 마신다 (take_action.drink). 거점에서 물이 모자라면 조금만 받는다 */
export function drinkWater(ctx: ToolContext): WaterResult {
  const w = waterSource(ctx);
  if ("error" in w) return { ok: false, error: w.error };
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  if (levelIndex(ctx, state, me.id, w.rules.track) <= 0) return { ok: false, error: "목이 마르지 않다." };
  const limited = w.source.grant === "limited";
  const c = changeCondition(ctx, me.id, w.rules.track, limited ? -1 : -w.rules.drink, "drink", w.source.kind === "spring" ? "물을 떠 마셨다" : limited ? "물 보급 (아껴서 조금만)" : "물 보급");
  const lines = [c?.line ?? "물을 마셨다."];
  // 바깥의 물은 끓이지 않으면 탈이 날 수 있다 (12-131)
  if (w.source.kind === "spring" && w.rules.dirty) {
    const boiled = drinkDirty(ctx, w.rules.dirty.chance);
    if (boiled) lines.push(boiled);
  }
  if (limited) lines.push("물이 모자라 보급 담당이 한 모금만 나눠 줬다. 아끼는 기색으로 서술한다.");
  return { ok: true, lines, displays: c?.display ? [c.display] : [] };
}

/**
 * 물에 들어간다 (take_action.wade, 12-255): 개천·강가처럼 물이 나는 바깥 물가에서만. 옷이 흠뻑 젖는다 (방수복도 막지 못한다)
 * (PT15 튜토리얼: "개천에 뛰어든다"를 처리할 칸이 없었다)
 */
export function wadeIn(ctx: ToolContext): WaterResult {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  const source = waterHere(ctx.content, state);
  // 물가 장소(바다·갯가·강가)면 들어갈 수 있다 (12-261, PT16 섬: 바닷가에서 "들어갈 물이 없다")
  const shore = currentPlace(state, ctx.content)?.wade === true;
  if (!me || (!shore && (!source || source.kind !== "spring" || waterFacilityHere(ctx.content, state)))) return { ok: false, error: "여기에는 들어갈 물이 없다. 개천·강가·바닷가처럼 물에 닿는 바깥에서만 들어간다." };
  if (placeIndoor(state, ctx.content) === true) return { ok: false, error: "지붕 아래에서는 물에 들어갈 수 없다. 물가(바깥 장소)로 옮긴다." };
  const displays = soak(ctx, me.id, "물에 들어가 옷이 흠뻑 젖었다");
  return { ok: true, lines: [`${me.name}의 옷: 물에 들어가 흠뻑 젖었다${shore ? ` (${currentPlace(state, ctx.content)!.name})` : source?.where ? ` (${source.where})` : ""}.`], displays };
}

/** 빈 물병을 채운다 (take_action.refill). 거점에서는 보급을 받으며 마시기까지 한다. 물이 모자라면 하나만 */
export function refillWater(ctx: ToolContext): WaterResult {
  const w = waterSource(ctx);
  if ("error" in w) return { ok: false, error: w.error };
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const limited = w.source.grant === "limited";
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  // 물가에 왔으면 목마를 때 마시기까지 한다 (B11, 플레이 테스트 9: 물병이 차 있어 채우기가 실패하고 마시지도 않아 탈수까지 갔다)
  if (levelIndex(ctx, state, me.id, w.rules.track) > 0) {
    const d = drinkWater(ctx);
    if (d.ok) {
      lines.push(...d.lines);
      displays.push(...d.displays);
    }
  }
  let left = limited ? 1 : Infinity;
  // 바깥의 물을 불 없이 채우면 끓이지 않은 물이 된다 (12-131)
  const dirtyRefill = w.source.kind === "spring" && w.rules.dirty && !fireHere(state) ? w.rules.dirty.refill : {};
  for (const [empty, clean] of Object.entries(w.rules.refill)) {
    const full = dirtyRefill[empty] ?? clean;
    const n = Math.min(left, ctx.store.getState().characters[me.id]!.inventory[empty] ?? 0);
    if (n <= 0) continue;
    left -= n;
    ctx.store.append({ type: "item_consumed", holder: me.id, itemId: empty, quantity: n });
    ctx.store.append({ type: "item_granted", to: me.id, itemId: full, quantity: n });
    lines.push(`${ctx.content.items[empty]?.name ?? empty} ${n}개를 채웠다.`);
  }
  // 마시기와 함께 오면 앞에서 마신 것과 어긋나지 않게 (플레이 테스트 12: "물 보급" 다음 줄에 "목도 마르지 않다")
  // 차 있는 물병은 거절이 아니라 한 줄로 (플레이 테스트 13: 마시기까지 함께 막혔다)
  const fullOne = Object.values(w.rules.refill).find((full) => (ctx.store.getState().characters[me.id]!.inventory[full] ?? 0) > 0);
  if (!lines.some((l) => l.includes("채웠다")) && fullOne) lines.push(`${josa(ctx.content.items[fullOne]?.name ?? fullOne, "은/는")} 이미 차 있다.`);
  if (!lines.length) return { ok: false, error: "채울 빈 그릇이 없다." };
  if (limited && lines.some((l) => l.includes("채웠다"))) lines.push("물이 모자라 보급 담당이 하나만 채워 줬다.");
  return { ok: true, lines, displays };
}

/** 하루의 갈증 (12-97). 끝 단계(fatal)에 이르면 changeCondition이 죽음을 처리한다 */
function dailyThirst(ctx: ToolContext, rules: ThirstRules): Change | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const track = trackOf(ctx.content.scenario, rules.track);
  let delta = rules.daily;
  if (heldOf(me) && rules.captive_max) delta = Math.max(0, Math.min(delta, track.levels.findIndex((l) => l.id === rules.captive_max) - levelIndex(ctx, state, me.id, track.id)));
  return changeCondition(ctx, me.id, track.id, delta, "daily", heldOf(me) ? "갇힌 곳의 물" : "하루가 지나 목이 마르다");
}

/**
 * 버릇 (12-129): 골초는 하루에 한 갑을 저절로 피운다. 피우면 그 트랙이 풀리고, 가진 게 없으면 한 단계 오른다.
 * 참는 일이라 버팀(레벨)으로 피하지 않는다
 */
function dailyHabits(ctx: ToolContext): Change[] {
  const changes: Change[] = [];
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return changes;
  for (const h of habitsOf(ctx.content, me)) {
    const now = ctx.store.getState().characters[me.id]!;
    // 남의 물건(맡은 담배)은 저절로 피우지 않는다 (공통 규칙 10)
    const item = h.items.find((i) => (now.inventory[i] ?? 0) > 0 && ownCount(ctx.store.getState(), me.id, i) > 0);
    let c: Change | null;
    if (item) {
      ctx.store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: 1 });
      c = changeCondition(ctx, me.id, h.track, -levelIndex(ctx, ctx.store.getState(), me.id, h.track), "habit", `${ctx.content.items[item]?.name ?? item} (${h.trait.label})`);
    } else {
      // 끊기 (12-157): 가장 괴로운 단계를 quit_days 동안 견디면 버릇이 떨어진다
      const quit = quitHabit(ctx, me.id, h);
      c = quit ?? changeCondition(ctx, me.id, h.track, 1, "habit", `${josa(h.items.map((i) => ctx.content.items[i]?.name ?? i).join("·"), "이/가")} 떨어졌다 (${h.trait.label})`);
    }
    if (c) changes.push(c);
  }
  return changes;
}

/** 버릇의 트랙이 마지막 단계에 quit_days 넘게 머물렀으면 트레잇을 빼고 트랙을 처음으로 */
function quitHabit(ctx: ToolContext, characterId: string, h: ReturnType<typeof habitsOf>[number]): Change | null {
  if (!h.quit_days) return null;
  const state = ctx.store.getState();
  const track = trackOf(ctx.content.scenario, h.track);
  const index = levelIndex(ctx, state, characterId, h.track);
  if (index < track.levels.length - 1) return null;
  const since = state.recovery.trackAt[`${characterId}:${h.track}`];
  if (since === undefined || dayOf(state.time) - dayOf(since) < h.quit_days) return null;
  const c = state.characters[characterId]!;
  ctx.store.append({ type: "character_patched", characterId, traits: traitIdsOf(ctx.content, c).filter((t) => t !== h.trait.id) });
  changeCondition(ctx, characterId, h.track, -index, "habit", `${josa(h.trait.label, "을/를")} 끊었다`);
  return { line: `${h.trait.label}: 고비를 넘겼다. 더는 ${josa(h.items.map((i) => ctx.content.items[i]?.name ?? i).join("·"), "을/를")} 찾지 않는다.`, display: null, died: false };
}

/** 의존 (12-157): 이 아이템을 쓴 사람에게 chance로 버릇 트레잇이 붙는다. 붙으면 알릴 줄 */
function dependOn(ctx: ToolContext, characterId: string, item: string): string | null {
  const d = ctx.content.scenario.body?.dependence?.[item];
  const c = ctx.store.getState().characters[characterId];
  if (!d || !c || c.dead) return null;
  const have = traitIdsOf(ctx.content, c);
  if (have.includes(d.trait) || ctx.rng() >= d.chance) return null;
  const def = ctx.content.scenario.traits.find((t) => t.id === d.trait);
  if (!def) return null;
  ctx.store.append({ type: "character_patched", characterId, traits: [...have, d.trait] });
  const who = playerCalls(ctx.store.getState(), ctx.content, characterId);
  return characterId === ctx.store.getState().playerId
    ? `몸이 이것을 다시 찾기 시작했다: ${def.label} (${def.description}).`
    : `${josa(who, "이/가")} 이것에 기대기 시작했다: ${def.label}.`;
}

/**
 * 기운이 빠진다 (12-157): body.wear_off의 트랙은 마지막으로 바뀐 뒤 그 시간마다 한 단계 내려간다.
 * 살아 있는 모든 사람 (진통제를 맞은 동료도 깬다)
 */
export function runWearOff(ctx: ToolContext): ToolDisplayEvent[] {
  const wear = ctx.content.scenario.body?.wear_off ?? {};
  const displays: ToolDisplayEvent[] = [];
  if (!Object.keys(wear).length) return displays;
  const state = ctx.store.getState();
  for (const c of Object.values(state.characters)) {
    if (c.dead) continue;
    for (const [trackId, hours] of Object.entries(wear)) {
      const index = levelIndex(ctx, ctx.store.getState(), c.id, trackId);
      if (index <= 0) continue;
      const since = ctx.store.getState().recovery.trackAt[`${c.id}:${trackId}`] ?? state.time;
      const times = Math.min(index, Math.floor((state.time - since) / (hours * 60)));
      if (times <= 0) continue;
      const ch = changeCondition(ctx, c.id, trackId, -times, "wear_off", "기운이 빠졌다");
      if (ch?.display && c.id === state.playerId) displays.push(ch.display);
    }
  }
  return displays;
}

/** 우리 거점에서 무리의 연료로 몸을 녹일 수 있는가 */
export function sheltered(ctx: ToolContext, state: GameState): boolean {
  const cold = ctx.content.scenario.body?.cold;
  const me = state.characters[state.playerId];
  if (!cold || !me || !state.playerZone) return false;
  if (!ownedBy(state, state.playerZone, me.factionId)) return false;
  const own = state.factions[me.factionId];
  return !!own && daysOfStock(ctx.content, own, cold.shelter.resource) >= cold.shelter.min_days;
}

/** 오늘의 추위: 양수면 그만큼 추워지고, 음수면 몸이 녹는다 */
export function dailyCold(ctx: ToolContext, state: GameState): { steps: number; cause: string } {
  const s = ctx.content.scenario;
  const cold = s.body!.cold!;
  if (sheltered(ctx, state)) return { steps: cold.shelter.warm, cause: "불을 땐 거처" };
  const season = seasonAt(s, state.time);
  const weather = weatherNow(s, state);
  const exposure = (season ? (cold.season[season.id] ?? 0) : 0) + (weather ? (cold.weather[weather.id] ?? 0) : 0);
  const me = state.characters[state.playerId]!;
  const gear = Object.entries(cold.gear).reduce((n, [item, amount]) => n + ((me.inventory[item] ?? 0) > 0 ? amount : 0), 0);
  // 트레잇: 추운 날에만 더하거나 덜한다 (추위를 탐 +1, 추위에 강함 -1)
  const steps = Math.max(0, exposure - gear + (exposure > 0 ? bodyTraits(ctx.content, me).cold : 0));
  if (steps === 0) return { steps: -1, cause: exposure > 0 ? "방한 장비" : "견딜 만한 날씨" };
  return { steps, cause: [season && cold.season[season.id] ? season.label : null, weather && cold.weather[weather.id] ? weather.label : null].filter(Boolean).join(", ") + "의 추위" };
}

export type Steady = { steps: number; outcome: CheckOutcome | null; displays: ToolDisplayEvent[] };

/**
 * 마음 다잡기 (12-220): 마음·공포가 steps단계 오를 때 주인공이 굴린다 (body.steady).
 * 성공이면 0, 대가 있는 성공이면 한 단계 덜 (적어도 한 단계), 실패면 그대로. 판정 줄(🎲)은 displays로 돌려준다
 */
export function steadyRoll(ctx: ToolContext, steps: number, cause: string): Steady {
  const rule = ctx.content.scenario.body?.steady;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  // 정신을 잃었으면 다잡을 수 없다 (굴리지 않는다)
  if (!rule || !me || me.dead || steps <= 0 || incapacitatingSymptom(ctx.content.scenario, me)) return { steps, outcome: null, displays: [] };
  const roll = rollPlayerCheck({ move: rule.move, stat: rule.stat, difficulty: "normal", intent: `마음을 다잡는다 (${cause})` }, ctx, { reaction: true, purpose: "reaction" });
  if (!roll.ok) return { steps, outcome: null, displays: [] };
  const left = roll.outcome === "success" ? 0 : roll.outcome === "partial" ? Math.max(1, steps - 1) : steps;
  return { steps: left, outcome: roll.outcome, displays: [roll.display] };
}

export type Shaken = { lines: string[]; displays: ToolDisplayEvent[] };

/**
 * 마음이 흔들린다 (12-48): 크게 다쳤거나 곁의 사람이 죽는 것을 봤을 때. 마음 다잡기 판정으로 버틴다 (12-220).
 * 판정 줄과 바뀐 한 줄을 돌려준다 (GM이 서술에 반영한다). roll: false면 굴리지 않고 그대로 오른다 (공포 판정이 이미 실패했을 때)
 */
export function shakeNerves(ctx: ToolContext, steps: number, cause: string, roll = true): Shaken {
  const nerves = ctx.content.scenario.body?.nerves;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !me || me.dead || steps <= 0) return { lines: [], displays: [] };
  // 이미 끝 단계면 더 흔들릴 데가 없다 (굴리지 않는다)
  if (levelIndex(ctx, state, me.id, nerves.track) >= trackOf(ctx.content.scenario, nerves.track).levels.length - 1) return { lines: [], displays: [] };
  const held = roll ? steadyRoll(ctx, steps, cause) : { steps, outcome: null, displays: [] };
  const out: Shaken = { lines: [], displays: [...held.displays] };
  if (held.steps <= 0) {
    out.lines.push(`${josa(me.name, "은/는")} 마음을 다잡았다 (${cause}). 마음이 흔들리지 않았다.`);
    return out;
  }
  const c = changeCondition(ctx, me.id, nerves.track, held.steps, "nerves", cause);
  if (c?.line) out.lines.push(c.line);
  if (c?.display) out.displays.push(c.display);
  return out;
}

/**
 * 하루마다 마음이 가라앉는다: 굶주리거나 얼지 않으면 확률로, 우리 땅이거나 곁에 사람이 있으면 더 잘 (떠돌이도 천천히 낫는다).
 * 막는 것은 굶주림·오한(보정 -2) 이상만이다. 허기짐·몸살 기운(-1)으로는 막지 않는다
 */
export function runDailyNerves(ctx: ToolContext): ToolDisplayEvent[] {
  const nerves = ctx.content.scenario.body?.nerves;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !me || me.dead) return [];
  if (levelIndex(ctx, state, me.id, nerves.track) <= 0) return [];
  if (severe(ctx, me, ctx.content.scenario.body?.hunger?.track) || severe(ctx, me, ctx.content.scenario.body?.cold?.track)) return [];
  const { mine, company } = safety(state, me);
  const chance = nerves.recover.chance + nerves.recover.per_point * steadyStat(ctx, me) + (mine || company ? nerves.recover.safe : 0);
  if (ctx.rng() >= chance) return [];
  const c = changeCondition(ctx, me.id, nerves.track, -1, "nerves", mine ? "익숙한 담 안에서 하루를 보냈다" : company ? "곁에 사람이 있었다" : "하루를 버텨 냈다");
  return c?.display ? [c.display] : [];
}

/** 마음 다잡기 능력의 값 (냉정). 마음이 가라앉는 확률에 더한다 */
function steadyStat(ctx: ToolContext, me: Character): number {
  const stat = ctx.content.scenario.body?.steady?.stat;
  return stat ? (me.stats[stat] ?? 0) : 0;
}

/** 마음이 쉬는 곳: 우리 땅이거나 곁에 동행이 있다 */
function safety(state: GameState, me: Character): { mine: boolean; company: boolean } {
  return {
    mine: !!state.playerZone && !!me.factionId && ownedBy(state, state.playerZone, me.factionId),
    company: state.companions.length > 0,
  };
}

/**
 * 푹 자고 나면 마음이 가라앉을 기회 (body.nerves.sleep). take_action이 끊기지 않은 잠 뒤에 부른다.
 * slept: 실제로 잔 분. min_hours보다 짧으면 없다
 */
export function sleepNerves(ctx: ToolContext, slept: number): Change | null {
  const nerves = ctx.content.scenario.body?.nerves;
  const rule = nerves?.sleep;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !rule || !me || me.dead || slept < rule.min_hours * 60) return null;
  if (levelIndex(ctx, state, me.id, nerves.track) <= 0) return null;
  // 가라앉지 않았으면 까닭을 한 줄 (12-251, 플레이 테스트 14: 잠 결과에 마음이 왜 그대로인지 보이지 않았다)
  const level = me.conditions[nerves.track];
  const stay = (why: string): Change => ({ line: `마음: 그대로 (${why})`, display: null, died: false });
  if (severe(ctx, me, ctx.content.scenario.body?.hunger?.track)) return stay("굶주려 푹 쉬지 못했다");
  if (severe(ctx, me, ctx.content.scenario.body?.cold?.track)) return stay("추위에 떨어 푹 쉬지 못했다");
  const { mine, company } = safety(state, me);
  const sure = !!level && rule.sure.includes(level);
  const chance = (mine || company ? rule.safe : rule.unsafe) + nerves.recover.per_point * steadyStat(ctx, me);
  if (!sure && ctx.rng() >= chance) return stay(mine || company ? "푹 잤지만 마음이 아직 가라앉지 않았다" : "낯선 곳에서 혼자 자 마음이 아직 가라앉지 않았다");
  return changeCondition(ctx, me.id, nerves.track, -1, "nerves", mine ? "익숙한 담 안에서 푹 잤다" : company ? "곁에 사람을 두고 푹 잤다" : "모처럼 푹 잤다");
}
