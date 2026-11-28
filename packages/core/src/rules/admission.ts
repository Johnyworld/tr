/**
 * 공통 규칙 22: 받아들임 (docs/design.md "공통 규칙", 12-308, 사용자 결정).
 *
 * 무소속 주인공이 무리에 들 때는 그 자리에서 식구가 되지 않는다 (청솔 정문에서 판정 하나로 곧장 분대원이 됐다):
 * 1. 이야기의 join_faction은 먼저 손님으로 들인다 (`admitsAsGuest`). 들일 때 정한 계급·직함·적응 기간은 기억해 둔다
 * 2. 손님은 그 무리 거점에서 태도와 상관없이 재워 주고(`guestOf`), 그 거점에서 밤을 넘기면 그 무리의 배급을 받는다
 * 3. 들인 뒤 offer_after_hours(2~5시간) 뒤, offer_hours(7~20시) 안에 그 거점에 있으면 대표의 면담이 열린다 (`offerDue`, 이야기 when.admission)
 * 4. 받아들이면 그때 들어간다 (이야기 효과 admission: accept). 사양하면 손님으로 남고 reoffer_days(3일) 뒤에 다시 권한다
 * 그대로 바로 드는 것: 갇힌 몸으로 드는 것(포로의 투항, 공통 규칙 1)과 다른 무리에서 옮기는 것(스카우트).
 * 수치는 시나리오의 admission (원칙 7). 없으면 예전처럼 바로 든다. 손님 상태(state.admission)는 이 모듈과 리듀서만 읽는다 (rules/guards.test.ts)
 *
 * 들어갈 자리 (12-309, 사용자 결정): 대표는 직분을 권한다. 이야기가 정한 자리(join_faction.occupation)가 먼저, 없으면 붕괴 전 직업(posts.by_past),
 * 없으면 posts.default (`postFor`). 면담에서 posts.ask의 자리를 대신 청할 수 있다. 계급은 자리가 정하고(`postRank`), 분대는 posts.squad의 자리만
 * (상관·분대는 game/customStart.ts joinRole이 정한다)
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { josa } from "../text.ts";
import { playerHeld } from "./held.ts";
import { atOwnBase, baseOfNow, ownedBy } from "./home.ts";
import { dayOf, MINUTES_PER_DAY, minuteOfDay, type GameTime } from "./time.ts";

export type Admission = NonNullable<GameState["admission"]>;

function rules(content: Content) {
  return content.scenario.admission;
}

/** 이 join_faction은 손님으로 먼저 들이는가: 무소속이고 갇히지 않았고 시나리오에 받아들임이 있을 때 */
export function admitsAsGuest(state: GameState, content: Content): boolean {
  const me = state.characters[state.playerId];
  return !!rules(content) && !!me && !me.factionId && !playerHeld(state);
}

/** 면담이 열릴 수 있는 시간대(offer_hours) 안의 첫 시각: t가 안이면 t, 밖이면 다음 시작 시각 */
export function intoOfferHours(content: Content, t: GameTime): GameTime {
  const r = rules(content);
  if (!r) return t;
  const [from, to] = r.offer_hours;
  const m = minuteOfDay(t);
  if (m >= from * 60 && m < to * 60) return t;
  const dayStart = t - m;
  return m < from * 60 ? dayStart + from * 60 : dayStart + MINUTES_PER_DAY + from * 60;
}

/** 처음 면담 시각: 들인 뒤 offer_after_hours 사이 어딘가 (시간대 안으로) */
export function firstOfferAt(content: Content, now: GameTime, rng: Rng): GameTime {
  const r = rules(content)!;
  const [lo, hi] = r.offer_after_hours;
  const minutes = Math.round((lo + rng() * (hi - lo)) * 60);
  return intoOfferHours(content, now + minutes);
}

