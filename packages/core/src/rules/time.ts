import { z } from "zod";
import type { Rng } from "../rng.ts";

/**
 * 게임 시간 = 1일차 00:00부터 흐른 분(minute). 정수로만 다룬다.
 * 계절은 시뮬레이션이 생기면 추가한다.
 */
export type GameTime = number;

export const MINUTES_PER_DAY = 24 * 60;

/** 시작 시각: 1일차 05:30 (새벽, 오프닝 장면과 맞춘다) */
export const START_TIME: GameTime = 5 * 60 + 30;

export function dayOf(time: GameTime): number {
  return Math.floor(time / MINUTES_PER_DAY) + 1;
}

export function minuteOfDay(time: GameTime): number {
  return ((time % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** 하루를 다섯 시간대로 나눈다. 시작 시각(시) 기준 */
export const TIME_SEGMENTS = ["dawn", "morning", "day", "evening", "night"] as const;
export type TimeSegment = (typeof TIME_SEGMENTS)[number];
export const timeSegmentSchema = z.enum(TIME_SEGMENTS);

export const SEGMENT_START_HOUR: Record<TimeSegment, number> = {
  dawn: 4,
  morning: 6,
  day: 10,
  evening: 17,
  night: 20,
};

export const SEGMENT_LABELS: Record<TimeSegment, string> = {
  dawn: "새벽",
  morning: "아침",
  day: "낮",
  evening: "저녁",
  night: "밤",
};

export function segmentOf(time: GameTime): TimeSegment {
  const hour = minuteOfDay(time) / 60;
  if (hour >= SEGMENT_START_HOUR.night || hour < SEGMENT_START_HOUR.dawn) return "night";
  if (hour >= SEGMENT_START_HOUR.evening) return "evening";
  if (hour >= SEGMENT_START_HOUR.day) return "day";
  if (hour >= SEGMENT_START_HOUR.morning) return "morning";
  return "dawn";
}

/** 지금 이후 처음으로 그 시간대가 시작되는 시각 (지금이 그 시간대여도 다음 시작) */
export function nextSegmentStart(time: GameTime, segment: TimeSegment): GameTime {
  const startOfToday = time - minuteOfDay(time) + SEGMENT_START_HOUR[segment] * 60;
  return startOfToday > time ? startOfToday : startOfToday + MINUTES_PER_DAY;
}

/** 지금 시간대가 끝나는 시각 (다음 시간대가 시작되는 시각) */
export function segmentEnd(time: GameTime): GameTime {
  return Math.min(...TIME_SEGMENTS.map((s) => nextSegmentStart(time, s)));
}

/** 1일차가 start(YYYY-MM-DD)인 달력의 날짜: "2032. 11. 8." */
export function calendarDate(start: string, time: GameTime): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOf(time) - 1);
  return `${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}. ${d.getUTCDate()}.`;
}

/** "05:30 (새벽)" (며칠째인지 없이) */
export function formatClock(time: GameTime): string {
  const m = minuteOfDay(time);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")} (${SEGMENT_LABELS[segmentOf(time)]})`;
}

/** "1일차 05:30 (새벽)" */
export function formatTime(time: GameTime): string {
  const m = minuteOfDay(time);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${dayOf(time)}일차 ${hh}:${mm} (${SEGMENT_LABELS[segmentOf(time)]})`;
}

/**
 * 그때가 지금으로부터 얼마나 전인지 (12-178, 낡은 정보): 날짜로 센다. "오늘", "어제", "그저께", "5일 전", "2주 전", "두 달 전"
 * 믿음 옆에 붙여 GM·플레이어가 정보가 얼마나 묵었는지 보게 한다 (정확도는 여전히 보이지 않는다)
 */
export function formatAgo(now: GameTime, then: GameTime): string {
  // 세계가 시작되기 전부터 알던 것 (출신·가족·지난 삶): "어제"가 아니다 (플레이 테스트 13)
  if (then < START_TIME) return "오래전부터";
  const days = dayOf(now) - dayOf(then);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days === 2) return "그저께";
  if (days < 14) return `${days}일 전`;
  if (days < 60) return `${Math.floor(days / 7)}주 전`;
  return `${Math.floor(days / 30)}달 전`;
}

/** "1시간 30분" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 활동별 소요 시간 (기획서 5.1, 임시값 · 18장 미정).
 * AI는 활동 종류만 고르고 시간은 코드가 정한다.
 * - fixed: 정해진 시간
 * - range: 범위 안에서 15분 단위로 굴린다
 * - long: 빨리감기로 진행한다 (끼어들기로 중간에 멈출 수 있음). until을 주면 그 시간대가 시작될 때까지
 */
export const ACTIVITIES = [
  "brief",
  "talk",
  "eat",
  "treat",
  "search",
  "work",
  "rest",
  "guard_duty",
  "sleep",
  "wait",
  "travel",
  "combat",
] as const;
export type Activity = (typeof ACTIVITIES)[number];
export const activitySchema = z.enum(ACTIVITIES);

export type ActivityCost =
  | { kind: "fixed"; minutes: number }
  | { kind: "range"; min: number; max: number }
  | { kind: "long"; minutes: number; allowUntil: boolean };

export const ACTIVITY_COSTS = {
  brief: { kind: "fixed", minutes: 5 },
  talk: { kind: "fixed", minutes: 10 },
  eat: { kind: "fixed", minutes: 30 },
  // 치료도 until을 받는다: 치료실 당번처럼 오래 돌보는 일 (12-240, A9: 2시간 당번에 처치를 네 번 불렀다). 낫게 하는 효과는 한 번
  treat: { kind: "long", minutes: 30, allowUntil: true },
  search: { kind: "range", min: 60, max: 120 },
  work: { kind: "fixed", minutes: 120 },
  // 휴식도 until을 받는다 (플레이 테스트 12: "오후 내내 쉰다"가 늘 1시간이었다). 정하지 않으면 1시간
  rest: { kind: "long", minutes: 60, allowUntil: true },
  // 보초도 until을 받고, 임무 보초는 남은 시간만큼만 선다 (플레이 테스트 13: 늘 4시간이라 3시간 요건이 기한을 넘겼다)
  guard_duty: { kind: "long", minutes: 240, allowUntil: true },
  sleep: { kind: "long", minutes: 360, allowUntil: true },
  wait: { kind: "long", minutes: 60, allowUntil: true },
  /** 인접 구역으로 이동 (move_to) */
  travel: { kind: "range", min: 30, max: 60 },
  /** 전투 한 라운드 (시나리오의 round_minutes와 맞춘다) */
  combat: { kind: "fixed", minutes: 10 },
} as const satisfies Record<Activity, ActivityCost>;

export const ACTIVITY_LABELS: Record<Activity, string> = {
  brief: "잠깐의 행동",
  talk: "대화",
  eat: "식사",
  // 응급처치·치료사의 치료·수술 모두 (플레이 테스트 13: 수술 결과의 시간 줄이 "응급처치")
  treat: "치료",
  search: "수색",
  work: "작업",
  rest: "휴식",
  guard_duty: "보초",
  sleep: "잠",
  wait: "기다림",
  travel: "이동",
  combat: "전투",
};

/** 한 번의 빨리감기 최대 길이 */
export const MAX_FAST_FORWARD_MINUTES = MINUTES_PER_DAY;

/** 턴이 시간을 쓰지 않고 끝나면 이만큼 흐른다 */
export const MIN_TURN_MINUTES = 5;

/**
 * 길마다 정해진 이동 시간 (12-239, 플레이 테스트 13: 장터 → 강변이 30분·45분·1시간으로 매번 달랐다).
 * 두 구역 짝에서 정해지는 travel 범위 안의 15분 단위. 오가는 방향이 같다
 */
export function routeMinutes(from: string, to: string): number {
  const cost = ACTIVITY_COSTS.travel as { kind: "range"; min: number; max: number };
  const key = [from, to].sort().join("|");
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const steps = (cost.max - cost.min) / 15;
  return cost.min + ((h >>> 0) % (steps + 1)) * 15;
}

/** 짧은 활동의 소요 시간 (분) */
export function rollActivityMinutes(cost: Exclude<ActivityCost, { kind: "long" }>, rng: Rng): number {
  if (cost.kind === "fixed") return cost.minutes;
  const steps = (cost.max - cost.min) / 15;
  return cost.min + Math.floor(rng() * (steps + 1)) * 15;
}
