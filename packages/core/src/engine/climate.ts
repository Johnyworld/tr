import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { daysOfStock } from "../sim/war.ts";
import { dayOf, nextSegmentStart, SEGMENT_LABELS, segmentOf, TIME_SEGMENTS, type Activity } from "../rules/time.ts";
import { trackOf } from "../scenario/scenario.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { changeCondition } from "./body.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 기온 (기획서 4.5.2, 12-98): 시간대마다 바깥 기온을 정하고, 주인공이 있는 곳의 체감 기온으로 냉기를 쌓는다.
 * - 바깥 = 계절 평균 + 시간대 + 날씨 + 그날의 들쭉날쭉 (같은 날은 늘 같다)
 * - 체감 = 바깥 + 실내(구역 cover, 날씨는 덜 받는다) + 모닥불 + 옷차림(입은 외투, 자거나 쉴 때 덮는 담요) + 트레잇. 불 땐 거점 실내는 최저 heated
 * - 실내인지는 활동과 구역으로 정한다 (이동·수색·보초·전투는 바깥, 덮을 곳이 없는 구역은 늘 바깥). GM이 정하는 값은 없다
 * - 냉기가 per_step 쌓일 때마다 추위 트랙이 오르고, 따뜻한 곳에서 빠지면 풀린다. 주인공만 계산한다
 */

const climateOf = (content: Content) => content.scenario.body?.cold?.climate;

/** 불 땐 거처: 우리 무리 땅이고 무리의 연료가 넉넉하다 (body.cold.shelter) */
function heatedHere(content: Content, state: GameState): boolean {
  const shelter = content.scenario.body?.cold?.shelter;
  const me = state.characters[state.playerId];
  if (!shelter || !me || !state.playerZone || state.zones[state.playerZone]?.owner !== me.factionId) return false;
  const own = state.factions[me.factionId];
  return !!own && daysOfStock(content, own, shelter.resource) >= shelter.min_days;
}

/** 활동이 없을 때(상태 화면·GM 상태)의 기준: 그 구역에서 쉬고 있다 */
const RESTING_ACTIVITIES: readonly string[] = ["sleep", "rest", "wait"];

