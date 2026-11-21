import { playerCalls } from "../game/acquaintance.ts";
import { heldOf } from "../rules/held.ts";
import { gearModifiers } from "./gear.ts";
import { oppositionParts, type Part } from "./opposition.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { afterCheckAmbush, ambushParts } from "./ambush.ts";
import { companionSkillMod } from "../game/companions.ts";
import { helperFor } from "../rules/company.ts";
import { CHECK_OUTCOME_LABELS, DIFFICULTY_LABELS, DIFFICULTY_MODIFIER, roll2d6, type CheckOutcome, type Difficulty } from "../rules/check.ts";
import { personaCheckParts } from "./persona.ts";
import { attractionCheckBonus, traitSkillMod, traitsOf } from "./traits.ts";
import { conditionPenalty, learnedSkill, moveOf, shownLevel, statLabel, penaltySymptoms } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import type { Scenario } from "../scenario/schema.ts";
import type { Character } from "../game/character.ts";
import { gainCheckXp } from "./growth.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { attemptValue, cannotAttempt, type AttemptPurpose } from "../rules/skill.ts";

/** distance: 장면의 인물을 칠 때 상대와의 거리 (12-93). 무기의 거리 보정이 붙는다 */
/** opponent: 맞서는 상대 (12-104). 상대의 실력이 판정 보정이 된다 */
export type PlayerCheckInput = { move: string; stat: string; difficulty: Difficulty; intent: string; distance?: string | null; opponent?: string | null };

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
      /** 매복·혼란 (12-177): 쓰였거나 생긴 것 */
      ambushNotes: string[];
    }
  | { ok: false; error: string };

type CheckDisplay = Extract<ToolDisplayEvent, { type: "check" }>;

/** 버티는 판정(reaction)의 판정 줄을 tool이 끝날 때까지 모은다. 어디서 굴렸든 executeTool이 결과에 붙인다 (사람이 죽는 것을 본 마음 다잡기처럼 결과를 돌려주지 않는 곳) */
const reactionChecks = new WeakMap<object, CheckDisplay[]>();

/** 모아 둔 버티는 판정을 꺼낸다 (꺼내면 비운다) */
export function takeReactionChecks(store: ToolContext["store"]): CheckDisplay[] {
  const list = reactionChecks.get(store) ?? [];
  reactionChecks.delete(store);
  return list;
}

/**
 * 플레이어 캐릭터의 2d6 판정을 굴리고 check_rolled 이벤트로 기록한다.
 * 행동과 능력치는 시나리오에서 오고, 보정은 능력치 + 난이도 + 상태 트랙 보정이다.
 */
/** 이야기 배역이 무리(crowd 2 이상)면 그 상대와 맞서는 판정에 -1 */
function crowdParts(content: Content, state: GameState, opponent: string | null): Part[] {
  const a = state.activeStorylet;
  if (!a || !opponent) return [];
  const key = Object.entries(a.cast).find(([, id]) => id === opponent)?.[0];
  const n = key ? content.storylets[a.id]?.cast[key]?.crowd : undefined;
  return n && n >= 2 ? [{ label: `상대가 여럿 (${n}명)`, value: -1 }] : [];
}

