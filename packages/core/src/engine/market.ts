import { josa } from "../text.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { seasonAt } from "../sim/season.ts";
import { DEFAULT_VALUE } from "./gear.ts";

/**
 * 시세 (기획서 4.8.2, 12-155). 그 땅 주인 무리의 창고 형편과 계절이 물건 값에 닿는다.
 * 창고가 처음보다 얼마나 남았는지(비율)로 정한다: 모자라면 비싸고, 넉넉하면 싸다. 그래서 넉넉한 곳에서 사서 모자란 곳에 파는 장사가 생긴다.
 * 흥정(barter)과 뇌물(bribe)의 값에 곱한다. 주인 없는 땅이나 자원과 이어지지 않은 물건은 그대로다
 */

/** 이 물건이 따르는 무리 자원 */
export function itemResource(content: Content, itemId: string): string | null {
  const item = content.items[itemId];
  if (!item) return null;
  return item.resource ?? (item.kind ? (content.scenario.market?.kinds[item.kind] ?? null) : null);
}

/** 지금 구역의 주인 무리 (시세를 정하는 창고) */
function marketOwner(state: GameState): string | null {
  const zone = state.playerZone;
  return zone ? (state.zones[zone]?.owner ?? null) : null;
}

/** 자원 하나의 시세 배수 (1이 보통) */
export function resourceFactor(content: Content, state: GameState, resource: string, owner = marketOwner(state)): number {
  const m = content.scenario.market;
  if (!m || !owner) return 1;
  const now = state.factions[owner]?.resources[resource];
  const start = content.factions[owner]?.resources[resource];
  let f = 1;
  if (now !== undefined && start) {
    const ratio = now / start;
    if (ratio <= m.scarce) f = m.high;
    else if (ratio < 1) f = m.high + ((ratio - m.scarce) / (1 - m.scarce)) * (1 - m.high);
    else if (ratio < m.plenty) f = 1 + ((ratio - 1) / (m.plenty - 1)) * (m.low - 1);
    else f = m.low;
  }
  const season = seasonAt(content.scenario, state.time)?.id;
  const s = (season ? m.seasons[season]?.[resource] : undefined) ?? 1;
  return Math.round(f * s * 100) / 100;
}

/** 물건 하나의 지금 값 (시세를 곱한 것, 소수 그대로) */
export function marketPrice(content: Content, state: GameState, itemId: string): number {
  const base = content.items[itemId]?.value ?? DEFAULT_VALUE;
  const r = itemResource(content, itemId);
  return r ? base * resourceFactor(content, state, r) : base;
}

/** 물건 묶음의 지금 값 (반올림) */
export function marketValue(content: Content, state: GameState, bundle: Record<string, number>): number {
  return Math.round(Object.entries(bundle).reduce((n, [id, q]) => n + marketPrice(content, state, id) * q, 0));
}

/**
 * GM 상태의 시세 줄: 주인 있는 땅의 거점이나 말이 모이는 곳에서, 눈에 띄게 비싸거나 싼 것만 (숫자는 말하지 않는다)
 */
export function describeMarket(content: Content, state: GameState): string | null {
  const m = content.scenario.market;
  const owner = marketOwner(state);
  const zone = state.playerZone;
  if (!m || !owner || !zone) return null;
  const talk = content.scenario.war?.talk?.rumor?.zones ?? [];
  if (content.locations[zone]?.kind !== "base" && !talk.includes(zone)) return null;
  const label = (r: string) => content.scenario.resources.find((x) => x.id === r)?.label ?? r;
  const resources = [...new Set([...Object.values(m.kinds), ...Object.values(content.items).flatMap((i) => (i.resource ? [i.resource] : []))])];
  const dear = resources.filter((r) => resourceFactor(content, state, r, owner) >= m.note_above).map(label);
  const cheap = resources.filter((r) => resourceFactor(content, state, r, owner) <= m.note_below).map(label);
  if (!dear.length && !cheap.length) return null;
  return `시세 (${content.factions[owner]?.name ?? owner}의 땅, 흥정 값에 시스템이 반영한다): ${[dear.length ? `${josa(dear.join("·"), "이/가")} 비싸다` : "", cheap.length ? `${josa(cheap.join("·"), "이/가")} 싸다` : ""].filter(Boolean).join(", ")}. 숫자는 말하지 않는다`;
}
