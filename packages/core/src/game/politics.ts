import { heldOf } from "../rules/held.ts";
import type { Content } from "../content/schemas.ts";
import { NEUTRAL_RELATION } from "./reputation.ts";
import type { GameState } from "./state.ts";

/**
 * 무리 안의 신망 (기획서 9.17, 12-152). 같은 무리의 이름 있는 사람 가운데 그 사람을 믿지 않는(신뢰 ≤ DISTRUST) 사람과
 * 믿는(신뢰 ≥ TRUST) 사람을 센다. 새 숫자를 저장하지 않고 지금 관계에서 계산한다 (재판·불신임·반란·추대 이야기의 조건)
 */
export const DISTRUST_AT = -4;
export const TRUST_AT = 4;

/** 그 사람과 같은 무리의 이름 있는 사람 (살아 있고 떠나지 않았고 붙잡히지 않은). 무소속이면 없다 */
export function factionPeers(state: GameState, content: Content, who: string): string[] {
  const faction = state.characters[who]?.factionId;
  if (!faction) return [];
  return Object.values(state.characters)
    .filter((c) => c.id !== who && c.factionId === faction && !c.dead && !c.away && !heldOf(c) && (content.npcs[c.id] || c.profile))
    .map((c) => c.id);
}

/** 무리 안에서 그 사람을 믿지 않는 사람 수와 믿는 사람 수 */
export function standingInFaction(state: GameState, content: Content, who: string): { distrust: number; trust: number } {
  let distrust = 0;
  let trust = 0;
  for (const id of factionPeers(state, content, who)) {
    const t = (state.relations[id]?.[who] ?? NEUTRAL_RELATION).trust;
    if (t <= DISTRUST_AT) distrust += 1;
    if (t >= TRUST_AT) trust += 1;
  }
  return { distrust, trust };
}
