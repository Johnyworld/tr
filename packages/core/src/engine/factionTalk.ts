import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { traitsOf } from "./traits.ts";
import { moraleLabel, WAR_TOPIC } from "./warTools.ts";

/**
 * 무리 형편 (기획서 9.13, 12-105): 거점 사람들이 입에 올리는 우리 무리의 어려움.
 * 주인공이 거점에서 느끼는 것(분위기·배급·창고 사정)과 주인공이 들은 전황(믿음)만 쓴다. 다른 무리의 사정이나 숨은 사실은 넣지 않는다 (원칙 4)
 */

/** 최근 전황 소식으로 치는 시간 */
const NEWS_HOURS = 48;

/** 지금 우리 무리 사람들 사이에 도는 어려움. 없으면 빈 목록 */
export function factionTroubles(state: GameState, content: Content): string[] {
  const war = content.scenario.war;
  const player = state.characters[state.playerId];
  const own = player ? state.factions[player.factionId] : undefined;
  if (!war || !player || !own) return [];
  const out: string[] = [];
  if (own.morale <= -1) out.push(`분위기가 ${moraleLabel(content, own.morale)}`);
  const ration = rationLevel(content, own);
  if (ration !== war.ration.levels[0]) out.push(`배급: ${ration.label}`);
  // 창고: "빠듯하다"보다 나쁜 것만 (두 번째 문턱 아래)
  const tight = war.stock_labels[1]?.min_days ?? 7;
  for (const r of content.scenario.resources) {
    if ((war.upkeep[r.id] ?? 0) <= 0) continue;
    const days = daysOfStock(content, own, r.id);
    if (days < tight) out.push(`${r.label}: ${war.stock_labels.find((l) => days >= l.min_days)?.label ?? war.stock_labels.at(-1)!.label}`);
  }
  // 주인공이 들은 최근 전황 (믿음이라 주인공이 아는 것뿐)
  const news = (state.beliefs[player.id] ?? []).filter((b) => b.topic === WAR_TOPIC && state.time - b.learnedAt <= NEWS_HOURS * 60).slice(-2);
  for (const b of news) out.push(`전황: ${b.fact}`);
  return out;
}

/** 이 인물이 무리 형편을 대하는 태도: 트레잇이 가장 많이 겹치는 것, 없으면 기본 */
export function troubleAttitude(content: Content, c: Character): { label: string; hint: string } | null {
  const talk = content.scenario.war?.talk;
  if (!talk) return null;
  const traits = new Set(traitsOf(content, c).map((t) => t.id));
  let best: { label: string; hint: string; score: number } | null = null;
  for (const a of talk.attitudes) {
    const score = a.traits.filter((t) => traits.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { label: a.label, hint: a.hint, score };
  }
  return best ?? talk.default;
}

/** 인물 카드의 한 줄: 같은 무리 사람이고 어려움이 있을 때만 */
export function troubleLine(state: GameState, content: Content, c: Character): string | null {
  const player = state.characters[state.playerId];
  if (!player || c.id === player.id || c.dead || !c.factionId || c.factionId !== player.factionId) return null;
  const troubles = factionTroubles(state, content);
  const attitude = troubleAttitude(content, c);
  if (!troubles.length || !attitude) return null;
  return `무리 형편에 대해: ${attitude.label} (${attitude.hint}). 말을 섞으면 이런 말이 나올 수 있다: ${troubles.join(" · ")}`;
}
