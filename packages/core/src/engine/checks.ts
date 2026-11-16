import { gearModifiers } from "./gear.ts";
import { companionSkillMod } from "../game/companions.ts";
import { squadFollowBonus } from "./command.ts";
import { CHECK_OUTCOME_LABELS, DIFFICULTY_LABELS, DIFFICULTY_MODIFIER, roll2d6, type CheckOutcome, type Difficulty } from "../rules/check.ts";
import { attractionCheckBonus, traitSkillMod, traitsOf } from "./traits.ts";
import { conditionPenalty, moveOf, shownLevel, statLabel, visibleSymptoms } from "../scenario/scenario.ts";
import type { Scenario } from "../scenario/schema.ts";
import type { Character } from "../game/character.ts";
import { gainCheckXp } from "./growth.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/** distance: 장면의 인물을 칠 때 상대와의 거리 (12-93). 무기의 거리 보정이 붙는다 */
export type PlayerCheckInput = { move: string; stat: string; difficulty: Difficulty; intent: string; distance?: string | null };

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
  const base = actor.skills[input.move] ?? move.default;
  const companion = actor.id === state.playerId ? companionSkillMod(state, content, input.move) : 0;
  const squad = actor.id === state.playerId ? squadFollowBonus(state, content, input.move) : 0;
  const skill = base + traitSkillMod(content, actor, input.move) + Math.max(companion, squad);
  // 손에 든 무기·지닌 도구의 보정은 상한 안에서, 방어구·짐의 불리함은 따로 (기획서 4.8)
  const gear = gearModifiers(content, actor, input.move, input.distance);
  const capped = Math.min(scenario.ranges.cap, ability + skill + gear.skill);
  // 판정 줄에 보일 상한 안의 내역: 스킬, 트레잇, 동행·분대, 무기·도구, 상한에 잘린 만큼
  const cappedParts = [
    { label: statLabel(scenario, input.stat), value: ability },
    { label: move.label, value: base },
    ...traitsOf(content, actor).map((t) => ({ label: t.label, value: t.effects.skills?.[input.move] ?? 0 })),
    { label: companion >= squad ? "동행" : "분대", value: Math.max(companion, squad) },
    { label: gear.skillLabel, value: gear.skill },
    { label: "상한", value: capped - (ability + skill + gear.skill) },
  ];
  const target = options.target ? state.characters[options.target] : undefined;
  const modifiers = {
    stat: ability,
    skill: capped - ability,
    difficulty: DIFFICULTY_MODIFIER[input.difficulty],
    condition: conditionPenalty(scenario, actor),
    trait: attractionCheckBonus(content, actor, target, input.move),
    gear: gear.penalty,
  };
  const roll = roll2d6(rng, modifiers.stat + modifiers.skill + modifiers.difficulty + modifiers.condition + modifiers.trait + modifiers.gear);
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
      line: checkLine(move.label, [
        ...cappedParts,
        { label: DIFFICULTY_LABELS[input.difficulty], value: modifiers.difficulty },
        { label: conditionLabel(scenario, actor), value: modifiers.condition },
        { label: "끌림", value: modifiers.trait },
        ...gear.penaltyParts,
      ], roll.dice, roll.total, CHECK_OUTCOME_LABELS[roll.outcome]),
    },
  };
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/**
 * 플레이어에게 그대로 보일 판정 한 줄. GM은 옮겨 적기만 한다 (원칙 2).
 * 예: 🎲 사격: +2(민첩) +2(사격) +1(소총) -1(상한) -1(어려움) +9(주사위) = 10 · 성공. 0인 보정은 뺀다
 */
export function checkLine(moveLabel: string, parts: { label: string; value: number }[], dice: [number, number], total: number, outcomeLabel: string): string {
  const terms = [...parts.filter((p) => p.value !== 0), { label: "주사위", value: dice[0] + dice[1] }].map((p) => `${signed(p.value)}(${p.label})`);
  return `🎲 ${moveLabel}: ${terms.join(" ")} = ${total} · ${outcomeLabel}`;
}

/** 몸 상태 보정의 이름: 보정이 붙은 증상들, 증상이 없는 월드는 상태 트랙의 단계 이름 */
function conditionLabel(s: Scenario, c: Pick<Character, "conditions">): string {
  const names = s.symptoms?.length
    ? visibleSymptoms(s, c).filter((x) => x.penalty < 0).map((x) => x.label)
    : s.condition_tracks.flatMap((t) => {
        const level = t.levels.find((l) => l.id === c.conditions[t.id]);
        return level?.penalty ? [shownLevel(t, level.id).label ?? t.label] : [];
      });
  return names.join("·") || "몸 상태";
}