/** 사양한 뒤 다시 권하는 시각 */
export function reofferAt(content: Content, now: GameTime): GameTime {
  return intoOfferHours(content, now + (rules(content)?.reoffer_days ?? 3) * MINUTES_PER_DAY);
}

/** 손님으로 들어 있는 무리 (없으면 null) */
export function admissionOf(state: GameState): Admission | null {
  return state.admission ?? null;
}

/** 지금 손님으로 머무는 무리: 손님으로 든 무리의 땅이 지금 있는 구역이면 그 무리 id */
export function guestOf(state: GameState): string | null {
  const a = state.admission;
  if (!a || state.characters[state.playerId]?.factionId) return null;
  return ownedBy(state, state.playerZone, a.factionId) ? a.factionId : null;
}

/** 대표의 면담을 열 때인가: 손님으로 든 무리의 거점에 있고, 면담 시각(+late분)이 지났고, 시간대 안이고, 갇히지 않았다 */
export function offerDue(state: GameState, content: Content, at: GameTime = state.time, late = 0): boolean {
  const r = rules(content);
  const a = state.admission;
  if (!r || !a || playerHeld(state) || at < a.offerAt + late) return false;
  const zone = state.playerZone;
  if (!zone || content.locations[zone]?.kind !== "base" || guestOf(state) !== a.factionId) return false;
  return intoOfferHours(content, at) === at;
}

/** from 뒤에 면담이 열릴 수 있는 첫 시각 (활동 빨리감기가 멈춰 볼 시각, 공통 규칙 17) */
export function offerOpensAt(state: GameState, content: Content, from: GameTime): GameTime | null {
  const a = state.admission;
  return a && rules(content) ? intoOfferHours(content, Math.max(a.offerAt, from + 1)) : null;
}

/** GM 상태 한 줄 */
export function admissionLine(state: GameState, content: Content): string | null {
  const a = state.admission;
  if (!a) return null;
  const name = content.factions[a.factionId]?.name ?? a.factionId;
  const here = guestOf(state) === a.factionId;
  const post = a.post ? content.scenario.occupations.find((o) => o.id === a.post) : undefined;
  const past = state.characters[state.playerId]?.past;
  const asks = askablePosts(state, content).map((o) => content.scenario.occupations.find((x) => x.id === o)?.label ?? o);
  const postLine = post
    ? ` 대표가 권할 자리: ${post.label}${past && posts(content)?.by_past[past.id] === a.post ? ` (붕괴 전에 ${josa(past.label, "이었다/였다")}는 것을 보고)` : ""}${asks.length ? `. 면담에서 ${asks.join("·")} 자리를 대신 청할 수 있다` : ""}.`
    : "";
  return `손님: ${name}에 손님으로 들어 있다 (아직 식구가 아니다${a.offers ? `, 대표의 권유를 ${a.offers}번 사양했다` : ""}). ${here ? "이 땅에서는 재워 주고 밤을 넘기면 끼니를 준다." : "그 거점에 돌아가면 다시 손님으로 묵는다."}${postLine} 대표의 면담은 이야기가 연다 (GM이 먼저 가입시키지 않는다).`;
}

/**
 * 거점 드나듦 (12-368, 유소진 판: 식구가 동행과 우리 거점에 돌아오는데 서술이 문지기 허락·출입 눈치를 지어냈다):
 * 우리 무리 거점과 손님으로 든 무리의 거점은 묻지 않고 드나든다. 검문·허락은 이야기나 결과 문구가 알릴 때만
 */
export function passLine(state: GameState, content: Content): string | null {
  const zone = state.playerZone;
  if (!zone || content.locations[zone]?.kind !== "base") return null;
  const who = atOwnBase(state, content) ? "우리 거점이다" : guestOf(state) ? "손님으로 든 거점이다" : null;
  return who ? `${who}: 주인공과 동행·짝(동물 포함)은 담 문과 초소를 묻지 않고 드나든다. 시스템이 알리지 않은 검문·통행 허락·출입 눈치를 지어내지 않는다.` : null;
}

