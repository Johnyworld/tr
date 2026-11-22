/**
 * 공통 규칙 15: 장소 (docs/design.md "공통 규칙", 12-244).
 *
 * 구역 > 장소 두 단계. 어디에 있는지, 그곳이 지붕 아래인지, 누가 그곳에 있는지는 여기서 정한다.
 * - 장소: 구역의 콘텐츠 장소(모두가 쓰는 곳) + GM이 즉흥으로 만든 장소(개인 거처·화장실 등, 세이브에 남는다)
 * - 장소를 정하지 않았으면(null) 구역에 막 들어선 자리다. 실내외는 구역의 cover로 정하던 대로
 * - 장소가 있으면 실내외는 장소의 indoor로 (플레이 테스트: "정문 앞 처마인데 실내 +7", "야영인데 실내 +4")
 * - 인물이 있는 장소: 일과(routine)의 그 시간대 말이 장소 이름·aliases와 맞으면 그 장소. 밤에는 자기 거처(주인 있는 즉흥 장소)
 * - 처음엔 수색표·땅 주인·전투·잠입은 구역 단위 그대로
 * 지금 장소와 즉흥 장소는 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { npcZoneAt } from "../game/whereabouts.ts";
import { segmentOf } from "./time.ts";
import { ownedBy } from "./home.ts";
import { heldOf, pausedWhileHeld } from "./held.ts";
import { disposition } from "../sim/war.ts";

export type Place = { id: string; zone: string; name: string; indoor: boolean; owner: string | null; spawned: boolean; aliases: readonly string[]; jail?: boolean; description?: string };

/**
 * 구역에 막 들어선 자리(장소를 정하지 않은 자리)로 돌아가는 place_to 값.
 * 그 자리에 내려놓은 물건은 그 자리에 남는다 (PT14 방문자: 장소를 정하기 전에 계단 앞에 던진 창을 다시 찾을 길이 없었다)
 */
export const ENTRY_PLACE = "entry";

/** 이 구역의 장소들 (콘텐츠 + 즉흥) */
export function placesIn(state: GameState, content: Content, zone: string | null | undefined): Place[] {
  if (!zone) return [];
  const fixed = (content.locations[zone]?.places ?? []).map((p) => ({ id: p.id, zone, name: p.name, indoor: p.indoor, owner: null, spawned: false, aliases: p.aliases, jail: p.jail, description: p.description }));
  const spawned = Object.entries(state.spawnedPlaces ?? {})
    .filter(([, p]) => p.zone === zone)
    .map(([id, p]) => ({ id, zone, name: p.name, indoor: p.indoor, owner: p.owner, spawned: true, aliases: [] as string[] }));
  return [...fixed, ...spawned];
}

/** 장소 하나 (지금 구역에서) */
export function placeById(state: GameState, content: Content, id: string | null | undefined, zone: string | null | undefined = state.playerZone): Place | null {
  return id ? (placesIn(state, content, zone).find((p) => p.id === id) ?? null) : null;
}

/** place_to 값이 가리키는 곳: 장소, 구역에 막 들어선 자리(null, ENTRY_PLACE), 이 구역에 없으면 undefined */
export function placeTarget(state: GameState, content: Content, id: string): Place | null | undefined {
  const place = placeById(state, content, id);
  if (place) return place;
  return id === ENTRY_PLACE ? null : undefined;
}

/** 주인공이 지금 있는 장소 (정하지 않았으면 null) */
export function currentPlace(state: GameState, content: Content): Place | null {
  return placeById(state, content, state.playerPlace);
}

/** 지금 있는 곳이 지붕 아래인가: 장소가 있으면 그 장소, 없으면 null (구역의 cover로 정한다) */
export function placeIndoor(state: GameState, content: Content): boolean | null {
  return currentPlace(state, content)?.indoor ?? null;
}

/** 실내(true)·바깥(false) 이야기가 지금 자리에 맞는가: 장소를 정하지 않았으면 늘 맞다 (이야기가 그 자리로 데려간다) */
export function storyPlaceFits(state: GameState, content: Content, indoor: boolean): boolean {
  const here = placeIndoor(state, content);
  return here === null || here === indoor;
}

