import { heldOf, pausedWhileHeld } from "../rules/held.ts";
import { josa } from "../text.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { stoveAt } from "./facilities.ts";
import type { Content } from "../content/schemas.ts";
import { isCreature } from "../game/kinds.ts";
import { activeCompanions } from "../game/companions.ts";
import type { GameState } from "../game/state.ts";
import { daysOfStock, disposition, policyEffects } from "../sim/war.ts";
import { dayOf, MINUTES_PER_DAY, nextSegmentStart, SEGMENT_LABELS, SEGMENT_START_HOUR, segmentOf, TIME_SEGMENTS, type Activity } from "../rules/time.ts";
import { trackOf } from "../scenario/scenario.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { changeCondition } from "./body.ts";
import { traitsOf } from "./traits.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { atOwnBase, myPeopleLiveHere, ownedBy } from "../rules/home.ts";
import { shelterAt, welcomedAsGuest } from "../rules/place.ts";
export { welcomedAsGuest } from "../rules/place.ts";

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
  const zone = state.playerZone;
  const owner = zone ? state.zones[zone]?.owner : null;
  if (!shelter || !me || !zone || !owner) return false;
  if (owner !== me.factionId && !welcomedAsGuest(content, state)) return false;
  const host = state.factions[owner];
  return !!host && daysOfStock(content, host, shelter.resource) >= shelter.min_days;
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

/** 내일 새벽이 처음 영하로 떨어지면 오늘 보이는 낌새 (12-239). 내일 날씨는 예보로 셈한다 */
export function frostOmen(content: Content, state: GameState): string | null {
  const c = climateOf(content);
  if (!c?.frost_omen) return null;
  const today = dayOf(state.time);
  const dawn = (day: number) => (day - 1) * MINUTES_PER_DAY + SEGMENT_START_HOUR.dawn * 60;
  const todayDawn = outsideTemp(content, state, dawn(today))?.value ?? 0;
  const forecast = state.forecast?.day === today + 1 ? state.forecast.id : null;
  const tomorrowDawn = (outsideTemp(content, state, dawn(today + 1))?.value ?? 0) + (forecast ? (c.weather[forecast] ?? 0) : 0);
  return todayDawn >= 0 && tomorrowDawn < 0 ? c.frost_omen : null;
}

/** warm: 불 곁이거나 불 땐 실내(거처·피난처)다. 젖은 옷이 마른다 (12-186, 플레이 테스트 8) */
export type Feels = { outside: OutsideTemp; value: number; indoor: boolean; parts: string[]; warm: boolean };

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 덮을 곳이 없는 구역 안의 실내 장소가 막아 주는 도 (폐허 정도, 12-244) */
const PLACE_COVER = 4;

/**
 * 지금 주인공이 있는 곳의 체감 기온. activity: 이 시간 동안 하는 일 (실내인지, 덮고 있는지를 정한다).
 * who: 그 자리의 다른 사람(동행, 12-122). 옷차림·체질·젖은 옷은 그 사람의 것, 자리와 불 땐 거처는 주인공과 같다
 */
