/**
 * 공통 규칙 7: 주인공은 본 것만 안다 (docs/design.md "공통 규칙", 원칙 4).
 *
 * 화면·GM 상태에 싣는 "주인공이 아는 대로"의 판단은 여기서만 한다:
 * 땅 주인(state.zoneSeen은 rules/knowledge.test.ts가 이 모듈 밖에서 읽지 못하게 막는다), 처음 보는 사람의 인간관계.
 */
import type { Content } from "../content/schemas.ts";
import { hasMet } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";

/**
 * 주인공이 아는 땅 주인 (12-219): 지금 있는 곳과 우리 무리가 낀 땅(차지했거나 잃은 땅)은 지금 주인을,
 * 나머지는 마지막으로 가서 본 주인을, 가 본 적 없으면 처음부터 알려진 주인을
 */
export function knownOwner(state: GameState, content: Content, zone: string): string | null {
  const now = state.zones[zone]?.owner ?? null;
  const seen = zone in (state.zoneSeen ?? {}) ? state.zoneSeen[zone]! : (content.locations[zone]?.owner ?? null);
  const mine = state.characters[state.playerId]?.factionId ?? null;
  return zone === state.playerZone || (!!mine && (now === mine || seen === mine)) ? now : seen;
}

/** 이 두 사람의 관계를 주인공이 알 수 있는가: 둘 다 만난 적이 있어야 한다 (주인공 자신과의 관계는 늘 안다, 플레이 테스트 13) */
export function knowsTieBetween(state: GameState, a: string, b: string): boolean {
  const me = state.playerId;
  if (a === me || b === me) return true;
  return hasMet(state, me, a) && hasMet(state, me, b);
}
