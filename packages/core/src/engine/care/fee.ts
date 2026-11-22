/** 치료 (fee): engine/body.ts에서 떼어 냈다 (docs/design.md 12-236) */
import { heldOf } from "../../rules/held.ts";
import { baseOf } from "../captivity.ts";
import { itemResource } from "../market.ts";
import { DEFAULT_VALUE } from "../gear.ts";
import type { GameState } from "../../game/state.ts";
import { playerCalls } from "../../game/acquaintance.ts";
import type { Content } from "../../content/schemas.ts";
import type { Character } from "../../game/character.ts";
import { josa } from "../../text.ts";
import { type ToolContext } from "../toolkit.ts";
import { entrusted, ownCount } from "../../rules/entrusted.ts";
/** 치료 값을 무엇으로 낼지 (플레이 테스트 13): null이면 미리 보여 주고 묻는다, default면 코드가 고른 것, 아니면 고른 물건 */
export type FeeChoice = "default" | Record<string, number> | null;

/** waived: 값을 받지 않은 까닭 (결과에 한 줄, 공통 규칙 9: 공짜인 까닭이 보이지 않았다) */
export type HealerPay = { carried: { holder: string; item: string } | null; fromStock: string | null; pay: Map<string, number>; waived: string | null };

/** 치료의 재료와 값을 정한다 (아직 쓰지 않는다). 못 하면 error */
export function planHealerPay(ctx: ToolContext, healerId: string, choice: FeeChoice = "default"): { ok: true; plan: HealerPay | null } | { ok: false; error: string } {
  const cost = ctx.content.scenario.recovery?.healer_cost;
  if (!cost) return { ok: true, plan: null };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const healer = state.characters[healerId]!;
  const name = playerCalls(state, ctx.content, healerId);
  const faction = healer.factionId ? state.factions[healer.factionId] : undefined;
  const label = ctx.content.scenario.resources.find((r) => r.id === cost.resource)?.label ?? cost.resource;
  // 거점 밖에서는 창고가 아니라 지닌 약을 쓴다: 치료사 본인 먼저, 그다음 곁의 같은 무리 사람 (값싼 것부터)
  const atBase = !!healer.factionId && state.playerZone === baseOf(ctx.content, healer.factionId);
  let carried: HealerPay["carried"] = null;
  if (!atBase) {
    const holders = [healerId, ...state.scene.present.filter((id) => id !== healerId && id !== player.id && !!healer.factionId && state.characters[id]?.factionId === healer.factionId && !state.characters[id]?.dead)];
    for (const holder of holders) {
      const inv = state.characters[holder]?.inventory ?? {};
      const item = Object.keys(inv)
        .filter((id) => (inv[id] ?? 0) > 0 && itemResource(ctx.content, id) === cost.resource)
        .sort((a, b) => (ctx.content.items[a]?.value ?? DEFAULT_VALUE) - (ctx.content.items[b]?.value ?? DEFAULT_VALUE))[0];
      if (item) {
        carried = { holder, item };
        break;
      }
    }
    if (!carried) return { ok: false, error: `${josa(name, "은/는")} 거점 밖에서 쓸 ${josa(label, "이/가")} 없어 치료하지 못한다 (치료사와 곁의 동료가 지닌 것을 쓴다).` };
  } else if (faction && (faction.resources[cost.resource] ?? 0) < 1) return { ok: false, error: `${name}의 무리 창고에 ${josa(label, "이/가")} 바닥나 치료하지 못한다.` };
  let pay = new Map<string, number>();
  const trust = state.relations[healerId]?.[player.id]?.trust ?? 0;
  // 갇힌 포로는 값을 낼 처지가 아니다: 붙잡은 쪽이 거둬 치료한다 (플레이 테스트 12: 포로의 마지막 물병까지 가져갔다)
  if (cost.fee > 0 && !heldOf(player) && player.factionId !== healer.factionId && trust < cost.free_trust) {
    const picked = pickFee(ctx, player, cost.fee);
    const list = (m: Map<string, number>) => [...m].map(([id, q]) => `${ctx.content.items[id]?.name ?? id}(${id}) ×${q}`).join(", ");
    if (choice && choice !== "default") {
      // 플레이어가 고른 물건 (플레이 테스트 13: 담요·물병을 묻지도 않고 가져갔다)
      const chosen = new Map(Object.entries(choice).filter(([, q]) => q > 0));
      // 소중한 것(신표)은 값으로 내지 않는다: 코드가 고를 때와 같은 규칙 (플레이 테스트 14, 동무조: 각인된 라이터가 값 0으로 보였다)
      const keepsake = [...chosen].find(([id]) => ctx.content.items[id]?.keepsake);
      if (keepsake) return { ok: false, error: `${josa(itemName(ctx, keepsake[0]), "은/는")} 소중한 것이라 값으로 내지 않는다. 다른 물건을 고른다. 시간은 흐르지 않았다.` };
      const bad = [...chosen].find(([id, q]) => q > payableCount(ctx, player, id));
      if (bad) return { ok: false, error: `${itemName(ctx, bad[0])} ×${bad[1]}은 낼 수 없다 (지니지 않았거나, 손에 들었거나 입었거나, 빌린 것이다). 시간은 흐르지 않았다.` };
      const sum = feeWorth(ctx, chosen);
      // 무엇이 얼마나 모자란지 (플레이 테스트 14, 동무조 T27·T28: 낸 물건이 몇 어치인지 몰랐다)
      if (sum < cost.fee) return { ok: false, error: `고른 물건의 값이 모자란다: ${worthList(ctx, chosen)} = ${sum}어치, ${cost.fee}어치를 받으니 ${cost.fee - sum} 모자란다. 더 고르거나 다른 물건으로 (시간은 흐르지 않았다).` };
      pay = chosen;
    } else {
      if (!picked) return { ok: false, error: `${josa(name, "은/는")} 다른 무리 사람에게는 값(${cost.fee}어치)을 받는다. 낼 만한 물건이 모자란다 (신뢰가 ${cost.free_trust} 이상이면 받지 않는다).` };
      // 미리 보여 주고 묻는다: 그대로 내거나 바꾼다
      if (choice === null) return { ok: false, error: `${josa(name, "은/는")} 값 ${cost.fee}어치를 받는다. 정해 둔 것: ${list(picked)} (${feeWorth(ctx, picked)}어치). 이대로 내려면 treatment.pay: "auto", 다른 것으로 내려면 treatment.pay: [{item, quantity}] (값의 합이 ${cost.fee} 이상, 손에 든 것·입은 것·빌린 것·소중한 것은 못 낸다). 플레이어에게 무엇을 낼지 물어본다 (시간은 흐르지 않았다).` };
      pay = picked;
    }
  }
  // 값을 받지 않은 까닭
  const waived = cost.fee <= 0 || pay.size ? null : player.factionId && player.factionId === healer.factionId ? "같은 무리라 값을 받지 않았다" : heldOf(player) ? "붙잡힌 몸이라 값을 받지 않았다" : "믿는 사이라 값을 받지 않았다";
  return { ok: true, plan: { carried, fromStock: atBase && faction ? healer.factionId : null, pay, waived } };
}

