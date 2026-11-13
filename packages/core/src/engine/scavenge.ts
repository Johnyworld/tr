import type { CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 수색으로 물건 찾기 (기획서 4.7): 수색(search) 활동을 하면 그 구역의 찾을 거리 표(locations의 loot)에서 코드가 굴린다.
 * - 판정 결과만큼 굴린다: 성공 2번, 대가 있는 성공 1번, 실패 0번. 판정 없이 뒤지면 1번을 절반 확률로
 * - 같은 날 같은 구역을 다시 뒤질수록 덜 나온다 (한 번 뒤질 때마다 절반)
 * - 찾은 것은 바로 주인공의 소지품에 들어간다. 무엇을 얼마나 찾는지는 코드가 정한다 (원칙 2)
 */
export function scavenge(ctx: ToolContext, outcome: CheckOutcome | null): { lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content, rng } = ctx;
  const state = store.getState();
  const zone = state.playerZone;
  const loot = zone ? content.locations[zone]?.loot : undefined;
  if (!zone || !loot || loot.items.length === 0) return { lines: ["이 구역에는 뒤져서 나올 만한 것이 없다."], displays: [] };

  const day = dayOf(state.time);
  const before = state.zoneSearches[zone];
  const count = before && before.day === day ? before.count : 0;
  store.append({ type: "zone_searched", zone, day });

  const rolls = outcome === "success" ? 2 : outcome === "partial" ? 1 : outcome === "miss" ? 0 : 1;
  const chance = loot.chance * 0.5 ** count * (outcome === null ? 0.5 : 1);
  const total = loot.items.reduce((n, i) => n + i.weight, 0);
  const found = new Map<string, number>();
  for (let r = 0; r < rolls; r++) {
    if (rng() >= chance) continue;
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
  const tired = count > 0 ? " 오늘 이미 뒤진 곳이라 남은 것이 적다." : "";
  const lines = names.length
    ? [`수색으로 ${josa(names.join(", "), "을/를")} 찾아 챙겼다 (소지품에 들어왔다). 찾은 것만 서술하고 다른 물건을 지어내지 않는다.${tired}`]
    : [`쓸 만한 것을 찾지 못했다.${tired} 빈손인 것을 서술한다.`];
  return { lines, displays };
}
