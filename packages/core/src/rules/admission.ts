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
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { playerHeld } from "./held.ts";
import { ownedBy } from "./home.ts";
import { MINUTES_PER_DAY, minuteOfDay, type GameTime } from "./time.ts";

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
  return `손님: ${name}에 손님으로 들어 있다 (아직 식구가 아니다${a.offers ? `, 대표의 권유를 ${a.offers}번 사양했다` : ""}). ${here ? "이 땅에서는 재워 주고 밤을 넘기면 끼니를 준다." : "그 거점에 돌아가면 다시 손님으로 묵는다."} 대표의 면담은 이야기가 연다 (GM이 먼저 가입시키지 않는다).`;
}
