/**
 * 공통 규칙 15: 장소 (docs/design.md "공통 규칙", 12-244).
 *
 * 구역 > 장소 두 단계. 어디에 있는지, 그곳이 지붕 아래인지, 누가 그곳에 있는지는 여기서 정한다.
 * - 장소: 구역의 콘텐츠 장소(모두가 쓰는 곳) + GM이 즉흥으로 만든 장소(개인 거처·화장실 등, 세이브에 남는다)
 * - 장소 개편 (docs/places-v2-plan.md): 장소 사이는 이웃 목록(near), 구역 안의 길도 장소다. 구역에 들어오면 길에 도착한다.
 *   장소가 늘 정해진다. 장소가 하나도 없는 구역(다른 월드 팩·테스트)만 null이고, 그때는 구역의 cover로 정한다
 * - 실내외는 장소의 indoor로 (플레이 테스트: "정문 앞 처마인데 실내 +7", "야영인데 실내 +4")
 * - 인물이 있는 장소: 일과(routine)의 그 시간대 말이 장소 이름·aliases와 맞으면 그 장소. 밤에는 자기 거처(주인 있는 즉흥 장소)
 * - 처음엔 수색표·땅 주인·전투·잠입은 구역 단위 그대로
 * 지금 장소와 즉흥 장소는 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { Content } from "../content/schemas.ts";
import { roleOf, type GameState } from "../game/state.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { segmentOf, TIME_SEGMENTS, type TimeSegment } from "./time.ts";
import { josa } from "../text.ts";
import {ownedBy, baseOfNow, hostileLand, onOwnLand } from "./home.ts";
import { heldOf, inQuarantine, pausedWhileHeld } from "./held.ts";
import { disposition } from "../sim/war.ts";
import { isCreature } from "../game/kinds.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { routeMinutes } from "./time.ts";

export type Place = { id: string; zone: string; name: string; indoor: boolean; owner: string | null; spawned: boolean; aliases: readonly string[]; jail?: boolean; wade?: boolean; description?: string; near: readonly string[]; road: boolean; to: readonly string[]; gate: boolean };

/** 이 구역의 장소들 (콘텐츠 + 즉흥) */
export function placesIn(state: GameState, content: Content, zone: string | null | undefined): Place[] {
  if (!zone) return [];
  const spawned = Object.entries(state.spawnedPlaces ?? {}).filter(([, p]) => p.zone === zone);
  // 즉흥 장소는 만든 자리의 이웃이다 (장소 개편)
  const fixed = (content.locations[zone]?.places ?? []).map((p) => ({
    id: p.id, zone, name: p.name, indoor: p.indoor, owner: null, spawned: false, aliases: p.aliases, jail: p.jail, wade: p.wade, description: p.description,
    near: [...(p.near ?? []), ...spawned.filter(([, x]) => x.at === p.id).map(([id]) => id)], road: !!p.road, to: p.to ?? [], gate: !!p.gate,
  }));
  const extra = spawned.map(([id, p]) => ({ id, zone, name: p.name, indoor: p.indoor, owner: p.owner, spawned: true, aliases: [] as string[], near: p.at ? [p.at] : [], road: false, to: [] as string[], gate: false }));
  return [...fixed, ...extra];
}

/** 장소 하나 (지금 구역에서) */
export function placeById(state: GameState, content: Content, id: string | null | undefined, zone: string | null | undefined = state.playerZone): Place | null {
  return id ? (placesIn(state, content, zone).find((p) => p.id === id) ?? null) : null;
}

/** place_to 값이 가리키는 장소 (이 구역에 없으면 undefined) */
export function placeTarget(state: GameState, content: Content, id: string): Place | undefined {
  return placeById(state, content, id) ?? undefined;
}

/** 이 구역의 길 (구역에 들어오면 도착하는 곳) */
export function roadsIn(state: GameState, content: Content, zone: string | null | undefined): Place[] {
  return placesIn(state, content, zone).filter((p) => p.road);
}

/**
 * 구역에 들어올 때 도착하는 길 (장소 개편: "막 들어선 자리"를 대신한다): 떠나온 구역으로 이어지는 길, 없으면 첫 길.
 * 길이 없는 구역이면 null
 */
export function arrivalPlace(state: GameState, content: Content, to: string, from: string | null = null): string | null {
  const roads = roadsIn(state, content, to);
  // 길이 없는 구역(다른 월드 팩·테스트)은 예전처럼 장소를 정하지 않는다
  return (roads.find((r) => !!from && r.to.includes(from)) ?? roads[0])?.id ?? null;
}

/** 이웃 장소 id (콘텐츠 near + 즉흥 장소) */
export function neighborsOf(state: GameState, content: Content, id: string, zone: string | null | undefined = state.playerZone): string[] {
  return [...(placeById(state, content, id, zone)?.near ?? [])];
}

/** 같은 구역의 두 장소 사이 칸수 (이웃 1, 닿지 않으면 Infinity) */
export function stepsBetween(state: GameState, content: Content, from: string | null, to: string | null, zone: string | null | undefined = state.playerZone): number {
  if (from === to) return 0;
  if (!from || !to) return 1;
  const places = new Map(placesIn(state, content, zone).map((p) => [p.id, p]));
  const dist = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift()!;
    for (const n of places.get(at)?.near ?? []) {
      if (dist.has(n)) continue;
      dist.set(n, dist.get(at)! + 1);
      if (n === to) return dist.get(n)!;
      queue.push(n);
    }
  }
  return Infinity;
}

/** 지금 장소에서 가장 가까운 길 (빠져나올 때) */
export function nearestRoad(state: GameState, content: Content): string | null {
  const roads = roadsIn(state, content, state.playerZone);
  if (!roads.length) return null;
  return roads.map((r) => ({ id: r.id, d: stepsBetween(state, content, state.playerPlace, r.id) })).sort((a, b) => a.d - b.d)[0]!.id;
}

/**
 * 장면 밖 사람이 주인공 곁에 얼마나 가까운가 (장소 개편, 숨은 목격자): 같은 장소 2, 이웃 장소 1, 그 밖 0.
 * 장소가 없는 구역이면 같은 구역 사람을 1로 본다
 */
