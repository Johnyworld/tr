import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Character } from "../game/character.ts";
import { NEUTRAL_RELATION } from "../game/reputation.ts";
import type { GameState } from "../game/state.ts";
import { CHECK_OUTCOME_LABELS, type CheckOutcome } from "../rules/check.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import { rollPlayerCheck } from "./checks.ts";
import { defineTool, type ToolContext, type ToolDisplayEvent, type ToolOutcome } from "./toolkit.ts";

/**
 * 물건 (기획서 4.8): 무기·탄약·방어구·도구·내구도·무게·수리·제작·흥정. 수치는 아이템·시나리오 데이터, 규칙은 여기.
 * GM은 무엇을 들고 쓰는지 고를 뿐 효과는 코드가 정한다 (원칙 2)
 */

export const DEFAULT_WEIGHT = 0.5;
export const DEFAULT_VALUE = 1;
type Item = Content["items"][string];
type Slot = "weapon" | "body" | "head" | "arms";
const ARMOR_SLOTS = ["body", "head", "arms"] as const;

export const itemOf = (content: Content, id: string | null | undefined): Item | undefined => (id ? content.items[id] : undefined);
const nameOf = (content: Content, id: string) => content.items[id]?.name ?? id;

/** 들고·입고 있는 것 (가진 것만 유효) */
export function equippedItem(c: Character, slot: Slot): string | null {
  const id = c.equipped?.[slot] ?? null;
  return id && (c.inventory[id] ?? 0) > 0 ? id : null;
}

/** 지닌 짐의 무게 */
export function carriedWeight(content: Content, c: Character): number {
  return Object.entries(c.inventory).reduce((n, [id, q]) => n + (content.items[id]?.weight ?? DEFAULT_WEIGHT) * q, 0);
}

/** 들 수 있는 무게 (근력에 따라) */
export function carryCapacity(content: Content, c: Character): number {
  const carry = content.scenario.gear?.carry;
  if (!carry) return Infinity;
  const strength = content.scenario.stats.find((s) => s.id === "strength") ? (c.stats.strength ?? 0) : 0;
  // 배낭 틀처럼 지니면 더 드는 것 (가장 큰 것 하나)
  const pack = Object.entries(c.inventory).reduce((n, [id, q]) => Math.max(n, q > 0 ? (content.items[id]?.carry_bonus ?? 0) : 0), 0);
  return carry.base + strength * carry.per_strength + pack;
}

/** 짐이 무거운 정도: 0 가벼움, 1 무거움(판정 보정), 2 너무 무거움(옮겨 가지 못한다) */
export function encumbrance(content: Content, c: Character): 0 | 1 | 2 {
  const carry = content.scenario.gear?.carry;
  if (!carry) return 0;
  const w = carriedWeight(content, c);
  const cap = carryCapacity(content, c);
  if (w > cap * carry.hard_limit) return 2;
  return w > cap ? 1 : 0;
}

/**
 * 판정에 붙는 물건 보정 (기획서 4.8):
 * - skill: 손에 든 무기의 보정(그 무기의 스킬일 때) 또는 지닌 도구 중 가장 큰 보정. 능력+스킬 상한 안에서 더한다
 * - penalty: 입은 방어구의 불리함 + 짐이 무거울 때. 상한과 따로 뺀다
 */
export function gearModifiers(content: Content, c: Character, move: string): { skill: number; penalty: number } {
  let skill = 0;
  const weapon = itemOf(content, equippedItem(c, "weapon"))?.weapon;
  if (weapon?.moves.includes(move)) skill = Math.max(skill, weapon.bonus);
  for (const [id, q] of Object.entries(c.inventory)) {
    const b = q > 0 ? (content.items[id]?.tool?.bonus[move] ?? 0) : 0;
    if (b > skill) skill = b;
  }
  let penalty = 0;
  for (const slot of ARMOR_SLOTS) penalty += itemOf(content, equippedItem(c, slot))?.armor?.penalty[move] ?? 0;
  const carry = content.scenario.gear?.carry;
  if (carry && encumbrance(content, c) > 0 && carry.encumbered_moves.includes(move)) penalty += carry.penalty;
  return { skill, penalty };
}

export type AttackPlan = { weapon: string | null; ammo: string | null; noise: number };

