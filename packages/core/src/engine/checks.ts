import { companionSkillMod } from "../game/companions.ts";
import { CHECK_OUTCOME_LABELS, DIFFICULTY_LABELS, DIFFICULTY_MODIFIER, roll2d6, type CheckOutcome, type Difficulty } from "../rules/check.ts";
import { attractionCheckBonus, traitSkillMod } from "./traits.ts";
import { conditionPenalty, moveOf, statLabel } from "../scenario/scenario.ts";
import { gainCheckXp } from "./growth.ts";
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
      /** 레벨이 올랐으면 GM에게 알릴 문장 */
      growthNote: string | null;
    }
  | { ok: false; error: string };

/**
 * 플레이어 캐릭터의 2d6 판정을 굴리고 check_rolled 이벤트로 기록한다.
 * 행동과 능력치는 시나리오에서 오고, 보정은 능력치 + 난이도 + 상태 트랙 보정이다.
 */
export function rollPlayerCheck(
  input: PlayerCheckInput,
  { store, rng, content }: ToolContext,
  options: { target?: string | null; forMission?: string | null } = {},
): PlayerCheckResult {
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

  // 능력 + 스킬은 상한까지만 (기획서 4.2). 몸 상태 보정은 그 뒤에 따로 뺀다
  // 트레잇의 스킬 보정도 상한 안에서 더한다. 끌림(상대가 이성에게 끌린다)은 상황 보정이라 따로 (기획서 4.6)
  const ability = actor.stats[input.stat] ?? 0;
  const skill = (actor.skills[input.move] ?? move.default) + traitSkillMod(content, actor, input.move) + (actor.id === state.playerId ? companionSkillMod(state, content, input.move) : 0);
  const capped = Math.min(scenario.ranges.cap, ability + skill);
  const target = options.target ? state.characters[options.target] : undefined;
  const modifiers = {
    stat: ability,
    skill: capped - ability,
    difficulty: DIFFICULTY_MODIFIER[input.difficulty],
    condition: conditionPenalty(scenario, actor),
    trait: attractionCheckBonus(content, actor, target, input.move),
  };
  const roll = roll2d6(rng, modifiers.stat + modifiers.skill + modifiers.difficulty + modifiers.condition + modifiers.trait);
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
    ...(options.target ? { target: options.target } : {}),
    ...(options.forMission ? { forMission: options.forMission } : {}),
  });

  const growthNote = gainCheckXp({ store, rng, content }, actor.id, roll.outcome);

  return {
    ok: true,
    checkId,
    growthNote,
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