export function closeness(state: GameState, content: Content, id: string): 0 | 1 | 2 {
  const w = whereIs(state, content, id);
  if (!w) return 0;
  // 구역이 없는 장면(세계를 막 만든 테스트 등)은 누구든 이웃만큼. 구역 밖에 나간 사람(zone 없음)은 보지 못한다
  if (!state.playerZone) return 1;
  if (!w.zone) return 0;
  if (w.zone !== state.playerZone) return 0;
  // 장소를 모르면(장소 없는 구역, 장소를 정하기 전 테스트 세계) 같은 구역 사람은 이웃만큼 본다
  if (!state.playerPlace || !w.place) return 1;
  if (w.place === state.playerPlace) return 2;
  return neighborsOf(state, content, state.playerPlace).includes(w.place) ? 1 : 0;
}

/** 주인공이 지금 있는 장소 (정하지 않았으면 null) */
export function currentPlace(state: GameState, content: Content): Place | null {
  return placeById(state, content, state.playerPlace);
}

/**
 * 불이 붙는 자리 (12-267, PT19 튜토리얼: 담 밖에 피운 모닥불이 담 안 식당까지 데웠다): 장소가 있으면 구역과 장소, 막 들어선 자리·장소 없는 구역은 구역.
 * 불(state.fires)은 이 열쇠로 적고 읽는다
 */
export function fireSpot(state: GameState): string | null {
  if (!state.playerZone) return null;
  return state.playerPlace ? `${state.playerZone}@${state.playerPlace}` : state.playerZone;
}

/** 지금 자리에 불이 타고 있는가 */
export function fireLitHere(state: GameState, at: number = state.time): boolean {
  const spot = fireSpot(state);
  return !!spot && (state.fires?.[spot] ?? 0) > at;
}

/** 지금 있는 곳이 지붕 아래인가: 장소가 있으면 그 장소, 없으면 null (구역의 cover로 정한다) */
export function placeIndoor(state: GameState, content: Content): boolean | null {
  return currentPlace(state, content)?.indoor ?? null;
}

/** 이야기의 실내외 조건: true 실내, false 바깥, undefined 어디서나 ("any"도 어디서나) */
export function storyIndoor(when: { indoor?: boolean | "any" }): boolean | undefined {
  return when.indoor === "any" ? undefined : when.indoor;
}

/** 이야기의 장소 조건 (when.places·when.indoor·when.summons)과 글 */
export type StoryWhere = { places?: readonly string[]; indoor?: boolean; summons?: boolean };

/**
 * 실내(true)·바깥(false) 이야기가 지금 자리에 맞는가 (지금 장소의 실내외). 부르는 이야기는 그 장소로 불려 가니 장소의 실내외로 본다.
 * 이야기는 주인공을 옮기지 않는다 (이동 기획): 길에서 실내 이야기를 열어 데려가던 것(B①)은 없앴다. 장소가 없는 구역은 거르지 않는다
 */
export function storyPlaceFits(state: GameState, content: Content, indoor: boolean, where: StoryWhere = {}, text = ""): boolean {
  const here = currentPlace(state, content);
  if (!here) return true;
  if (here.indoor === indoor) return true;
  if (!where.summons) return false;
  const named = storyPlaces(state, content, where.places, text, indoor);
  return named.length === 1 && placeById(state, content, named[0])?.indoor === indoor;
}

/**
 * 이야기의 장소가 지금 자리에 맞는가 (12-251, 플레이 테스트 14: 경비실에서 "우물가", 격리실에서 약제실·부엌 장면).
 * places를 적었으면 그 장소, 아니면 이야기 글에 나오는 지금 구역의 장소 이름·aliases. 글이 장소를 말하지 않거나
 * 길(구역에 막 들어온 자리)·즉흥 장소에 있으면 거르지 않는다 (이야기가 그 자리로 데려간다)
 */
export function storyPlacesFit(state: GameState, content: Content, places: readonly string[] | undefined, text: string, summons = false, indoor?: boolean): boolean {
  const here = currentPlace(state, content);
  // 부르는 이야기는 어디서든 연다: 그 장소로 데려간다 (12-260). 그 밖의 이야기는 주인공이 이미 있는 자리에서만 연다 (공통 규칙 15, 이동 기획: 이야기는 주인공을 옮기지 않는다)
  if (!here || here.spawned || summons) return true;
  const named = storyPlaces(state, content, places, text, indoor);
  return !named.length || named.includes(here.id);
}

/**
 * 이야기가 주인공을 데려갈 곳: 부르는 이야기(summons, 12-260)만, 그 이야기의 장소 하나로 (이미 거기 있거나 갇혔으면 null).
 * 그 밖의 이야기는 주인공을 옮기지 않는다 (이동 기획, PT20~22: 이야기가 글의 낱말에 맞춰 주인공을 정문·골목·담 안으로 옮겼다)
 */
export function storySummonsTo(state: GameState, content: Content, places: readonly string[] | undefined, text: string, summons: boolean, indoor?: boolean): string | null {
  if (!summons || heldOf(state.characters[state.playerId])) return null;
  const named = storyPlaces(state, content, places, text, indoor);
  return named.length === 1 && named[0] !== state.playerPlace ? named[0]! : null;
}

/** 시작 장면 글이 이 구역의 장소 하나를 말하면 그 장소 (세계를 열 때 처음 놓을 자리, 12-259) */
export function openingPlace(state: GameState, content: Content, text: string): string | null {
  const named = storyPlaces(state, content, undefined, text);
  return named.length === 1 ? named[0]! : null;
}

/**
 * 이야기가 말하는 지금 구역의 장소 (places를 적었으면 그것, 아니면 글에 나오는 장소 이름·aliases).
 * 글자로 맞춘 장소는 이야기의 실내외(indoor)와 같아야 한다 (B① 2026-11-23: 바위 위 이야기 "저장고 아래 바위"가 실내 식당의 별칭 "저장고"와 맞았다)
 */
