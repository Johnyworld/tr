import type { Scenario } from "../scenario/schema.ts";
import { dayOf, type GameTime } from "../rules/time.ts";

/**
 * 계절 (기획서 2.1, 12-1): 계절이 돌고, 겨울마다 자원 압박이 커진다.
 * 1일차는 seasons.start의 계절·날짜. 계절의 길이와 소모·산출 배수는 시나리오가 정한다
 */
export type SeasonInfo = { id: string; label: string; dayInSeason: number; days: number; upkeep: Record<string, number>; yields: Record<string, number> };

export function seasonOfDay(s: Scenario, day: number): SeasonInfo | null {
  const seasons = s.seasons;
  if (!seasons) return null;
  const list = seasons.list;
  const startIndex = list.findIndex((x) => x.id === seasons.start.season);
  const total = list.reduce((n, x) => n + x.days, 0);
  // 시작 계절의 첫날부터 센 날수
  let offset = list.slice(0, startIndex).reduce((n, x) => n + x.days, 0) + (seasons.start.day - 1) + (day - 1);
  offset = ((offset % total) + total) % total;
  for (const x of list) {
    if (offset < x.days) return { id: x.id, label: x.label, dayInSeason: offset + 1, days: x.days, upkeep: x.upkeep, yields: x.yields };
    offset -= x.days;
  }
  return null;
}

export function seasonAt(s: Scenario, time: GameTime): SeasonInfo | null {
  return seasonOfDay(s, dayOf(time));
}

/** "늦가을 (가을 18/20일)" 같은 말 대신 짧게: "가을 18일째" */
export function seasonLabel(info: SeasonInfo | null): string {
  if (!info) return "";
  const phase = info.dayInSeason <= info.days / 3 ? "초" : info.dayInSeason > (info.days * 2) / 3 ? "늦" : "한";
  return `${phase}${info.label}`;
}
