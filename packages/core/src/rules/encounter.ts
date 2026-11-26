import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { Rng } from "../rng.ts";
import { MINUTES_PER_DAY } from "./time.ts";
import { attemptValue } from "./skill.ts";

/**
 * 공통 규칙 23 마주침 (docs/war-parties-plan.md 파트 4, 9).
 * 같은 구역에 들어선 둘이 서로를 알아채는가, 알아챈 쪽이 무엇을 하는가를 한 곳에서 정한다.
 * 부대끼리든 주인공과 부대든 같은 셈을 쓴다 (따로 정하면 "정찰대인데 주인공은 쉽게 보고 부대끼리는 못 본다"가 생긴다).
 *
 * 알아채기 = 2d6 + 보는 쪽 보정 − 숨는 쪽 가림 ≥ NOTICE_TARGET
 * - 보는 쪽 보정: 정찰대 +2, 주인공은 그 판정의 능력 + 스킬 (상한 +4, 판정과 같다)
 * - 가림: 숨어 기다리는 중 +1, 밤 +2, 구역의 엄폐 3마다 +1
 */
export const NOTICE_TARGET = 8;
/** 판정의 능력 + 스킬 상한 (핵심 규칙 요약: 합쳐서 최대 +4) */
const BONUS_CAP = 4;

export type Concealment = { hiding?: boolean; night: boolean; cover: number };

/** 밤 (20시 ~ 6시) */
export function isNight(t: number): boolean {
  const h = Math.floor((((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60);
  return h < 6 || h >= 20;
}

export function concealment(c: Concealment): number {
  return (c.hiding ? 1 : 0) + (c.night ? 2 : 0) + Math.floor(Math.max(0, c.cover) / 3);
}

/** 한 번 굴려 알아채는가 */
export function notices(rng: Rng, bonus: number, hidden: Concealment): boolean {
  const roll = 1 + Math.floor(rng() * 6) + 1 + Math.floor(rng() * 6);
  return roll + bonus - concealment(hidden) >= NOTICE_TARGET;
}

/** 부대의 보는 보정: 정찰대는 살피러 나온 사람들이다 */
export function partyNoticeBonus(kind: string, intercept = false): number {
  // 가로막으러 숨어 기다리는 부대는 길을 지켜본다 (5-3·5-4): 정찰과 같은 눈
  return kind === "scout" || intercept ? 2 : 0;
}

/** 주인공(사람)의 보는 보정: 시나리오의 알아채기 판정(war.parties.notice_move)의 가장 나은 능력 + 스킬, 상한 +4 */
export function personNoticeBonus(content: Content, c: Pick<Character, "stats" | "skills">): number {
  const moveId = content.scenario.war?.parties?.notice_move;
  const move = moveId ? content.scenario.moves.find((m) => m.id === moveId) : undefined;
  if (!move) return 0;
  const stat = Math.max(...move.stats.map((s) => c.stats[s] ?? 0));
  const skill = attemptValue(content.scenario, c.skills, move.id) ?? 0;
  return Math.min(BONUS_CAP, stat + Math.max(0, skill));
}

/** 서로 알아채기: 둘 다 못 봄 / 한쪽만 / 둘 다 */
export function sightings(rng: Rng, a: { bonus: number; hidden: Concealment }, b: { bonus: number; hidden: Concealment }): { aSees: boolean; bSees: boolean } {
  return { aSees: notices(rng, a.bonus, b.hidden), bSees: notices(rng, b.bonus, a.hidden) };
}

export type PartyChoice = "fight" | "avoid";

/**
 * 알아챈 부대가 무엇을 하는가 (4-2, 결정적): 정찰·짐 행렬은 피하고 세 배가 넘을 때만 싸운다.
 * 순찰은 자기 땅이면 싸우고 남의 땅이면 두 배가 넘을 때만. 습격·공세는 가는 길에 만난 상대를 피하고 두 배가 넘으면 싸운다
 */
export function partyChoice(me: { kind: string; size: number; onOwnLand: boolean; intercept?: boolean; returning?: boolean }, other: { size: number }): PartyChoice {
  // 가로막으러 나간 부대는 보면 친다 (5-3·5-4)
  if (me.intercept) return "fight";
  // 할 일을 마치고 돌아가는 정찰·운반은 먼저 덤비지 않는다 (PT37 졸병, 사용자 결정: 일을 마친 정찰대 넷이 우리 초소 망루로 덤벼 왔다)
  if (me.returning && (me.kind === "scout" || me.kind === "supply")) return "avoid";
  const ratio = me.size / Math.max(1, other.size);
  if (me.kind === "scout" || me.kind === "supply") return ratio > 3 ? "fight" : "avoid";
  if (me.kind === "patrol") return me.onOwnLand || ratio > 2 ? "fight" : "avoid";
  return ratio > 2 ? "fight" : "avoid";
}

/** 매복은 자기 땅에서만 (4-3, AI 부대). 가로막으러 나간 부대(주인공이 내게 한 부대·분대)는 남의 땅에서도. 매복한 쪽의 첫 교환 화력 배수 */
export const AMBUSH_FACTOR = 1.5;
export function canAmbush(onOwnLand: boolean, intercept = false): boolean {
  return onOwnLand || intercept;
}