export function storyPlaces(state: GameState, content: Content, places: readonly string[] | undefined, text: string, indoor?: boolean): string[] {
  if (places) return [...places];
  return placesIn(state, content, state.playerZone)
    .filter((p) => !p.spawned && (indoor === undefined || p.indoor === indoor) && [p.name, ...p.aliases].some((a) => text.includes(a)))
    .map((p) => p.id);
}

/**
 * 잠입 깊이 (B③ 12-273, 장소 개편에서 gate로): 담 있는 구역(gate 장소가 있는 구역)은 길에서 gate를 거치지 않고 닿는 곳 0(담 밖),
 * gate 1(담 안), gate 너머는 1 + gate에서 몇 칸. 담 없는 구역은 길에서 몇 칸. 가장 깊은 칸(infiltration.depths)에서 멈춘다.
 * 장소가 없는 구역은 null (잠입이 깊이만 따로 센다)
 */
export function depthAt(state: GameState, content: Content, placeId: string | null = state.playerPlace, zone: string | null = state.playerZone): number | null {
  const places = placesIn(state, content, zone);
  if (!places.length) return null;
  const deepest = Math.max(0, (content.scenario.infiltration?.depths.length ?? 1) - 1);
  const byId = new Map(places.map((p) => [p.id, p]));
  const walled = places.some((p) => p.gate);
  // 담 있는 구역: 길에서 gate를 거치지 않고 닿는 곳이 0, 거기 맞닿은 gate가 1, 그 너머는 한 칸씩
  const depth = new Map<string, number>();
  const spread = (from: string[], start: number, pass: (p: Place) => boolean) => {
    const queue = from.filter((id) => !depth.has(id));
    for (const id of queue) depth.set(id, start);
    while (queue.length) {
      const at = queue.shift()!;
      for (const n of byId.get(at)?.near ?? []) {
        const next = byId.get(n);
        if (!next || depth.has(n) || !pass(next)) continue;
        depth.set(n, depth.get(at)! + (walled ? 0 : 1));
        queue.push(n);
      }
    }
  };
  const roads = places.filter((p) => p.road).map((p) => p.id);
  if (!walled) spread(roads, 0, () => true);
  else {
    spread(roads, 0, (p) => !p.gate);
    const gates = places.filter((p) => p.gate && p.near.some((n) => depth.get(n) === 0)).map((p) => p.id);
    // gate 너머는 칸마다 하나씩
    const queue = gates.filter((id) => !depth.has(id));
    for (const id of queue) depth.set(id, 1);
    while (queue.length) {
      const at = queue.shift()!;
      for (const n of byId.get(at)?.near ?? []) if (!depth.has(n)) { depth.set(n, depth.get(at)! + 1); queue.push(n); }
    }
  }
  const d = placeId ? depth.get(placeId) : 0;
  return Math.min(deepest, d ?? deepest);
}

/** 이 깊이의 장소들 (지금 구역, 가두는 곳 포함) */
export function placesAtDepth(state: GameState, content: Content, depth: number): Place[] {
  return placesIn(state, content, state.playerZone).filter((p) => depthAt(state, content, p.id) === depth);
}

/** 수색 횟수를 세는 자리: 장소가 있으면 구역@장소, 없으면 구역 (12-258, PT15 튜토리얼: 매장을 뒤진 뒤 창고에서 "오늘 다시 뒤짐") */
export function searchSpot(state: GameState): string | null {
  if (!state.playerZone) return null;
  return state.playerPlace ? `${state.playerZone}@${state.playerPlace}` : state.playerZone;
}

/** 지금 있는 곳의 이름 (장소, 없으면 구역) */
export function hereName(state: GameState, content: Content): string {
  const zone = state.playerZone ? (content.locations[state.playerZone]?.name ?? state.playerZone) : "";
  const place = currentPlace(state, content);
  return place ? place.name : zone;
}

/** 이 인물이 지금 있을 장소 (구역이 다르거나 일과로 정해지지 않으면 null = 구역 어딘가) */
export function npcPlaceAt(state: GameState, content: Content, id: string, time: number = state.time): string | null {
  const npc = content.npcs[id];
  if (!npc) return null;
  const zone = npcZoneAt(npc, time);
  const places = placesIn(state, content, zone);
  if (!places.length) return null;
  const segment = segmentOf(time);
  // 밤에는 자기 거처
  if (segment === "night") {
    const home = places.find((p) => p.owner === id);
    if (home) return home.id;
  }
  // 그 시간대 칸이 비면 바로 앞 시간대의 자리에 그대로 있다 (12-253, PT15 분대장: 아침 칸이 빈 분대원이 어느 장소에도 없었다)
  const said = routineSaid(npc.routine, segment);
  if (!said) return null;
  // 일과로는 가두는 곳에 두지 않는다: 갇힌 사람은 whereIs가 갇힌 곳에 둔다 (12-261, PT16 졸병: 구해 온 정찰조가 포로 때 일과 "수용소"로 우리 수용소에 있었다)
  return placeSaid(places, said)?.id ?? null;
}

/** 일과 한 칸의 말이 가리키는 장소 (이름·aliases, 가두는 곳은 뺀다). content:check의 일과 검사도 이것으로 본다 */
export function placeSaid<P extends { name: string; aliases: readonly string[]; jail?: boolean }>(places: readonly P[], said: string): P | undefined {
  return places.find((p) => !p.jail && (said.includes(p.name) || p.aliases.some((a) => said.includes(a))));
}

/**
 * 이 인물이 지금 일과상 구역 밖에 나가 있는가 (장소 개편 A안): 그 시간대 일과 말에 구역 밖 말(story_lint.routine_away)이 있고
 * 그 구역의 장소로 정해지지 않으면 그 말을 돌려준다. 떠도는 사람, 주인공의 분대원·같은 분대는 늘 구역에 있다
 */
export function routineAway(state: GameState, content: Content, id: string, time: number = state.time): string | null {
  const npc = content.npcs[id];
  if (!npc || npc.roams?.length) return null;
  const role = roleOf(content, state);
  const squad = [...(state.squad ?? []), ...(role?.squad ?? []), ...(role?.squad_mates ?? [])];
  if (squad.includes(id)) return null;
  const said = routineSaid(npc.routine, segmentOf(time));
  if (!said) return null;
  const away = content.scenario.story_lint?.routine_away ?? [];
  if (!away.some((w) => said.includes(w))) return null;
  const zone = npcZoneAt(npc, time);
  return placeSaid(placesIn(state, content, zone), said) ? null : said;
}

