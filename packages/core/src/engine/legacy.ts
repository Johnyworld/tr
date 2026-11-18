import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import { tiesOf } from "../game/ties.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 유품과 이어지는 끈 (기획서 3.2.3, 12-158).
 * - 가까운 사람: 죽은 주인공과 관계(앙숙 빼고)가 있거나, 그를 향한 호감이 legacy.close_affection 이상인 사람
 * - 가까운 사람이 뒤를 이으면 앞사람의 사물함·거처의 짐을 물려받는다 (stash_inherited)
 * - 가까운 사람은 이야기 배역 mourner가 된다: 앞사람을 기억하고 이야기한다
 */

/** b가 a(죽은 사람)와 가까운가 */
export function closeTo(state: GameState, content: Content, deadId: string, otherId: string): boolean {
  const rule = content.scenario.legacy;
  if (!rule) return false;
  if (tiesOf(state, content, deadId).some((t) => t.other === otherId && t.kind !== "rival")) return true;
  return (state.relations[otherId]?.[deadId] ?? NEUTRAL_RELATION).affection >= rule.close_affection;
}

/** 이 사람이 기억하는 죽은 앞 주인공들 (최근에 죽은 사람부터) */
export function mournedBy(state: GameState, content: Content, id: string): string[] {
  if (!content.scenario.legacy) return [];
  return state.chronicle
    .filter((r) => r.characterId !== state.playerId && r.characterId !== id && closeTo(state, content, r.characterId, id))
    .sort((a, b) => b.diedAt - a.diedAt)
    .map((r) => r.characterId);
}

/** 뒤를 이은 사람이 가까운 사람이면 앞사람들의 사물함·거처의 짐을 물려받는다. 알릴 줄 */
export function inheritStashes(ctx: ToolContext, deadIds: string[]): string[] {
  const lines: string[] = [];
  const state = ctx.store.getState();
  const heir = state.playerId;
  for (const dead of deadIds) {
    const places = state.stashes[dead];
    if (!places || !Object.keys(places).length || !closeTo(ctx.store.getState(), ctx.content, dead, heir)) continue;
    ctx.store.append({ type: "stash_inherited", from: dead, to: heir });
    const where = Object.keys(places).map((z) => ctx.content.locations[z]?.name ?? z);
    const name = state.characters[dead]?.name ?? dead;
    lines.push(`${name}의 짐이 이 사람 몫이 됐다: ${where.join("·")}에 맡겨 둔 것 (가까운 사이라 물려받았다). 그곳에 가면 꺼낼 수 있다.`);
  }
  return lines;
}

/** 장례 (12-163): 사흘 안에 죽은 우리 무리의 이름 있는 사람 (가장 최근). 주인공이 그 죽음을 아는지는 묻지 않는다 (같은 무리에는 소식이 돈다) */
export function recentlyDeadComrade(state: GameState, content: Content, at: number = state.time): string | null {
  const me = state.characters[state.playerId];
  if (!me?.factionId) return null;
  const days = content.scenario.legacy?.funeral_days ?? 3;
  const r = state.remains
    .filter((x) => x.of !== state.playerId && !!content.npcs[x.of] && state.characters[x.of]?.factionId === me.factionId && at - x.diedAt <= days * 24 * 60)
    .sort((a, b) => b.diedAt - a.diedAt)[0];
  return r?.of ?? null;
}
