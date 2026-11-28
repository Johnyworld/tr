/**
 * 공통 규칙 28: 가게 (12-367, docs/shops-plan.md).
 *
 * 현실감: 구시가에도 약국이 있고 길가에 전파상·편의점이 드문드문 있다. 그러나 그것을 GM이 지어내면 개수도, 나오는 물건도 GM이 정한 셈이 된다 (원칙 2).
 * 그래서 가게는 콘텐츠가 바깥 장소마다 몇 곳(places.shops)이라고 적어 두고, 플레이어가 그 가게를 찾는 수색(take_action.activity.target)이 성공하면
 * 코드가 가게 장소 하나를 만든다. 길 하나가 가진 수까지만 찾을 수 있어 무한히 늘지 않는다.
 * 가게 장소를 뒤지면 구역 표 대신 그 종류의 표(scenario.shops.kinds.<종류>.loot)가 쓰인다.
 * 가게 장소는 만든 길의 이웃이고 세이브에 남아 다시 가도 같은 가게다. 읽기는 장소(rules/place.ts)로만 한다.
 */
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { currentPlace, nextPlaceId, placesIn } from "./place.ts";
import { dayOf } from "./time.ts";

export type ShopLoot = { modifier: number; items: { item: string; weight: number; qty: [number, number] }[] };

/** 이 월드의 가게 종류 id */
export function shopKindIds(content: Content): string[] {
  return Object.keys(content.scenario.shops?.kinds ?? {});
}

/** 지금 있는 곳이 가게면 그 종류와 수색표 */
export function shopHere(state: GameState, content: Content): { kind: string; name: string; loot: ShopLoot } | null {
  const here = currentPlace(state, content);
  const def = here?.shop ? content.scenario.shops?.kinds[here.shop] : undefined;
  return here?.shop && def ? { kind: here.shop, name: def.name, loot: def.loot as ShopLoot } : null;
}

/** 지금 있는 바깥 장소에서 아직 못 찾은 가게 수: 종류 → 수 (0이면 빠진다) */
export function shopsLeft(state: GameState, content: Content): Record<string, number> {
  const here = currentPlace(state, content);
  if (!here || !state.playerZone) return {};
  const all = placesIn(state, content, state.playerZone);
  const out: Record<string, number> = {};
  for (const [kind, n] of Object.entries(here.shops ?? {})) {
    const found = all.filter((p) => p.shop === kind && p.near.includes(here.id)).length;
    if (n - found > 0) out[kind] = n - found;
  }
  return out;
}

/** 찾는 수색을 하기 전에 막히는 까닭 (시간이 흐르기 전). 없으면 null */
export function shopSearchProblem(state: GameState, content: Content, kind: string): string | null {
  const def = content.scenario.shops?.kinds[kind];
  if (!def) return `target은 ${shopKindIds(content).join("/") || "없음"} 중 하나다.`;
  const here = currentPlace(state, content);
  if (!here || here.indoor || here.shop) return `${def.name}을 찾는 수색은 바깥(길) 장소에서 한다. 지금 자리에서는 둘러봐도 가게가 따로 보이지 않는다.`;
  const left = shopsLeft(state, content);
  if (left[kind]) return null;
  const known = Object.keys(here.shops ?? {});
  return known.includes(kind)
    ? `이 길의 ${def.name}은 이미 다 찾았다. 다시 가려면 take_action place_to로 찾아 둔 가게로 간다.`
    : `이 길에는 ${def.name}이 있을 만하지 않다 (둘러봐도 그런 가게는 보이지 않는다). 다른 길에서 찾는다.${Object.keys(left).length ? ` 이 길에서 찾을 수 있는 가게: ${Object.keys(left).map((k) => content.scenario.shops?.kinds[k]?.name ?? k).join(", ")}` : ""}`;
}

/**
 * 찾는 수색의 결과 (판정 한 번에 가게 하나): 성공·대가 있는 성공이면 가게 장소를 만들고 어느 곳인지 알려 준다.
 * 같은 날 다시 뒤지는 보정(zone_searched)은 수색과 같이 센다. units는 뒤진 양
 */
export function findShop(ctx: ToolContext, kind: string, outcome: "success" | "partial" | "miss" | null, units: number, hurt: boolean): { lines: string[] } {
  const { store, content } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  const here = currentPlace(state, content);
  const def = content.scenario.shops?.kinds[kind];
  if (!zone || !here || !def) return { lines: ["여기서는 가게를 찾을 수 없다."] };
  store.append({ type: "zone_searched", zone: `${zone}@${here.id}`, day: dayOf(state.time), units, ...(hurt ? { hurt: true } : {}) });
  if (outcome !== "success" && outcome !== "partial") {
    return { lines: [outcome === null ? `판정 없이 둘러봐서는 ${def.name}을 찾지 못했다. 제대로 찾으려면 수색 판정을 건다.` : `${def.name}을 찾지 못했다. 이 길에 있기는 하지만 아직 눈에 띄지 않았다고 서술한다 (다시 찾을 수 있다).`] };
  }
  const already = placesIn(state, content, zone).filter((p) => p.shop === kind && p.near.includes(here.id)).length;
  const name = already > 0 ? `${def.name} (${already + 1}번째)` : def.name;
  const id = nextPlaceId(state);
  store.append({ type: "place_spawned", id, zone, name, indoor: true, owner: null, at: here.id, shop: kind });
  return { lines: [`${name}을 찾았다 (장소 ${id}, 실내, 지금 자리의 이웃). 들어가려면 take_action place_to: "${id}", 거기서 수색하면 이 가게의 물건이 나온다. 가게 안의 물건은 지어내지 않는다 (코드가 정한다).`] };
}
