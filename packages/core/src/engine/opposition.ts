import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { segmentOf } from "../rules/time.ts";
import { weatherNow } from "../sim/weather.ts";

/**
 * 상대와 상황 (기획서 4.1.1, 12-104): 주사위는 주인공만 굴린다. 상대의 실력·지켜보는 눈·어둠은 코드가 판정 보정으로 바꾼다.
 * - 상대 보정: 상대가 이 스킬에 맞서는 스킬(opposition.moves)의 능력 + 스킬 점수가 높으면 어렵고, 낮으면 쉽다
 * - 지켜보는 눈: 장면에 함께 있는 사람(동행 빼고)이 많으면 숨기 어렵다
 * - 어둠·날씨: 밤이나 안개·비면 숨기 쉽다
 * - 상대의 몫: 판정이 나빠 다칠 때, 싸움 실력이 좋은 상대는 한 단계 더, 서툰 상대는 한 단계 덜 다치게 한다
 * GM은 상황(지형, 거리, 엄폐)만 난이도로 고르고, 상대와 사람 수와 밝기는 고르지 않는다 (원칙 2)
 */

export type Part = { label: string; value: number };

const rules = (content: Content) => content.scenario.opposition;

/** 능력 + 스킬 (상한까지): 이 사람이 그 스킬로 얼마나 잘하는가 */
export function skillScore(content: Content, c: Character, moveId: string): number {
  const move = content.scenario.moves.find((m) => m.id === moveId);
  if (!move) return 0;
  const stat = Math.max(...move.stats.map((s) => c.stats[s] ?? 0));
  return Math.min(content.scenario.ranges.cap, stat + (c.skills[moveId] ?? move.default));
}

/** 상대 점수 → 판정 보정: 0~1 그대로, 2~3 -1, 4 -2, 음수면 +1 */
export function opposeModifier(score: number): number {
  return Math.max(-2, Math.min(1, -Math.floor(score / 2)));
}

/** 판정에 붙는 상대·상황 보정의 내역 (0인 것은 빼고) */
export function oppositionParts(content: Content, state: GameState, moveId: string, opponentId: string | null): Part[] {
  const r = rules(content);
  if (!r) return [];
  const parts: Part[] = [];
  const opposing = r.moves[moveId];
  const opponent = opponentId ? state.characters[opponentId] : undefined;
  if (opposing && opponent && !opponent.dead) {
    const value = opposeModifier(skillScore(content, opponent, opposing));
    const label = content.scenario.moves.find((m) => m.id === opposing)?.label ?? opposing;
    if (value) parts.push({ label: `${playerCalls(state, content, opponent.id)}의 ${label}`, value });
  }
  if (r.crowd?.moves.includes(moveId)) {
    const eyes = watchers(state).length;
    const value = -r.crowd.at.filter((n) => eyes >= n).length;
    if (value) parts.push({ label: `지켜보는 눈 ${eyes}`, value });
  }
  if (r.dark?.moves.includes(moveId) && r.dark.segments.includes(segmentOf(state.time))) parts.push({ label: "어둠", value: r.dark.value });
  if (r.visibility?.moves.includes(moveId)) {
    const weather = weatherNow(content.scenario, state);
    if (weather && weather.visibility < r.visibility.below) parts.push({ label: weather.label, value: r.visibility.value });
  }
  return parts.filter((p) => p.value !== 0);
}

/** 장면에서 주인공을 볼 수 있는 사람: 살아 있고, 함께 다니는 사람이 아니다 */
export function watchers(state: GameState): string[] {
  return state.scene.present.filter((id) => id !== state.playerId && !state.characters[id]?.dead && !state.companions.includes(id));
}

/**
 * 상대의 몫: 판정이 나빠 주인공이 다칠 때 상대의 싸움 실력으로 피해 단계를 고친다.
 * 돌려주는 것: 더하거나 뺄 단계와 한 줄 (상대가 없으면 null)
 */
export function opponentHarm(content: Content, state: GameState, opponentId: string | null): { delta: number; line: string } | null {
  const r = rules(content)?.harm;
  const opponent = opponentId ? state.characters[opponentId] : undefined;
  if (!r || !opponent || opponent.dead) return null;
  const best = r.moves
    .map((m) => ({ m, score: skillScore(content, opponent, m) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const delta = best.score >= r.strong ? 1 : best.score <= r.weak ? -1 : 0;
  const label = content.scenario.moves.find((m) => m.id === best.m)?.label ?? best.m;
  const who = playerCalls(state, content, opponent.id);
  const signed = best.score >= 0 ? `+${best.score}` : `${best.score}`;
  return {
    delta,
    line: `상대의 몫: ${who} (${label} ${signed})${delta > 0 ? " → 솜씨가 좋아 한 단계 더" : delta < 0 ? " → 서툴러 한 단계 덜" : ""}`,
  };
}
