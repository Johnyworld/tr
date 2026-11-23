/**
 * 공통 규칙 7: 주인공은 본 것만 안다 (docs/design.md "공통 규칙", 원칙 4).
 *
 * 화면·GM 상태에 싣는 "주인공이 아는 대로"의 판단은 여기서만 한다:
 * 땅 주인(state.zoneSeen은 rules/knowledge.test.ts가 이 모듈 밖에서 읽지 못하게 막는다), 처음 보는 사람의 인간관계, 들어서 아는 건너는 길.
 */
import type { Content } from "../content/schemas.ts";
import { hasMet, knowsName } from "../game/acquaintance.ts";
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

/**
 * 주인공이 아는 건너는 길 (12-251, 플레이 테스트 14: 섬에서 나갈 길이 어디에도 없었다): 지금 구역에서 배로 건너갈 수 있는 곳 가운데
 * 이야기로 들어 안 곳(crossing.heard_flags 중 하나가 있다)만. 스스로는 모른다
 */
export function knownCrossings(state: GameState, content: Content, zone: string): string[] {
  const flags = new Set(state.flags[state.playerId] ?? []);
  return Object.entries(content.locations)
    .filter(([, loc]) => !!loc.crossing?.from.includes(zone) && loc.crossing.heard_flags.some((f) => flags.has(f)))
    .map(([id]) => id);
}

/** 이 두 사람의 관계를 주인공이 알 수 있는가: 둘 다 만난 적이 있어야 한다 (주인공 자신과의 관계는 늘 안다, 플레이 테스트 13) */
export function knowsTieBetween(state: GameState, a: string, b: string): boolean {
  const me = state.playerId;
  if (a === me || b === me) return true;
  return hasMet(state, me, a) && hasMet(state, me, b);
}

/**
 * 이름 모르는 사람의 id 가리기 (PT21 분대장·졸병: 콘텐츠 인물 id에 이름 로마자가 들어 있어 `lone_seokgu`·`c_changsik`이 이름을 알기 전부터 GM에게 보였다).
 * GM에게 가는 글에서는 주인공이 이름을 모르는 콘텐츠 인물의 id를 겉 id로 바꾸고, 도구 입력의 겉 id는 실제 id로 되돌린다.
 * 겉 id는 id마다 늘 같다 (이름을 알게 된 뒤에도 예전 겉 id를 받는다)
 */
export function maskedId(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `p_${h.toString(36).padStart(7, "0").slice(0, 7)}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** GM에게 가는 글에서 이름 모르는 콘텐츠 인물의 id를 겉 id로 */
export function maskUnknownIds(text: string, state: GameState, content: Content): string {
  const hidden = Object.keys(content.npcs).filter((id) => !knowsName(state, state.playerId, id) && text.includes(id));
  if (!hidden.length) return text;
  const re = new RegExp(`(?<![A-Za-z0-9_])(${hidden.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
  return text.replace(re, (id) => maskedId(id));
}

/** 도구 입력의 겉 id를 실제 id로 (문자열이면 어디든) */
export function unmaskIds(input: unknown, content: Content): unknown {
  const map = new Map(Object.keys(content.npcs).map((id) => [maskedId(id), id]));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(input);
}
