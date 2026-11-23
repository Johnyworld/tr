/**
 * 공통 규칙 11: 우리 땅 (docs/design.md "공통 규칙").
 *
 * 어디가 우리 땅이고 우리 거점인지, 어디가 내 사람이 사는 곳인지는 여기서 정한다.
 * 땅 주인은 전쟁으로 바뀐다: 콘텐츠의 처음 주인이 아니라 세이브의 지금 주인(state.zones)으로 본다.
 * 배급·자리 비움·우리 땅에서 들킴·옷 갈아입기·수군거림·준비물·창고·시설이 모두 이 질문을 쓴다
 * (플레이 테스트 13 뒤: 같은 검사가 열세 곳 넘게 흩어져 있었다). 주인공 쪽의 "이 땅 주인이 내 무리인가"는 이 모듈로만 묻는다 (rules/guards.test.ts).
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { tiesOf } from "../game/ties.ts";

type Zones = { zones: Record<string, { owner: string | null } | undefined> };

/** 이 구역의 지금 주인이 이 무리인가 */
export function ownedBy(state: Zones, zone: string | null | undefined, factionId: string | null | undefined): boolean {
  return !!zone && !!factionId && state.zones[zone]?.owner === factionId;
}

/** 이 사람(기본 주인공)이 이 구역(기본 지금 구역)에서 자기 무리 땅에 있는가 */
export function onOwnLand(state: GameState, zone: string | null | undefined = state.playerZone, who: string = state.playerId): boolean {
  return ownedBy(state, zone, state.characters[who]?.factionId);
}

/** 이 구역(기본 지금 구역)이 이 사람(기본 주인공) 무리의 거점이고, 지금도 그 무리 것인가 */
export function atOwnBase(state: GameState, content: Content, zone: string | null | undefined = state.playerZone, who: string = state.playerId): boolean {
  return !!zone && content.locations[zone]?.kind === "base" && onOwnLand(state, zone, who);
}

/** 이 인물이 사는 구역 (이름 있는 인물은 콘텐츠의 zone, 이름 없는 인물은 엮인 구역) */
function homeOf(state: GameState, content: Content, id: string): string | null {
  return content.npcs[id]?.zone ?? state.characters[id]?.extra?.zone ?? null;
}

/**
 * 내 사람이 사는 곳 (12-238, 플레이 테스트 13: 우리 무리가 상주하는 물류창고, 부모님이 사는 집에서 옷을 못 갈아입었다):
 * 우리 무리 사람이 사는 우리 땅, 살아 있는 피붙이·배우자가 사는 곳
 */
export function myPeopleLiveHere(state: GameState, content: Content, zone: string | null | undefined = state.playerZone): boolean {
  const me = state.characters[state.playerId];
  if (!zone || !me) return false;
  const family = tiesOf(state, content, me.id).filter((t) => KIN.includes(t.kind)).map((t) => t.other);
  if (family.some((id) => state.characters[id] && !state.characters[id]!.dead && homeOf(state, content, id) === zone)) return true;
  if (!onOwnLand(state, zone) || !me.factionId) return false;
  return Object.values(state.characters).some((c) => c.id !== me.id && !c.dead && c.factionId === me.factionId && homeOf(state, content, c.id) === zone);
}

const KIN: readonly string[] = ["parent", "child", "sibling", "spouse"];

/**
 * 이 무리의 지금 거점 (12-269, 우회 점검: 콘텐츠의 처음 주인으로 찾아, 거점이 함락되면 "집으로 돌아왔다"가 적의 거점이었다).
 * 거점(kind base) 가운데 지금 그 무리 것인 곳. 없으면 null
 */
export function baseOfNow(state: Zones, content: Content, factionId: string | null | undefined): string | null {
  if (!factionId) return null;
  // 땅 주인이 아직 정해지지 않은 세계(만드는 중)는 콘텐츠의 처음 주인으로
  const ownerOf = (id: string, first: string | null | undefined) => (state.zones[id] ? state.zones[id]!.owner : (first ?? null));
  return Object.values(content.locations).find((l) => l.kind === "base" && ownerOf(l.id, l.owner) === factionId)?.id ?? null;
}

/**
 * 이 구역이 주인공을 적대하는 땅인가 (12-269, 우회 점검: 경보·잠입·GM 화면이 "적 땅"을 세 가지로 정했다).
 * 땅 주인이 주인공 무리를 나쁘게 보면(태도 0 미만) 적 땅. 무소속이면 낯선 사람을 잡아가는 무리나 현상금을 건 무리의 땅
 */
export function hostileLand(state: GameState, content: Content, zone: string | null | undefined): boolean {
  const owner = zone ? state.zones[zone]?.owner : null;
  const mine = state.characters[state.playerId]?.factionId ?? null;
  if (!owner || owner === mine) return false;
  if (mine) return (state.factions[owner]?.disposition?.[mine] ?? 0) < 0;
  return !!content.scenario.helpless?.prey_on_strangers.includes(owner) || (state.bounties ?? []).includes(owner);
}
