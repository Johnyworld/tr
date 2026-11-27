/**
 * 임무 기한·이야기 시간 제한 검사 (12-354, content:check에서 부른다)
 * - 임무: 모든 임무를 저녁 17시에 받았다 치고, 기한까지 남는 낮 시간이 6시간 이상이어야 한다 (모자라면 오류)
 * - 이야기: 동행 기한(until.hours)은 같은 때 시작했다 치고 낮 6시간 이상이어야 한다 (오류, 12-356). 잠시 떨어짐 hours·소식·흔적 창은 짧으면 알리기만 한다
 */
import { daylightMinutes, missionDeadline, MINUTES_PER_DAY } from "../rules/time.ts";
import type { Content } from "./schemas.ts";

export const MIN_DAYLIGHT_HOURS = 6;
const EVENING = 17 * 60;

export interface DeadlineReport {
  errors: string[];
  /** 이야기의 시간 제한 가운데 밤을 끼어 낮 시간이 짧은 것 (고치지 않고 알리기만) */
  storyNotes: string[];
}

/** 17시에 받은 임무의 기한까지 남는 낮 시간 (시간) */
export function daylightLeft(hours: number, urgent: boolean): number {
  const start = MINUTES_PER_DAY + EVENING;
  return daylightMinutes(start, missionDeadline(start, hours, urgent)) / 60;
}

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    visit(k, v);
    walk(v, visit);
  }
}

export function checkMissionDeadlines(content: Content): DeadlineReport {
  const errors: string[] = [];
  for (const m of Object.values(content.missions)) {
    const left = daylightLeft(m.deadline_hours, m.urgent ?? false);
    if (left < MIN_DAYLIGHT_HOURS) errors.push(`임무 ${m.id}: 17시에 받으면 기한까지 낮 시간이 ${left}시간뿐이다 (최소 ${MIN_DAYLIGHT_HOURS}시간)`);
  }
  const storyNotes: string[] = [];
  // 동행 기한은 오류 (함께 가던 사람이 밤사이 떠나 버린다, 12-356). 잠시 떨어짐·소식 창은 플레이어를 묶지 않아 알리기만 한다
  const limit = (id: string, what: string, hours: number, strict = false) => {
    const left = daylightMinutes(MINUTES_PER_DAY + EVENING, MINUTES_PER_DAY + EVENING + hours * 60) / 60;
    if (left >= MIN_DAYLIGHT_HOURS) return;
    const text = `이야기 ${id}: ${what} ${hours}시간 (17시에 시작하면 낮 시간 ${left}시간, 최소 ${MIN_DAYLIGHT_HOURS}시간)`;
    if (strict) errors.push(text);
    else storyNotes.push(text);
  };
  for (const st of Object.values(content.storylets)) {
    walk(st, (k, v) => {
      if (k === "until" && v && typeof v === "object" && typeof (v as { hours?: unknown }).hours === "number") limit(st.id, "동행 기한", (v as { hours: number }).hours, true);
      if (k === "companion_part" && v && typeof v === "object" && typeof (v as { hours?: unknown }).hours === "number") limit(st.id, "동행 잠시 떨어짐", (v as { hours: number }).hours);
      if ((k === "war_news_within_hours" || k === "party_trace_hours") && typeof v === "number") limit(st.id, k === "war_news_within_hours" ? "전황 소식 창" : "일행 흔적 창", v);
    });
  }
  return { errors: [...new Set(errors)], storyNotes: [...new Set(storyNotes)] };
}