/** 일과의 그 시간대 말. 칸이 비면 앞 시간대로 거슬러 올라간다 (하루를 한 바퀴까지) */
function routineSaid(routine: Partial<Record<TimeSegment, string>> | undefined, segment: TimeSegment): string | undefined {
  if (!routine) return undefined;
  const at = TIME_SEGMENTS.indexOf(segment);
  for (let back = 0; back < TIME_SEGMENTS.length; back++) {
    const said = routine[TIME_SEGMENTS[(at - back + TIME_SEGMENTS.length) % TIME_SEGMENTS.length]!];
    if (said) return said;
  }
  return undefined;
}

/**
 * 인물은 어디에 (12-245): 구역과 장소. 주인공은 지금 자리, 갇힌 사람은 갇힌 곳, 곁의 동행·장면의 사람은 주인공 곁,
 * 이름 있는 인물은 일과(떠도는 사람은 날마다), 이름 없는 인물은 마지막으로 본 구역. 죽었거나 떠났으면 null.
 * 인물의 구역은 이 모듈로만 묻는다 (rules/guards.test.ts: npcZoneAt을 직접 부르지 않는다)
 */
export function whereIs(state: GameState, content: Content, id: string, time: number = state.time): { zone: string | null; place: string | null } | null {
  const c = state.characters[id];
  if (!c) return null;
  if (id === state.playerId) return { zone: state.playerZone, place: state.playerPlace };
  // 갇힌 사람은 그 구역의 가두는 장소에 (없으면 구역 어딘가)
  const held = heldOf(c);
  if (held) return { zone: held.zone, place: (inQuarantine(c) ? quarantineIn(content, held.zone)?.id : undefined) ?? jailIn(content, held.zone)?.id ?? arrivalPlace(state, content, held.zone) };
  if (c.dead || c.away) return null;
  if (state.scene.present.includes(id) || (state.companions.includes(id) && !state.bonds[id]?.apart)) return { zone: state.playerZone, place: state.playerPlace };
  // 두고 온 자리에 머무는 사람 (12-253): 그 시간대가 끝날 때까지
  const stay = state.npcStays?.[id];
  if (stay && stay.until > time) return { zone: stay.zone, place: stay.place };
  // 떨어져 기다리는 동행은 그 자리에 (12-261, PT16 분대장: 막사에 남긴 동행이 보급 창고의 "있을 사람"에 떴다)
  // (PT17: companions일 때만 봐서 돌지 않았다. companion_parted가 companions에서 뺀다)
  const apart = state.bonds[id]?.apart;
  if (apart) return { zone: apart.zone, place: apart.place ?? null };
  // 분대 일을 나간 사람은 그 구역의 길에 (일과 자리에 두지 않는다, 장소 개편: "구역 어딘가"는 없다)
  const order = state.squadOrders?.[id];
  if (order) return { zone: order.zone, place: arrivalPlace(state, content, order.zone) };
  // 엑스트라는 머무는 장소, 없으면 마지막으로 본 구역의 길
  if (c.extra) return { zone: c.extra.zone, place: c.extra.place ?? (c.extra.zone ? arrivalPlace(state, content, c.extra.zone) : null) };
  const npc = content.npcs[id];
  if (!npc) return null;
  // 일과가 구역 밖에 나간 시간이면 구역에 없다 (장소 개편 A안, docs/place-unknown-plan.md: 털이·정찰 나간 사람이 거점 안 일을 숨은 목격자로 봤다).
  // 주인공의 분대원은 주인공이 내리는 분대 일을 따르므로 뺀다
  if (routineAway(state, content, id, time)) return { zone: null, place: null };
  // 일과로 장소가 정해지지 않으면(떠도는 사람 등) 그 구역의 길
  const zone = npcZoneAt(npc, time) ?? null;
  return { zone, place: npcPlaceAt(state, content, id, time) ?? (zone ? arrivalPlace(state, content, zone) : null) };
}

/** 이 인물의 구역 (죽었거나 떠났어도 일과·마지막 자리로: 유해·변이가 남는 곳) */
export function zoneOf(state: GameState, content: Content, id: string): string | null {
  const w = whereIs(state, content, id);
  if (w) return w.zone;
  const c = state.characters[id];
  return content.npcs[id] ? (npcZoneAt(content.npcs[id]!, state.time) ?? null) : (c?.extra?.zone ?? null);
}

/** 이 인물이 주인공 가까이(같은 구역, 같은 장소일 만한 곳)에 있는가 */
export function nearby(state: GameState, content: Content, id: string): boolean {
  const w = whereIs(state, content, id);
  if (!w || !w.zone || w.zone !== state.playerZone) return false;
  return !state.playerPlace || !w.place || w.place === state.playerPlace;
}

/**
 * 이 구역의 이 장소에 있을 이름 있는 인물 (장면의 사람은 뺀다). 장소 id는 구역마다 겹친다(막사·마당·정문)
 * 그래서 반드시 구역까지 맞춘다. 죽은 사람·떠난 사람은 whereIs가 거르고, 갇힌 사람은 갇힌 구역의 가두는 장소에만 있다
 * (PT14: 다른 무리 거점 사람과 갇힌 실종자가 우리 막사·수용소에 나왔다)
 */
export function peopleAt(state: GameState, content: Content, zone: string | null, placeId: string): string[] {
  if (!zone) return [];
  // 머무는 장소가 있는 엑스트라(가족의 집)도 (12-262, PT17 튜토리얼: 집에 있는 부모가 목록에 없었다)
  const ids = [...Object.keys(content.npcs), ...Object.values(state.characters).filter((c) => !!c.extra?.place).map((c) => c.id)];
  return ids.filter((id) => {
    if (id === state.playerId || state.scene.present.includes(id)) return false;
    const w = whereIs(state, content, id);
    return !!w && w.zone === zone && w.place === placeId;
  });
}

