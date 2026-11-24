/**
 * 공통 규칙 17: 이야기의 자리 (docs/design.md "공통 규칙", 12-254).
 *
 * 이야기를 "지금 열어도 되는가"는 여기서만 정한다. 이야기는 등급 하나를 가진다:
 *   꼭(essential) > 급한 위협(urgent이고 다치게 하는 것) > 급함(urgent) > 시나리오 > 공통(world)
 * 그리고 막는 것마다 어느 등급까지 막는지 한 표로 정한다 (숫자는 시나리오의 storylet_pacing).
 *
 * | 막는 것                          | 꼭 | 급한 위협 | 급함 | 시나리오 | 공통 |
 * | 시작 뒤 first_after_hours (시작한 구역에서만) | 막음 | 막음 | 막음 | 막음 | 막음 |
 * | 최소 간격 min_any_gap_hours       | ·  | ·        | 막음 | 막음     | 막음 |
 * | 간격 min~max_gap_hours, 위급할 때 | ·  | ·        | ·    | 막음     | 막음 |
 * | 같은 장소 하루 하나               | ·  | 같거나 높은 등급이 썼으면 막음 (공통은 늘)     |
 * | 하루 상한 (위협·길·급함), 같은 위협 간격 | · | 막음 | 막음 | 막음 | 막음 |
 *
 * 낮은 등급이 쓴 자리는 높은 등급을 막지 않는다 (PT15 섬: 도시 공통 이야기가 회관 자리를 써 시나리오 줄기 첫 이야기가 막혔다).
 * 처지(갇힘·누움·잠·위급할 때 무엇이 열리는지)는 공통 규칙 4(rules/situation.ts)와 storyletAllowed가 본다.
 * 이야기 간격 상태(lastStoryletAt)는 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { Content, StoryletContent } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { offerOpensAt } from "./admission.ts";
import { heldOf, playerHeld } from "./held.ts";
import { storyIndoor, storyPlaces } from "./place.ts";
import { dayOf, MINUTES_PER_DAY, SEGMENT_START_HOUR, TIME_SEGMENTS, type GameTime } from "./time.ts";

/** 이야기의 등급. 숫자가 클수록 높다 */
export const STORY_TIERS = { common: 0, role: 1, urgent: 2, urgent_threat: 3, must: 4 } as const;
export type StoryTier = keyof typeof STORY_TIERS;

/** 어느 시나리오(역할)에서나 발동하는 스토리렛 태그 */
const WORLD_TAG = "world";

/** 이 이야기가 주는 위협 (공포 태그와, 감염체 배역이면 infected). 같은 위협끼리 간격을 둔다 (D3) */
export function threatTags(content: Content, s: StoryletContent): string[] {
  const infected = Object.values(s.cast).some((r) => "extra" in r && !!r.extra && content.extras[r.extra]?.kind === "infected");
  return [...new Set([...(s.fright_tags ?? []), ...(infected ? ["infected"] : [])])];
}

/** 다치게 하는 이야기인가 (D1): 공포가 오르거나, 매복이거나, 감염체가 나온다 */
export function isThreat(content: Content, s: StoryletContent): boolean {
  return (s.fright ?? 0) > 0 || !!s.ambush || threatTags(content, s).includes("infected");
}

export function storyTier(content: Content, s: StoryletContent): StoryTier {
  if (s.essential) return "must";
  if (s.urgent) return isThreat(content, s) ? "urgent_threat" : "urgent";
  return s.tags.includes(WORLD_TAG) ? "common" : "role";
}

/** 이야기의 글: 제목·상황·변형 (장소 맞추기에 쓴다. PT15 섬: "그물 창고의 기도"는 제목에만 장소가 있었다) */
export function storyText(s: StoryletContent): string {
  return [s.title, s.setup, ...(s.variants ?? [])].join(" ");
}

/** 갇힌 뒤 첫 이야기까지 (분) */
const HELD_FIRST_STORY_MINUTES = 60;

/**
 * 앞 이야기 뒤 다음 이야기까지의 간격 (분). max_gap_hours가 있으면 min~max 사이에서 앞 이야기의 시각으로 정한다
 * (난수를 쓰지 않아 같은 세이브는 늘 같은 간격이다)
 */
export function storyletGapMinutes(content: Content, lastAt: GameTime): number {
  const p = content.scenario.storylet_pacing;
  const min = p.min_gap_hours * 60;
  if (p.max_gap_hours === undefined || p.max_gap_hours <= p.min_gap_hours) return min;
  const h = (Math.imul(lastAt + 0x9e37, 2654435761) >>> 0) / 2 ** 32;
  return Math.round(min + h * (p.max_gap_hours * 60 - min));
}

