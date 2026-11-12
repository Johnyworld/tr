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

/** "1일차 05:30 (새벽)" */
export function formatTime(time: GameTime): string {
  const m = minuteOfDay(time);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${dayOf(time)}일차 ${hh}:${mm} (${SEGMENT_LABELS[segmentOf(time)]})`;
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
  treat: { kind: "fixed", minutes: 30 },
  search: { kind: "range", min: 60, max: 120 },
  work: { kind: "fixed", minutes: 120 },
  rest: { kind: "fixed", minutes: 60 },
  guard_duty: { kind: "long", minutes: 240, allowUntil: false },
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
  treat: "응급처치",
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

/** 짧은 활동의 소요 시간 (분) */
export function rollActivityMinutes(cost: Exclude<ActivityCost, { kind: "long" }>, rng: Rng): number {
  if (cost.kind === "fixed") return cost.minutes;
  const steps = (cost.max - cost.min) / 15;
  return cost.min + Math.floor(rng() * (steps + 1)) * 15;
}