const itemName = (ctx: ToolContext, id: string) => ctx.content.items[id]?.name ?? id;

/** 물건들의 값 합 */
function feeWorth(ctx: ToolContext, items: Map<string, number>): number {
  return [...items].reduce((n, [id, q]) => n + (ctx.content.items[id]?.value ?? DEFAULT_VALUE) * q, 0);
}

/** 물건마다 몇 어치인지: "감자 ×1(1), 담배 ×1(3)" */
function worthList(ctx: ToolContext, items: Map<string, number>): string {
  return [...items].map(([id, q]) => `${itemName(ctx, id)} ×${q}${items.size > 1 ? `(${(ctx.content.items[id]?.value ?? DEFAULT_VALUE) * q})` : ""}`).join(", ");
}

/** 값으로 고르지 않는 살림 (플레이 테스트 13): 쉴 때 덮는 것, 물그릇, 손에 든 무기의 탄약 */
export function keptForLiving(ctx: ToolContext, payer: Character, id: string): boolean {
  const item = ctx.content.items[id];
  if (item?.warmth?.when === "resting") return true;
  const refill = ctx.content.scenario.body?.thirst?.refill ?? {};
  if (id in refill || Object.values(refill).includes(id)) return true;
  const held = Object.values(payer.equipped ?? {}).map((x) => (x ? ctx.content.items[x]?.weapon?.ammo : undefined));
  return held.includes(id);
}