/** 주인공의 몸이 위급한가 (storylet_pacing.urgent_only_when): 그동안은 급한 이야기만 연다 (12-191) */
export function inCrisis(state: GameState, content: Content): boolean {
  const me = state.characters[state.playerId];
  // 갇힌 몸은 감옥 이야기가 유일한 길이다: 위급해도 막지 않는다 (B5, 플레이 테스트 9: 치명상인 포로가 51시간 멈췄다)
  if (!me || heldOf(me)) return false;
  return Object.entries(content.scenario.storylet_pacing.urgent_only_when).some(([track, from]) => {
    const levels = content.scenario.condition_tracks.find((t) => t.id === track)?.levels ?? [];
    const at = levels.findIndex((l) => l.id === me.conditions[track]);
    const min = levels.findIndex((l) => l.id === from);
    return at >= 0 && min >= 0 && at >= min;
  });
}

/** 지금 캐릭터로 아직 이야기가 열린 적 없는가 */
function fresh(state: GameState): boolean {
  return state.lastStoryletAt === null || state.lastStoryletAt < state.runStartedAt;
}

/** 시작 장면을 지키는 동안인가: 시작 뒤 first_after_hours, 시작한 구역에 있을 때만 (PT15 튜토리얼: 고가에서 정문까지 왔는데 첫 1시간에 막혔다) */
function startGuarded(state: GameState, content: Content, at: GameTime): boolean {
  const first = content.scenario.storylet_pacing.first_after_hours * 60;
  return at - state.runStartedAt < first && (state.runStartZone === null || state.runStartZone === state.playerZone);
}

/**
 * 지금 열 수 있는 가장 낮은 등급 (null이면 아무것도 열지 않는다). 등급 하나로 간격들을 셈한다:
 * 최소 간격 안이면 급한 위협부터, 긴 간격 안·위급할 때·갇힌 동안 간격이면 급함부터, 아니면 모두
 */
export function storySlotFloor(state: GameState, content: Content, at: GameTime): number | null {
  // 잠입 중에는 다른 이야기가 끼어들지 않는다 (12-154)
  if (state.activeStorylet || state.battle || state.infiltration) return null;
  if (startGuarded(state, content, at)) return null;
  const pacing = content.scenario.storylet_pacing;
  const held = playerHeld(state);
  if (held && !fresh(state)) {
    // 갇힌 동안 (플레이 테스트 13: 갇혀 열 시간 넘게 아무 일도 없었다): 갇힌 뒤 첫 이야기는 1시간이 지나면, 그다음은 간격의 절반
    const last = state.lastStoryletAt!;
    const since = held.since ?? last;
    if (last < since) return at - since >= HELD_FIRST_STORY_MINUTES ? STORY_TIERS.common : STORY_TIERS.urgent;
    return at - last >= storyletGapMinutes(content, last) / 2 ? STORY_TIERS.common : STORY_TIERS.urgent;
  }
  // 이야기가 몰리지 않게 (12-191): 앞 이야기와 가까우면 급한 위협만 (12-254, PT15 튜토리얼: 위협 아닌 급한 이야기 둘이 한 시간 안에)
  if (!fresh(state) && at - state.lastStoryletAt! < pacing.min_any_gap_hours * 60) return STORY_TIERS.urgent_threat;
  // 위급하면 급한 이야기만 (12-191)
  if (inCrisis(state, content)) return STORY_TIERS.urgent;
  if (fresh(state)) return STORY_TIERS.common;
  return at - state.lastStoryletAt! >= storyletGapMinutes(content, state.lastStoryletAt!) ? STORY_TIERS.common : STORY_TIERS.urgent;
}

/** 앞 이야기가 막 열렸는가 (최소 간격 안): 길 위의 일도 열지 않는다 (12-191) */
export function justHadStory(state: GameState, content: Content, at: GameTime = state.time): boolean {
  return !fresh(state) && at - state.lastStoryletAt! < content.scenario.storylet_pacing.min_any_gap_hours * 60;
}

/** 누워 있는 동안의 이야기를 위급할 때 열 수 있는가: 이야기 사이 간격은 지킨다 (D4) */
export function bedsideGapPassed(state: GameState, content: Content, at: GameTime): boolean {
  return fresh(state) || at - state.lastStoryletAt! >= storyletGapMinutes(content, state.lastStoryletAt!);
}