/** 공격 판정이 이 무기로 가능한지. 안 되면 오류 문장 */
export function planAttack(content: Content, c: Character, move: string, harm: "none" | "light" | "heavy"): AttackPlan | string {
  const g = content.scenario.gear;
  if (!g) return { weapon: null, ammo: null, noise: 0 };
  const weaponId = equippedItem(c, "weapon");
  const w = itemOf(content, weaponId)?.weapon;
  const rank = (h: string) => (h === "heavy" ? 2 : h === "light" ? 1 : 0);
  if (w && w.moves.includes(move)) {
    if (rank(harm) > rank(w.max_harm)) return `${nameOf(content, weaponId!)}(으)로는 ${harm} 피해를 노릴 수 없다 (상한 ${w.max_harm}). target_harm을 낮춘다.`;
    const usesAmmo = !!w.ammo && (w.ammo_moves ?? w.moves).includes(move);
    if (usesAmmo && (c.inventory[w.ammo!] ?? 0) < 1) return `${nameOf(content, weaponId!)}에 쓸 ${nameOf(content, w.ammo!)}이(가) 없다. 쏠 수 없다 (다른 무기를 들거나 맨손으로).`;
    // 소리는 쏠 때만 (개머리판·칼은 조용하다)
    return { weapon: weaponId, ammo: usesAmmo ? w.ammo! : null, noise: usesAmmo || !w.ammo ? w.noise : 0 };
  }
  if (g.unarmed.moves.includes(move)) {
    if (rank(harm) > rank(g.unarmed.max_harm)) {
      return `맨손${weaponId ? `(손에 든 ${nameOf(content, weaponId)}은(는) 이 판정에 쓰지 않는다)` : ""}으로는 ${harm} 피해를 노릴 수 없다. 무기를 들려면 equip.`;
    }
    return { weapon: null, ammo: null, noise: 0 };
  }
  return `${weaponId ? `손에 든 ${nameOf(content, weaponId)}(으)로는` : "맨손으로는"} 이 판정(${move})으로 공격할 수 없다. 맞는 무기를 equip으로 든다.`;
}

/** 공격 뒤: 탄약을 쓰고, 소리를 내고, 실패하면 무기가 닳는다 */
export function afterAttack(ctx: ToolContext, plan: AttackPlan, outcome: CheckOutcome): { lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const lines: string[] = [];
  if (plan.ammo) {
    store.append({ type: "item_consumed", holder: me.id, itemId: plan.ammo, quantity: 1 });
    const left = store.getState().characters[me.id]!.inventory[plan.ammo] ?? 0;
    lines.push(`${nameOf(content, plan.ammo)} 하나를 썼다 (남은 것 ${left}).`);
  }
  if (plan.noise > 0 && state.playerZone) {
    store.append({ type: "noise_made", zone: state.playerZone, level: plan.noise, day: dayOf(state.time) });
    if (plan.noise >= 2) lines.push("총소리가 멀리 퍼졌다. 근처의 감염체와 사람들이 들었을 수 있다 (서술에 반영하되 무엇이 오는지는 정하지 않는다).");
  }
  const broke = plan.weapon && outcome === "miss" ? wearItem(ctx, me.id, plan.weapon, 1) : null;
  if (broke) lines.push(broke);
  return { lines, displays: [] };
}

/** 물건을 닳게 한다. 망가지면 문장 */
export function wearItem(ctx: ToolContext, holder: string, itemId: string, delta: number): string | null {
  const { store, content } = ctx;
  const item = content.items[itemId];
  if (!item?.durability) return null;
  // 손질: 물건을 잘 다루는 사람은 덜 닳게 쓴다 (기획서 4.8)
  const m = content.scenario.gear?.maintenance;
  const who = store.getState().characters[holder];
  if (m && who && delta > 0) {
    const level = Math.min(2, who.skills[m.move] ?? content.scenario.moves.find((x) => x.id === m.move)?.default ?? 0);
    if (level >= 0 && ctx.rng() < m.save_chance[level]!) return null;
  }
  store.append({ type: "item_worn", characterId: holder, itemId, delta });
  const wear = store.getState().characters[holder]!.wear[itemId] ?? 0;
  if (wear < item.durability) return null;
  store.append({ type: "item_broken", characterId: holder, itemId, into: item.breaks_into ?? null });
  return `${item.name}이(가) 망가졌다${item.breaks_into ? ` (${nameOf(content, item.breaks_into)}만 남았다)` : ""}. 망가지는 순간을 서술한다.`;
}

