import { playerCalls } from "../game/acquaintance.ts";
import { isExpertMove, learnedSkill, moveOf } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import { pickFee } from "./body.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 가르침 (기획서 4.2.1): 전문 기술은 판정이 아니라 배워서 얻는다.
 * 그 스킬이 growth.teaching.min_skill 이상이고 신뢰가 min_trust 이상인 사람 곁에서 take_action.lesson으로 hours시간을 채우면
 * 배운 상태(스킬 최저값)가 된다. 여러 번에 나눠도 된다. 가르치는 사람이 다른 무리면 처음 배울 때 물건으로 값 fee (신뢰 free_trust 이상이면 공짜)
 */
export type LessonInput = { teacher: string; skill: string };

/** 배울 수 없는 까닭 (없으면 null) */
export function planLesson(ctx: ToolContext, input: LessonInput): string | null {
  const s = ctx.content.scenario;
  const rule = s.growth?.teaching;
  if (!rule) return "이 월드에는 가르침이 없다.";
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const move = moveOf(s, input.skill);
  if (!move) return `알 수 없는 스킬: ${input.skill}`;
  if (!isExpertMove(s, input.skill)) return `${josa(move.label, "은/는")} 누구나 하는 일이다. 배우지 않아도 할 수 있고, 잘하려면 스킬 포인트로 올린다 (learn_skill).`;
  if (learnedSkill(s, me.skills, input.skill) !== null) return `${josa(move.label, "은/는")} 이미 배웠다. 더 잘하려면 스킬 포인트로 올린다 (learn_skill).`;
  const teacher = state.characters[input.teacher];
  if (!teacher || teacher.dead || !state.scene.present.includes(input.teacher)) return "가르칠 사람이 장면에 없다.";
  const name = playerCalls(state, ctx.content, input.teacher);
  const level = learnedSkill(s, teacher.skills, input.skill);
  if (level === null || level < rule.min_skill) return `${josa(name, "은/는")} ${josa(move.label, "을/를")} 가르칠 만큼 익히지 않았다 (${rule.min_skill >= 0 ? "+" : ""}${rule.min_skill} 이상이어야 가르친다).`;
  const trust = state.relations[input.teacher]?.[me.id]?.trust ?? 0;
  if (trust < rule.min_trust) return `${josa(name, "은/는")} 아직 가르쳐 줄 만큼 믿지 않는다 (신뢰 ${rule.min_trust} 이상).`;
  if (state.lessons[input.skill] === undefined && lessonFee(ctx, input.teacher) > 0 && !pickFee(ctx, me, rule.fee)) {
    return `${josa(name, "은/는")} 다른 무리 사람에게는 값(${rule.fee}어치)을 받는다. 낼 만한 물건이 모자란다 (신뢰가 ${rule.free_trust} 이상이면 받지 않는다).`;
  }
  return null;
}

/** 가르치는 사람이 받는 값 (같은 무리이거나 신뢰가 높으면 0) */
function lessonFee(ctx: ToolContext, teacherId: string): number {
  const rule = ctx.content.scenario.growth?.teaching;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const teacher = state.characters[teacherId]!;
  const trust = state.relations[teacherId]?.[me.id]?.trust ?? 0;
  if (!rule || rule.fee <= 0 || (!!me.factionId && me.factionId === teacher.factionId) || trust >= rule.free_trust) return 0;
  return rule.fee;
}

/** 배운 시간(분)을 쌓는다. planLesson을 통과한 뒤, 시간이 흐른 다음에 부른다. 결과 줄 */
export function applyLesson(ctx: ToolContext, input: LessonInput, minutes: number): string[] {
  const s = ctx.content.scenario;
  const rule = s.growth!.teaching!;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const move = moveOf(s, input.skill)!;
  const name = playerCalls(state, ctx.content, input.teacher);
  const lines: string[] = [];
  // 값은 처음 배울 때 한 번 낸다
  if (state.lessons[input.skill] === undefined && lessonFee(ctx, input.teacher) > 0) {
    const pay = pickFee(ctx, me, rule.fee) ?? new Map<string, number>();
    for (const [id, q] of pay) ctx.store.append({ type: "item_transferred", from: me.id, to: input.teacher, itemId: id, quantity: q });
    if (pay.size) lines.push(`가르침 값으로 ${[...pay].map(([id, q]) => `${ctx.content.items[id]?.name ?? id} ×${q}`).join(", ")}을 냈다.`);
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  ctx.store.append({ type: "skill_lesson", characterId: me.id, skill: input.skill, teacherId: input.teacher, hours });
  const total = ctx.store.getState().lessons[input.skill] ?? hours;
  if (total >= rule.hours) {
    ctx.store.append({ type: "skill_trained", characterId: me.id, skill: input.skill, to: s.ranges.skill.min });
    lines.push(`${name}에게서 ${josa(move.label, "을/를")} 배웠다 (못 함 → 배움 ${s.ranges.skill.min}). 이제 ${move.label} 판정을 할 수 있다. 더 잘하려면 스킬 포인트로 올린다.`);
  } else {
    lines.push(`${name}에게서 ${josa(move.label, "을/를")} 배우는 중이다 (${total}/${rule.hours}시간). 다 채우면 배운다.`);
  }
  return lines;
}
