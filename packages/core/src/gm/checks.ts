import { CHECK_OUTCOME_LABELS, DIFFICULTY_LABELS, DIFFICULTY_MODIFIER, roll2d6, type CheckOutcome, type Difficulty } from "../rules/check.ts";
import { INJURY_PENALTY } from "../rules/injury.ts";
import { MOVE_LABELS, MOVE_STATS, type Move } from "../rules/moves.ts";
import { STAT_LABELS, type Stat } from "../rules/stats.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

export type PlayerCheckInput = { move: Move; stat: Stat; difficulty: Difficulty; intent: string };

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
 * request_check와, 판정이 들어가는 다른 tool(목격자 살피기 등)이 같이 쓴다.
 */
export function rollPlayerCheck(input: PlayerCheckInput, { store, rng }: ToolContext): PlayerCheckResult {
  const state = store.getState();
  const actor = state.characters[state.playerId];
  if (!actor) return { ok: false, error: "플레이어 캐릭터가 없습니다." };
  if (actor.injury === "dead") return { ok: false, error: "사망한 캐릭터는 판정할 수 없습니다." };

  const allowed = MOVE_STATS[input.move];
  if (!allowed.includes(input.stat)) {
    return { ok: false, error: `${input.move}에는 ${allowed.join(" 또는 ")} 능력치만 쓸 수 있습니다.` };
  }

  const modifiers = {
    stat: actor.stats[input.stat],
    difficulty: DIFFICULTY_MODIFIER[input.difficulty],
    injury: INJURY_PENALTY[actor.injury],
  };
  const roll = roll2d6(rng, modifiers.stat + modifiers.difficulty + modifiers.injury);
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
      moveLabel: MOVE_LABELS[input.move],
      statLabel: STAT_LABELS[input.stat],
      difficultyLabel: DIFFICULTY_LABELS[input.difficulty],
      dice: roll.dice,
      modifiers,
      total: roll.total,
      outcome: roll.outcome,
      outcomeLabel: CHECK_OUTCOME_LABELS[roll.outcome],
    },
  };
}
