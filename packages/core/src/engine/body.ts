import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { idleDays } from "../game/missions.ts";
import { baseOf } from "./captivity.ts";
import { itemResource } from "./market.ts";
import { DEFAULT_VALUE } from "./gear.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { waterFacilityHere } from "./facilities.ts";
import { drinkDirty, fireHere } from "./forage.ts";
import { resistSteps } from "./growth.ts";
import { policyEffects } from "../sim/war.ts";
import { turnIntoInfected } from "./turning.ts";
import { fatigueBlocksRecovery } from "./fatigue.ts";
import { onPersonDeath } from "./people.ts";
import { lightFire } from "./climate.ts";
import { hasAccess } from "../game/culture.ts";
import type { GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { bodyTraits, canUseSkill, effectiveSkill, habitsOf, traitIdsOf } from "./traits.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { harmTrack, incapacitatingSymptom, shownLevel, trackOf, visibleSymptoms } from "../scenario/scenario.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { josa } from "../text.ts";
import { recordDeath } from "./succession.ts";
import { bleedingBlocksRecovery, staunch, stopBleeding } from "./bleeding.ts";
import { CHECK_OUTCOME_LABELS, roll2d6, type CheckOutcome } from "../rules/check.ts";
import { scarFromHarm } from "./scars.ts";
import { rollPlayerCheck } from "./checks.ts";
import { DEATH_GUIDE, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 몸 상태 (기획서 4.4, 4.5): 부상 회복, 소모품, 허기, 감염. 수치는 시나리오(recovery, consumables, body)에서 온다.
 * - 사망은 상태 트랙의 fatal 단계로만 (원칙 3, 코드가 정한다). 부상 외에 허기·추위·감염도 끝까지 가면 죽는다 (12-74)
 * - 숨은 단계(감염 잠복기)는 캐릭터도 GM도 모른다. 보이는 단계가 바뀔 때만 화면에 알린다
 */

type Change = { line: string; display: ToolDisplayEvent | null; died: boolean };

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
  if (steps > 0 && by !== "cheat" && by !== "fatigue" && by !== "habit" && by !== "put_down" && by !== "infection") {
    const kept = resistSteps(ctx.content.scenario, character.level ?? 1, steps, ctx.rng);
    if (kept === 0) {
      const would = track.levels[Math.min(track.levels.length - 1, index + steps)]!;
      // 숨은 단계로 가는 것(잠복)은 버텨도 알리지 않는다
      const visible = shownLevel(track, would.id).id !== shownLevel(track, track.levels[index]!.id).id;
      return { line: visible ? `${josa(playerCalls(state, ctx.content, characterId), "은/는")} 버텨 냈다 (${josa(track.label, "이/가")} 나빠지지 않았다).` : "", display: null, died: false };
    }
    steps = kept;
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

function levelIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, track.levels.findIndex((l) => l.id === state.characters[characterId]?.conditions[trackId]));
}

/** 캐릭터가 아는 단계의 위치 (숨은 단계는 그 앞의 보이는 단계로). 쓸 필요가 있는지를 이걸로 정해야 잠복기가 새지 않는다 */
function shownIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return track.levels.indexOf(shownLevel(track, state.characters[characterId]?.conditions[trackId] ?? track.levels[0]!.id));
}

/** 무력화됐는지 (부상이 scenario.combat.incapacitated_at 이상이거나 사망). 규칙이 없으면 사망만 */
export function isIncapacitated(content: Content, c: Character): boolean {
  if (c.dead) return true;
  const at = content.scenario.combat?.incapacitated_at;
  if (!at) return false;
  const track = harmTrack(content.scenario);
  return track.levels.findIndex((l) => l.id === c.conditions[track.id]) >= track.levels.findIndex((l) => l.id === at);
}

/** 지금 보이는 증상의 묶음 (같은 증상을 여러 원인이 쓴다, 12-74) */
function symptomGroupsShown(content: Content, c: Character | undefined): Set<string> {
  if (!c || !content.scenario.symptoms?.length) return new Set();
  return new Set(visibleSymptoms(content.scenario, c).map((x) => x.group ?? x.id));
}

