import { CARE_BY, careUsedToday } from "./slots.ts";
/** 치료 (kinds): engine/body.ts에서 떼어 냈다 (docs/design.md 12-236) */
import { heldOf } from "../../rules/held.ts";
import type { GameState } from "../../game/state.ts";
import { playerCalls } from "../../game/acquaintance.ts";
import type { Content } from "../../content/schemas.ts";
import type { Character } from "../../game/character.ts";
import { effectiveSkill } from "../traits.ts";
import { dayOf } from "../../rules/time.ts";
import { harmTrack } from "../../scenario/scenario.ts";
import { josa } from "../../text.ts";
import { stopBleeding } from "../bleeding.ts";
import { type CheckOutcome } from "../../rules/check.ts";
import { type ToolContext, type ToolDisplayEvent } from "../toolkit.ts";
import { changeCondition, useItem, levelIndex, shownIndex, symptomGroupsShown } from "../body.ts";
import { type FeeChoice, planHealerPay, payHealer } from "./fee.ts";
import { needsSurgery, canOperate, surgeonRoll, operate } from "./surgery.ts";
import { ownedBy } from "../../rules/home.ts";
import { quarantineAfterCare } from "./quarantine.ts";
import { nearby } from "../../rules/place.ts";
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
    const here = Object.values(ctx.content.npcs).filter((n) => n.healer && !heldOf(state.characters[n.id]) && nearby(state, ctx.content, n.id));
    return `치료해 줄 사람이 장면에 없다 (장면의 치료사만 치료한다).${here.length ? ` 이 구역의 치료사: ${here.map((n) => `${playerCalls(state, ctx.content, n.id)} (${n.id})`).join(", ")} (npc_presence로 들인다).` : " 이 구역에는 치료사가 없다."} 치료 아이템을 쓰거나 치료사를 찾아간다.`;
  }
  const needed = Object.entries(recovery.healer).some(([t, steps]) => steps > 0 && shownIndex(ctx, state, player.id, t) > 0);
  if (!needed && !symptomGroupsShown(ctx.content, player).size) return `${who}다친 데가 없어 치료할 것이 없다.`;
  // 오늘 이미 치료받았어도 새로 난 피는 멎게 한다 (플레이 테스트 12: 하루 한 번 제한이 새 출혈까지 막았다)
  const bleedTrack = ctx.content.scenario.wounds?.track;
  const freshBleed = !!bleedTrack && shownIndex(ctx, state, player.id, bleedTrack) > 0;
  if (needed && !freshBleed && careUsedToday(state, ctx.content, player.id, "healer")) return `${other ? `${josa(playerCalls(state, ctx.content, player.id), "은/는")} ` : ""}오늘은 이미 치료를 받았다. 내일 다시 받을 수 있다.`;
  if (needed) {
    const planned = planHealerPay(ctx, healer, pay);
    if (!planned.ok) return planned.error;
  }
  return null;
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
  const again = careUsedToday(state, ctx.content, player.id, "healer");
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
      const homeGround = !!state.characters[healer]?.factionId && !!state.playerZone && ownedBy(state, state.playerZone, state.characters[healer]!.factionId);
      const r = operate(ctx, player.id, surgery.outcome, name, homeGround);
      lines.push(...r.lines);
      displays.push(...r.displays);
      continue;
    }
    const c = changeCondition(ctx, player.id, t, -steps, "healer", "치료");
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  // 감염체에게 다친 상처를 그 무리의 치료사가 보면 격리한다 (12-238)
  const isolated = quarantineAfterCare(ctx, state.characters[healer]?.factionId);
  if (isolated) lines.push(isolated);
  return { ok: true, lines, displays };
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

export function firstAidProblem(ctx: ToolContext, item: string | null, targetId: string, checkMove: string | null): { error: string | null; bleeding: boolean; canHeal: boolean; nursing?: boolean } {
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
  const canHeal = (!!item || skilled) && (!cutting || canOperate(ctx, me.id)) && shownIndex(ctx, state, targetId, harm.id) > 0 && !careUsedToday(state, content, targetId, "aid");
  // 간호 (플레이 테스트 13): 상처도 피도 없이 앓는 사람은 응급처치 판정으로 돌본다. 하루 한 번
  const disease = content.scenario.body?.disease?.track;
  if (!bleeding && shownIndex(ctx, state, targetId, harm.id) <= 0 && disease && shownIndex(ctx, state, targetId, disease) > 0) {
    if (careUsedToday(state, content, targetId, "aid")) return no(`${self ? "" : `${josa(playerCalls(state, content, targetId), "은/는")} `}오늘 이미 돌봤다. 내일 다시 할 수 있다.`);
    if (checkMove !== w.staunch_move) return no(`앓는 사람은 간호로 돌본다: check(move: ${w.staunch_move})를 함께 선언한다. 성공하면 병이 한 단계 가라앉고(하루 한 번), 대가 있는 성공·실패면 시간만 간다.`);
    return { error: null, bleeding: false, canHeal: false, nursing: true };
  }
  if (!bleeding && !canHeal) {
    if (cutting && !canOperate(ctx, me.id) && shownIndex(ctx, state, targetId, harm.id) > 0) return no(`${self ? "이" : `${playerCalls(state, content, targetId)}의`} 상처는 꿰매고 파내야 한다. 수술을 배우지 않아 손댈 수 없다. 수술할 줄 아는 치료사를 찾는다.`);
    if (shownIndex(ctx, state, targetId, harm.id) <= 0) return no(`${self ? "" : `${playerCalls(state, content, targetId)}에게는 `}피도 상처도 없다. 응급처치할 것이 없다.`);
    if (careUsedToday(state, content, targetId, "aid")) return no(`${self ? "" : `${playerCalls(state, content, targetId)}의 `}상처는 오늘 이미 돌봤다. 내일 다시 할 수 있다.`);
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
export function nurse(ctx: ToolContext, targetId: string, outcome: CheckOutcome): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content } = ctx;
  const state = store.getState();
  const track = content.scenario.body!.disease!.track;
  const who = targetId === state.playerId ? "" : `${playerCalls(state, content, targetId)}의 `;
  if (outcome === "miss") return { ok: true, lines: [`${who}열을 내리려 애썼지만 잘 되지 않았다. 시간만 갔다 (다시 할 수 있다).`], displays: [] };
  if (outcome === "partial") return { ok: true, lines: [`${who}곁을 지키며 물을 먹이고 이마를 식혔다. 잠깐 편해 보였지만 병은 그대로다 (대가 있는 성공: 시간이 더 들었다. 다시 할 수 있다).`], displays: [] };
  const c = changeCondition(ctx, targetId, track, -1, CARE_BY.aid, targetId === state.playerId ? "간호" : `${state.characters[state.playerId]!.name}의 간호`);
  return { ok: true, lines: [`${who}곁을 지키며 열을 내렸다.`, ...(c?.line ? [c.line] : [])], displays: c?.display ? [c.display] : [] };
}

export function firstAidCheck(
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
    const r = operate(ctx, targetId, check.outcome, self ? "스스로 한" : me.name, false, "aid");
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
    const c = changeCondition(ctx, targetId, harm.id, -1, CARE_BY.aid, self ? "응급처치" : `${me.name}의 응급처치`);
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  } else if (canHeal) {
    lines.push(`${who}상처는 그대로다 (대가 있는 성공: 피만 멎었다).`);
  }
  return { ok: true, lines, displays };
}
