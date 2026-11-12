import type { Scenario } from "../scenario/schema.ts";
import type { GameState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { dayOf } from "../rules/time.ts";
import { seasonOfDay } from "./season.ts";

/**
 * 날씨 (12-3). 하루에 한 번, 계절별 무게로 고른다 (결정적: 주입한 RNG).
 * 효과는 데이터: visibility(숨은 목격자 확률 배수)와 GM이 장면에 반영할 설명
 */
export type WeatherKind = NonNullable<Scenario["weather"]>["kinds"][number];

export function rollWeather(s: Scenario, day: number, rng: Rng): string | null {
  const w = s.weather;
  if (!w) return null;
  const season = seasonOfDay(s, day)?.id;
  const table = (season && w.by_season[season]) || w.default;
  const entries = Object.entries(table).filter(([, weight]) => weight > 0);
  const total = entries.reduce((n, [, x]) => n + x, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const [id, weight] of entries) {
    r -= weight;
    if (r < 0) return id;
  }
  return entries.at(-1)![0];
}

/** 오늘의 날씨 (아직 안 정했으면 null) */
export function weatherNow(s: Scenario, state: GameState): WeatherKind | null {
  if (!s.weather || !state.weather || state.weather.day !== dayOf(state.time)) return null;
  return s.weather.kinds.find((k) => k.id === state.weather!.id) ?? null;
}