/** 이 트랙이 띄우는 증상의 묶음 */
function trackSymptomGroups(content: Content, trackId: string): string[] {
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

/**
 * 치료사에게 자기 치료를 받을 수 없는 까닭 (물건 없이, 판정·시간 전에 본다, 플레이 테스트 11). 받을 수 있으면 null.
 * 피가 나는데 치료사가 없으면 맨손 지혈로 넘어가므로 막지 않는다
 */
export function selfTreatmentProblem(ctx: ToolContext, patientId?: string, pay: FeeChoice = "default"): string | null {
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return "이 시나리오에는 치료 규칙이 없다.";
  const state = ctx.store.getState();
  // 치료사가 돌보는 사람: 주인공, 또는 장면의 다른 사람 (플레이 테스트 12: 분대원·동행을 치료사에게 보일 수 없었다)
  const player = state.characters[patientId ?? state.playerId]!;
  const other = player.id !== state.playerId;
  const who = other ? `${playerCalls(state, ctx.content, player.id)}의 ` : "";
  const healer = state.scene.present.find((id) => ctx.content.npcs[id]?.healer && id !== player.id);
  if (!healer) {
    const w = ctx.content.scenario.wounds;
    if (w && levelIndex(ctx, state, player.id, w.track) > 0) return null;
    // 이 구역의 치료사를 알려 준다 (플레이 테스트 11: 간호조무사·약사에게 청하다 누가 치료사인지 몰랐다)
    const here = Object.values(ctx.content.npcs).filter((n) => n.healer && !state.characters[n.id]?.dead && !heldOf(state.characters[n.id]) && npcZoneAt(n, state.time) === state.playerZone);
    return `치료해 줄 사람이 장면에 없다 (장면의 치료사만 치료한다).${here.length ? ` 이 구역의 치료사: ${here.map((n) => `${playerCalls(state, ctx.content, n.id)} (${n.id})`).join(", ")} (npc_presence로 들인다).` : " 이 구역에는 치료사가 없다."} 치료 아이템을 쓰거나 치료사를 찾아간다.`;
  }
  const needed = Object.entries(recovery.healer).some(([t, steps]) => steps > 0 && shownIndex(ctx, state, player.id, t) > 0);
  if (!needed && !symptomGroupsShown(ctx.content, player).size) return `${who}다친 데가 없어 치료할 것이 없다.`;
  // 오늘 이미 치료받았어도 새로 난 피는 멎게 한다 (플레이 테스트 12: 하루 한 번 제한이 새 출혈까지 막았다)
  const bleedTrack = ctx.content.scenario.wounds?.track;
  const freshBleed = !!bleedTrack && shownIndex(ctx, state, player.id, bleedTrack) > 0;
  if (needed && !freshBleed && state.recovery.lastHealerDay[player.id] === dayOf(state.time)) return `${other ? `${josa(playerCalls(state, ctx.content, player.id), "은/는")} ` : ""}오늘은 이미 치료를 받았다. 내일 다시 받을 수 있다.`;
  if (needed) {
    const planned = planHealerPay(ctx, healer, pay);
    if (!planned.ok) return planned.error;
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

/** 치료사에게 치료받는다 (하루 한 번). 아이템이면 useItem */
export function applyTreatment(
  ctx: ToolContext,
  item: string | null,
  targetId: string | null = null,
  check: { move: string; outcome: CheckOutcome } | null = null,
  pay: FeeChoice = "default",
): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  // 응급처치 (플레이 테스트 11, A9): 물건으로든 맨손으로든, 자기든 남이든 판정 하나로 정한다. 장면의 치료사에게 받는 치료만 따로
  const me0 = ctx.store.getState();
  const patient = targetId && targetId !== me0.playerId ? targetId : me0.playerId;
  const healerHere = me0.scene.present.some((id) => ctx.content.npcs[id]?.healer && id !== patient);
  // 치료사가 장면에 있고 판정을 걸지 않았으면 치료사가 돌본다 (남이면 그 사람을). 물건을 쓰거나 판정을 걸면 주인공의 응급처치
  if (item || !healerHere || (patient !== me0.playerId && check)) return firstAidCheck(ctx, item, patient, check);
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return { ok: false, error: "이 시나리오에는 치료 규칙이 없다." };
  const state = ctx.store.getState();
  const player = state.characters[patient]!;
  const healer = state.scene.present.find((id) => ctx.content.npcs[id]?.healer && id !== patient);
  const problem = selfTreatmentProblem(ctx, patient);
  if (problem) return { ok: false, error: problem };
  if (!healer) return { ok: false, error: "치료해 줄 사람이 장면에 없다." };
  const needed = Object.entries(recovery.healer).some(([t, steps]) => steps > 0 && shownIndex(ctx, state, player.id, t) > 0);
  // 증상은 있는데 치료사가 손쓸 것이 아니면 (감염의 열 등): 살펴보고 돌려보낸다. "다친 데가 없다"로 원인이 새지 않게 (B3)
  if (!needed) return { ok: true, lines: [`${josa(playerCalls(state, ctx.content, healer), "이/가")} 살펴봤지만 지금 손쓸 데는 없다고 한다. 잘 먹고 따뜻하게 쉬라고 한다.`], displays: [] };
  const name = playerCalls(state, ctx.content, healer);
  const paid = payHealer(ctx, healer, pay);
  if (!paid.ok) return paid;
  const lines = [patient === state.playerId ? `${name}에게 치료를 받았다.` : `${josa(name, "이/가")} ${josa(playerCalls(state, ctx.content, patient), "을/를")} 치료했다.`, ...paid.lines];
  const displays: ToolDisplayEvent[] = [];
  // 수술 (12-159): 치명상 이상이면 치료사의 솜씨와 장소로 코드가 굴린다. 수술을 배우지 않은 치료사는 상처는 손대지 못한다 (피·병만 본다)
  // 오늘 이미 치료받았으면 피만 멎게 한다 (수술·상처는 내일)
  const again = state.recovery.lastHealerDay[player.id] === dayOf(state.time);
  const cutting = !again && needsSurgery(ctx, player.id);
  const canCut = cutting && canOperate(ctx, healer);
  const surgery = canCut ? surgeonRoll(ctx, healer) : null;
  if (surgery) lines.push(surgery.line);
  if (cutting && !canCut) lines.push(`${josa(name, "은/는")} 수술을 할 줄 몰라 상처는 손대지 못했다. 수술할 줄 아는 사람을 찾아야 한다.`);
  for (const [t, steps] of Object.entries(recovery.healer)) {
    if (again && t !== ctx.content.scenario.wounds?.track) continue;
    if (cutting && !canCut && t === ctx.content.scenario.harm_track) continue;
    if (surgery && t === ctx.content.scenario.harm_track) {
      // 치료사 무리의 땅(거점·진료소)에서 받는 수술은 실패해도 덧나지 않는다
      const homeGround = !!state.characters[healer]?.factionId && !!state.playerZone && state.zones[state.playerZone]?.owner === state.characters[healer]!.factionId;
      const r = operate(ctx, player.id, surgery.outcome, name, homeGround);
      lines.push(...r.lines);
      displays.push(...r.displays);
      continue;
    }
    const c = changeCondition(ctx, player.id, t, -steps, "healer", "치료");
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  return { ok: true, lines, displays };
}

/** 치료 값을 무엇으로 낼지 (플레이 테스트 13): null이면 미리 보여 주고 묻는다, default면 코드가 고른 것, 아니면 고른 물건 */
export type FeeChoice = "default" | Record<string, number> | null;

type HealerPay = { carried: { holder: string; item: string } | null; fromStock: string | null; pay: Map<string, number> };

/** 치료의 재료와 값을 정한다 (아직 쓰지 않는다). 못 하면 error */
function planHealerPay(ctx: ToolContext, healerId: string, choice: FeeChoice = "default"): { ok: true; plan: HealerPay | null } | { ok: false; error: string } {
  const cost = ctx.content.scenario.recovery?.healer_cost;
  if (!cost) return { ok: true, plan: null };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const healer = state.characters[healerId]!;
  const name = playerCalls(state, ctx.content, healerId);
  const faction = healer.factionId ? state.factions[healer.factionId] : undefined;
  const label = ctx.content.scenario.resources.find((r) => r.id === cost.resource)?.label ?? cost.resource;
  // 거점 밖에서는 창고가 아니라 지닌 약을 쓴다: 치료사 본인 먼저, 그다음 곁의 같은 무리 사람 (값싼 것부터)
  const atBase = !!healer.factionId && state.playerZone === baseOf(ctx.content, healer.factionId);
  let carried: HealerPay["carried"] = null;
  if (!atBase) {
    const holders = [healerId, ...state.scene.present.filter((id) => id !== healerId && id !== player.id && !!healer.factionId && state.characters[id]?.factionId === healer.factionId && !state.characters[id]?.dead)];
    for (const holder of holders) {
      const inv = state.characters[holder]?.inventory ?? {};
      const item = Object.keys(inv)
        .filter((id) => (inv[id] ?? 0) > 0 && itemResource(ctx.content, id) === cost.resource)
        .sort((a, b) => (ctx.content.items[a]?.value ?? DEFAULT_VALUE) - (ctx.content.items[b]?.value ?? DEFAULT_VALUE))[0];
      if (item) {
        carried = { holder, item };
        break;
      }
    }
    if (!carried) return { ok: false, error: `${josa(name, "은/는")} 거점 밖에서 쓸 ${josa(label, "이/가")} 없어 치료하지 못한다 (치료사와 곁의 동료가 지닌 것을 쓴다).` };
  } else if (faction && (faction.resources[cost.resource] ?? 0) < 1) return { ok: false, error: `${name}의 무리 창고에 ${josa(label, "이/가")} 바닥나 치료하지 못한다.` };
  let pay = new Map<string, number>();
  const trust = state.relations[healerId]?.[player.id]?.trust ?? 0;
  // 갇힌 포로는 값을 낼 처지가 아니다: 붙잡은 쪽이 거둬 치료한다 (플레이 테스트 12: 포로의 마지막 물병까지 가져갔다)
  if (cost.fee > 0 && !heldOf(player) && player.factionId !== healer.factionId && trust < cost.free_trust) {
    const picked = pickFee(ctx, player, cost.fee);
    const list = (m: Map<string, number>) => [...m].map(([id, q]) => `${ctx.content.items[id]?.name ?? id}(${id}) ×${q}`).join(", ");
    if (choice && choice !== "default") {
      // 플레이어가 고른 물건 (플레이 테스트 13: 담요·물병을 묻지도 않고 가져갔다)
      const chosen = new Map(Object.entries(choice).filter(([, q]) => q > 0));
      const bad = [...chosen].find(([id, q]) => q > payableCount(ctx, player, id));
      if (bad) return { ok: false, error: `${ctx.content.items[bad[0]]?.name ?? bad[0]} ×${bad[1]}은 낼 수 없다 (지니지 않았거나, 손에 들었거나 입었거나, 빌린 것이다). 시간은 흐르지 않았다.` };
      const sum = [...chosen].reduce((n, [id, q]) => n + (ctx.content.items[id]?.value ?? DEFAULT_VALUE) * q, 0);
      if (sum < cost.fee) return { ok: false, error: `고른 물건의 값이 ${sum}이라 모자란다 (${cost.fee}어치를 받는다). 시간은 흐르지 않았다.` };
      pay = chosen;
    } else {
      if (!picked) return { ok: false, error: `${josa(name, "은/는")} 다른 무리 사람에게는 값(${cost.fee}어치)을 받는다. 낼 만한 물건이 모자란다 (신뢰가 ${cost.free_trust} 이상이면 받지 않는다).` };
      // 미리 보여 주고 묻는다: 그대로 내거나 바꾼다
      if (choice === null) return { ok: false, error: `${josa(name, "은/는")} 값 ${cost.fee}어치를 받는다. 정해 둔 것: ${list(picked)}. 이대로 내려면 treatment.pay: "auto", 다른 것으로 내려면 treatment.pay: [{item, quantity}] (값의 합이 ${cost.fee} 이상, 손에 든 것·입은 것·빌린 것은 못 낸다). 플레이어에게 무엇을 낼지 물어본다 (시간은 흐르지 않았다).` };
      pay = picked;
    }
  }
  return { ok: true, plan: { carried, fromStock: atBase && faction ? healer.factionId : null, pay } };
}

/** 값으로 고르지 않는 살림 (플레이 테스트 13): 쉴 때 덮는 것, 물그릇, 손에 든 무기의 탄약 */
function keptForLiving(ctx: ToolContext, payer: Character, id: string): boolean {
  const item = ctx.content.items[id];
  if (item?.warmth?.when === "resting") return true;
  const refill = ctx.content.scenario.body?.thirst?.refill ?? {};
  if (id in refill || Object.values(refill).includes(id)) return true;
  const held = Object.values(payer.equipped ?? {}).map((x) => (x ? ctx.content.items[x]?.weapon?.ammo : undefined));
  return held.includes(id);
}

/** 이 물건을 값으로 낼 수 있는 수 (플레이어가 고를 때): 지닌 것에서 손에 든 것·입은 것·빌린 것을 뺀다 */
function payableCount(ctx: ToolContext, payer: Character, id: string): number {
  if (Object.values(payer.equipped ?? {}).includes(id)) return 0;
  let loaned = 0;
  for (const loan of Object.values(ctx.store.getState().loans ?? {})) loaned += loan[id] ?? 0;
  return Math.max(0, (payer.inventory[id] ?? 0) - loaned);
}

/**
 * 물건으로 내는 값 (치료사·가르침): 지닌 물건 중 값싼 것부터 fee어치까지. 모자라면 null
 * 손에 든 것·입은 것, 신표(keepsake: 완장·통행패)는 내지 않고, 먹고 마시는 소모품은 하나씩 남긴다 (플레이 테스트 12)
 */
export function pickFee(ctx: ToolContext, payer: Character, fee: number): Map<string, number> | null {
  const pay = new Map<string, number>();
  const worn = new Set(Object.values(payer.equipped ?? {}).filter(Boolean));
  // 먹고 마시고 쓰는 소모품(consumables)은 마지막 하나를 남긴다: 값 때문에 굶거나 목마르지 않게
  const survival = (id: string) => Object.values(ctx.content.scenario.consumables[id] ?? {}).some((n) => n > 0);
  // 무기고에서 빌린 것은 내 것이 아니다 (플레이 테스트 13: 빌린 탄이 치료 값으로 나갔다)
  const loaned: Record<string, number> = {};
  for (const loan of Object.values(ctx.store.getState().loans ?? {})) for (const [id, q] of Object.entries(loan)) loaned[id] = (loaned[id] ?? 0) + q;
  const goods = Object.entries(payer.inventory)
    .map(([id, q]) => [id, payer.id === ctx.store.getState().playerId ? q - (loaned[id] ?? 0) : q] as const)
    .filter(([id, q]) => q > 0 && !worn.has(id) && !ctx.content.items[id]?.keepsake && !keptForLiving(ctx, payer, id))
    .flatMap(([id, q]) => Array.from({ length: survival(id) ? q - 1 : q }, () => id))
    .sort((a, b) => (ctx.content.items[a]?.value ?? DEFAULT_VALUE) - (ctx.content.items[b]?.value ?? DEFAULT_VALUE));
  let sum = 0;
  for (const id of goods) {
    if (sum >= fee) break;
    pay.set(id, (pay.get(id) ?? 0) + 1);
    sum += ctx.content.items[id]?.value ?? DEFAULT_VALUE;
  }
  return sum >= fee ? pay : null;
}

/**
 * 치료사의 재료와 값 (플레이 테스트 11, recovery.healer_cost): 거점에서는 치료사 무리의 창고에서, 거점 밖에서는 치료사·곁의 동료가 지닌 약에서 1을 쓰고,
 * 다른 무리·무소속이면 (치료사의 신뢰가 모자라면) 지닌 물건에서 값을 받는다. 무엇을 내는지는 코드가 고른다 (값싼 것부터, 손에 든 것·입은 것은 빼고)
 */
function payHealer(ctx: ToolContext, healerId: string, choice: FeeChoice = "default"): { ok: true; lines: string[] } | { ok: false; error: string } {
  const planned = planHealerPay(ctx, healerId, choice);
  if (!planned.ok) return planned;
  const plan = planned.plan;
  if (!plan) return { ok: true, lines: [] };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const lines: string[] = [];
  for (const [id, q] of plan.pay) ctx.store.append({ type: "item_transferred", from: player.id, to: healerId, itemId: id, quantity: q });
  if (plan.pay.size) lines.push(`치료 값으로 ${[...plan.pay].map(([id, q]) => `${ctx.content.items[id]?.name ?? id} ×${q}`).join(", ")}을 냈다.`);
  const resource = ctx.content.scenario.recovery!.healer_cost!.resource;
  if (plan.carried) {
    ctx.store.append({ type: "item_consumed", holder: plan.carried.holder, itemId: plan.carried.item, quantity: 1 });
    lines.push(`${playerCalls(state, ctx.content, plan.carried.holder)}의 ${josa(ctx.content.items[plan.carried.item]?.name ?? plan.carried.item, "을/를")} 썼다.`);
  } else if (plan.fromStock) ctx.store.append({ type: "faction_resource_changed", factionId: plan.fromStock, resource, delta: -1 });
  return { ok: true, lines };
}

/** 이 사람의 부상이 수술이 필요한 단계인가 (12-159) */
export function needsSurgery(ctx: ToolContext, characterId: string): boolean {
  const surgery = ctx.content.scenario.recovery?.surgery;
  if (!surgery) return false;
  const track = harmTrack(ctx.content.scenario);
  const from = track.levels.findIndex((l) => l.id === surgery.from);
  return from >= 0 && levelIndex(ctx, ctx.store.getState(), characterId, track.id) >= from;
}

/** 이 사람이 수술을 할 줄 아는가 (recovery.surgery.min_skill, 배우지 않았으면 못 한다) */
export function canOperate(ctx: ToolContext, characterId: string): boolean {
  const surgery = ctx.content.scenario.recovery?.surgery;
  const c = ctx.store.getState().characters[characterId];
  return !!surgery && !!c && canUseSkill(ctx.content, c, surgery.move) && effectiveSkill(ctx.content, c, surgery.move) >= surgery.min_skill;
}

/** 치료사(NPC)의 수술 굴림: 2d6 + 능력·스킬(상한) + 장소 */
function surgeonRoll(ctx: ToolContext, healerId: string): { outcome: CheckOutcome; line: string } {
  const s = ctx.content.scenario;
  const surgery = s.recovery!.surgery!;
  const state = ctx.store.getState();
  const healer = state.characters[healerId]!;
  const skill = Math.min(s.ranges.cap, (healer.stats[surgery.stat] ?? 0) + effectiveSkill(ctx.content, healer, surgery.move));
  const zone = state.playerZone;
  const place = zone && surgery.clinics.includes(zone) ? surgery.clinic_bonus : zone && ctx.content.locations[zone]?.kind === "base" ? 0 : surgery.field_penalty;
  const roll = roll2d6(ctx.rng, skill + place);
  const where = place > 0 ? "진료소" : place < 0 ? "맨땅" : "거점";
  return {
    outcome: roll.outcome,
    line: `🩺 수술 (${playerCalls(state, ctx.content, healerId)}): ${roll.dice[0]}+${roll.dice[1]} ${roll.modifier >= 0 ? "+" : ""}${roll.modifier}(솜씨·${where}) = ${roll.total} · ${CHECK_OUTCOME_LABELS[roll.outcome]}`,
  };
}

/** 수술 결과: 성공 = 한 단계 낫는다, 대가 있는 성공 = 낫되 흔적이 남을 수 있다, 실패 = 한 단계 나빠진다 */
export function operate(ctx: ToolContext, targetId: string, outcome: CheckOutcome, by: string, safe = false): { lines: string[]; displays: ToolDisplayEvent[] } {
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  const harm = ctx.content.scenario.harm_track;
  const push = (c: Change | null) => {
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  };
  // 거점 의무실의 수술은 실패해도 상처를 덧내지 않는다: 낫지 않을 뿐이다 (플레이 테스트 13: 치료받으러 갔다가 의식장애가 됐다)
  if (outcome === "miss" && safe) {
    const state = ctx.store.getState();
    const now = state.characters[targetId]?.conditions[harm];
    // 오늘 치료는 받은 것으로 친다 (하루 한 번)
    if (now) ctx.store.append({ type: "condition_changed", targetId, track: harm, from: now, to: now, fatal: false, by: "healer", cause: `${by}의 수술`, day: dayOf(state.time), harmTrack: false });
    lines.push("수술이 뜻대로 되지 않았다. 상처는 그대로다 (더 깊어지지는 않았다). 내일 다시 받을 수 있다.");
    return { lines, displays };
  }
  if (outcome === "miss") {
    lines.push("수술이 잘못됐다. 상처가 더 깊어졌다.");
    push(changeCondition(ctx, targetId, harm, 1, "healer", `${by}의 서툰 수술`));
    return { lines, displays };
  }
  if (outcome === "partial") {
    const scar = scarFromHarm(ctx, targetId, null);
    if (scar) lines.push(scar);
  }
  push(changeCondition(ctx, targetId, harm, -1, "healer", `${by}의 수술`));
  return { lines, displays };
}

/** 저절로 낫기 (부상 트랙). 시간이 흐른 뒤마다 부른다 */
export function runNaturalRecovery(ctx: ToolContext): ToolDisplayEvent[] {
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return [];
  const displays: ToolDisplayEvent[] = [];
  const track = harmTrack(ctx.content.scenario);
  const maxIndex = track.levels.findIndex((l) => l.id === recovery.natural_max_level);
  for (let guard = 0; guard < 5; guard++) {
    const state = ctx.store.getState();
    const player = state.characters[state.playerId];
    if (!player || player.dead) break;
    // 피가 멎지 않으면 정신이 들지도, 저절로 낫지도 않는다 (12-91)
    if (bleedingBlocksRecovery(ctx, player)) break;
    const index = levelIndex(ctx, state, player.id, track.id);
    const since = state.recovery.lastChangeAt[player.id] ?? state.runStartedAt;
    // 의식불명 등: 그 단계에 wake_hours만큼 머물면 정신이 든다 (한 단계 나아진다)
    const out = track.levels[index]?.symptoms?.some((id) => ctx.content.scenario.symptoms?.find((x) => x.id === id)?.incapacitates);
    if (out && recovery.wake_hours !== undefined) {
      if (state.time - since < recovery.wake_hours * 60) break;
      const c = changeCondition(ctx, player.id, track.id, -1, "rest", "정신이 들었다");
      if (c?.display) displays.push(c.display);
      break;
    }
    if (index <= 0 || index > maxIndex) break;
    // 푹 잔 밤에 낫는 규칙이 있으면 그것으로만 (healFromSleep)
    if (recovery.sleep_heal) break;
    // 지친 동안은 저절로 낫지 않는다 (12-115). 자고 나면 밀린 만큼 낫는다
    if (fatigueBlocksRecovery(ctx.content, player)) break;
    const days = Math.max(1, recovery.natural_days + bodyTraits(ctx.content, player).recoveryDays);
    if (state.time - since < days * MINUTES_PER_DAY) break;
    const c = changeCondition(ctx, player.id, track.id, -1, "rest", "시간이 지나 아물었다");
    if (c?.display) displays.push(c.display);
  }
  return displays;
}

/**
 * 푹 잔 밤에 낫는다 (플레이 테스트 11, A1, recovery.sleep_heal): from~to 동안 잤으면 부른다.
 * min_hours 이상 잤고, 피가 멎어 있고, 자는 사이 새로 다치지 않았으면 max_level까지 한 단계. slow 단계는 마지막 변화에서 그만큼 지나야
 */
/** 푹 잤는데 상처가 아물지 않은 까닭 (플레이 테스트 13: 갇힌 동안 잠을 자도 그대로인데 까닭이 보이지 않았다). 아물었거나 다치지 않았으면 null */
export function sleepHealBlocker(ctx: ToolContext, from: number, to: number): string | null {
  const rule = ctx.content.scenario.recovery?.sleep_heal;
  if (!rule) return null;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return null;
  const track = harmTrack(ctx.content.scenario);
  const index = levelIndex(ctx, state, me.id, track.id);
  if (index <= 0) return null;
  if (to - from < rule.min_hours * 60) return `${rule.min_hours}시간 넘게 자지 못해 상처가 아물지 않았다.`;
  if (bleedingBlocksRecovery(ctx, me)) return "피가 멎지 않아 상처가 아물지 않았다.";
  const max = track.levels.findIndex((l) => l.id === rule.max_level);
  if (index > max) return "이만한 상처는 잠만으로 아물지 않는다. 치료사의 치료나 수술이 있어야 한다.";
  const since = state.recovery.lastChangeAt[me.id] ?? state.runStartedAt;
  if (since > from) return "자는 사이 상처가 바뀌어 아물지 않았다.";
  const slow = rule.slow[track.levels[index]!.id];
  if (slow !== undefined && to - since < slow * MINUTES_PER_DAY) return `깊은 상처라 마지막으로 다친 뒤 ${slow}일은 지나야 자고 나서 아물기 시작한다.`;
  return null;
}

export function healFromSleep(ctx: ToolContext, from: number, to: number): ToolDisplayEvent[] {
  const rule = ctx.content.scenario.recovery?.sleep_heal;
  if (!rule || to - from < rule.min_hours * 60) return [];
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || bleedingBlocksRecovery(ctx, me)) return [];
  const track = harmTrack(ctx.content.scenario);
  const index = levelIndex(ctx, state, me.id, track.id);
  const max = track.levels.findIndex((l) => l.id === rule.max_level);
  if (index <= 0 || index > max) return [];
  const since = state.recovery.lastChangeAt[me.id] ?? state.runStartedAt;
  if (since > from) return []; // 자는 사이 다쳤다
  const slow = rule.slow[track.levels[index]!.id];
  if (slow !== undefined && to - since < slow * MINUTES_PER_DAY) return [];
  const c = changeCondition(ctx, me.id, track.id, -1, "rest", "푹 자고 나니 상처가 조금 아물었다");
  return c?.display ? [c.display] : [];
}

/** 감염체에게 다쳤을 때 감염되는지 (상처 종류별 확률, 12-106). kind가 없으면 가장 위험한 종류(물려 뜯김 같은)로 본다 */
export function maybeInfect(ctx: ToolContext, kind: string | null): Change | null {
  const infection = ctx.content.scenario.body?.infection;
  if (!infection) return null;
  const chance = kind ? (infection.chance[kind] ?? 0) : Math.max(0, ...Object.values(infection.chance));
  if (chance <= 0) return null;
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
  if (!state.playerZone || state.zones[state.playerZone]?.owner !== me.factionId || content.locations[state.playerZone]?.kind !== "base") return [];
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
    const captive = !!heldOf(player()!);
    const own = !captive && hasAccess(content, state, "ration") ? state.factions[player()!.factionId] : undefined;
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
    if (captive && hasAccess(content, state, "ration")) ctx.store.append({ type: "ration_missed", day });
    if (push(changeCondition(ctx, state.playerId, body.hunger.track, delta, "daily", captive ? "갇힌 곳의 끼니" : !own ? "하루가 지나 배가 고프다" : lower ? `일하지 않아 배급이 줄었다 (${lower.label})` : delta < 0 ? `배급 (${level?.label ?? ""})` : `배급 부족 (${level?.label ?? "없음"})`))) return displays;
    // 배가 고프면 지닌 먹을 것을 하나 먹는다 (플레이 테스트 11: 날생선을 지니고 자도 아침에 굶었다). 갇혀 있으면 빼앗긴 셈이다
    if (!captive && levelIndex(ctx, ctx.store.getState(), state.playerId, track.id) > 0) {
      const inv = player()!.inventory;
      const food = Object.entries(content.scenario.consumables)
        .filter(([id, e]) => (inv[id] ?? 0) > 0 && (e[track.id] ?? 0) > 0 && content.items[id]?.kind === "food" && !content.items[id]?.contaminated)
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
 * - spring: 물이 나는 바깥 구역(강·우물·정수장). 마음껏 마시고 채운다
 * - supply: 우리 거점(우리 땅이면서 거점). 무리의 물 보급을 받는다: 넉넉하면 full, 하루치도 안 남으면 limited(조금만), 바닥이거나 배급 권한이 없으면 refused
 */
export type WaterSource = { kind: "spring" | "supply"; grant: "full" | "limited" | "refused" };

export function waterHere(content: Content, state: GameState): WaterSource | null {
  const rules = content.scenario.body?.thirst;
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!rules || !me || me.dead || heldOf(me) || !zone) return null;
  // 빗물받이 (12-167): 그 구역이 물이 나는 곳이 된다
  if (waterFacilityHere(content, state)) return { kind: "spring", grant: "full" };
  const loc = content.locations[zone];
  const base = (loc?.kind === "base" || !!loc?.water_supply) && state.zones[zone]?.owner === me.factionId;
  if (base) {
    const own = state.factions[me.factionId];
    if (!own || !hasAccess(content, state, "ration")) return { kind: "supply", grant: "refused" };
    const days = daysOfStock(content, own, rules.resource);
    return { kind: "supply", grant: days >= rules.min_days ? "full" : (own.resources[rules.resource] ?? 0) >= 1 ? "limited" : "refused" };
  }
  return (content.locations[zone]?.yields[rules.resource] ?? 0) > 0 ? { kind: "spring", grant: "full" } : null;
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
    const item = h.items.find((i) => (now.inventory[i] ?? 0) > 0);
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
  if (state.zones[state.playerZone]?.owner !== me.factionId) return false;
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
  const roll = rollPlayerCheck({ move: rule.move, stat: rule.stat, difficulty: "normal", intent: `마음을 다잡는다 (${cause})` }, ctx, { reaction: true, unlearnedAs: 0 });
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
    mine: !!state.playerZone && !!me.factionId && state.zones[state.playerZone]?.owner === me.factionId,
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
  if (severe(ctx, me, ctx.content.scenario.body?.hunger?.track) || severe(ctx, me, ctx.content.scenario.body?.cold?.track)) return null;
  const { mine, company } = safety(state, me);
  const chance = (mine || company ? rule.safe : rule.unsafe) + nerves.recover.per_point * steadyStat(ctx, me);
  if (ctx.rng() >= chance) return null;
  return changeCondition(ctx, me.id, nerves.track, -1, "nerves", mine ? "익숙한 담 안에서 푹 잤다" : company ? "곁에 사람을 두고 푹 잤다" : "모처럼 푹 잤다");
}

/** 응급처치에 쓰는 물건: 피를 멎게 하는 소모품 (구급상자·붕대) */
export function isFirstAidItem(content: ToolContext["content"], item: string): boolean {
  const w = content.scenario.wounds;
  return !!w && (content.scenario.consumables[item]?.[w.track] ?? 0) > 0;
}

/**
 * 응급처치 (플레이 테스트 11, A9). 판정(wounds.staunch_move)이 결과를 정한다:
 * 성공 = 피가 멎고 부상이 한 단계 낫는다, 대가 있는 성공 = 피만 멎는다, 실패 = 시간만 가고 아무 일 없다 (다시 할 수 있다).
 * 물건(구급상자·붕대)은 성공·대가 있는 성공에 하나 쓴다. 부상을 낫게 하려면 물건이 있거나 응급처치를 익혔어야 한다 (맨손의 서툰 사람은 피만 멎게 한다).
 * 부상이 낫는 것은 한 사람에게 하루 한 번 (치료사의 치료와 같이 센다)
 */
/** 치료 요청을 시간 쓰기 전에 본다 (치료사에게 받기 또는 응급처치). 할 수 있으면 null */
export function treatmentProblem(ctx: ToolContext, item: string | null, targetId: string | null, checkMove: string | null, pay: FeeChoice = "default"): string | null {
  const state = ctx.store.getState();
  const self = !targetId || targetId === state.playerId;
  const patient = self ? state.playerId : targetId!;
  if (!item && (self || !checkMove) && state.scene.present.some((id) => ctx.content.npcs[id]?.healer && id !== patient)) return selfTreatmentProblem(ctx, patient, pay);
  return firstAidProblem(ctx, item, self ? state.playerId : targetId!, checkMove).error;
}

function firstAidProblem(ctx: ToolContext, item: string | null, targetId: string, checkMove: string | null): { error: string | null; bleeding: boolean; canHeal: boolean; nursing?: boolean } {
  const { store, content } = ctx;
  const w = content.scenario.wounds;
  const rule = content.scenario.recovery?.first_aid;
  const no = (error: string) => ({ error, bleeding: false, canHeal: false });
  if (!w) return no("이 월드에는 응급처치 규칙이 없다.");
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const target = state.characters[targetId];
  const self = targetId === me.id;
  if (!target || target.dead || (!self && !state.scene.present.includes(targetId))) return no("그 사람이 장면에 없다.");
  if (item) {
    if (!isFirstAidItem(content, item)) return no(`${josa(content.items[item]?.name ?? item, "은/는")} 응급처치에 쓰는 물건이 아니다. 약은 use_item으로 쓴다.`);
    if ((me.inventory[item] ?? 0) < 1) return no(`${josa(content.items[item]?.name ?? item, "이/가")} 없다.`);
  }
  const harm = harmTrack(content.scenario);
  const bleeding = levelIndex(ctx, state, targetId, w.track) > 0;
  const skilled = !!rule && ((!!me.occupation && rule.occupations.includes(me.occupation.id)) || effectiveSkill(content, me, rule.skill) >= rule.min);
  // 치명상 이상은 수술이다: 수술을 배운 사람만 손댄다 (못 하면 피만 멎게 한다)
  const cutting = needsSurgery(ctx, targetId);
  const canHeal = (!!item || skilled) && (!cutting || canOperate(ctx, me.id)) && shownIndex(ctx, state, targetId, harm.id) > 0 && state.recovery.lastHealerDay[targetId] !== dayOf(state.time);
  // 간호 (플레이 테스트 13): 상처도 피도 없이 앓는 사람은 응급처치 판정으로 돌본다. 하루 한 번
  const disease = content.scenario.body?.disease?.track;
  if (!bleeding && shownIndex(ctx, state, targetId, harm.id) <= 0 && disease && shownIndex(ctx, state, targetId, disease) > 0) {
    if (state.recovery.lastHealerDay[targetId] === dayOf(state.time)) return no(`${self ? "" : `${josa(playerCalls(state, content, targetId), "은/는")} `}오늘 이미 돌봤다. 내일 다시 할 수 있다.`);
    if (checkMove !== w.staunch_move) return no(`앓는 사람은 간호로 돌본다: check(move: ${w.staunch_move})를 함께 선언한다. 성공하면 병이 한 단계 가라앉고(하루 한 번), 대가 있는 성공·실패면 시간만 간다.`);
    return { error: null, bleeding: false, canHeal: false, nursing: true };
  }
  if (!bleeding && !canHeal) {
    if (cutting && !canOperate(ctx, me.id) && shownIndex(ctx, state, targetId, harm.id) > 0) return no(`${self ? "이" : `${playerCalls(state, content, targetId)}의`} 상처는 꿰매고 파내야 한다. 수술을 배우지 않아 손댈 수 없다. 수술할 줄 아는 치료사를 찾는다.`);
    if (shownIndex(ctx, state, targetId, harm.id) <= 0) return no(`${self ? "" : `${playerCalls(state, content, targetId)}에게는 `}피도 상처도 없다. 응급처치할 것이 없다.`);
    if (state.recovery.lastHealerDay[targetId] === dayOf(state.time)) return no(`${self ? "" : `${playerCalls(state, content, targetId)}의 `}상처는 오늘 이미 돌봤다. 내일 다시 할 수 있다.`);
    return no(skilled
      ? "피는 멎어 있다. 맨손으로는 피만 멎게 할 수 있다. 상처를 돌보려면 붕대·구급상자 같은 물건이 있어야 한다 (treatment.item). 장면의 치료사에게 받을 수도 있다."
      : "피는 멎어 있다. 상처를 돌보려면 붕대·구급상자 같은 물건이 있거나 응급처치를 익혀야 한다 (treatment.item). 장면의 치료사에게 받을 수도 있다.");
  }
  const surgery = content.scenario.recovery?.surgery;
  if (cutting && canHeal && surgery) {
    if (checkMove !== surgery.move) return no(`${self ? "이" : `${playerCalls(state, content, targetId)}의`} 상처는 수술이다: check(move: ${surgery.move})를 함께 선언한다. 성공이면 한 단계 낫고, 대가 있는 성공이면 낫되 흔적이 남을 수 있고, 실패하면 상처가 더 깊어진다.`);
    return { error: null, bleeding, canHeal };
  }
  if (checkMove !== w.staunch_move) {
    return no(`응급처치는 판정으로 한다: check(move: ${w.staunch_move})를 함께 선언한다. 성공하면 피가 멎고 상처가 한 단계 낫고, 대가 있는 성공이면 피만 멎고, 실패하면 시간만 간다.`);
  }
  return { error: null, bleeding, canHeal };
}

/** 간호: 앓는 사람을 돌본다 (플레이 테스트 13). 성공이면 병이 한 단계 가라앉는다 (치료사보다 약하게 하루 한 번) */
function nurse(ctx: ToolContext, targetId: string, outcome: CheckOutcome): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content } = ctx;
  const state = store.getState();
  const track = content.scenario.body!.disease!.track;
  const who = targetId === state.playerId ? "" : `${playerCalls(state, content, targetId)}의 `;
  if (outcome === "miss") return { ok: true, lines: [`${who}열을 내리려 애썼지만 잘 되지 않았다. 시간만 갔다 (다시 할 수 있다).`], displays: [] };
  if (outcome === "partial") return { ok: true, lines: [`${who}곁을 지키며 물을 먹이고 이마를 식혔다. 잠깐 편해 보였지만 병은 그대로다 (대가 있는 성공: 시간이 더 들었다. 다시 할 수 있다).`], displays: [] };
  const c = changeCondition(ctx, targetId, track, -1, "healer", targetId === state.playerId ? "간호" : `${state.characters[state.playerId]!.name}의 간호`);
  return { ok: true, lines: [`${who}곁을 지키며 열을 내렸다.`, ...(c?.line ? [c.line] : [])], displays: c?.display ? [c.display] : [] };
}

function firstAidCheck(
  ctx: ToolContext,
  item: string | null,
  targetId: string,
  check: { move: string; outcome: CheckOutcome } | null,
): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const p = firstAidProblem(ctx, item, targetId, check?.move ?? null);
  if (p.error || !check) return { ok: false, error: p.error ?? "판정이 없다." };
  const { bleeding, canHeal } = p;
  if (p.nursing) return nurse(ctx, targetId, check.outcome);
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const self = targetId === me.id;
  const harm = harmTrack(content.scenario);
  const who = self ? "" : `${playerCalls(state, content, targetId)}의 `;
  // 수술 (치명상 이상, 수술을 배운 사람): 실패하면 상처가 깊어진다. 성공·대가 있는 성공이면 피도 멎는다
  if (canHeal && needsSurgery(ctx, targetId)) {
    const lines: string[] = [];
    const displays: ToolDisplayEvent[] = [];
    if (check.outcome !== "miss") {
      if (item) {
        store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: 1 });
        lines.push(`${josa(content.items[item]?.name ?? item, "을/를")} 썼다.`);
      }
      if (bleeding) displays.push(...stopBleeding(ctx, targetId, "수술"));
    }
    const r = operate(ctx, targetId, check.outcome, self ? "스스로 한" : me.name);
    return { ok: true, lines: [`${who}상처를 수술했다.`, ...lines, ...r.lines], displays: [...displays, ...r.displays] };
  }
  if (check.outcome === "miss") return { ok: true, lines: [`${who}응급처치가 잘 되지 않았다. 시간만 갔다 (물건은 쓰지 않았다. 다시 할 수 있다).`], displays: [] };
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  // 피가 안 나는 상처에 대가 있는 성공이면 물건을 쓰지 않는다 (플레이 테스트 13: 구급상자만 사라졌다)
  if (!bleeding && check.outcome !== "success") return { ok: true, lines: [`${who}상처를 제대로 돌보지 못했다 (대가 있는 성공: 손이 서툴러 시간만 더 들었다. 물건은 쓰지 않았다. 다시 할 수 있다).`], displays };
  if (item) {
    store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: 1 });
    lines.push(`${josa(content.items[item]?.name ?? item, "을/를")} 썼다.`);
  }
  if (bleeding) {
    displays.push(...stopBleeding(ctx, targetId, item ? (content.items[item]?.name ?? item) : "맨손 지혈"));
    lines.push(`${who}피를 멎게 했다.`);
  }
  if (check.outcome === "success" && canHeal) {
    const c = changeCondition(ctx, targetId, harm.id, -1, "healer", self ? "응급처치" : `${me.name}의 응급처치`);
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  } else if (canHeal) {
    lines.push(`${who}상처는 그대로다 (대가 있는 성공: 피만 멎었다).`);
  }
  return { ok: true, lines, displays };
}