/** 오늘 급한 이야기를 더 열 수 있는가 (storylet_pacing.urgent_per_day, 12-191) */
export function urgentAllowed(state: GameState, content: Content, at: GameTime): boolean {
  const cap = content.scenario.storylet_pacing.urgent_per_day;
  if (!cap) return true;
  const today = dayOf(at);
  const fired = Object.entries(state.storyletLog).filter(([id, log]) => content.storylets[id]?.urgent && dayOf(log.lastFiredAt) === today).length;
  return fired < cap;
}

/**
 * 하루 상한·같은 장소·같은 위협 (플레이 테스트 11, D1~D3, 12-251). 꼭 열리는 이야기와 임무 자리의 이야기(when.mission)는 막지 않는다.
 * 같은 장소 하루 하나는 같거나 높은 등급이 그 장소를 썼을 때만 막는다 (12-254)
 */
export function pacingBlocks(state: GameState, content: Content, s: StoryletContent, at: GameTime): boolean {
  const p = content.scenario.storylet_pacing;
  if (s.when.mission || s.essential) return false;
  const today = dayOf(at);
  const fired = Object.entries(state.storyletLog).filter(([id, log]) => dayOf(log.lastFiredAt) === today && !content.storylets[id]?.when.mission);
  if (p.per_day && fired.length >= p.per_day) return true;
  if (p.threat_per_day && isThreat(content, s) && fired.filter(([id]) => content.storylets[id] && isThreat(content, content.storylets[id]!)).length >= p.threat_per_day) return true;
  const road = content.scenario.travel?.tag;
  if (p.road_per_day && road && s.tags.includes(road) && fired.filter(([id]) => content.storylets[id]?.tags.includes(road)).length >= p.road_per_day) return true;
  const mine = storyPlaces(state, content, s.when, storyText(s), storyIndoor(s.when));
  if (mine.length) {
    const rank = STORY_TIERS[storyTier(content, s)];
    const rival = (o: StoryletContent) => STORY_TIERS[storyTier(content, o)] >= rank && storyPlaces(state, content, o.when, storyText(o), storyIndoor(o.when)).some((pl) => mine.includes(pl));
    // 바로 앞 이야기를 잇는 후속(after_storylet)은 그 앞 이야기가 쓴 장소라도 막지 않는다 (설계 목록 10-1, PT16·19·20 튜토리얼: 정문 재시도가 다음 날 새벽에야)
    if (fired.some(([id]) => id !== s.id && id !== s.when.after_storylet?.id && content.storylets[id] && rival(content.storylets[id]!))) return true;
  }
  if (p.same_threat_gap_days) {
    const tags = threatTags(content, s);
    if (tags.length && Object.entries(state.storyletLog).some(([id, log]) => id !== s.id && at - log.lastFiredAt < p.same_threat_gap_days * MINUTES_PER_DAY && content.storylets[id] && threatTags(content, content.storylets[id]!).some((t) => tags.includes(t)))) return true;
  }
  return false;
}

/**
 * from~to 사이에 자리가 새로 열릴 수 있는 시각 (활동 빨리감기의 끊는 지점, 12-254).
 * 시작 장면 대기가 끝날 때, 최소 간격·간격·갇힌 동안 간격이 끝날 때, 시간대가 바뀔 때 (시간대 조건 이야기)
 * (PT15 튜토리얼: 빨리감기가 한 시간씩 건너뛰어 정문 이야기가 50분 늦게, 수소문 이야기가 기다림 끝에야 열렸다)
 */
export function slotOpensBetween(state: GameState, content: Content, from: GameTime, to: GameTime): GameTime[] {
  const p = content.scenario.storylet_pacing;
  const times: GameTime[] = [state.runStartedAt + p.first_after_hours * 60];
  if (!fresh(state)) {
    const last = state.lastStoryletAt!;
    const gap = storyletGapMinutes(content, last);
    times.push(last + p.min_any_gap_hours * 60, last + gap, last + gap / 2);
    const since = playerHeld(state)?.since;
    if (since !== undefined) times.push(since + HELD_FIRST_STORY_MINUTES);
  }
  // 대표의 면담 시각 (공통 규칙 22): 손님으로 지내며 쉬거나 기다리는 사이에 지나치지 않게
  const offer = offerOpensAt(state, content, from);
  if (offer !== null) times.push(offer);
  for (let day = dayOf(from) - 1; day <= dayOf(to); day++) for (const seg of TIME_SEGMENTS) times.push((day - 1) * MINUTES_PER_DAY + SEGMENT_START_HOUR[seg] * 60);
  return [...new Set(times.map((t) => Math.ceil(t)))].filter((t) => t > from && t < to).sort((a, b) => a - b);
}
