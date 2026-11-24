import { josa } from "../text.ts";
import type { Content } from "../content/schemas.ts";
import type { MissionInstance } from "../game/missions.ts";
import { autoEquip, equippedItem } from "./gear.ts";
import { lastFreedAt, playerHeld } from "../rules/held.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { loanOf } from "../rules/entrusted.ts";
import { ownedBy } from "../rules/home.ts";

/**
 * 무기고 (기획서 4.8): 무장이 필요한 작전에 무리가 무기·탄약을 빌려주고, 임무가 끝나면 거둬들인다.
 * 이미 가진 만큼은 빼고 모자란 것만. 무리 창고의 탄약이 모자라면 탄약 없이 무기만 (전황이 장비에 닿는다)
 */

const nameOf = (content: Content, id: string) => content.items[id]?.name ?? id;

/** 작전을 받을 때: 빌려준 것을 문장으로 (없으면 null) */
export function issueArmory(ctx: ToolContext, mission: MissionInstance): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const template = content.missions[mission.templateId];
  const me = state.characters[state.playerId];
  if (!template?.armed || !me) return null;
  const faction = content.factions[me.factionId];
  const armory = faction?.armory;
  if (!armory) return null;
  const war = content.scenario.war;
  const stock = war ? (state.factions[me.factionId]?.resources[war.ammo] ?? 0) : Infinity;
  const ammoShort = armory.ammo_cost > 0 && stock < armory.ammo_cost;
  const items: Record<string, number> = {};
  // 지닌 총이 쓰는 탄 (12-258, PT15 섬: 작살총을 "쏠 수 있는 총"으로 쳐 소총은 안 주고 소총탄만 줬다)
  const carriedAmmo = new Set(Object.keys(me.inventory).filter((i) => (me.inventory[i] ?? 0) > 0).map((i) => content.items[i]?.weapon?.ammo).filter((a): a is string => !!a));
  // 여기 사물함에 그 탄을 쓰는 총이 있으면 그것을 챙겨 간다: 무기고가 같은 총을 또 내주지 않는다 (PT21·PT22 섬: 짐이 한도를 넘었다)
  const fromLocker: string[] = [];
  const locker = state.playerZone ? (state.stashes?.[me.id]?.[state.playerZone] ?? {}) : {};
  for (const [id, want] of Object.entries(armory.items)) {
    const ammo = content.items[id]?.weapon?.ammo;
    if (!ammo || carriedAmmo.has(ammo) || want <= 0) continue;
    const own = Object.keys(locker).find((i) => (locker[i] ?? 0) > 0 && content.items[i]?.weapon?.ammo === ammo);
    if (!own) continue;
    store.append({ type: "item_stashed", characterId: me.id, zone: state.playerZone!, itemId: own, quantity: 1, direction: "take" });
    // "사물함에 두었다"는 기억은 이제 맞지 않는다 (PT23 섬)
    const itemName = content.items[own]?.name ?? own;
    for (const b of store.getState().beliefs[me.id] ?? []) if (b.fact.includes(itemName) && b.fact.includes("사물함에 두었다")) store.append({ type: "belief_dropped", characterId: me.id, beliefId: b.id });
    carriedAmmo.add(ammo);
    fromLocker.push(content.items[own]?.name ?? own);
  }
  // 총은 그 탄을 쓰는 총을 지니지 않았을 때만 빌려준다
  for (const [id, want] of Object.entries(armory.items)) {
    const ammo = content.items[id]?.weapon?.ammo;
    if (!ammo || carriedAmmo.has(ammo)) continue;
    const short = want - (me.inventory[id] ?? 0);
    if (short > 0) items[id] = short;
  }
  // 탄은 지닌 총이나 함께 빌려주는 총에 맞는 것만
  const usable = new Set([...carriedAmmo, ...Object.keys(items).map((id) => content.items[id]?.weapon?.ammo).filter((a): a is string => !!a)]);
  for (const [id, want] of Object.entries(armory.items)) {
    if (content.items[id]?.weapon?.ammo) continue;
    if (content.items[id]?.kind === "ammo" && (ammoShort || !usable.has(id))) continue;
    const short = want - (me.inventory[id] ?? 0);
    if (short > 0) items[id] = short;
  }
  const lockerLine = fromLocker.length ? `사물함에서 ${josa(fromLocker.join(", "), "을/를")} 챙겼다.` : "";
  if (!Object.keys(items).length) return lockerLine || null;
  const cost = ammoShort ? 0 : armory.ammo_cost;
  store.append({ type: "armory_issued", missionId: mission.id, factionId: me.factionId, items, resource: war?.ammo ?? "", cost });
  // 받은 총을 손에 든다 (지금 든 것이 총이 아니면)
  const now = store.getState().characters[me.id]!;
  const held = equippedItem(now, "weapon");
  const gun = Object.keys(items).find((id) => content.items[id]?.weapon?.ammo);
  const swapped = !!gun && !(held && content.items[held]?.weapon?.ammo);
  if (swapped) store.append({ type: "item_equipped", characterId: me.id, slot: "weapon", itemId: gun! });
  else autoEquip(ctx, me.id);
  const list = Object.entries(items).map(([id, q]) => `${nameOf(content, id)} ×${q}`).join(", ");
  // 손의 무기를 바꿨으면 알린다 (플레이 테스트 11: 쥐여 준 총 탓에 근접 판정이 말없이 맨손이 됐다)
  const hand = swapped ? ` ${josa(nameOf(content, gun!), "을/를")} 손에 들었다${held ? ` (${josa(nameOf(content, held), "은/는")} 소지품에 있다. 근접전에 쓰려면 equip)` : ""}.` : "";
  return `${lockerLine ? `${lockerLine} ` : ""}무기고에서 ${josa(list, "을/를")} 내줬다 (임무가 끝나면 반납한다).${hand}${ammoShort ? " 무리 창고에 탄약이 모자라 탄약은 받지 못했다." : ""}`;
}