/**
 * NPC가 낫는다 (12-52): 하루마다.
 * - 저절로: 주인공과 같은 규칙 (새 부상 없이 natural_days가 지나면 한 단계, natural_max_level까지). 붙잡힌 사람은 낫지 않는다
 * - 무리의 돌봄: 무리에 의무병(faction_care.occupation)이 있으면 무리의 의약품을 써서 가장 많이 다친 사람부터 돌본다. 드러난 감염도 뗀다
 * 장면에 있는 사람의 보이는 변화만 화면에 알린다
 */
export function runNpcRecovery(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const recovery = content.scenario.recovery;
  if (!recovery) return [];
  const displays: ToolDisplayEvent[] = [];
  const show = (c: Change | null, id: string) => {
    if (c?.display && store.getState().scene.present.includes(id)) displays.push(c.display);
  };
  const harm = harmTrack(content.scenario);
  const maxIndex = harm.levels.findIndex((l) => l.id === recovery.natural_max_level);
  const npcs = () => Object.values(store.getState().characters).filter((c) => c.id !== store.getState().playerId && !c.dead && !c.away);
  for (const c of npcs()) {
    if (heldOf(c)) continue;
    // 피가 멎지 않으면 저절로 낫지 않는다 (12-91)
    if (bleedingBlocksRecovery(ctx, c)) continue;
    const state = store.getState();
    const index = harm.levels.findIndex((l) => l.id === c.conditions[harm.id]);
    if (index <= 0 || index > maxIndex) continue;
    const since = state.recovery.lastChangeAt[c.id] ?? 0;
    if (state.time - since < recovery.natural_days * MINUTES_PER_DAY) continue;
    show(changeCondition(ctx, c.id, harm.id, -1, "rest", "시간이 지나 아물었다"), c.id);
  }
  const care = recovery.faction_care;
  if (!care) return displays;
  for (const factionId of Object.keys(store.getState().factions)) {
    const members = npcs().filter((c) => c.factionId === factionId && !heldOf(c));
    const medics = members.filter((c) => !!c.occupation && care.occupations.includes(c.occupation.id) && !isIncapacitated(content, c)).length;
    // 분배 (12-128): 의약품을 아끼면 덜, 아낌없이 쓰면 더 돌본다
    let slots = Math.round(medics * care.per_medic * policyEffects(content, store.getState().factions[factionId]).care);
    if (slots === 0) continue;
    const severity = (c: (typeof members)[number]) => harm.levels.findIndex((l) => l.id === c.conditions[harm.id]);
    for (const c of [...members].sort((a, b) => severity(b) - severity(a) || a.id.localeCompare(b.id))) {
      if (slots <= 0) break;
      const stock = () => store.getState().factions[factionId]?.resources[care.resource] ?? 0;
      let treated = false;
      if (severity(c) > 0 && stock() >= 1) {
        store.append({ type: "faction_resource_changed", factionId, resource: care.resource, delta: -1 });
        show(changeCondition(ctx, c.id, harm.id, -1, "healer", "무리 의무실의 치료"), c.id);
        treated = true;
      }
      if (treated) slots--;
    }
  }
  return displays;
}
