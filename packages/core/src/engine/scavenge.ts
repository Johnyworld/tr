import { searchSpot } from "../rules/place.ts";
import { ownedBy } from "../rules/home.ts";
import { findRuin } from "./exploration.ts";
import { effectiveSkill } from "./traits.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import { moveLabel } from "../scenario/scenario.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

type Part = { label: string; value: number };

/** 오늘 이 곳(구역, 또는 구역#먹을 것 구하기)을 뒤진 횟수 */
export function searchedToday(state: ReturnType<ToolContext["store"]["getState"]>, key: string): number {
  const before = state.zoneSearches[key];
  return before && before.day === dayOf(state.time) ? before.count : 0;
}

/**
 * 수색 판정의 상황 보정 (12-220). 판정 줄에 보인다:
 * 구역의 넉넉함(loot.modifier: 털린 곳 -, 넉넉한 곳 +), 오늘 이미 뒤진 횟수만큼 -, 옛 지도·건물 용도를 아는 사람(search_lore) +
 */
export function scavengeParts(ctx: ToolContext): Part[] {
  const { content } = ctx;
  const state = ctx.store.getState();
  const zone = state.playerZone;
  const loot = zone ? content.locations[zone]?.loot : undefined;
  if (!zone || !loot) return [];
  const lore = content.scenario.search_lore;
  const known = lore && effectiveSkill(content, state.characters[state.playerId]!, lore.skill) >= 1;
  // 우리 거점은 털린 폐허가 아니다: 구역의 넉넉함을 셈하지 않는다 (12-261, PT16 분대장·졸병: 우리 보급 창고에 "-1(털린 구역)")
  const me = state.characters[state.playerId];
  const ownBase = content.locations[zone]?.kind === "base" && !!me?.factionId && ownedBy(state, zone, me.factionId);
  return [
    // 판정 줄만 보고 까닭을 알게 (플레이 테스트 14: "+1(넉넉한 곳) +1(역사)"가 무슨 뜻인지 몰랐다)
    { label: loot.modifier > 0 ? "뒤질 거리가 많은 구역" : "털린 구역", value: ownBase ? 0 : loot.modifier },
    { label: "오늘 다시 뒤짐", value: -searchedToday(state, searchSpot(state) ?? zone) },
    ...(lore && known ? [{ label: `${moveLabel(content.scenario, lore.skill)}: 옛 건물 쓰임을 앎`, value: lore.bonus }] : []),
  ].filter((p) => p.value !== 0);
}

/** 판정 결과만큼 찾는다: 성공 2, 대가 있는 성공 1, 실패·판정 없음 0 */
export function foundCount(outcome: CheckOutcome | null): number {
  return outcome === "success" ? 2 : outcome === "partial" ? 1 : 0;
}

type SearchScope = NonNullable<ToolContext["content"]["scenario"]["search_scopes"]>["scopes"][number];

/** 수색 범위 (12-355). id가 없으면 기본 범위, 월드 팩에 범위가 없으면 null (예전 규칙) */
export function searchScopeOf(content: ToolContext["content"], id: string | null | undefined): SearchScope | null {
  const cfg = content.scenario.search_scopes;
  if (!cfg) return null;
  return cfg.scopes.find((x) => x.id === (id ?? cfg.default)) ?? cfg.scopes.find((x) => x.id === cfg.default) ?? null;
}

/** 이 범위를 뒤진 양 (같은 날 다시 뒤지기 보정의 단위: deplete_minutes마다 1) */
export function searchUnits(content: ToolContext["content"], scope: SearchScope): number {
  return Math.max(1, Math.round(scope.minutes / (content.scenario.search_scopes?.deplete_minutes ?? 15)));
}