/** 이 물건을 값으로 낼 수 있는 수 (플레이어가 고를 때): 지닌 것에서 손에 든 것·입은 것·빌린 것을 뺀다 */
export function payableCount(ctx: ToolContext, payer: Character, id: string): number {
  if (Object.values(payer.equipped ?? {}).includes(id)) return 0;
  return payer.id === ctx.store.getState().playerId ? ownCount(ctx.store.getState(), payer.id, id) : (payer.inventory[id] ?? 0);
}

/**
 * 물건으로 내는 값 (치료사·가르침): 지닌 물건 중 값싼 것부터 fee어치까지. 모자라면 null
 * 손에 든 것·입은 것, 신표(keepsake: 완장·통행패)는 내지 않고, 먹고 마시는 소모품은 하나씩 남긴다 (플레이 테스트 12)
 */
export function pickFee(ctx: ToolContext, payer: Character, fee: number): Map<string, number> | null {
  const pay = new Map<string, number>();
  const worn = new Set(Object.values(payer.equipped ?? {}).filter(Boolean));
  // 먹고 마시고 쓰는 소모품(consumables)은 마지막 하나를 남긴다: 값 때문에 굶거나 목마르지 않게
  const survival = (id: string) => Object.values(ctx.content.scenario.consumables[id] ?? {}).some((n) => n > 0);
  // 남의 물건(빌린 장비·맡은 짐)은 내 것이 아니다 (공통 규칙 10, 플레이 테스트 13: 빌린 탄이 치료 값으로 나갔다)
  const loaned = entrusted(ctx.store.getState());
  const goods = Object.entries(payer.inventory)
    .map(([id, q]) => [id, payer.id === ctx.store.getState().playerId ? q - (loaned[id] ?? 0) : q] as const)
    .filter(([id, q]) => q > 0 && !worn.has(id) && !ctx.content.items[id]?.keepsake && !keptForLiving(ctx, payer, id))
    .flatMap(([id, q]) => Array.from({ length: survival(id) ? q - 1 : q }, () => id))
    .sort((a, b) => (ctx.content.items[a]?.value ?? DEFAULT_VALUE) - (ctx.content.items[b]?.value ?? DEFAULT_VALUE));
  let sum = 0;
  for (const id of goods) {
    if (sum >= fee) break;
    pay.set(id, (pay.get(id) ?? 0) + 1);
    sum += ctx.content.items[id]?.value ?? DEFAULT_VALUE;
  }
  return sum >= fee ? pay : null;
}

/**
 * 치료사의 재료와 값 (플레이 테스트 11, recovery.healer_cost): 거점에서는 치료사 무리의 창고에서, 거점 밖에서는 치료사·곁의 동료가 지닌 약에서 1을 쓰고,
 * 다른 무리·무소속이면 (치료사의 신뢰가 모자라면) 지닌 물건에서 값을 받는다. 무엇을 내는지는 코드가 고른다 (값싼 것부터, 손에 든 것·입은 것은 빼고)
 */
export function payHealer(ctx: ToolContext, healerId: string, choice: FeeChoice = "default"): { ok: true; lines: string[] } | { ok: false; error: string } {
  const planned = planHealerPay(ctx, healerId, choice);
  if (!planned.ok) return planned;
  const plan = planned.plan;
  if (!plan) return { ok: true, lines: [] };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const lines: string[] = [];
  for (const [id, q] of plan.pay) ctx.store.append({ type: "item_transferred", from: player.id, to: healerId, itemId: id, quantity: q });
  if (plan.pay.size) lines.push(`치료 값으로 ${[...plan.pay].map(([id, q]) => `${itemName(ctx, id)} ×${q}`).join(", ")}을 냈다 (${feeWorth(ctx, plan.pay)}어치${plan.pay.size > 1 ? `: ${worthList(ctx, plan.pay)}` : ""}).`);
  else if (plan.waived) lines.push(`${plan.waived}.`);
  const resource = ctx.content.scenario.recovery!.healer_cost!.resource;
  if (plan.carried) {
    ctx.store.append({ type: "item_consumed", holder: plan.carried.holder, itemId: plan.carried.item, quantity: 1 });
    lines.push(`${playerCalls(state, ctx.content, plan.carried.holder)}의 ${josa(ctx.content.items[plan.carried.item]?.name ?? plan.carried.item, "을/를")} 썼다.`);
  } else if (plan.fromStock) ctx.store.append({ type: "faction_resource_changed", factionId: plan.fromStock, resource, delta: -1 });
  return { ok: true, lines };
}