/** 임무가 끝날 때: 빌린 것을 거둬들인다. 잃어버린 무기가 있으면 공적이 깎인다 */
export function returnArmory(ctx: ToolContext, missionId: string, options: { excused?: boolean } = {}): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const loan = loanOf(state, missionId);
  const me = state.characters[state.playerId];
  if (!loan || !me) return null;
  const returned: Record<string, number> = {};
  const lost: string[] = [];
  for (const [id, qty] of Object.entries(loan)) {
    const have = me.inventory[id] ?? 0;
    const back = Math.min(have, qty);
    if (back > 0) returned[id] = back;
    // 탄약은 쓰라고 준 것이다. 무기를 잃어버린 것만 따진다
    if (back < qty && content.items[id]?.kind !== "ammo") lost.push(nameOf(content, id));
  }
  store.append({ type: "armory_returned", missionId, returned });
  autoEquip(ctx, me.id);
  const spent = Object.entries(loan).filter(([id, q]) => content.items[id]?.kind === "ammo" && (returned[id] ?? 0) < q);
  // 돌려준 것이 없으면 "반납했다"고 하지 않는다 (PT15 졸병: 소총·탄을 모두 빼앗겼는데 "반납했다"). 빼앗긴 탄을 "쓴 것"으로 적지 않는다
  const backText = Object.keys(returned).length ? `빌린 장비를 무기고에 반납했다 (${Object.entries(returned).map(([id, q]) => `${nameOf(content, id)} ×${q}`).join(", ")}).` : "";
  const spentText = spent.length ? `${options.excused ? "빼앗기거나 쓴" : "쓴"} ${spent.map(([id]) => nameOf(content, id)).join(", ")}은 따지지 않는다.` : "";
  const parts = [[backText, spentText].filter(Boolean).join(" ")].filter(Boolean);
  if (lost.length && options.excused) {
    parts.push(`${backText ? "" : "돌려줄 것이 없다. "}${josa(lost.join(", "), "은/는")} 붙잡혔을 때 빼앗겼다. 탓하지 않는다.`);
  } else if (lost.length) {
    store.append({ type: "merit_awarded", characterId: me.id, delta: -1, reason: `빌린 장비를 잃어버렸다: ${lost.join(", ")}` });
    parts.push(`${josa(lost.join(", "), "을/를")} 돌려주지 못했다. 공적 -1.`);
  }
  return parts.join(" ");
}

/**
 * 붙잡혀 무기를 다 빼앗기고 풀려난 뒤 우리 거점에 오면 무기고가 근접 무기 하나를 내준다 (풀려날 때마다 한 번, 플레이 테스트 13: 붙잡혀 빼앗긴 뒤 끝까지 맨손).
 * 시간이 흐른 뒤마다 (runAfterTimeAdvance)
 */
export function issueSpare(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || !me.factionId || playerHeld(state)) return [];
  const spare = content.factions[me.factionId]?.armory?.spare;
  const zone = state.playerZone;
  if (!spare || !zone || content.locations[zone]?.kind !== "base" || !ownedBy(state, zone, me.factionId)) return [];
  const freed = lastFreedAt(state);
  if (freed === null || (state.spareIssuedAt !== null && state.spareIssuedAt >= freed)) return [];
  if (Object.entries(me.inventory).some(([id, n]) => n > 0 && !!content.items[id]?.weapon)) return [];
  store.append({ type: "item_granted", to: me.id, itemId: spare, quantity: 1 });
  store.append({ type: "armory_spare_issued" });
  autoEquip(ctx, me.id);
  const fact = `맨손으로 돌아오자 무기고에서 ${josa(nameOf(content, spare), "을/를")} 내줬다`;
  return [{ type: "belief", fact, sourceLabel: "", note: `${fact} (붙잡혀 빼앗긴 뒤 처음 돌아왔을 때 한 번).` }];
}
