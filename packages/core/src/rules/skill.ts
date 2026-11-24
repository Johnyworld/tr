/**
 * 공통 규칙 12: 판정과 스킬 (docs/design.md "공통 규칙").
 *
 * 누가 무엇을 얼마나 할 수 있는지는 여기서 정하고, 그 설명(상태의 스킬 줄, 보정 줄의 표기, 가르칠 수 있는 것, 출신이 준 것)도
 * 여기서 만든다 (12-241, 플레이 테스트 13: "못 함은 판정할 수 없다"는 문구와 달리 지혈은 -1로 굴렸고, 상대 보정 줄은 방향이 없었다).
 * - 배운 값: 누구나 하는 일은 적혀 있지 않으면 미숙(스킬 최저값), 전문 기술은 적혀 있지 않으면 못 함(null)
 * - 못 함이어도 굴리는 때 (purpose): 지혈(staunch, 시나리오의 wounds.staunch_move)은 누구나 미숙으로, 버티는 판정(reaction)은 0으로
 * - 보이는 값 (shownSkill): 판정에 실제로 쓰는 값 = 배운 값 + 트레잇 보정. ?상태·GM 상태·시트가 모두 이것을 쓴다
 *   (PT14: ?상태는 배운 값만, GM 상태는 트레잇까지 더해 "버티기 -1 / +0", "거짓말 -1 / -2"로 어긋났다)
 * 배운 값은 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { Content } from "../content/schemas.ts";
import type { Scenario } from "../scenario/schema.ts";
import { learnedSkill } from "../scenario/scenario.ts";
import { josa } from "../text.ts";
import type { Character } from "../game/character.ts";
import { canUseSkill, effectiveSkill, traitSkillMod } from "../engine/traits.ts";

type Skills = Partial<Record<string, number>>;

/** 배운 값 (못 함이면 null) */
export function learned(s: Scenario, skills: Skills, move: string): number | null {
  return learnedSkill(s, skills, move);
}

/** 보이는 스킬 값: 판정에 쓰는 값(배운 값 + 트레잇 보정). 못 하는 전문 기술이면 null */
export function shownSkill(content: Content, c: Pick<Character, "id" | "skills" | "traits">, move: string): number | null {
  return canUseSkill(content, c, move) ? effectiveSkill(content, c, move) : null;
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v}`;

/** 스킬을 분류별 한 줄씩: "전투  근접전 +1 · 사격 -1 · 손질 못 함". 값은 보이는 값(트레잇 보정 포함), 보정이 있으면 "(트레잇 +1)" */
export function skillLines(content: Content, c: Pick<Character, "id" | "skills" | "traits">): string[] {
  const groups = new Map<string, string[]>();
  for (const m of content.scenario.moves) {
    const key = m.category ?? "스킬";
    const value = shownSkill(content, c, m.id);
    const mod = traitSkillMod(content, c as Character, m.id);
    const list = groups.get(key) ?? [];
    list.push(`${m.label} ${value === null ? "못 함" : `${signed(value)}${mod ? ` (트레잇 ${signed(mod)})` : ""}`}`);
    groups.set(key, list);
  }
  return [...groups].map(([k, list]) => `${k}  ${list.join(" · ")}`);
}

/** 못 함이어도 굴리는 까닭 */
export type AttemptPurpose = "staunch" | "reaction";

/** 이 판정을 굴릴 때의 스킬 값 (못 함이고 예외도 아니면 null) */
export function attemptValue(s: Scenario, skills: Skills, move: string, purpose?: AttemptPurpose | null): number | null {
  const v = learned(s, skills, move);
  if (v !== null) return v;
  if (purpose === "staunch" && move === s.wounds?.staunch_move) return s.ranges.skill.min;
  if (purpose === "reaction") return 0;
  return null;
}

/** 상태의 스킬 줄에 붙는 못 함의 설명 (실제 규칙과 같은 말) */
export function unlearnedNote(s: Scenario): string {
  const staunch = s.wounds?.staunch_move ? s.moves.find((m) => m.id === s.wounds!.staunch_move) : undefined;
  return `"못 함"은 배우지 않은 전문 기술: 판정할 수 없다${staunch ? ` (다만 피를 멎게 하는 ${staunch.label}은 못 함이어도 ${s.ranges.skill.min}로 굴린다)` : ""}`;
}

/** 상대 보정 줄의 표기: 방향과 누구인지 (0이어도 보인다) */
export function opposedLabel(value: number, skillLabel: string, who: string): string {
  if (value > 0) return `상대가 ${skillLabel}에 서툶: ${who}`;
  if (value < 0) return `상대가 ${skillLabel}에 능함: ${who}`;
  return `${who}의 ${skillLabel}`;
}

/** 가르칠 수 있는 것: 배운 값이 1 이상인 스킬 (take_action.lesson의 조건) */
export function teachable(content: Content, skills: Skills): string[] {
  return content.scenario.moves.filter((m) => (learned(content.scenario, skills, m.id) ?? -99) >= 1).map((m) => `${m.label}(${learned(content.scenario, skills, m.id)})`);
}

/** 출신(과거 배경)이 준 것: 스킬과 물건 */
export function pastGiven(content: Content, pastId: string | null | undefined): string | null {
  const past = content.scenario.creation?.pasts.find((p) => p.id === pastId);
  if (!past) return null;
  const skills = Object.entries(past.skills).filter(([, v]) => v > 0).map(([id, v]) => `${content.scenario.moves.find((m) => m.id === id)?.label ?? id} +${v}`);
  const items = past.items.map((id) => content.items[id]?.name ?? id);
  const all = [...skills, ...items];
  return all.length ? `준 것: ${all.join(", ")}` : null;
}

/** 못 함인 스킬로 판정하려 할 때의 거절 문구 */
export function cannotAttempt(label: string): string {
  return `${josa(label, "은/는")} 배우지 않아 할 수 없는 전문 기술이다. 판정하지 않는다: 배운 사람에게 맡기거나, 그 스킬을 익힌 사람에게 배운다(take_action.lesson). 할 수 없는 일로 서술한다.`;
}

/**
 * 그 스킬로 굴릴 때 주인공에게 가장 나은 능력 (공통 규칙 12). 도구가 능력을 고를 때 첫 능력만 쓰지 않는다
 * (PT21·PT22 하얀매: 수색을 감각 +1로 굴렸는데 지능 +2였다)
 */
export function bestStatOf(state: { playerId: string; characters: Record<string, { stats: Record<string, number> } | undefined> }, move: { stats: readonly string[] }): string {
  const me = state.characters[state.playerId];
  return [...move.stats].sort((a, b) => (me?.stats[b] ?? 0) - (me?.stats[a] ?? 0))[0]!;
}
