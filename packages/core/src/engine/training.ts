import type { Content } from "../content/schemas.ts";
import { activeCompanions, bondOf, daysTogether, tricksOf } from "../game/companions.ts";
import type { GameState } from "../game/state.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 개 기르기 (기획서 7.8.1, 12-172). 곁의 동물에게 재주를 가르친다.
 * take_action.train + 판정(재주의 move). 동물마다 하루 한 번. 함께 지낸 날이 min_days 이상이어야 한다.
 * 성공 = 배운다, 대가 있는 성공 = 반쯤 배운다 (반쯤 배운 재주는 다음에 성공이든 대가 있는 성공이든 배운다), 실패 = 헛수고
 */

export type TrainInput = { companion: string; trick: string };

/** 가르칠 수 없는 까닭 (없으면 null) */
export function planTrain(content: Content, state: GameState, input: TrainInput, move: string | undefined): string | null {
  const c = state.characters[input.companion];
  if (!c || !activeCompanions(state).includes(input.companion) || bondOf(state, content, input.companion)?.kind !== "animal") {
    return "곁에 있는 동물에게만 가르친다 (동행 줄의 id).";
  }
  const trick = tricksOf(state, content, input.companion).find((t) => t.id === input.trick);
  if (!trick) return `${josa(c.name, "이/가")} 배울 수 있는 재주가 아니다: ${input.trick} (가능: ${tricksOf(state, content, input.companion).map((t) => t.id).join(", ") || "없음"})`;
  const rec = state.tricks?.[input.companion];
  if (rec?.learned.includes(trick.id)) return `${josa(c.name, "은/는")} 이미 ${josa(trick.label, "을/를")} 안다.`;
  const days = daysTogether(state, content, input.companion);
  if (days < trick.min_days) return `아직 ${josa(c.name, "이/가")} 그만큼 따르지 않는다 (함께 지낸 지 ${days}일, ${trick.min_days}일은 지나야 한다).`;
  if (rec?.lastDay === dayOf(state.time)) return `오늘은 이미 ${c.name}에게 가르쳤다. 내일 다시 한다.`;
  if (move !== trick.move) return `${josa(trick.label, "을/를")} 가르치려면 check.move가 ${trick.move}여야 한다.`;
  return null;
}

/** 판정 결과대로 가르친다. 알릴 줄 */
export function applyTrain(ctx: ToolContext, input: TrainInput, outcome: CheckOutcome): string[] {
  const state = ctx.store.getState();
  const c = state.characters[input.companion]!;
  const trick = tricksOf(state, ctx.content, input.companion).find((t) => t.id === input.trick)!;
  const half = state.tricks?.[input.companion]?.half.includes(trick.id) ?? false;
  const result = outcome === "success" || (outcome === "partial" && half) ? "learned" : outcome === "partial" ? "half" : "miss";
  ctx.store.append({ type: "trick_trained", animalId: c.id, trick: trick.id, result, day: dayOf(state.time) });
  if (result === "learned") return [`${josa(c.name, "이/가")} ${josa(trick.label, "을/를")} 익혔다. 이제부터 곁에 있으면 그 재주를 쓴다.`];
  if (result === "half") return [`${josa(c.name, "이/가")} ${josa(trick.label, "을/를")} 반쯤 알아들었다. 한 번 더 가르치면 익힌다.`];
  return [`${josa(c.name, "은/는")} 오늘 ${josa(trick.label, "을/를")} 알아듣지 못했다. 헛수고였다.`];
}