/** 주인공이 지금 있는 장소에 있을 사람 (장면의 사람은 뺀다). 장소를 정하지 않았으면(막 들어선 자리) 없다 (B②) */
export function peopleHere(state: GameState, content: Content): string[] {
  return state.playerPlace ? peopleAt(state, content, state.playerZone, state.playerPlace) : [];
}

/**
 * 장소를 옮길 때 함께 가는 장면의 인물 (PT14: 데려가던 다친 동료, 같이 걷던 사람, 그 장소가 제자리인 사람이 매번 장면에서 빠졌다).
 * 곁의 동행은 늘 따라온다(리듀서). 그 밖에는 이번 행동이 겨누는 사람과 GM이 함께 간다고 넣은 사람(with: 업거나 부축하는 사람, 같이 걷는 사람, 쫓아오는 것),
 * 그리고 옮겨 가는 장소가 일과상 제자리인 사람만 남는다. 나머지는 원래 자리에 남는다
 */
export function comesAlong(state: GameState, content: Content, to: string | null, involved: readonly string[]): string[] {
  return state.scene.present.filter((id) => involved.includes(id) || (to !== null && npcPlaceAt(state, content, id) === to));
}

/**
 * 남겨 둔 동행이 기다리는 자리에 왔는가: 같은 구역이고, 그 장소(장소 없음 = 막 들어선 자리)이거나 구역에 막 들어섰다.
 * 남겨 둔 자리를 한 번 떠났는지(left)는 따로 본다 (PT14 떠돌이: 같은 구역 다른 장소에서 돌아와도 합류하지 않았다)
 */
export function atWaitingSpot(state: GameState, apart: { zone: string | null; place?: string | null }): boolean {
  if (!apart.zone || apart.zone !== state.playerZone) return false;
  // 기다리라고 둔 장소로 와야 합류한다. 막 들어선 자리에 둔 사람은 막 들어선 자리에서 (12-268, PT18 분대장: 막사에 둔 막내가 정문에서 합류했다)
  return (apart.place ?? null) === state.playerPlace;
}

/** 이 구역의 격리 장소 (콘텐츠 places의 quarantine_room) */
export function quarantineIn(content: Content, zone: string | null | undefined): { id: string; name: string } | null {
  const p = zone ? content.locations[zone]?.places.find((x) => x.quarantine_room) : undefined;
  return p ? { id: p.id, name: p.name } : null;
}

/** 이 구역의 가두는 장소 (콘텐츠 places의 jail) */
export function jailIn(content: Content, zone: string | null | undefined): { id: string; name: string } | null {
  const p = zone ? content.locations[zone]?.places.find((x) => x.jail) : undefined;
  return p ? { id: p.id, name: p.name } : null;
}

/**
 * 붙잡히면 갇힐 곳 (PT14: 수용소가 있는 물류창고에서 붙잡혔는데 감옥 장소가 없는 거점으로 0분에 옮겨져 "구역에 막 들어선 자리"에 갇혔다):
 * 붙잡힌 구역이 그 무리 땅이고 가두는 장소가 있으면 그곳, 아니면 그 무리 땅 가운데 가두는 장소가 있는 곳(거점 먼저),
 * 그것도 없으면 그 무리의 거점(장소 없음). 갇히는 장소도 함께 정한다
 */
export function jailFor(state: GameState, content: Content, faction: string, caughtZone: string | null): { zone: string; place: string | null } | null {
  const own = (z: string) => ownedBy(state, z, faction);
  if (caughtZone && own(caughtZone) && jailIn(content, caughtZone)) return { zone: caughtZone, place: jailIn(content, caughtZone)!.id };
  const base = baseOfNow(state, content, faction) ?? undefined;
  const lands = Object.keys(content.locations).filter((z) => own(z) && jailIn(content, z)).sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  if (lands[0]) return { zone: lands[0], place: jailIn(content, lands[0])!.id };
  return base ? { zone: base, place: arrivalPlace(state, content, base) } : null;
}

/**
 * 이 인물이 지금 주인공과 같은 장소에 있는가 (장면에 들이지 않았어도). 주인공이 장소를 정했고 그 인물의 자리도 그 장소일 때만
 * (12-253, PT15: 장소 목록에 "지금 여기"로 보이는 사람을 target·with로 부르자 "장면에 없다" 오류로 실행이 버려졌다)
 */
export function hereWithMe(state: GameState, content: Content, id: string): boolean {
  if (!state.playerPlace || id === state.playerId || state.scene.present.includes(id)) return false;
  const w = whereIs(state, content, id);
  return !!w && w.zone === state.playerZone && w.place === state.playerPlace;
}

/** 이 인물이 지금 있을 곳의 이름: 장소, 장소를 모르면 "구역 어딘가", 장면에 있으면 "곁에" (GM 상태의 상관 줄, 12-253).
 * 주인공이 모르는 장소(설계 목록 C-1)나 아직 찾지 못한 집이면 장소 이름 대신 "구역 어딘가" */
export function whereLabel(state: GameState, content: Content, id: string): string | null {
  if (state.scene.present.includes(id)) return "곁에 (장면에 있다)";
  const w = whereIs(state, content, id);
  const out = routineAway(state, content, id);
  if (out && w && !w.zone) return `나가 있다 (일과: ${out})`;
  if (!w || !w.zone) return null;
  const zoneName = content.locations[w.zone]?.name ?? w.zone;
  const sameZone = w.zone === state.playerZone;
  const shown = !homeHidden(state, id) && knowsPlace(state, content, w.zone, w.place);
  const place = shown ? placeById(state, content, w.place, w.zone) : null;
  return place ? (sameZone ? place.name : `${zoneName}의 ${place.name}`) : sameZone ? "이 구역 어딘가" : `${zoneName} 어딘가`;
}

/**
 * 집이 있는 아는 사람(가족 등)의 집은 이 판에서 그 사람을 직접 본 뒤에만 안다 (12-267, PT20 튜토리얼).
 * perceived·met은 세계를 만들 때 가족 관계로 미리 채워지니, 마지막으로 본 때가 판을 시작한 때보다 뒤인지로 본다
 */