export function feelsLike(content: Content, state: GameState, activity: Activity | string, time: number = state.time, who: string = state.playerId): Feels | null {
  const c = climateOf(content);
  const outside = outsideTemp(content, state, time);
  const me = state.characters[who];
  if (!c || !outside || !me) return null;
  const zone = state.playerZone;
  // 지붕 아래인지와 막아 주는 도는 공통 규칙 15 (rules/place.ts의 shelterAt)
  const { indoor, cover } = shelterAt(content, state, activity, who);
  const parts: string[] = [];
  let value = outside.value;
  if (indoor) {
    // 실내는 날씨를 indoor_weather만큼만 받는다. 막아 준 몫은 따로 적는다 (한파 때 "실내 +10"이 "10도 따뜻하다"로 읽혔다, 12-186)
    const blocked = Math.round(-outside.weatherDegrees * (1 - c.indoor_weather));
    value += cover + blocked;
    parts.push(`실내 ${signed(cover)}`);
    if (blocked) parts.push(`날씨를 막아 줌 ${signed(blocked)}`);
  } else {
    parts.push(cover > 0 ? "바깥" : "덮을 곳 없는 바깥");
  }
  // 불: 지핀 불이 타는 동안. 난로(12-167)가 있는 구역이면 난로 안의 불이라 실내에서만 따뜻하다 (12-190: 꺼지지 않는 불이 아니다)
  const stove = !!zone && stoveAt(content, state, zone);
  const fireHere = !!zone && !!c.fire && (state.fires[zone] ?? 0) > time && (!stove || indoor);
  if (fireHere) {
    value += c.fire!.warmth;
    parts.push(`${stove ? "난로" : "모닥불"} ${signed(c.fire!.warmth)}`);
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
  // 다른 사람은 장비 칸을 따로 고르지 않으므로 지닌 옷을 입은 것으로 본다 (12-122)
  const worn = best("worn", (id) => (who !== state.playerId || Object.values(me.equipped ?? {}).includes(id)) && (me.inventory[id] ?? 0) > 0);
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
  const coldTraits = traitsOf(content, me).filter((t) => (t.effects.cold ?? 0) !== 0);
  const trait = coldTraits.reduce((n, t) => n + (t.effects.cold ?? 0), 0) * c.trait_degrees;
  if (trait) {
    value -= trait;
    // 어느 트레잇 때문인지 적는다 (플레이 테스트 11: 설명 없는 "체질 -3")
    parts.push(`체질(${coldTraits.map((t) => t.label).join("·")}) ${signed(-trait)}`);
  }
  // 젖은 옷 (12-121, 12-186): 불 곁이 아니면 체감이 떨어진다. 옷차림·체질까지 셈한 체감으로 세기를 정한다 (12-251)
  if (c.wet && !fireHere && (state.wet?.[me.id] ?? 0) > 0) {
    const d = wetDegrees(c, value);
    value -= d;
    parts.push(`젖은 옷 ${signed(-d)}`);
  }
  // 분배 (12-128): 그 거점 무리의 연료 방침만큼 불 땐 거처가 덜(더) 따뜻하다
  const floor = c.heated + (zone && state.zones[zone]?.owner ? policyEffects(content, state.factions[state.zones[zone]!.owner!]).heated : 0);
  if (indoor && heatedHere(content, state) && value < floor) {
    value = floor;
    // 더하는 값이 아니라 최저 체감이다 (플레이 테스트 11: 합이 맞지 않아 보였다)
    parts.push(`불 땐 거처 (최저 ${floor}°)`);
  } else if (indoor && c.sanctuary !== undefined && zone && content.locations[zone]?.sanctuary && value < c.sanctuary) {
    // 피난처 (12-122): 성당·캠퍼스처럼 누구의 땅도 아닌 곳도 모여 사는 사람들이 불을 땐다. 거점보다는 덜 따뜻하다
    value = c.sanctuary;
    parts.push(`피난처의 난로 (최저 ${c.sanctuary}°)`);
  }
  const warm = fireHere || (indoor && (heatedHere(content, state) || (c.sanctuary !== undefined && !!zone && !!content.locations[zone]?.sanctuary)));
  return { outside, value: Math.round(value), indoor, parts, warm };
}

/** 지금부터 처음 바뀌는 시간대의 시작 */
function nextBoundary(time: number): number {
  return Math.min(...TIME_SEGMENTS.map((seg) => nextSegmentStart(time, seg)));
}

/**
 * from부터 to까지 activity를 하며 보낸 시간의 냉기를 쌓고, 추위 트랙을 바꾼다. take_action이 시간을 흘릴 때마다 부른다.
 * 바뀐 게 있으면 화면·GM에 알릴 결과를 돌려준다
 */
/** 거점 사람들의 추위 한도 단계 (residents.cold_max). 없으면 null */
function residentsColdCap(ctx: ToolContext, factionId: string, levels: readonly { id: string }[]): number | null {
  const max = ctx.content.scenario.body?.residents?.cold_max;
  if (!max || !factionId) return null;
  const i = levels.findIndex((l) => l.id === max);
  return i >= 0 ? i : null;
}


export function exposeToCold(ctx: ToolContext, activity: Activity | string, from: number, to: number): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const displays = exposeOne(ctx, state.playerId, activity, from, to);
  // 함께 다니는 사람도 같은 추위를 겪는다 (12-122). 거점에 사는 사람은 무리가 불을 때 준다고 보고 계산하지 않는다
  for (const id of activeCompanions(state)) {
    if (isCreature(ctx.content, state.characters[id])) continue;
    displays.push(...exposeOne(ctx, id, activity, from, to));
  }
  return displays;
}

