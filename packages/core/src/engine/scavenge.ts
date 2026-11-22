import { searchSpot } from "../rules/place.ts";
import { ownedBy } from "../rules/home.ts";
import { itemResource } from "./market.ts";
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

/**
 * 수색으로 물건 찾기 (기획서 4.7): 수색(search) 활동을 하면 그 구역의 찾을 거리 표(locations의 loot)에서 코드가 고른다.
 * - 판정 결과만큼 찾는다 (12-220): 성공 2개, 대가 있는 성공 1개, 실패 0개. 판정 없이는 찾지 못한다 (숨은 확률을 굴리지 않는다)
 * - 구역의 넉넉함과 같은 날 다시 뒤지는 것은 판정 보정이다 (scavengeParts)
 * - 찾은 것은 바로 주인공의 소지품에 들어간다. 무엇을 얼마나 찾는지는 코드가 정한다 (원칙 2)
 */
export function scavenge(ctx: ToolContext, outcome: CheckOutcome | null, want: string | null = null): { lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  const loot = zone ? content.locations[zone]?.loot : undefined;
  if (!zone || !loot || loot.items.length === 0) return { lines: ["이 구역에는 뒤져서 나올 만한 것이 없다."], displays: [] };

  // 장소마다 센다 (12-258)
  const spot = searchSpot(state) ?? zone;
  const count = searchedToday(state, spot);
  store.append({ type: "zone_searched", zone: spot, day: dayOf(state.time) });

  const total = loot.items.reduce((n, i) => n + i.weight, 0);
  const found = new Map<string, number>();
  for (let r = 0; r < foundCount(outcome); r++) {
    let pick = rng() * total;
    const entry = loot.items.find((i) => (pick -= i.weight) < 0) ?? loot.items[loot.items.length - 1]!;
    const [min, max] = entry.qty;
    const qty = min + Math.floor(rng() * (max - min + 1));
    found.set(entry.item, (found.get(entry.item) ?? 0) + qty);
  }

  // 임무로 찾는 자원이 있으면 (찾아오기·땔감 수색) 대가 있는 성공 이상에서 그 자원 물건 하나는 나온다 (플레이 테스트 13: 6일 동안 약을 한 번도 못 찾았다)
  if (want && outcome && outcome !== "miss" && ![...found.keys()].some((id) => itemResource(content, id) === want)) {
    const here = loot.items.filter((i) => itemResource(content, i.item) === want).map((i) => i.item);
    const any = Object.values(content.items).filter((i) => itemResource(content, i.id) === want).sort((a, b) => (a.value ?? 0) - (b.value ?? 0)).map((i) => i.id);
    const pick = here[0] ?? any[0];
    if (pick) {
      const first = [...found.keys()][0];
      if (first && found.size >= foundCount(outcome)) found.delete(first);
      found.set(pick, (found.get(pick) ?? 0) + 1);
    }
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