export function homeHidden(state: GameState, id: string): boolean {
  const extra = state.characters[id]?.extra;
  return !!extra?.place && (extra.lastSeenAt ?? 0) <= state.runStartedAt;
}

/**
 * 주인공이 아는 장소인가 (설계 목록 C-1). 모르는 장소는 GM에게도 이름·id·그곳 사람 없이 '알 수 없는 문'으로만 보인다 (원칙 4).
 * - 늘 안다: 구역의 길(road)과 담 문(gate), 즉흥 장소(GM이 그 자리에서 만든 곳), 우리 무리 땅의 모든 곳
 * - 담 밖(깊이 0)은 밖에서 보이니 안다. 담 없는 구역은 길만
 * - 있어 본 곳 (state.knownPlaces, 어떤 일로 옮겨졌든)
 */
export function knowsPlace(state: GameState, content: Content, zone: string | null | undefined, placeId: string | null | undefined): boolean {
  if (!zone || !placeId) return true;
  if (zone === state.playerZone && placeId === state.playerPlace) return true;
  const p = placeById(state, content, placeId, zone);
  if (!p) return false;
  if (p.road || p.gate || p.spawned) return true;
  if (onOwnLand(state, zone)) return true;
  if ((state.knownPlaces?.[state.playerId] ?? []).includes(`${zone}:${placeId}`)) return true;
  return depthAt(state, content, placeId, zone) === 0;
}

/** 지금 자리의 이웃 가운데 모르는 곳: '알 수 없는 문 1, 2…' (이웃 목록 순서, 같은 자리면 늘 같은 번호) */
export function unknownDoors(state: GameState, content: Content): Place[] {
  const here = currentPlace(state, content);
  if (!here) return [];
  return here.near.map((id) => placeById(state, content, id)).filter((p): p is Place => !!p && !knowsPlace(state, content, state.playerZone, p.id));
}

/** 문 하나의 표기: 문 번호와, 눈으로 보이는 것(건물로 드는 문인지 바깥으로 이어지는지)만 */
export function doorLabel(p: Place, i: number): string {
  return `문${i + 1} (알 수 없는 곳, ${p.indoor ? "건물 안으로" : "바깥으로"})`;
}

/**
 * place_to·infiltrate의 장소 입력: 아는 장소 id, 또는 지금 자리의 '문N'. 모르는 장소의 id는 받지 않는다 (id를 넣어 보는 우회로를 막는다).
 * 못 찾으면 undefined
 */
export function resolvePlace(state: GameState, content: Content, input: string): Place | undefined {
  const door = /^(?:문|door)\s*(\d+)$/i.exec(input.trim());
  if (door) return unknownDoors(state, content)[Number(door[1]) - 1];
  const p = placeById(state, content, input.trim());
  return p && knowsPlace(state, content, state.playerZone, p.id) ? p : undefined;
}

/** 옮겨 갈 수 있다고 GM에게 보일 장소 목록: 아는 장소 "id(이름)"와 지금 자리의 문 */
export function placeChoices(state: GameState, content: Content): string {
  const known = placesIn(state, content, state.playerZone).filter((p) => knowsPlace(state, content, state.playerZone, p.id)).map((p) => `${p.id}(${p.name})`);
  return [...known, ...unknownDoors(state, content).map(doorLabel)].join(", ");
}

/** 이 인물이 주인공과 같은 구역에 있는가 (장소는 보지 않는다) */
export function inZone(state: GameState, content: Content, id: string): boolean {
  const w = whereIs(state, content, id);
  return !!w && !!w.zone && w.zone === state.playerZone;
}

/** 시간대 열쇠 (날 × 시간대): 둘이 다르면 시간대가 바뀌었다 */
function segmentKey(time: number): number {
  return Math.floor(time / 1440) * TIME_SEGMENTS.length + TIME_SEGMENTS.indexOf(segmentOf(time));
}

/**
 * 시간대가 바뀌면 장면을 비운다 (B④ 2026-11-23, 장소 개편 위에서. PT12 떠돌이: 새벽에 들인 할머니가 다음 날 새벽까지 "함께 있는 인물",
 * PT17 섬: 저장고로 들어간 배역이 부두 장면에 남아 임무 짝이 됐다). 긴 잠 뒤에 흩어지던 규칙(12-261·12-265)을 이것으로 합친다.
 * 남는 사람: 곁의 동행, 진행 중인 이야기의 배역, 갇힌 사람(함께 갇힌 사람), 새 시간대 자리가 지금 장소인 사람(일과·집),
 * 이번 행동이 겨눈 사람(involved), 사람이 아닌 것(감염체·짐승: 위협은 공통 규칙 4의 몫). 새 시간대 일과가 구역 밖이면 빠진다.
 * 전투·잠입 중이면 비우지 않는다. 돌려주는 것: 장면에서 뺄 사람
 */
export function sceneLeavesAt(state: GameState, content: Content, from: number, involved: readonly string[] = []): string[] {
  // 장소를 모르면(장소가 없는 구역) 누가 제자리인지 몰라 비우지 않는다
  if (segmentKey(from) === segmentKey(state.time) || state.battle || state.infiltration || !state.playerPlace) return [];
  const companions = new Set(state.companions.filter((id) => !state.bonds[id]?.apart));
  const cast = new Set(Object.values(state.activeStorylet?.cast ?? {}));
  return state.scene.present.filter((id) => {
    const c = state.characters[id];
    if (!c || c.dead || companions.has(id) || cast.has(id) || heldOf(c) || involved.includes(id)) return false;
    if (c.extra && !content.npcs[id]) {
      // 이름 없는 사람: 사람이 아닌 것은 남고, 집이 이 장소면 남는다
      if (isCreature(content, c)) return false;
      return !(c.extra.place && c.extra.place === state.playerPlace);
    }
    if (routineAway(state, content, id)) return true;
    return !(state.playerPlace && npcPlaceAt(state, content, id) === state.playerPlace);
  });
}

/** 이 인물이 주인공과 같은 장소에 있는가 (장소가 없는 구역이면 같은 구역이면 그렇다) */
export function sharesPlace(state: GameState, content: Content, id: string): boolean {
  const at = whereIs(state, content, id)?.place ?? null;
  return at === state.playerPlace;
}