/** 그날의 들쭉날쭉: 세계와 날에서 정해지는 -1 ~ 1. 세계의 씨앗(같은 시드면 같다), 없으면(이전 세이브) 세계 id */
function dayNoise(world: string | number, day: number): number {
  let h = 2166136261;
  for (const ch of `${world}:${day}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 2001) / 1000 - 1;
}

export type OutsideTemp = { value: number; segmentLabel: string; weatherLabel: string | null; weatherDegrees: number };

/** 바깥 기온 (도, 정수) */
export function outsideTemp(content: Content, state: GameState, time: number = state.time): OutsideTemp | null {
  const c = climateOf(content);
  if (!c) return null;
  const s = content.scenario;
  const season = seasonAt(s, time);
  const weather = dayOf(time) === dayOf(state.time) ? weatherNow(s, state) : null;
  const weatherDegrees = weather ? (c.weather[weather.id] ?? 0) : 0;
  const segment = segmentOf(time);
  const value = (season ? (c.season[season.id] ?? 0) : 0) + c.segments[segment] + weatherDegrees + c.jitter * dayNoise(state.worldSeed ?? state.worldId, dayOf(time));
  return { value: Math.round(value), segmentLabel: SEGMENT_LABELS[segment], weatherLabel: weather?.label ?? null, weatherDegrees };
}

export type Feels = { outside: OutsideTemp; value: number; indoor: boolean; parts: string[] };

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 지금 주인공이 있는 곳의 체감 기온. activity: 이 시간 동안 하는 일 (실내인지, 덮고 있는지를 정한다) */
export function feelsLike(content: Content, state: GameState, activity: Activity | string, time: number = state.time): Feels | null {
  const c = climateOf(content);
  const outside = outsideTemp(content, state, time);
  const me = state.characters[state.playerId];
  if (!c || !outside || !me) return null;
  const zone = state.playerZone;
  const cover = (zone ? content.locations[zone]?.cover : undefined) ?? 0;
  const indoor = cover > 0 && !c.outdoor.includes(activity);
  const parts: string[] = [];
  let value = outside.value;
  if (indoor) {
    const sheltering = Math.round(cover - outside.weatherDegrees * (1 - c.indoor_weather));
    value += sheltering;
    parts.push(`실내 ${signed(sheltering)}`);
  } else {
    parts.push(cover > 0 ? "바깥" : "덮을 곳 없는 바깥");
  }
  if (zone && c.fire && (state.fires[zone] ?? 0) > time) {
    value += c.fire.warmth;
    parts.push(`모닥불 ${signed(c.fire.warmth)}`);
  }
  // 옷차림: 입은 것(worn)과, 자거나 쉴 때 덮는 것(resting). 종류마다 가장 따뜻한 하나
  const best = (when: "worn" | "resting", have: (id: string) => boolean) => {
    let top: { id: string; degrees: number } | null = null;
    for (const [id, item] of Object.entries(content.items)) {
      if (item.warmth?.when !== when || !have(id)) continue;
      if (!top || item.warmth.degrees > top.degrees) top = { id, degrees: item.warmth.degrees };
    }
    return top;
  };
  const worn = best("worn", (id) => Object.values(me.equipped ?? {}).includes(id) && (me.inventory[id] ?? 0) > 0);
  if (worn) {
    value += worn.degrees;
    parts.push(`${content.items[worn.id]!.name} ${signed(worn.degrees)}`);
  }
  if (RESTING_ACTIVITIES.includes(activity)) {
    const cover2 = best("resting", (id) => (me.inventory[id] ?? 0) > 0);
    if (cover2) {
      value += cover2.degrees;
      parts.push(`${content.items[cover2.id]!.name} ${signed(cover2.degrees)}`);
    }
  }
  const trait = traitsOf(content, me).reduce((n, t) => n + (t.effects.cold ?? 0), 0) * c.trait_degrees;
  if (trait) {
    value -= trait;
    parts.push(`체질 ${signed(-trait)}`);
  }
  if (indoor && heatedHere(content, state) && value < c.heated) {
    value = c.heated;
    parts.push("불 땐 거처");
  }
  return { outside, value: Math.round(value), indoor, parts };
}

/** 지금부터 처음 바뀌는 시간대의 시작 */
function nextBoundary(time: number): number {
  return Math.min(...TIME_SEGMENTS.map((seg) => nextSegmentStart(time, seg)));
}

/**
 * from부터 to까지 activity를 하며 보낸 시간의 냉기를 쌓고, 추위 트랙을 바꾼다. take_action이 시간을 흘릴 때마다 부른다.
 * 바뀐 게 있으면 화면·GM에 알릴 결과를 돌려준다
 */
export function exposeToCold(ctx: ToolContext, activity: Activity | string, from: number, to: number): ToolDisplayEvent[] {
  const c = climateOf(ctx.content);
  const track = ctx.content.scenario.body?.cold?.track;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!c || !track || !me || me.dead || to <= from) return [];
  const before = state.coldLoad[me.id] ?? 0;
  let load = before;
  let coldest: Feels | null = null;
  let warmest: Feels | null = null;
  for (let t = from; t < to; ) {
    const end = Math.min(to, nextBoundary(t));
    const f = feelsLike(ctx.content, state, activity, t);
    if (!f) break;
    const hours = (end - t) / 60;
    if (f.value < c.comfort) {
      load += (c.comfort - f.value) * hours;
      if (!coldest || f.value < coldest.value) coldest = f;
    } else {
      load -= (f.value >= c.warm ? c.warm_rate : c.mild_rate) * hours;
      if (!warmest || f.value > warmest.value) warmest = f;
    }
    t = end;
  }

  const levels = trackOf(ctx.content.scenario, track).levels;
  const index = Math.max(0, levels.findIndex((l) => l.id === me.conditions[track]));
  let steps = 0;
  if (load >= c.per_step) steps = Math.floor(load / c.per_step);
  else if (load <= -c.per_step && index > 0) steps = -Math.min(index, Math.floor(-load / c.per_step));
  load -= steps * c.per_step;
  // 멀쩡할 때는 따뜻함을 쌓아 두지 않는다
  if (index + steps <= 0) load = Math.max(0, load);
  load = Math.round(load * 10) / 10;

  const displays: ToolDisplayEvent[] = [];
  if (steps !== 0) {
    const f = steps > 0 ? coldest : warmest;
    const where = f ? `${f.outside.segmentLabel} 바깥 ${f.outside.value}°${f.outside.weatherLabel ? `·${f.outside.weatherLabel}` : ""}, 체감 ${f.value}° (${f.parts.join(", ")})` : "";
    const ch = changeCondition(ctx, me.id, track, steps, "cold", steps > 0 ? `추위: ${where}` : `몸이 녹았다: ${where}`);
    if (ch?.display) displays.push(ch.display);
  }
  if (load !== before && !ctx.store.getState().characters[me.id]?.dead) ctx.store.append({ type: "cold_load_set", characterId: me.id, load });
  return displays;
}

/** 모닥불을 피운다 (연료 아이템을 쓴다). 같은 구역에 있으면 따뜻하고, 연기와 불빛은 소음이 된다 */
export function lightFire(ctx: ToolContext, item: string): { ok: true; lines: string[] } | { ok: false; error: string } | null {
  const fire = climateOf(ctx.content)?.fire;
  const hours = fire?.items[item];
  if (!fire || hours === undefined) return null;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const name = ctx.content.items[item]?.name ?? item;
  const zone = state.playerZone;
  if (!zone) return { ok: false, error: "불을 피울 곳이 없다." };
  if ((me.inventory[item] ?? 0) < 1) return { ok: false, error: `${name}이(가) 없다.` };
  const until = Math.max(state.time, state.fires[zone] ?? 0) + Math.round(hours * 60);
  ctx.store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: 1 });
  ctx.store.append({ type: "fire_lit", zone, until, itemId: item });
  if (fire.noise > 0) ctx.store.append({ type: "noise_made", zone, level: fire.noise, day: dayOf(state.time) });
  const hoursLeft = Math.round(((until - state.time) / 60) * 10) / 10;
  return {
    ok: true,
    lines: [`${name}(으)로 불을 피웠다. 앞으로 ${hoursLeft}시간쯤 탄다 (곁에 있으면 체감 +${fire.warmth}°). 연기와 불빛은 멀리서도 보일 수 있다.`],
  };
}

/** GM 상태·상태 화면의 한 줄: "바깥 -7° (밤·눈), 여기 체감 3° (실내 +4, 모닥불 +10)" */
export function describeTemperature(content: Content, state: GameState): string | null {
  const f = feelsLike(content, state, "rest");
  if (!f) return null;
  const fireLeft = state.playerZone ? (state.fires[state.playerZone] ?? 0) - state.time : 0;
  return (
    `바깥 ${f.outside.value}° (${f.outside.segmentLabel}${f.outside.weatherLabel ? `·${f.outside.weatherLabel}` : ""}), ` +
    `여기서 쉬면 체감 ${f.value}° (${f.parts.join(", ")})` +
    (fireLeft > 0 ? `. 모닥불이 ${Math.ceil(fireLeft / 60)}시간쯤 더 탄다` : "")
  );
}
