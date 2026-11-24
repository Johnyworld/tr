/**
 * 공통 규칙 20: 무리 사이와 사람 사이 (docs/design.md "공통 규칙", 12-296, 사용자 결정).
 *
 * 무리 사이는 따로 저장하지 않고 지금 무리 태도(disposition)를 그때그때 읽는다: 전쟁이면 바로 나빠지고 휴전·종전이면 바로 중립.
 * 개인 관계(신뢰·호감·존중)는 무리 사이와 상관없이 그대로다. 둘이 엇갈릴 때만 이 규칙이 끼어든다 (NPC 쪽에만, 굴림 없음):
 * - 전쟁 중 + 각별함(호감 fond_affection 이상): 먼저 치지 않는다(위협 이야기의 배역으로 뽑지 않는다).
 *   맞서도 목숨은 빼앗지 않는다: 그 사람이 낸 상처는 harm_stops_before 단계 바로 앞에서 멈추고, 쓰러진 주인공은 죽이지 않고 붙잡아 간다
 * - 전쟁이 아님(같은 무리·휴전·동맹·중립) + 원수(신뢰 grudge_trust 이하): 곁에 두지 않는다.
 *   이야기 배역·임무 짝·분대로 뽑지 않고, 장면에 들어와도 피할 뿐이다 (사람을 정해 둔 배역 ids는 그 사람의 이야기라 그대로)
 * 주인공이 각별한 적을 치는 것은 막지 않는다. 수치는 시나리오의 crossed (원칙 7)
 */
import type { Content } from "../content/schemas.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { disposition, HOSTILE } from "../sim/war.ts";

function rules(content: Content) {
  return content.scenario.crossed;
}

/** 그 사람의 무리와 주인공의 무리가 지금 전쟁 중인가 (어느 한쪽이라도 적대) */
export function factionsAtWar(state: GameState, content: Content, npcId: string): boolean {
  const mine = state.characters[state.playerId]?.factionId;
  const theirs = state.characters[npcId]?.factionId;
  if (!mine || !theirs || mine === theirs) return false;
  return [disposition(content, theirs, mine, state), disposition(content, mine, theirs, state)].some((d) => d <= HOSTILE);
}

const toPlayer = (state: GameState, npcId: string) => state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION;

/** 전쟁 중인 무리 사람인데 주인공에게 각별하다: 먼저 치지 않고, 목숨은 빼앗지 않는다 */
export function sparesPlayer(state: GameState, content: Content, npcId: string): boolean {
  const r = rules(content);
  if (!r || npcId === state.playerId) return false;
  return factionsAtWar(state, content, npcId) && toPlayer(state, npcId).affection >= r.fond_affection;
}

/** 전쟁 중이 아닌데 주인공의 원수다: 곁에 두지 않는다 */
export function keepsAway(state: GameState, content: Content, npcId: string): boolean {
  const r = rules(content);
  if (!r || npcId === state.playerId || !state.characters[npcId]?.factionId) return false;
  return !factionsAtWar(state, content, npcId) && toPlayer(state, npcId).trust <= r.grudge_trust;
}

/** 이 사람이 낸 상처로 주인공이 다칠 단계 수의 한계 (목숨을 빼앗지 않는 사람이면). 없으면 null */
export function spareCap(state: GameState, content: Content, opponentId: string | null | undefined, track: { id: string; levels: { id: string }[] }, current: string): number | null {
  const r = rules(content);
  if (!r || !opponentId || !sparesPlayer(state, content, opponentId)) return null;
  const stop = track.levels.findIndex((l) => l.id === r.harm_stops_before);
  if (stop <= 0) return null;
  const now = Math.max(0, track.levels.findIndex((l) => l.id === current));
  return Math.max(0, stop - 1 - now);
}

/** 쓰러진 주인공 곁의 적 가운데 목숨을 빼앗지 않는 사람이 있는가 */
export function anySparer(state: GameState, content: Content, ids: readonly string[]): boolean {
  return ids.some((id) => sparesPlayer(state, content, id));
}

/** GM 사람 카드의 한 줄 (엇갈릴 때만). 없으면 null */
export function crossedLine(state: GameState, content: Content, npcId: string): string | null {
  if (sparesPlayer(state, content, npcId)) return "무리 사이: 전쟁 중 · 개인적으로 각별함 (먼저 치지 않는다. 맞서도 목숨은 빼앗지 않는다)";
  if (keepsAway(state, content, npcId)) return "무리 사이: 전쟁 아님 · 개인적으로 원수 (곁에 두지 않는다. 마주쳐도 피할 뿐 시비를 걸지 않는다)";
  return null;
}