/** 즉흥 장소의 새 id */
export function nextPlaceId(state: GameState): string {
  return `pl_${Object.keys(state.spawnedPlaces ?? {}).length + 1}`;
}

/** 덮을 곳이 없는 구역의 실내 장소가 막아 주는 도 (폐허 정도, 12-244) */
const PLACE_COVER = 4;

/**
 * 지붕 아래인가와 막아 주는 도 (체감 기온·젖음, 12-245). 장소가 있으면 장소의 실내외가 먼저다
 * (정문 앞 처마인데 실내 +7, 야영인데 실내 +4, 실내 경비실 보초가 바깥으로 셈한 것). 장소가 없으면 구역의 cover와 하는 일로:
 * 바깥 일(climate.outdoor)은 바깥이지만 내 거처·우리 거점을 뒤지는 것은 지붕 아래 일이다 (B10, 플레이 테스트 9)
 */
export function shelterAt(content: Content, state: GameState, activity: string, who: string = state.playerId): { indoor: boolean; cover: number } {
  const zone = state.playerZone;
  const me = state.characters[who];
  const c = content.scenario.body?.cold?.climate;
  const zoneCover = (zone ? content.locations[zone]?.cover : undefined) ?? 0;
  // 구역을 옮기는 길은 바깥이다 (PT15 졸병: 출발한 실내 장소로 셈해 빗속 45분을 걸어도 옷이 마른 채였다)
  if (activity === "travel") return { indoor: false, cover: 0 };
  const atPlace = placeIndoor(state, content);
  if (atPlace !== null) return { indoor: atPlace, cover: atPlace && zoneCover <= 0 ? PLACE_COVER : zoneCover };
  // 장소가 있는 구역인데 장소를 모르면 길바닥이다: 바깥 (12-261)
  if (placesIn(state, content, zone).length) return { indoor: false, cover: 0 };
  const sheltered = !!zone && (state.homes?.[who] === zone || (content.locations[zone]?.kind === "base" && !!me?.factionId && ownedBy(state, zone, me.factionId)));
  const outdoorWork = !!c?.outdoor.includes(activity as never);
  return { indoor: zoneCover > 0 && (!outdoorWork || (activity === "search" && sheltered)), cover: zoneCover };
}

/**
 * 어두운가 (B① 2026-11-23, PT19: 불 땐 숙소 안 새벽에도 "어둠 +1"): 어두운 시간대(segments)이고, 불이 타는 지붕 아래가 아니면.
 * 숨기의 어둠 보정(opposition.dark)과 어둠 공포(fear.dark)가 이것으로 본다
 */
export function darkHere(state: GameState, content: Content, segments: readonly TimeSegment[]): boolean {
  if (!segments.includes(segmentOf(state.time))) return false;
  return !(shelterAt(content, state, "rest").indoor && fireLitHere(state));
}

/**
 * 불빛이 쓸모 있는가 (B①, PT19: 한낮 바깥 수색에도 손전등 +1): 어둡거나 지붕 아래. 도구의 only.dark가 이것으로 본다.
 * 어두운 시간대는 시나리오의 opposition.dark
 */
export function needsLight(state: GameState, content: Content): boolean {
  const segments = content.scenario.opposition?.dark?.segments ?? [];
  return darkHere(state, content, segments) || shelterAt(content, state, "rest").indoor;
}

/**
 * 담과 순찰이 지켜 주는 곳인가 (야영이 아니다, 12-245): 피난처, 우리 무리 거점, 재워 주는 다른 무리 거점.
 * 장소의 실내외와 따로다: 거점 안의 바깥 장소(운동장)는 지켜 주지만 바깥이고, 바깥 구역의 실내 장소(상가 안)는 지붕은 있지만 지켜 주지 않는다
 */
export function guardedHere(content: Content, state: GameState): boolean {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  const location = zone ? content.locations[zone] : undefined;
  if (!me || !zone || !location) return false;
  if (location.sanctuary) return true;
  const ownLand = !!me.factionId && ownedBy(state, zone, me.factionId);
  return location.kind === "base" && (ownLand || welcomedAsGuest(content, state));
}

/**
 * 다른 무리의 거점에 손님으로 묵을 수 있다 (12-121): 그 무리가 우리를 나쁘게 보지 않으면. 갇힌 몸은 손님이 아니다.
 * 무소속은 0으로 보되, 떠돌이를 먹잇감으로 보는 무리(helpless.prey_on_strangers)는 재워 주지 않는다
 */
export function welcomedAsGuest(content: Content, state: GameState): boolean {
  const shelter = content.scenario.body?.cold?.shelter;
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  const owner = zone ? state.zones[zone]?.owner : null;
  if (!shelter || shelter.guests === undefined || !me || pausedWhileHeld(state, "guest") || !zone || !owner || owner === me.factionId) return false;
  if (content.locations[zone]?.kind !== "base") return false;
  // 몰래 숨어든 사람은 손님이 아니다 (플레이 테스트 13)
  if (state.infiltration) return false;
  const regard = me.factionId ? disposition(content, owner, me.factionId, state) : content.scenario.helpless?.prey_on_strangers.includes(owner) ? -3 : 0;
  return regard >= shelter.guests;
}


/** 소문(rumor)으로 갇힌 곳의 어림 단편까지 들을 확률 (설계 목록 C-1 2단계: 운 좋으면). 상관·포로에게 들은 것(report)은 늘 */
export const PLACE_HINT_RUMOR_CHANCE = 1 / 3;

/**
 * 장소의 어림 단편 (설계 목록 C-1 2단계): 이웃 하나(주인공이 아는 곳 먼저), 실내외, 담 안팎. 이름·id는 주지 않는다.
 * 그 이웃에 가면 같은 쪽(건물 안·바깥)의 문 가운데 하나다: 어느 문인지는 플레이어가 짐작한다
 */
