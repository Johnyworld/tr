import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { Scenario } from "../scenario/schema.ts";

/**
 * 트레잇 효과 (기획서 4.6). 어떤 트레잇이 무엇을 하는지는 시나리오 `traits` 데이터, 여기는 효과 종류만 안다.
 * 판정·성장·몸 상태·목격자·소문·첫인상·끌림이 이 함수들로 트레잇을 읽는다
 */

export type TraitDef = Scenario["traits"][number];

/** 이 캐릭터의 트레잇 id. 이전 세이브의 NPC처럼 캐릭터에 없으면 콘텐츠의 것을 쓴다 */
export function traitIdsOf(content: Content, c: Pick<Character, "id" | "traits">): string[] {
  return c.traits.length ? c.traits : (content.npcs[c.id]?.traits ?? []);
}

export function traitsOf(content: Content, c: Pick<Character, "id" | "traits">): TraitDef[] {
  return traitIdsOf(content, c)
    .map((id) => content.scenario.traits.find((t) => t.id === id))
    .filter((t): t is TraitDef => t !== undefined);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const product = (xs: number[]) => xs.reduce((a, b) => a * b, 1);

/** 스킬 보정 (능력 + 스킬 상한 안에서 더한다) */
export function traitSkillMod(content: Content, c: Character, move: string): number {
  return sum(traitsOf(content, c).map((t) => t.effects.skills?.[move] ?? 0));
}

export function xpMultiplier(content: Content, c: Character): number {
  return product(traitsOf(content, c).map((t) => t.effects.xp ?? 1));
}

/** 몸 상태: 허기·추위 단계 ±, 질병·감염 확률 배수, 저절로 낫는 날 ± */
export function bodyTraits(content: Content, c: Character) {
  const ts = traitsOf(content, c);
  return {
    hunger: sum(ts.map((t) => t.effects.hunger ?? 0)),
    cold: sum(ts.map((t) => t.effects.cold ?? 0)),
    disease: product(ts.map((t) => t.effects.disease ?? 1)),
    infection: product(ts.map((t) => t.effects.infection ?? 1)),
    recoveryDays: sum(ts.map((t) => t.effects.recovery_days ?? 0)),
  };
}

/** 내가 한 일이 숨은 목격자에게 들킬 확률 배수 */
export const noticedFactor = (content: Content, c: Character) => product(traitsOf(content, c).map((t) => t.effects.noticed ?? 1));
/** 내가 남의 일을 목격할 확률 배수 */
export const alertnessFactor = (content: Content, c: Character) => product(traitsOf(content, c).map((t) => t.effects.alertness ?? 1));
/** 내가 소문을 옮길 확률 배수 */
export const rumorFactor = (content: Content, c: Character) => product(traitsOf(content, c).map((t) => t.effects.rumor ?? 1));
/** 외모 등급 (+2 아름다움, +1 호감형, -1 험악함, 0 보통) */
export const looksOf = (content: Content, c: Character) => sum(traitsOf(content, c).map((t) => t.effects.looks ?? 0));

/** 이성편력처럼 이성에게 끌리는지. 끌리면 쉬워지는 스킬 목록 */
export function attractionOf(content: Content, c: Character): string[] | null {
  const moves = traitsOf(content, c).flatMap((t) => t.effects.attraction?.moves ?? []);
  return moves.length ? moves : null;
}

/** 둘 다 성별이 있고 서로 다르다 */
export const oppositeSex = (a: Character, b: Character) => a.gender !== null && b.gender !== null && a.gender !== b.gender;
export const sameSex = (a: Character, b: Character) => a.gender !== null && b.gender !== null && a.gender === b.gender;

/** 끌림: target이 이성에게 끌리고 actor가 이성이면, actor가 target에게 쓰는 그 스킬 판정 +1 (actor가 아름다우면 +2) */
export function attractionCheckBonus(content: Content, actor: Character, target: Character | undefined, move: string): number {
  if (!target) return 0;
  const moves = attractionOf(content, target);
  if (!moves?.includes(move) || !oppositeSex(actor, target)) return 0;
  return looksOf(content, actor) >= 2 ? 2 : 1;
}

/**
 * viewer가 target을 처음 볼 때 외모로 생기는 호감 (기획서 4.6 "외모와 끌림").
 * 보통 = 외모 등급, 이성에게 끌리는 이성 = 외모가 +면 두 배, 이성에게 끌리는 동성 = 외모가 +면 질투로 그만큼 -
 */
export function looksImpression(content: Content, viewer: Character, target: Character): number {
  const looks = looksOf(content, target);
  if (looks <= 0) return looks;
  if (attractionOf(content, viewer)) {
    if (oppositeSex(viewer, target)) return looks * 2;
    if (sameSex(viewer, target)) return -looks;
  }
  return looks;
}

/**
 * from이 to를 향한 호감이 오를 때 더하는 양: 이성에게 끌리는 이성이면 +1,
 * 이성에게 끌리는 동성이 to의 외모를 질투하면 -1 (호감 상승을 0 밑으로 내리지는 않는다, 호출하는 쪽이 자른다)
 */
export function affectionTraitBonus(content: Content, from: Character, to: Character): number {
  if (!attractionOf(content, from)) return 0;
  if (oppositeSex(from, to)) return 1;
  if (sameSex(from, to) && looksOf(content, to) > 0) return -1;
  return 0;
}

/** 보여 줄 트레잇 이름들. visibleOnly면 처음 보는 사람에게도 보이는 것만 */
export function traitLabels(content: Content, c: Character, options: { visibleOnly?: boolean; acting?: boolean } = {}): string[] {
  return traitsOf(content, c)
    .filter((t) => !options.visibleOnly || t.visible)
    .map((t) => (options.acting && t.acting ? `${t.label}(${t.acting})` : t.label));
}
