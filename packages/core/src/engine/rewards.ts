import { daysOfStock } from "../sim/war.ts";
import { josa } from "../text.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 포상 (기획서 8.6.1, 12-171). 임무 보고로 공적이 무리의 rewards.every 배수를 새로 넘을 때마다 포상 하나.
 * 받은 횟수를 세어 공적이 깎였다 다시 올라도 같은 몫을 두 번 주지 않는다.
 * 무리 식량이 hungry_days일치 아래면 물건 대신 말뿐인 포상 (상관의 존중 +1)
 */
export function grantRewards(ctx: ToolContext, characterId: string, giverId: string): string[] {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[characterId];
  const faction = me?.factionId ? content.factions[me.factionId] : undefined;
  const r = faction?.rewards;
  if (!me || !r) return [];
  const due = Math.floor(Math.max(0, me.merit) / r.every) - (state.rewardsGiven?.[characterId] ?? 0);
  if (due <= 0) return [];
  const own = state.factions[faction!.id];
  const food = content.scenario.war?.ration.resource;
  const hungry = !!own && !!food && daysOfStock(content, own, food) < r.hungry_days;
  const giver = state.characters[giverId]?.name ?? "상관";
  const lines: string[] = [];
  for (let i = 0; i < due; i++) {
    if (hungry) {
      store.append({ type: "reward_given", characterId, itemId: null });
      store.append({ type: "relation_changed", from: giverId, to: characterId, delta: { trust: 0, affection: 0, respect: 1 }, reason: "포상 (말뿐)" });
      lines.push(`포상: 무리 형편이 어려워 줄 것이 없다. ${josa(giver, "이/가")} 말로 공을 치하한다 (존중이 올랐다). 이 장면을 서술하라.`);
      continue;
    }
    const pick = r.items[Math.floor(ctx.rng() * r.items.length)]!;
    store.append({ type: "reward_given", characterId, itemId: pick.id });
    store.append({ type: "item_granted", to: characterId, itemId: pick.id, quantity: pick.qty });
    lines.push(`포상: ${pick.line} (${content.items[pick.id]?.name ?? pick.id} ×${pick.qty}). ${josa(giver, "이/가")} 건네는 장면을 서술하라.`);
  }
  return lines;
}
