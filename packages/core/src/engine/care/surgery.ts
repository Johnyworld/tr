import { CARE_BY, type CareSlot } from "./slots.ts";
/** 치료 (surgery): engine/body.ts에서 떼어 냈다 (docs/design.md 12-236) */
import type { GameState } from "../../game/state.ts";
import { playerCalls } from "../../game/acquaintance.ts";
import type { Content } from "../../content/schemas.ts";
import type { Character } from "../../game/character.ts";
import { canUseSkill, effectiveSkill } from "../traits.ts";
import { dayOf } from "../../rules/time.ts";
import { harmTrack } from "../../scenario/scenario.ts";
import { CHECK_OUTCOME_LABELS, roll2d6, type CheckOutcome } from "../../rules/check.ts";
import { scarFromHarm } from "../scars.ts";
import { type ToolContext, type ToolDisplayEvent } from "../toolkit.ts";
import { changeCondition, type Change, levelIndex } from "../body.ts";
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
export function surgeonRoll(ctx: ToolContext, healerId: string): { outcome: CheckOutcome; line: string } {
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
export function operate(ctx: ToolContext, targetId: string, outcome: CheckOutcome, by: string, safe = false, slot: CareSlot = "healer"): { lines: string[]; displays: ToolDisplayEvent[] } {
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
    if (now) ctx.store.append({ type: "condition_changed", targetId, track: harm, from: now, to: now, fatal: false, by: CARE_BY[slot], cause: `${by}의 수술`, day: dayOf(state.time), harmTrack: false });
    lines.push("수술이 뜻대로 되지 않았다. 상처는 그대로다 (더 깊어지지는 않았다). 내일 다시 받을 수 있다.");
    return { lines, displays };
  }
  if (outcome === "miss") {
    lines.push("수술이 잘못됐다. 상처가 더 깊어졌다.");
    push(changeCondition(ctx, targetId, harm, 1, CARE_BY[slot], `${by}의 서툰 수술`));
    return { lines, displays };
  }
  if (outcome === "partial") {
    const scar = scarFromHarm(ctx, targetId, null);
    if (scar) lines.push(scar);
  }
  push(changeCondition(ctx, targetId, harm, -1, CARE_BY[slot], `${by}의 수술`));
  return { lines, displays };
}
