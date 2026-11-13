import type { Content } from "../content/schemas.ts";
import type { MissionInstance } from "../game/missions.ts";
import { autoEquip, equippedItem } from "./gear.ts";
import type { ToolContext } from "./toolkit.ts";

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
  for (const [id, want] of Object.entries(armory.items)) {
    if (ammoShort && content.items[id]?.kind === "ammo") continue;
    // 쏠 수 있는 총이 이미 있으면 총은 빌려주지 않는다 (탄약만 채운다)
    const isGun = !!content.items[id]?.weapon?.ammo;
    const hasGun = Object.keys(me.inventory).some((i) => (me.inventory[i] ?? 0) > 0 && content.items[i]?.weapon?.ammo);
    if (isGun && hasGun) continue;
    const short = want - (me.inventory[id] ?? 0);
    if (short > 0) items[id] = short;
  }
  if (!Object.keys(items).length) return null;
  const cost = ammoShort ? 0 : armory.ammo_cost;
  store.append({ type: "armory_issued", missionId: mission.id, factionId: me.factionId, items, resource: war?.ammo ?? "", cost });
  // 받은 총을 손에 든다 (지금 든 것이 총이 아니면)
  const now = store.getState().characters[me.id]!;
  const held = equippedItem(now, "weapon");
  const gun = Object.keys(items).find((id) => content.items[id]?.weapon?.ammo);
  if (gun && !(held && content.items[held]?.weapon?.ammo)) store.append({ type: "item_equipped", characterId: me.id, slot: "weapon", itemId: gun });
  else autoEquip(ctx, me.id);
  const list = Object.entries(items).map(([id, q]) => `${nameOf(content, id)} ×${q}`).join(", ");
  return `무기고에서 ${list}을(를) 내줬다 (임무가 끝나면 반납한다).${ammoShort ? " 무리 창고에 탄약이 모자라 탄약은 받지 못했다." : ""}`;
}

/** 임무가 끝날 때: 빌린 것을 거둬들인다. 잃어버린 무기가 있으면 공적이 깎인다 */
export function returnArmory(ctx: ToolContext, missionId: string): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const loan = state.loans?.[missionId];
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
  const parts = [`빌린 장비를 무기고에 반납했다${Object.keys(returned).length ? ` (${Object.entries(returned).map(([id, q]) => `${nameOf(content, id)} ×${q}`).join(", ")})` : ""}.`];
  if (lost.length) {
    store.append({ type: "merit_awarded", characterId: me.id, delta: -1, reason: `빌린 장비를 잃어버렸다: ${lost.join(", ")}` });
    parts.push(`${lost.join(", ")}을(를) 돌려주지 못했다. 공적 -1.`);
  }
  return parts.join(" ");
}