function posts(content: Content) {
  return content.scenario.admission?.posts;
}

/** 무소속이 들어갈 자리 (직분): 이야기가 정한 것, 없으면 붕괴 전 직업으로, 없으면 기본. 자리 표가 없는 월드는 null */
export function postFor(state: GameState, content: Content, story?: string): string | null {
  const p = posts(content);
  if (!p) return story ?? null;
  const past = state.characters[state.playerId]?.past?.id;
  return story ?? (past ? p.by_past[past] : undefined) ?? p.default;
}

/** 그 자리의 계급 (없으면 null: 이야기·예전 규칙대로) */
export function postRank(content: Content, post: string | null | undefined): string | null {
  const p = posts(content);
  return p && post ? (p.ranks[post] ?? p.other_rank) : null;
}

/** 대표가 권할 자리 (손님이 아니면 null) */
export function offeredPost(state: GameState): string | null {
  return state.admission?.post ?? null;
}

/** 면담에서 대신 청할 수 있는 자리: posts.ask 중 권한 자리가 아닌 것 */
export function askablePosts(state: GameState, content: Content): string[] {
  const offered = offeredPost(state);
  return (posts(content)?.ask ?? []).filter((o) => o !== offered);
}

/** 손님이 청한 자리로 들어갈 때의 자리 (청할 수 없는 자리면 null) */
export function askedPost(state: GameState, content: Content, ask: string): { post: string; rank: string | null } | null {
  return askablePosts(state, content).includes(ask) ? { post: ask, rank: postRank(content, ask) } : null;
}

/** 분대에 드는 자리인가 (자리 표가 없으면 예전처럼 늘 그렇다) */
export function squadPost(content: Content, post: string | null | undefined): boolean {
  const p = posts(content);
  return !p || !post || p.squad.includes(post);
}

/**
 * 분대 없는 자리의 상관이 들를 때인가 (12-311, 사용자 결정): 그 상관이 우리 거점 밖에 살고(거점에 간부가 없는 무리), 주인공이 우리 거점에 있고,
 * posts.visit_hours 안이고, 오늘 아직 들르지 않았으면. 들르면 임무를 내리러 장면에 든다 (assign_mission). 거점에 사는 상관은 찾아간다
 */
export function chiefVisits(state: GameState, content: Content, chiefId: string): boolean {
  const hours = posts(content)?.visit_hours;
  const me = state.characters[state.playerId];
  if (!hours || !me?.factionId || squadPost(content, me.occupation?.id) || playerHeld(state)) return false;
  const base = baseOfNow(state, content, me.factionId);
  const home = content.npcs[chiefId]?.zone;
  if (!base || state.playerZone !== base || !home || home === base) return false;
  if (state.chiefVisitDay === dayOf(state.time)) return false;
  const m = minuteOfDay(state.time);
  return m >= hours[0] * 60 && m < hours[1] * 60;
}

/** GM 상태 한 줄: 거점 밖에 사는 상관이 언제 들르는지 (분대 없는 자리만) */
export function chiefVisitLine(state: GameState, content: Content, chiefId: string): string | null {
  const hours = posts(content)?.visit_hours;
  const me = state.characters[state.playerId];
  if (!hours || !me?.factionId || squadPost(content, me.occupation?.id)) return null;
  const base = baseOfNow(state, content, me.factionId);
  const home = content.npcs[chiefId]?.zone;
  if (!base || !home || home === base) return null;
  const today = state.chiefVisitDay === dayOf(state.time);
  return `상관은 거점 밖에 산다: 아침 ${hours[0]}~${hours[1]}시에 우리 거점에 있으면 하루 한 번 들러 일감을 준다 (assign_mission을 부르면 들인다${today ? ". 오늘은 이미 들렀다" : ""}). 그 밖의 때는 상관이 있는 곳으로 찾아간다.`;
}