/** 범위의 finds에서 뽑는 수: 성공·대가 있는 성공은 범위 안에서 굴리고, 실패·판정 없음은 0 */
export function scopeFinds(scope: SearchScope, outcome: CheckOutcome | null, rng: () => number): number {
  if (outcome !== "success" && outcome !== "partial") return 0;
  const [min, max] = scope.finds[outcome];
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 수색으로 물건 찾기 (기획서 4.7): 수색(search) 활동을 하면 그 구역의 찾을 거리 표(locations의 loot)에서 코드가 고른다.
 * - 판정 결과만큼 찾는다: 수색 범위(search_scopes, 12-355)가 있으면 그 범위의 finds에서 뽑는 수를 굴리고, 없으면 성공 2·대가 있는 성공 1 (12-220). 실패 0. 판정 없이는 찾지 못한다
 * - 찾을 거리 표대로만 나온다: 임무로 찾는 자원도 따로 보장하지 않는다 (12-355, 사용자 결정: 약을 찾으러 가도 잡동사니만 나올 수 있다)
 * - 구역의 넉넉함과 같은 날 다시 뒤지는 것은 판정 보정이다 (scavengeParts). 뒤진 양은 범위의 시간으로 센다
 * - 찾은 것은 바로 주인공의 소지품에 들어간다. 무엇을 얼마나 찾는지는 코드가 정한다 (원칙 2)
 * hurt: 이번 수색에서 다쳤다 (그날 그 칸 수색은 다시 다치지 않는다)
 */
export function scavenge(ctx: ToolContext, outcome: CheckOutcome | null, opts: { scope?: string | null; hurt?: boolean } = {}): { lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  const loot = zone ? content.locations[zone]?.loot : undefined;
  if (!zone || !loot || loot.items.length === 0) return { lines: ["이 구역에는 뒤져서 나올 만한 것이 없다."], displays: [] };

  // 장소마다 센다 (12-258)
  const spot = searchSpot(state) ?? zone;
  const count = searchedToday(state, spot);
  const scope = searchScopeOf(content, opts.scope);
  store.append({ type: "zone_searched", zone: spot, day: dayOf(state.time), ...(scope ? { units: searchUnits(content, scope) } : {}), ...(opts.hurt ? { hurt: true } : {}) });

  const total = loot.items.reduce((n, i) => n + i.weight, 0);
  const found = new Map<string, number>();
  const picks = scope ? scopeFinds(scope, outcome, rng) : foundCount(outcome);
  for (let r = 0; r < picks; r++) {
    let pick = rng() * total;
    const entry = loot.items.find((i) => (pick -= i.weight) < 0) ?? loot.items[loot.items.length - 1]!;
    const [min, max] = entry.qty;
    const qty = min + Math.floor(rng() * (max - min + 1));
    found.set(entry.item, (found.get(entry.item) ?? 0) + qty);
  }

  const player = state.characters[state.playerId]!;
  const displays: ToolDisplayEvent[] = [];
  const names: string[] = [];
  for (const [item, quantity] of found) {
    store.append({ type: "item_granted", to: state.playerId, itemId: item, quantity });
    const itemName = content.items[item]?.name ?? item;
    names.push(`${itemName} ×${quantity}`);
    displays.push({ type: "item", fromName: "", toName: player.name, itemName, quantity });
  }
  // 숨은 곳 (12-162): 제대로 뒤지면(성공) 찾고, 대가 있는 성공이면 낌새만
  const ruin = findRuin(ctx, outcome);
  const tired = count > 0 ? " 오늘 이미 뒤진 곳이라 남은 것이 적다." : "";
  const lines = names.length
    ? [`수색으로 ${josa(names.join(", "), "을/를")} 찾아 챙겼다 (소지품에 들어왔다). 찾은 것만 서술하고 다른 물건을 지어내지 않는다.${tired}`]
    : outcome === null
      ? ["판정 없이 둘러봐서는 쓸 만한 것을 찾지 못했다. 제대로 뒤지려면 수색 판정을 건다."]
      : [`쓸 만한 것을 찾지 못했다.${tired} 빈손인 것을 서술한다.`];
  if (ruin) lines.push(ruin);
  return { lines, displays };
}