function exposeOne(ctx: ToolContext, who: string, activity: Activity | string, from: number, to: number): ToolDisplayEvent[] {
  const c = climateOf(ctx.content);
  const track = ctx.content.scenario.body?.cold?.track;
  const state = ctx.store.getState();
  const me = state.characters[who];
  if (!c || !track || !me || me.dead || to <= from) return [];
  const before = state.coldLoad[me.id] ?? 0;
  let load = before;
  // 젖은 옷 (12-121, 12-186): 젖는 날씨에 바깥에 있으면 젖고, 불 곁에 fire_hours 있어야 마른다 (시간으로는 마르지 않는다)
  let wetLeft = state.wet?.[me.id] ?? 0;
  const wetBefore = wetLeft;
  let coldest: Feels | null = null;
  let warmest: Feels | null = null;
  let allIndoor = true;
  for (let t = from; t < to; ) {
    const end = Math.min(to, nextBoundary(t));
    const f = feelsLike(ctx.content, { ...state, wet: { ...state.wet, [me.id]: wetLeft } }, activity, t, me.id);
    if (!f) break;
    if (!f.indoor) allIndoor = false;
    if (c.wet) {
      const weather = dayOf(t) === dayOf(state.time) ? weatherNow(ctx.content.scenario, state) : null;
      if (!f.indoor && weather && c.wet.weather.includes(weather.id) && !wearsWaterproof(ctx, me.id)) wetLeft = Math.round(c.wet.fire_hours * 60);
      // 불 곁이면 fire_hours, 지붕 아래면 roof_hours에 마른다 (12-251: 빗속 섬에서 사흘 내내 젖어 있었다)
      else if (wetLeft > 0 && (f.warm || f.indoor)) wetLeft = Math.max(0, Math.round(wetLeft - (end - t) * (f.warm ? 1 : c.wet.fire_hours / c.wet.roof_hours)));
    }
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
  // 우리 거점 실내에서는 거점 사람들과 같은 한도에서 멈춘다 (12-138, 4.5.4): 불을 못 때도 모여서 버틴다.
  // 같은 방의 거점 사람은 오한에서 멈추는데 이어받은 주인공만 얼어 죽어 계승이 연달아 끊겼다. 바깥은 그대로 위험하다
  const cap = residentsColdCap(ctx, me.factionId, levels);
  const capped = steps > 0 && allIndoor && cap !== null && atOwnBase(ctx.store.getState(), ctx.content, undefined, me.id) && index + steps > cap;
  if (capped) steps = Math.max(0, cap! - index);
  load -= steps * c.per_step;
  // 한도에 걸렸으면 남은 냉기를 쌓아 두지 않는다 (밖에 나가자마자 여러 단계가 한꺼번에 떨어지지 않게)
  if (capped) load = Math.min(load, c.per_step - 1);
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
  if (wetLeft !== wetBefore && !ctx.store.getState().characters[me.id]?.dead) {
    const name = playerCalls(ctx.store.getState(), ctx.content, me.id);
    if (wetBefore <= 0) displays.push(...soak(ctx, me.id, "비를 맞았다"));
    else if (wetLeft <= 0) displays.push(dryOff(ctx, me.id, name, warmest?.warm || coldest?.warm ? "불기 곁에서 말렸다" : "지붕 아래에서 말렸다"));
    else ctx.store.append({ type: "wet_set", characterId: me.id, left: wetLeft, cause: "말리는 중" });
  }
  return displays;
}

/** 방수복을 입고 있는가 (E3) */
export function wearsWaterproof(ctx: ToolContext, who: string): boolean {
  const me = ctx.store.getState().characters[who];
  return !!me && Object.values(me.equipped ?? {}).some((id) => !!id && (me.inventory[id] ?? 0) > 0 && !!ctx.content.items[id]?.armor?.waterproof);
}

/** 젖은 옷 (12-186): 마르기까지 체감이 떨어진다. 무엇으로 마르는지 GM·화면에 알린다. splash: 물이 튀는 정도라 방수복이 막는다 (물에 빠지면 막지 못한다) */
export function soak(ctx: ToolContext, who: string, cause: string, splash = false): ToolDisplayEvent[] {
  const wet = climateOf(ctx.content)?.wet;
  const me = ctx.store.getState().characters[who];
  if (!wet || !me || me.dead) return [];
  if (splash && wearsWaterproof(ctx, who)) return [];
  const was = (ctx.store.getState().wet?.[who] ?? 0) > 0;
  ctx.store.append({ type: "wet_set", characterId: who, left: Math.round(wet.fire_hours * 60), cause });
  if (was) return [];
  return [{ type: "harm", targetName: playerCalls(ctx.store.getState(), ctx.content, who), trackLabel: "옷", severityLabel: cause, fatal: false, fromLabel: "마름", toLabel: "젖음", cause: `${cause}. 마를 때까지 체감이 ${wet.degrees.mild}~${wet.degrees.cold}° 떨어진다 (추울수록 크다). 바깥에서는 마르지 않는다: 불 곁이나 불 땐 실내에서 ${wet.fire_hours}시간, 지붕 아래에서 ${wet.roof_hours}시간, 또는 갈아입을 옷이 있는 곳(우리 거점·거처·옷이 남은 폐허)에서 갈아입는다` }];
}

function dryOff(ctx: ToolContext, who: string, name: string, by: string): ToolDisplayEvent {
  ctx.store.append({ type: "wet_set", characterId: who, left: 0, cause: by });
  return { type: "heal", targetName: name, trackLabel: "옷", fromLabel: "젖음", toLabel: "마름", byLabel: by };
}

/** 갈아입을 옷이 있는 곳인가 (12-186): 우리 무리의 거점, 내 거처, 옷이 남은 곳(location.clothes) */
export function clothesHere(content: Content, state: GameState): boolean {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me || !zone) return false;
  if (content.locations[zone]?.clothes) return true;
  if (state.homes?.[me.id] === zone) return true;
  // 우리 거점, 그리고 내 사람이 사는 곳 (공통 규칙 11, 12-238: 우리 무리가 상주하는 물류창고, 부모님 집)
  return atOwnBase(state, content, zone) || myPeopleLiveHere(state, content, zone);
}