/** 입은 방어구가 받는 피해를 줄인다. 줄인 단계와 막은 방어구 */
export function armorAbsorb(ctx: ToolContext, steps: number): { steps: number; lines: string[] } {
  const { store, content } = ctx;
  if (steps <= 0) return { steps, lines: [] };
  const me = store.getState().characters[store.getState().playerId]!;
  const lines: string[] = [];
  let left = steps;
  for (const slot of ARMOR_SLOTS) {
    const id = equippedItem(me, slot);
    const armor = itemOf(content, id)?.armor;
    if (!id || !armor?.reduces || left <= 0) continue;
    const cut = Math.min(armor.reduces, left);
    left -= cut;
    lines.push(`${nameOf(content, id)}이(가) 피해를 ${cut}단계 막았다.`);
    const broke = wearItem(ctx, me.id, id, 1);
    if (broke) lines.push(broke);
  }
  return { steps: left, lines };
}

/** 감염원에게 다칠 때 입은 방어구가 감염을 막는지 */
export function armorBlocksInfection(ctx: ToolContext): boolean {
  const me = ctx.store.getState().characters[ctx.store.getState().playerId]!;
  let p = 0;
  for (const slot of ARMOR_SLOTS) p = Math.max(p, itemOf(ctx.content, equippedItem(me, slot))?.armor?.blocks_infection ?? 0);
  return p > 0 && ctx.rng() < p;
}