export function placeHint(state: GameState, content: Content, zone: string, placeId: string): string | null {
  const p = placeById(state, content, placeId, zone);
  if (!p) return null;
  const near = p.near.map((id) => placeById(state, content, id, zone)).filter((x): x is Place => !!x);
  const anchor = near.find((x) => knowsPlace(state, content, zone, x.id)) ?? near[0];
  const depths = content.scenario.infiltration?.depths ?? [];
  const walled = placesIn(state, content, zone).some((x) => x.gate);
  const d = depthAt(state, content, p.id, zone);
  return [anchor ? `${josa(anchor.name, "과/와")} 이어진 곳` : null, p.indoor ? "건물 안" : "바깥", walled && d !== null ? depths[d] : null].filter(Boolean).join(", ");
}

/** 장소 사이 한 칸을 옮기는 시간 (장소 개편: 이웃 5분, 한 칸 멀 때마다 5분) */
export const STEP_MINUTES = 5;

/**
 * 주인공이 옮겨지는 까닭 (공통 규칙 15 movePlayer). walk: 걸어서(place_to), travel: 구역 이동(move_to), start: 세계를 열 때,
 * summoned: 부르는 이야기, captured: 붙잡혀 끌려감, carried: 쓰러져 업혀 감, escape: 달아나 가장 가까운 길로, infiltrate: 잠입으로 숨어듦·빠짐,
 * released: 풀려나 돌아감, sent: 이야기가 보냄, inherit: 계승해 이어 감, cheat: 치트
 */
export type MoveReason = "walk" | "travel" | "start" | "summoned" | "captured" | "carried" | "escape" | "infiltrate" | "released" | "sent" | "inherit" | "cheat";

/**
 * 주인공 이동은 이 함수 하나로 (공통 규칙 15, PT20~22: 이야기·업혀 감·계승이 저마다 장소를 바꿔 순간이동이 되풀이됐다).
 * - 구역이 바뀌면 zone_moved(도착 장소는 주어진 장소, 없으면 떠나온 쪽 길), 같은 구역이면 place_moved
 * - with: 함께 옮기는 사람 (동행은 리듀서가 늘 데려간다). 판정의 상대·이야기 배역은 넣지 않는다: 빗나가면 부르는 쪽이 쫓아오게 한다
 * - 시간: minutes를 주면 그만큼 흐른다 (걸어서·구역 이동은 부르는 쪽이 활동으로 셈한다). 불려 감·업혀 감은 길이만큼 든다
 * - 돌려주는 줄: 플레이어가 고르지 않은 이동(불려 감·끌려감·업혀 감·보냄)은 결과에 알린다
 * 이 함수 밖에서 place_moved·zone_moved를 직접 남기면 rules/guards.test.ts가 실패한다
 */
export function movePlayer(ctx: ToolContext, to: { zone: string; place?: string | null }, reason: MoveReason, opts: { with?: readonly string[]; minutes?: number } = {}): string | null {
  const { store, content } = ctx;
  const s = store.getState();
  const from = s.playerZone;
  const fromPlace = s.playerPlace;
  const along = opts.with?.length ? { with: [...opts.with] } : {};
  if (from !== to.zone || from === null) {
    const place = to.place !== undefined && to.place !== null ? to.place : arrivalPlace(s, content, to.zone, from);
    store.append({ type: "zone_moved", from, to: to.zone, place, ...along });
  } else if ((to.place ?? null) !== fromPlace) {
    store.append({ type: "place_moved", from: fromPlace, to: to.place ?? null, ...along });
  } else return null;
  // 고르지 않은 이동에 드는 시간 (불려 감·업혀 감): 같은 구역이면 칸 수, 다른 구역이면 길 (PT21 하얀매: 업혀 구역 둘을 5분에)
  const minutes = opts.minutes ?? (reason === "summoned" ? STEP_MINUTES * Math.max(1, Number.isFinite(stepsBetween(s, content, fromPlace, to.place ?? null)) ? stepsBetween(s, content, fromPlace, to.place ?? null) : 1) : reason === "carried" && from && from !== to.zone ? routeMinutes(from, to.zone) : 0);
  if (minutes > 0) {
    const now = store.getState().time;
    store.append({ type: "time_advanced", activity: reason === "carried" ? "travel" : "brief", from: now, to: now + minutes });
  }
  const now = store.getState();
  const where = placeById(now, content, now.playerPlace)?.name ?? content.locations[now.playerZone ?? ""]?.name ?? "";
  if (reason === "summoned") return `${josa(where, "으로/로")} 불려 갔다${minutes ? ` (${minutes}분)` : ""}.`;
  if (reason === "carried") return `업혀 ${josa(content.locations[to.zone]?.name ?? where, "으로/로")} 옮겨졌다${minutes ? ` (${minutes}분)` : ""}.`;
  if (reason === "sent") return `${josa(where, "으로/로")} 옮겨졌다.`;
  return null;
}

/**
 * 이 이야기가 이 구역에서 열릴 수 있는 장소 (이동 기획: 이야기는 주인공이 이미 있는 자리에서만 열린다).
 * 장소 조건(places·글의 장소 이름)과 실내외가 맞는 곳. 장소가 없는 구역이면 [null]. content:check와 테스트가 쓴다
 */
export function storyOpenPlaces(state: GameState, content: Content, zone: string, where: StoryWhere, text: string): (string | null)[] {
  const places = placesIn(state, content, zone);
  if (!places.length) return [null];
  return places.filter((p) => {
    const at = { ...state, playerZone: zone, playerPlace: p.id } as GameState;
    return (where.indoor === undefined || storyPlaceFits(at, content, where.indoor, where, text)) && storyPlacesFit(at, content, where.places, text, !!where.summons, where.indoor);
  }).map((p) => p.id);
}

/** 주인공이 지금 있는 자리 (유해 등 구역 안 자리를 적을 때): 숨은 곳을 탐험 중이면 "ruin:<id>", 아니면 장소 id */
export function spotHere(state: GameState): string | null {
  return state.exploration ? `ruin:${state.exploration.ruin}` : state.playerPlace;
}

/** 그 자리에 주인공이 있는가 (자리를 적지 않았으면 구역 어디서나) */
export function atSpot(state: GameState, spot: string | null | undefined): boolean {
  return !spot || spot === spotHere(state);
}