/** 젖은 옷을 갈아입는다 (take_action.change_clothes): 주인공과 곁의 사람들 */
export function changeClothes(ctx: ToolContext): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const state = ctx.store.getState();
  if (!climateOf(ctx.content)?.wet) return { ok: false, error: "이 월드에는 젖은 옷 규칙이 없다." };
  if (!clothesHere(ctx.content, state)) return { ok: false, error: "여기에는 갈아입을 옷이 없다 (우리 무리의 거점, 내 거처, 우리 무리나 가족이 사는 곳, 옷이 남은 곳에서만)." };
  // 끌고 다니는 포로는 빼고 (묶인 사람의 옷까지 갈아입히지 않는다)
  const who = [state.playerId, ...activeCompanions(state).filter((id) => !isCreature(ctx.content, state.characters[id]) && state.bonds?.[id]?.kind !== "prisoner")].filter((id) => (state.wet?.[id] ?? 0) > 0);
  if (!who.length) return { ok: false, error: "젖은 옷을 입은 사람이 없다." };
  const displays = who.map((id) => dryOff(ctx, id, playerCalls(state, ctx.content, id), "마른 옷으로 갈아입었다"));
  return { ok: true, lines: [`${who.map((id) => playerCalls(state, ctx.content, id)).join(", ")}: 마른 옷으로 갈아입었다.`], displays };
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
  if ((me.inventory[item] ?? 0) < 1) return { ok: false, error: `${josa(name, "이/가")} 없다.` };
  // 난로가 있으면 같은 땔감이 오래 탄다 (12-190)
  const stove = stoveAt(ctx.content, state, zone);
  const until = Math.max(state.time, state.fires[zone] ?? 0) + Math.round(hours * (stove ? fire.stove : 1) * 60);
  ctx.store.append({ type: "item_consumed", holder: me.id, itemId: item, quantity: 1 });
  ctx.store.append({ type: "fire_lit", zone, until, itemId: item });
  if (fire.noise > 0) ctx.store.append({ type: "noise_made", zone, level: fire.noise, day: dayOf(state.time) });
  const hoursLeft = Math.round(((until - state.time) / 60) * 10) / 10;
  return {
    ok: true,
    lines: [
      stove
        ? `난로에 ${josa(name, "을/를")} 넣었다. 앞으로 ${hoursLeft}시간쯤 탄다 (실내에 있으면 체감 +${fire.warmth}°). 연통의 연기는 멀리서도 보일 수 있다.`
        : `${josa(name, "으로/로")} 불을 피웠다. 앞으로 ${hoursLeft}시간쯤 탄다 (곁에 있으면 체감 +${fire.warmth}°). 연기와 불빛은 멀리서도 보일 수 있다.`,
    ],
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
    (fireLeft > 0 ? `. 모닥불이 ${Math.ceil(fireLeft / 60)}시간쯤 더 탄다` : "") +
    wetNote(content, state)
  );
}

