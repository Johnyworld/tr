import { CHECK_OUTCOME_LABELS, DIFFICULTY_LABELS, DIFFICULTY_MODIFIER, roll2d6, type CheckOutcome, type Difficulty } from "../rules/check.ts";
import { conditionPenalty, moveOf, statLabel } from "../scenario/scenario.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

export type PlayerCheckInput = { move: string; stat: string; difficulty: Difficulty; intent: string };

export type PlayerCheckResult =
  | {
      ok: true;
      checkId: string;
      outcome: CheckOutcome;
      dice: [number, number];
      modifier: number;
      total: number;
      display: Extract<ToolDisplayEvent, { type: "check" }>;
    }
  | { ok: false; error: string };

/**
 * 플레이어 캐릭터의 2d6 판정을 굴리고 check_rolled 이벤트로 기록한다.
 * 행동과 능력치는 시나리오에서 오고, 보정은 능력치 + 난이도 + 상태 트랙 보정이다.
 */
export function rollPlayerCheck(input: PlayerCheckInput, { store, rng, content }: ToolContext): PlayerCheckResult {
  const scenario = content.scenario;
  const state = store.getState();
  const actor = state.characters[state.playerId];
  if (!actor) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (actor.dead) return { ok: false, error: "사망한 캐릭터는 판정할 수 없습니다." };

  const move = moveOf(scenario, input.move);
  if (!move) return { ok: false, error: `알 수 없는 행동: ${input.move}` };
  if (!move.stats.includes(input.stat)) {
    return { ok: false, error: `${input.move}에는 ${move.stats.join(" 또는 ")} 능력치만 쓸 수 있습니다.` };
  }

  const modifiers = {
    stat: actor.stats[input.stat] ?? 0,
    difficulty: DIFFICULTY_MODIFIER[input.difficulty],
    condition: conditionPenalty(scenario, actor),
  };
  const roll = roll2d6(rng, modifiers.stat + modifiers.difficulty + modifiers.condition);
  const checkId = `chk_${state.nextCheckNo}`;

  store.append({
    type: "check_rolled",
    checkId,
    turn: state.turn,
    actorId: actor.id,
    move: input.move,
    stat: input.stat,
    difficulty: input.difficulty,
    intent: input.intent,
    dice: roll.dice,
    modifiers,
    total: roll.total,
    outcome: roll.outcome,
  });

  return {
    ok: true,
    checkId,
    outcome: roll.outcome,
    dice: roll.dice,
    modifier: roll.modifier,
    total: roll.total,
    display: {
      type: "check",
      checkId,
      actorName: actor.name,
      intent: input.intent,
      moveLabel: move.label,
      statLabel: statLabel(scenario, input.stat),
      difficultyLabel: DIFFICULTY_LABELS[input.difficulty],
      dice: roll.dice,
      modifiers,
      total: roll.total,
      outcome: roll.outcome,
      outcomeLabel: CHECK_OUTCOME_LABELS[roll.outcome],
    },
  };
}