export function rollPlayerCheck(
  input: PlayerCheckInput,
  { store, rng, content }: ToolContext,
  /** noTools: 무기·도구의 보정을 붙이지 않는다 (동물 가르치기처럼 물건이 거들 수 없는 일) */
  /** purpose: 못 함이어도 굴리는 까닭 (지혈·버티는 판정, 공통 규칙 12) */
  /** reaction: 주인공이 하는 일이 아니라 닥친 일에 버티는 판정 (마음 다잡기, 12-220). 매복·혼란을 쓰지 않고 경험도 주지 않는다 */
  /** situation: 그 일의 상황 보정 (수색할 곳의 넉넉함, 다시 뒤짐 같은 것, 12-220) */
  options: { target?: string | null; forMission?: string | null; noTools?: boolean; forage?: string | null; purpose?: AttemptPurpose | null; dest?: string | null; toolItem?: string | null; activity?: string | null; stakes?: boolean; escape?: boolean; reaction?: boolean; situation?: { label: string; value: number }[] } = {},
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
  // 전문 기술은 배우기 전엔 판정할 수 없다 (4.2.1)
  // 할 수 있는지와 못 함의 예외는 공통 규칙 12 (rules/skill.ts)
  const learned = attemptValue(scenario, actor.skills, input.move, options.purpose);
  if (learned === null) return { ok: false, error: cannotAttempt(move.label) };
  const ability = actor.stats[input.stat] ?? 0;
  const base = learned;
  const companion = actor.id === state.playerId ? companionSkillMod(state, content, input.move) : 0;
  // 곁의 사람이 돕는다 (공통 규칙 8, rules/company.ts)
  const helper = actor.id === state.playerId ? helperFor(state, content, input.move) : null;
  const squad = helper?.bonus ?? 0;
  const skill = base + traitSkillMod(content, actor, input.move) + Math.max(companion, squad);
  // 손에 든 무기·지닌 도구의 보정은 상한 안에서, 방어구·짐의 불리함은 따로 (기획서 4.8)
  const rawGear = gearModifiers(content, actor, input.move, input.distance, state, options.forage ?? null, { ...(options.toolItem !== undefined ? { item: options.toolItem } : {}), activity: options.activity ?? null });
  const gear = options.noTools ? { ...rawGear, skill: 0 } : rawGear;
  const capped = Math.min(scenario.ranges.cap, ability + skill + gear.skill);
  // 판정 줄에 보일 상한 안의 내역: 스킬, 트레잇, 동행·분대, 무기·도구, 상한에 잘린 만큼
  const cappedParts = [
    { label: statLabel(scenario, input.stat), value: ability },
    { label: move.label, value: base },
    ...traitsOf(content, actor).map((t) => ({ label: t.label, value: t.effects.skills?.[input.move] ?? 0 })),
    { label: companion >= squad ? "동행" : `${josa(playerCalls(state, content, helper!.id), "이/가")} 도움`, value: Math.max(companion, squad) },
    { label: gear.skillLabel, value: gear.skill },
    { label: "상한", value: capped - (ability + skill + gear.skill) },
  ];
  const target = options.target ? state.characters[options.target] : undefined;
  // 성격의 득 (12-107): 다혈질은 위협에 +1 같은 것. 끌림처럼 상한 밖의 상황 보정
  const temperament = personaCheckParts(content, actor, input.move);
  const modifiers = {
    stat: ability,
    skill: capped - ability,
    difficulty: DIFFICULTY_MODIFIER[input.difficulty],
    condition: conditionPenalty(scenario, actor),
    trait: attractionCheckBonus(content, actor, target, input.move) + temperament.reduce((n, p) => n + p.value, 0),
    gear: gear.penalty,
    opposition: 0,
  };
  // 상대와 상황 (12-104): 맞서는 상대가 없으면 공격 대상이 상대다. 함께하는 말(설득)의 대상은 상대가 아니다 (플레이 테스트 11)
  const cooperative = scenario.opposition?.cooperative.includes(input.move) ?? false;
  const opponent = input.opponent ?? (cooperative ? null : options.target) ?? null;
  // 매복·매복당함·혼란 (12-177)도 상황 보정이다
  const against = [
    ...oppositionParts(content, state, input.move, opponent, input.distance),
    ...(options.reaction ? [] : ambushParts(content, state, input.move, opponent)),
    ...(options.situation ?? []),
    // 여럿이 막아섰다 (플레이 테스트 13: 넷이 막아섰는데 한 사람과만 맞섰다): 이야기 배역의 crowd
    ...crowdParts(content, state, opponent),
  ];
  // 갇힌 곳의 감시 (플레이 테스트 12): 탈출에 실패한 만큼 탈출 판정이 어렵다
  // 탈출 판정(갇힌 채 옮겨 가기)에만 (플레이 테스트 13: 광장 이야기의 버티기에도 -3이 붙었다)
  if (heldOf(actor)?.watch && options.escape) against.push({ label: "감시", value: -(heldOf(actor)!.watch ?? 0) });
  modifiers.opposition = against.reduce((n, p) => n + p.value, 0);
  const roll = roll2d6(rng, modifiers.stat + modifiers.skill + modifiers.difficulty + modifiers.condition + modifiers.trait + modifiers.gear + modifiers.opposition);
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
    ...(opponent ? { opponent } : {}),
    ...(options.forMission ? { forMission: options.forMission } : {}),
    ...(options.dest ? { dest: options.dest } : {}),
  });

  // 걸린 것이 없는 판정은 경험치가 없다 (플레이 테스트 12: 5분짜리 판정을 되풀이해 레벨을 올렸다)
  const growthNote = options.reaction || options.stakes === false ? null : gainCheckXp({ store, rng, content }, actor.id, roll.outcome);
  const ambushNotes = options.reaction ? [] : afterCheckAmbush({ store, rng, content }, input.move, opponent, roll.outcome, state);

  const display: CheckDisplay = {
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
      { label: "끌림", value: modifiers.trait - temperament.reduce((n, p) => n + p.value, 0) },
      ...temperament,
      ...gear.penaltyParts,
      ...against,
    ], roll.dice, roll.total, CHECK_OUTCOME_LABELS[roll.outcome]),
  };
  if (options.reaction) reactionChecks.set(store, [...(reactionChecks.get(store) ?? []), display]);

  return {
    ok: true,
    checkId,
    growthNote,
    ambushNotes,
    outcome: roll.outcome,
    dice: roll.dice,
    modifier: roll.modifier,
    total: roll.total,
    display,
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
    ? penaltySymptoms(s, c).filter((x) => x.penalty < 0).map((x) => x.label)
    : s.condition_tracks.flatMap((t) => {
        const level = t.levels.find((l) => l.id === c.conditions[t.id]);
        return level?.penalty ? [shownLevel(t, level.id).label ?? t.label] : [];
      });
  return names.join("·") || "몸 상태";
}