/** 젖은 옷이 떨어뜨리는 도 (12-251): 젖기 전 체감이 추울수록 크다 */
export function wetDegrees(c: NonNullable<ReturnType<typeof climateOf>>, before: number): number {
  const d = c.wet!.degrees;
  return before < c.comfort ? d.cold : before < c.warm ? d.cool : d.mild;
}

/** 젖은 옷이면 GM 기온 줄에 붙는 말 (12-186) */
function wetNote(content: Content, state: GameState): string {
  const wet = climateOf(content)?.wet;
  const left = state.wet?.[state.playerId] ?? 0;
  if (!wet || left <= 0) return "";
  // 불 곁이면 체감에서 빼고 마르는 중이라고 (플레이 테스트 12: 체감 합에 젖은 옷이 빠졌는데 이 줄은 -10°라고 했다)
  const zone = state.playerZone;
  const byFire = !!zone && (state.fires?.[zone] ?? 0) > state.time;
  if (byFire) return `. 옷이 젖어 있다 (불 곁이라 체감에는 들지 않고 마르는 중: ${Math.ceil(left / 60)}시간 더)`;
  const f = feelsLike(content, state, "rest");
  const d = f?.parts.find((p) => p.startsWith("젖은 옷"))?.replace("젖은 옷 ", "") ?? "";
  const roof = Math.ceil((left / 60) * (wet.roof_hours / wet.fire_hours));
  return `. 옷이 젖어 있다 (체감 ${d}°, 바깥에서는 마르지 않는다: 불 곁이나 불 땐 실내에서 ${Math.ceil(left / 60)}시간, 지붕 아래에서 ${roof}시간 더, 또는 ${clothesHere(content, state) ? "여기서 갈아입을 수 있다 (take_action.change_clothes)" : "갈아입을 옷이 있는 곳에서 갈아입기"})`;
}