/**
 * 이야기의 장소가 지금 자리에 맞는가 (12-251, 플레이 테스트 14: 경비실에서 "우물가", 격리실에서 약제실·부엌 장면).
 * places를 적었으면 그 장소, 아니면 이야기 글에 나오는 지금 구역의 장소 이름·aliases. 글이 장소를 말하지 않거나
 * 장소를 정하지 않은 자리(막 들어선 자리)·즉흥 장소에 있으면 거르지 않는다 (이야기가 그 자리로 데려간다)
 */
export function storyPlacesFit(state: GameState, content: Content, places: readonly string[] | undefined, text: string): boolean {
  const here = currentPlace(state, content);
  if (!here || here.spawned) return true;
  const named = storyPlaces(state, content, places, text);
  return !named.length || named.includes(here.id);
}

/** 이야기가 말하는 지금 구역의 장소 (places를 적었으면 그것, 아니면 글에 나오는 장소 이름·aliases) */
export function storyPlaces(state: GameState, content: Content, places: readonly string[] | undefined, text: string): string[] {
  return places ? [...places] : placesIn(state, content, state.playerZone).filter((p) => !p.spawned && [p.name, ...p.aliases].some((a) => text.includes(a))).map((p) => p.id);
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
  const said = npc.routine?.[segment];
  if (!said) return null;
  const hit = places.find((p) => said.includes(p.name) || p.aliases.some((a) => said.includes(a)));
  return hit?.id ?? null;
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
  if (held) return { zone: held.zone, place: jailIn(content, held.zone)?.id ?? null };
  if (c.dead || c.away) return null;
  if (state.scene.present.includes(id) || (state.companions.includes(id) && !state.bonds[id]?.apart)) return { zone: state.playerZone, place: state.playerPlace };
  if (c.extra) return { zone: c.extra.zone, place: null };
  const npc = content.npcs[id];
  return npc ? { zone: npcZoneAt(npc, time) ?? null, place: npcPlaceAt(state, content, id, time) } : null;
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
  return Object.keys(content.npcs).filter((id) => {
    if (id === state.playerId || state.scene.present.includes(id)) return false;
    const w = whereIs(state, content, id);
    return !!w && w.zone === zone && w.place === placeId;
  });
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
  return state.playerPlace === null || (apart.place ?? null) === state.playerPlace;
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
  const base = Object.values(content.locations).find((l) => l.owner === faction && l.kind === "base")?.id;
  const lands = Object.keys(content.locations).filter((z) => own(z) && jailIn(content, z)).sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  if (lands[0]) return { zone: lands[0], place: jailIn(content, lands[0])!.id };
  return base ? { zone: base, place: null } : null;
}

/** 이 인물이 주인공과 같은 구역에 있는가 (장소는 보지 않는다) */
export function inZone(state: GameState, content: Content, id: string): boolean {
  const w = whereIs(state, content, id);
  return !!w && !!w.zone && w.zone === state.playerZone;
}

/** 이 인물이 주인공과 같은 장소에 있을 만한가: 주인공이 장소를 정하지 않았거나, 인물의 장소가 정해지지 않았으면(구역 어딘가) 그렇다 */
export function sharesPlace(state: GameState, content: Content, id: string): boolean {
  if (!state.playerPlace) return true;
  const at = whereIs(state, content, id)?.place ?? npcPlaceAt(state, content, id);
  return at === null || at === state.playerPlace;
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
  const atPlace = placeIndoor(state, content);
  if (atPlace !== null) return { indoor: atPlace, cover: atPlace && zoneCover <= 0 ? PLACE_COVER : zoneCover };
  const sheltered = !!zone && (state.homes?.[who] === zone || (content.locations[zone]?.kind === "base" && !!me?.factionId && ownedBy(state, zone, me.factionId)));
  const outdoorWork = !!c?.outdoor.includes(activity as never);
  return { indoor: zoneCover > 0 && (!outdoorWork || (activity === "search" && sheltered)), cover: zoneCover };
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