const equipTool = defineTool({
  name: "equip",
  description:
    "주인공이 무기를 손에 들거나 방어구를 입는다(벗는다). 가진 것만. 공격 판정은 손에 든 무기로 한다 (없으면 맨손). 방어구는 받는 피해를 줄이지만 무겁고 불리한 판정이 있을 수 있다. 시간은 거의 들지 않는다.",
  schema: z.strictObject({
    item_id: z.string().nullable().describe("들거나 입을 아이템 id. 벗으려면 null"),
    slot: z.enum(["weapon", "body", "head", "arms"]).nullable().describe("벗을 때만 자리. 들거나 입을 때는 null (아이템이 정한다)"),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    if (!input.item_id) {
      if (!input.slot) return { ok: false, error: "벗을 자리(slot)를 정한다." };
      const was = equippedItem(me, input.slot);
      store.append({ type: "item_equipped", characterId: me.id, slot: input.slot, itemId: null });
      return { ok: true, resultText: was ? `${nameOf(content, was)}을(를) 내려놓았다 (소지품에는 남는다).` : "그 자리에는 든 것이 없다.", display: { type: "item", fromName: me.name, toName: "", itemName: was ? nameOf(content, was) : "-", quantity: 0 } };
    }
    const item = content.items[input.item_id];
    if (!item || (me.inventory[input.item_id] ?? 0) < 1) return { ok: false, error: `가진 물건이 아니다: ${input.item_id}` };
    const slot: Slot | null = item.weapon ? "weapon" : item.armor ? item.armor.slot : null;
    if (!slot) return { ok: false, error: `${item.name}은(는) 들거나 입는 물건이 아니다.` };
    store.append({ type: "item_equipped", characterId: me.id, slot, itemId: item.id });
    const what = slot === "weapon" ? "손에 들었다" : "입었다";
    const note = item.weapon
      ? ` (${item.weapon.moves.join("/")} 공격, 피해 상한 ${item.weapon.max_harm}${item.weapon.ammo ? `, 쏠 때마다 ${nameOf(content, item.weapon.ammo)} 하나` : ""}${item.weapon.noise >= 2 ? ", 시끄럽다" : ""})`
      : ` (피해 ${item.armor!.reduces}단계 줄임${Object.keys(item.armor!.penalty).length ? `, ${Object.entries(item.armor!.penalty).map(([m, v]) => `${m} ${v}`).join(", ")}` : ""})`;
    return { ok: true, resultText: `${item.name}을(를) ${what}${note}.`, display: { type: "item", fromName: "", toName: me.name, itemName: item.name, quantity: 1 } };
  },
});

/** 상인이 흥정에서 받으려는 값 배수 (상인 이윤 × 관계) */
function priceFactor(content: Content, state: GameState, npcId: string): number {
  const markup = content.npcs[npcId]?.merchant?.markup ?? 1;
  const r = state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION;
  const rel = r.trust >= 2 || r.affection >= 2 ? 0.85 : r.trust <= -1 ? 1.25 : 1;
  return markup * rel;
}

const valueOf = (content: Content, bundle: Record<string, number>) =>
  Object.entries(bundle).reduce((n, [id, q]) => n + (content.items[id]?.value ?? DEFAULT_VALUE) * q, 0);

const barterTool = defineTool({
  name: "barter",
  description:
    "장면의 인물과 물건을 바꾼다 (흥정). give는 주인공이 내주는 것, get은 받는 것. 값이 맞는지와 받아들이는지는 시스템이 정한다: " +
    "넉넉하면 그냥 바꾸고, 조금 모자라면 판정(move·stat: 흥정에 쓰는 스킬과 능력), 턱없이 모자라면 거절. 상인은 값을 더 받고, 믿는 사이면 깎아 준다. 값을 지어내지 않는다.",
  schema: z.strictObject({
    npc_id: z.string(),
    give: z.record(z.string(), z.number().int().min(1)).describe("내주는 것: 아이템 id → 수량"),
    get: z.record(z.string(), z.number().int().min(1)).describe("받는 것: 아이템 id → 수량"),
    move: z.string().nullable().describe("값이 모자랄 때 흥정에 쓰는 스킬 id (예: 교섭, 거짓말). 없으면 null"),
    stat: z.string().nullable(),
  }),
  run(input, ctx): ToolOutcome {
    const { store, content } = ctx;
    const state = store.getState();
    const me = state.characters[state.playerId]!;
    const npc = state.characters[input.npc_id];
    if (!npc || !state.scene.present.includes(input.npc_id) || npc.dead) return { ok: false, error: "장면에 있는 인물이 아니다." };
    if (isEmpty(input.get) && isEmpty(input.give)) return { ok: false, error: "주고받는 것이 없다." };
    for (const [id, q] of Object.entries(input.give)) if ((me.inventory[id] ?? 0) < q) return { ok: false, error: `${nameOf(content, id)}이(가) ${me.inventory[id] ?? 0}개뿐이다.` };
    const name = playerCalls(state, content, input.npc_id);
    for (const [id, q] of Object.entries(input.get)) if ((npc.inventory[id] ?? 0) < q) return { ok: false, error: `${josa(name, "은/는")} ${nameOf(content, id)}을(를) ${npc.inventory[id] ?? 0}개만 가졌다.` };
    const giving = valueOf(content, input.give);
    const asking = Math.ceil(valueOf(content, input.get) * priceFactor(content, state, input.npc_id));
    const floor = content.scenario.gear?.haggle_floor ?? 0.7;
    const lines = [`값: 내주는 것 ${giving} · 상대가 바라는 것 ${asking}`];
    let accepted = giving >= asking;
    let display: ToolDisplayEvent = { type: "item", fromName: me.name, toName: name, itemName: "흥정", quantity: 0 };
    if (!accepted) {
      if (giving < asking * floor) return { ok: true, resultText: `${lines[0]}\n${josa(name, "은/는")} 턱없이 모자란다며 거절한다. 거절하는 장면을 서술한다.`, display };
      const moves = content.scenario.gear?.haggle_moves ?? [];
      if (!input.move || !input.stat || (moves.length && !moves.includes(input.move))) {
        return { ok: false, error: `값이 조금 모자란다 (${giving}/${asking}). 흥정하려면 move·stat (${moves.join("/") || "교섭"})을 넣는다. 아니면 더 얹는다.` };
      }
      const check = rollPlayerCheck({ move: input.move, stat: input.stat, difficulty: "normal", intent: `${name}과(와) 흥정한다` }, ctx, { target: input.npc_id });
      if (!check.ok) return check;
      display = check.display;
      lines.push(`흥정 판정: ${CHECK_OUTCOME_LABELS[check.outcome]}`);
      if (check.outcome === "success") accepted = true;
      else if (check.outcome === "partial") {
        accepted = true;
        store.append({ type: "relation_changed", from: input.npc_id, to: me.id, delta: { trust: 0, affection: -1, respect: 0 }, reason: "값을 후려쳤다" });
        lines.push(`${josa(name, "은/는")} 마지못해 받아들였지만 기분이 상했다.`);
      } else {
        store.append({ type: "relation_changed", from: input.npc_id, to: me.id, delta: { trust: -1, affection: 0, respect: 0 }, reason: "흥정이 틀어졌다" });
        return { ok: true, resultText: `${lines.join("\n")}\n${josa(name, "은/는")} 흥정을 거절했다.`, display };
      }
    }
    for (const [id, q] of Object.entries(input.give)) store.append({ type: "item_transferred", from: me.id, to: input.npc_id, itemId: id, quantity: q });
    for (const [id, q] of Object.entries(input.get)) store.append({ type: "item_transferred", from: input.npc_id, to: me.id, itemId: id, quantity: q });
    const list = (b: Record<string, number>) => Object.entries(b).map(([id, q]) => `${nameOf(content, id)} ×${q}`).join(", ") || "없음";
    lines.push(`바꿨다: 내준 것 ${list(input.give)} / 받은 것 ${list(input.get)}. 흥정 장면을 서술한다.`);
    return { ok: true, resultText: lines.join("\n"), display };
  },
});

const isEmpty = (b: Record<string, number>) => Object.keys(b).length === 0;

export const GEAR_TOOLS = [equipTool, barterTool] as const;

/** 상인이 날마다 물건을 다시 채운다 (모자란 만큼) */
export function runRestock(ctx: ToolContext): void {
  const { store, content } = ctx;
  const state = store.getState();
  const day = dayOf(state.time);
  for (const npc of Object.values(content.npcs)) {
    if (!npc.merchant) continue;
    const c = state.characters[npc.id];
    if (!c || c.dead || c.away || c.captive || state.restockedDay[npc.id] === day) continue;
    const items: Record<string, number> = {};
    for (const [id, want] of Object.entries(npc.merchant.restock)) {
      const short = want - (c.inventory[id] ?? 0);
      if (short > 0) items[id] = short;
    }
    // 모자란 것이 있을 때만 (날마다 빈 기록을 쌓지 않는다)
    if (Object.keys(items).length) store.append({ type: "merchant_restocked", npcId: npc.id, day, items });
  }
}

/** 제작·수리를 이 판정으로 할 수 있는지. 안 되면 오류 문장 */
export function planCraft(content: Content, c: Character, craft: { recipe: string | null; repair: string | null }, move: string | undefined): string | null {
  const has = (bundle: Record<string, number>) => Object.entries(bundle).find(([id, q]) => (c.inventory[id] ?? 0) < q);
  if (craft.recipe) {
    const r = content.scenario.crafting?.recipes.find((x) => x.id === craft.recipe);
    if (!r) return `없는 제작 법: ${craft.recipe} (가능: ${(content.scenario.crafting?.recipes ?? []).map((x) => x.id).join(", ")})`;
    if (move !== r.move) return `${r.label}은(는) ${r.move} 판정으로 만든다 (check.move).`;
    const missing = has(r.materials);
    if (missing) return `${r.label}에 ${nameOf(content, missing[0])}이(가) ${missing[1]}개 필요하다.`;
    const tool = r.tools.find((t) => (c.inventory[t] ?? 0) < 1);
    if (tool) return `${r.label}에는 ${nameOf(content, tool)}이(가) 있어야 한다.`;
    return null;
  }
  if (craft.repair) {
    const item = content.items[craft.repair];
    if (!item?.repair || (c.inventory[craft.repair] ?? 0) < 1) return `고칠 수 있는 가진 물건이 아니다: ${craft.repair}`;
    if (!(c.wear[craft.repair] ?? 0)) return `${item.name}은(는) 닳지 않았다.`;
    if (move !== item.repair.move) return `${item.name}은(는) ${item.repair.move} 판정으로 고친다 (check.move).`;
    const missing = has(item.repair.materials);
    if (missing) return `${item.name}을(를) 고치려면 ${nameOf(content, missing[0])}이(가) ${missing[1]}개 필요하다.`;
    const tool = item.repair.tools.find((t) => (c.inventory[t] ?? 0) < 1);
    if (tool) return `${item.name}을(를) 고치려면 ${nameOf(content, tool)}이(가) 있어야 한다.`;
    return null;
  }
  return "craft에는 recipe나 repair 하나를 넣는다.";
}

/** 제작·수리의 결과 (판정 뒤) */
export function applyCraft(ctx: ToolContext, craft: { recipe: string | null; repair: string | null }, outcome: CheckOutcome): string[] {
  const { store, content } = ctx;
  const me = store.getState().characters[store.getState().playerId]!;
  const use = (bundle: Record<string, number>, part: number) => {
    for (const [id, q] of Object.entries(bundle)) {
      const n = Math.max(1, Math.ceil(q * part));
      store.append({ type: "item_consumed", holder: me.id, itemId: id, quantity: Math.min(n, store.getState().characters[me.id]!.inventory[id] ?? 0) });
    }
  };
  if (craft.recipe) {
    const r = content.scenario.crafting!.recipes.find((x) => x.id === craft.recipe)!;
    if (outcome === "miss") {
      use(r.materials, 0.5);
      return [`${r.label}: 실패했다. 재료 절반을 버렸다.`];
    }
    use(r.materials, 1);
    const qty = outcome === "success" ? r.yields.qty : Math.max(1, Math.floor(r.yields.qty / 2));
    store.append({ type: "item_granted", to: me.id, itemId: r.yields.item, quantity: qty });
    return [`${r.label}: ${nameOf(content, r.yields.item)} ×${qty}을(를) 만들었다${outcome === "partial" ? " (대가 있는 성공: 절반만)" : ""}.`];
  }
  const id = craft.repair!;
  const item = content.items[id]!;
  use(item.repair!.materials, 1);
  if (outcome === "miss") return [`${item.name} 수리: 실패했다. 재료만 썼다.`];
  const wear = me.wear[id] ?? 0;
  const fix = outcome === "success" ? wear : Math.max(1, Math.floor(wear / 2));
  store.append({ type: "item_worn", characterId: me.id, itemId: id, delta: -fix });
  return [`${item.name} 수리: ${outcome === "success" ? "말끔히 고쳤다" : "반쯤 고쳤다"}.`];
}

/** GM 상태의 장비·짐 줄 */
export function describeGear(content: Content, c: Character): string {
  if (!content.scenario.gear) return "";
  const parts: string[] = [];
  const weapon = equippedItem(c, "weapon");
  const show = (id: string) => {
    const item = content.items[id]!;
    const wear = c.wear[id] ?? 0;
    const ammo = item.weapon?.ammo ? `, ${nameOf(content, item.weapon.ammo)} ${c.inventory[item.weapon.ammo] ?? 0}` : "";
    return `${item.name}(${id})${item.durability ? ` 닳음 ${wear}/${item.durability}` : ""}${ammo}`;
  };
  parts.push(`손에 든 것: ${weapon ? show(weapon) : "맨손"}`);
  const worn = ARMOR_SLOTS.map((s) => equippedItem(c, s)).filter((x): x is string => !!x);
  if (worn.length) parts.push(`입은 것: ${worn.map(show).join(", ")}`);
  const w = carriedWeight(content, c);
  const cap = carryCapacity(content, c);
  const enc = encumbrance(content, c);
  parts.push(`짐 ${w.toFixed(1)}/${cap.toFixed(0)}kg${enc === 2 ? " (너무 무겁다: 내려놓아야 옮겨 간다)" : enc === 1 ? ` (무겁다: ${content.scenario.gear.carry.encumbered_moves.join("·")} ${content.scenario.gear.carry.penalty})` : ""}`);
  return `장비: ${parts.join(" · ")} (들기·입기는 equip, 흥정은 barter, 고치기·만들기는 take_action.craft)`;
}

/** 든 무기가 없으면 가진 것 중 가장 센 것을 든다 (시작할 때, 이어 갈 때). 쏘는 무기는 탄약이 있을 때만 앞선다 */
export function autoEquip(ctx: ToolContext, characterId: string): void {
  const { store, content } = ctx;
  if (!content.scenario.gear) return;
  const c = store.getState().characters[characterId];
  if (!c || equippedItem(c, "weapon")) return;
  const score = (id: string) => {
    const w = content.items[id]?.weapon;
    if (!w) return -1;
    const loaded = !w.ammo || (c.inventory[w.ammo] ?? 0) > 0;
    // 탄약이 있는 총이 먼저, 그다음 무거운 피해를 내는 것
    return (w.max_harm === "heavy" ? 4 : 2) + (w.ammo ? (loaded ? 3 : -4) : 2) + w.bonus;
  };
  const best = Object.keys(c.inventory).filter((id) => score(id) >= 0).sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
  if (best) store.append({ type: "item_equipped", characterId, slot: "weapon", itemId: best });
}
