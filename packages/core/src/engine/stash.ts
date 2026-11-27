import { heldOf } from "../rules/held.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { SCENE_HOLDER, type GameState } from "../game/state.ts";
import { josa } from "../text.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem } from "./gear.ts";
import { defineTool, type ToolContext, type ToolOutcome } from "./toolkit.ts";
import { ownedBy } from "../rules/home.ts";
import { bagById, bagsAt, bagSpec, contentsWeight, heldCount, packItem, unpackItem, type BagRef } from "../rules/bags.ts";
import { situationOf } from "../rules/situation.ts";

/**
 * 내 물건 보관 (기획서 4.8.1, 12-149). 무게 제한 때문에 다 들고 다닐 수 없는 물건을 맡겨 둔다. 용량 제한은 없다.
 * - 무리에 들었으면 우리 무리 거점의 사물함 (거점 안이면 어디서나 넣고 꺼낸다, 12-260), 떠돌이면 스스로 정한 거처 (한 곳)
 * - 맡긴 물건은 그 구역에 남는다. 거처를 옮기거나 무리를 옮겨도 예전 자리의 물건은 거기 있고, 가서 꺼낼 수 있다 (넣기는 지금 자리에만)
 * - 게임 시간을 쓰지 않는다 (줍고 내려놓기와 같다)
 */

export type StashPlace = { kind: "locker" | "home"; zone: string; label: string };

const zoneName = (content: Content, zone: string) => content.locations[zone]?.name ?? zone;

/** 지금 물건을 넣을 수 있는 자리: 우리 무리 거점의 사물함, 또는 떠돌이의 거처 */
export function stashPlace(content: Content, state: GameState): StashPlace | null {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me || me.dead || heldOf(me) || !zone) return null;
  if (me.factionId) {
    const own = content.locations[zone]?.kind === "base" && ownedBy(state, zone, me.factionId);
    return own ? { kind: "locker", zone, label: `${zoneName(content, zone)}의 내 사물함` } : null;
  }
  return state.homes[me.id] === zone ? { kind: "home", zone, label: `${zoneName(content, zone)}의 내 거처` } : null;
}

/** 이 구역에 맡겨 둔 내 물건 (없으면 빈 것) */
export function stashHere(state: GameState): Record<string, number> {
  const zone = state.playerZone;
  return (zone && state.stashes[state.playerId]?.[zone]) || {};
}

/** 거처로 삼을 수 있는가: 떠돌이이고, 다른 무리의 거점이 아니다 */
export function canSettle(content: Content, state: GameState): { ok: true } | { ok: false; error: string } {
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me || me.dead || !zone) return { ok: false, error: "지금은 거처를 정할 수 없다." };
  if (heldOf(me)) return { ok: false, error: "갇힌 몸이다." };
  if (me.factionId) return { ok: false, error: "무리에 든 사람은 거점의 사물함에 맡긴다. 거처는 떠돌이만 정한다." };
  const location = content.locations[zone];
  const owner = state.zones[zone]?.owner ?? null;
  if (location?.kind === "base" && owner) return { ok: false, error: `${josa(zoneName(content, zone), "은/는")} 다른 무리의 거점이다. 남의 거점에 거처를 둘 수 없다.` };
  if (location?.isolated) return { ok: false, error: `${zoneName(content, zone)}에는 거처를 둘 수 없다.` };
  if (state.homes[me.id] === zone) return { ok: false, error: "이미 여기가 거처다." };
  return { ok: true };
}

/** 걸치지 않고 지닌 수량 (걸친 것은 먼저 벗어야 맡긴다) */
function looseCount(c: Character, itemId: string): number {
  const worn = (["weapon", "body", "head", "arms", "outer", "back"] as const).filter((slot) => equippedItem(c, slot) === itemId).length;
  return Math.max(0, (c.inventory[itemId] ?? 0) - worn);
}

export type StashMove = { item_id: string; quantity: number; /** 가방이면 그 가방 개체째 (공통 규칙 26) */ bag_id?: string | null };

/**
 * 넣기(put)·꺼내기(take). 하나라도 안 되면 아무것도 옮기지 않는다.
 * 넣기는 지금 자리(사물함·거처)에만, 꺼내기는 이 구역에 맡겨 둔 것이 있으면 된다
 */
export function moveStash(ctx: ToolContext, direction: "put" | "take", moves: readonly StashMove[]): { ok: true; lines: string[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!me || me.dead || !zone) return { ok: false, error: "지금은 창고를 쓸 수 없다." };
  if (heldOf(me)) return { ok: false, error: "갇힌 몸이다." };
  if (!moves.length) return { ok: false, error: "옮길 물건이 없다." };
  const place = stashPlace(content, state);
  const box = stashHere(state);
  if (direction === "put" && !place) {
    return {
      ok: false,
      error: me.factionId ? "물건은 우리 무리 거점의 사물함에 맡긴다. 거점 안이면 어디서든 된다. 거점에 가야 한다." : state.homes[me.id] ? `물건은 거처(${zoneName(content, state.homes[me.id]!)})에 맡긴다.` : "아직 거처가 없다. 머물 곳을 정하면(stash settle) 거기에 맡길 수 있다.",
    };
  }
  if (direction === "take" && !Object.keys(box).length) return { ok: false, error: "이 구역에 맡겨 둔 물건이 없다." };
  // 같은 물건이 여러 번 적혀도 합쳐서 본다
  const total = new Map<string, number>();
  for (const m of moves) total.set(m.item_id, (total.get(m.item_id) ?? 0) + m.quantity);
  for (const [id, n] of total) {
    const item = content.items[id];
    if (!item) return { ok: false, error: `알 수 없는 아이템: ${id}` };
    // 지닌 가방 속 것도 맡길 수 있다 (리듀서가 가방에서 덜어 낸다)
    const inBags = heldCount(state, me.id, id) - (me.inventory[id] ?? 0);
    const have = direction === "put" ? looseCount(me, id) + inBags : (box[id] ?? 0);
    if (have < n) {
      const worn = direction === "put" && (me.inventory[id] ?? 0) > have ? " (걸친 것은 먼저 벗어야 맡긴다)" : "";
      return { ok: false, error: `${direction === "put" ? "지닌" : "맡겨 둔"} ${josa(item.name, "이/가")} ${have}개뿐이다${worn}.` };
    }
  }
  // 꺼낼 때도 너무 무거우면 들지 못한다 (기획서 4.8)
  if (direction === "take" && content.scenario.gear) {
    const bagLoad = moves.reduce((w, m) => w + (m.bag_id ? contentsWeight(content, bagById(state, m.bag_id)?.contents ?? {}) : 0), 0);
    const add = [...total].reduce((w, [id, n]) => w + (content.items[id]?.weight ?? 0.5) * n, 0) + bagLoad;
    const after = carriedWeight(content, me, store.getState()) + add;
    if (after > carryCapacity(content, me, store.getState()) * content.scenario.gear.carry.hard_limit) return { ok: false, error: `그만큼 꺼내면 너무 무겁다 (${after.toFixed(1)}kg). 덜 꺼낸다.` };
  }
  // 집은 가방은 그 개체째 하나씩, 나머지는 합쳐서
  const picked = moves.filter((m) => m.bag_id);
  for (const m of picked) store.append({ type: "item_stashed", characterId: me.id, zone, itemId: m.item_id, quantity: 1, direction, bagId: m.bag_id! });
  for (const [id, n] of total) {
    const rest = n - picked.filter((m) => m.item_id === id).length;
    if (rest > 0) store.append({ type: "item_stashed", characterId: me.id, zone, itemId: id, quantity: rest, direction });
  }
  const listed = [...total].map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ");
  const where = place?.label ?? `${zoneName(content, zone)}에 맡겨 둔 곳`;
  const after = store.getState().characters[me.id]!;
  const weight = content.scenario.gear ? ` 짐 ${carriedWeight(content, after, store.getState()).toFixed(1)}/${carryCapacity(content, after, store.getState()).toFixed(0)}kg.` : "";
  return { ok: true, lines: [`${direction === "put" ? `${where}에 넣었다` : `${where}에서 꺼냈다`}: ${listed}.${weight}`] };
}

/** 이 구역을 거처로 삼는다 (떠돌이). 예전 거처에 맡긴 물건은 거기 남는다 */
export function settleHome(ctx: ToolContext): { ok: true; lines: string[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const can = canSettle(content, state);
  if (!can.ok) return can;
  const old = state.homes[state.playerId];
  store.append({ type: "home_settled", characterId: state.playerId, zone: state.playerZone! });
  const left = old && Object.keys(state.stashes[state.playerId]?.[old] ?? {}).length ? ` 예전 거처(${zoneName(content, old)})에 맡긴 물건은 거기 남아 있다. 가서 꺼낼 수 있다.` : "";
  return { ok: true, lines: [`${josa(zoneName(content, state.playerZone!), "을/를")} 거처로 삼았다. 여기에 물건을 맡겨 둘 수 있다.${left}`] };
}

/**
 * 시작할 때 짐이 한도를 넘으면 무거운 것부터 사물함·거처에 넣어 둔다 (12-259, PT15 섬: 14.6/12kg으로 시작해 은밀·근접전 -1).
 * 걸친 것과 짐을 더 들게 해 주는 것(배낭)은 남긴다. 넣을 자리가 없으면 시작 자리 바닥에 둔다(다시 와서 가져갈 수 있다). 넣은 것의 목록을 돌려준다
 */
export function stowStartingLoad(ctx: ToolContext): string[] {
  const { store, content } = ctx;
  if (!content.scenario.gear) return [];
  const state = store.getState();
  const me = state.characters[state.playerId];
  const place = stashPlace(content, state);
  if (!me || carriedWeight(content, me, state) <= carryCapacity(content, me, state)) return [];
  const loose = Object.keys(me.inventory)
    .filter((id) => looseCount(me, id) > 0 && !content.items[id]?.bag)
    .sort((a, b) => (content.items[b]?.weight ?? 0.5) - (content.items[a]?.weight ?? 0.5));
  const stowed: string[] = [];
  for (const id of loose) {
    const now = store.getState().characters[me.id]!;
    if (carriedWeight(content, now, store.getState()) <= carryCapacity(content, now, store.getState())) break;
    const n = looseCount(now, id);
    // 넣을 사물함·거처가 없으면 시작 자리에 내려 둔다 (12-261, PT16 튜토리얼: 무리 없는 방문자가 8.5/8kg으로 시작)
    if (place) store.append({ type: "item_stashed", characterId: me.id, zone: place.zone, itemId: id, quantity: n, direction: "put" });
    else store.append({ type: "item_transferred", from: me.id, to: SCENE_HOLDER, itemId: id, quantity: n });
    stowed.push(`${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`);
  }
  // 무엇을 어디 두었는지 주인공이 안다 (12-265, PT18 튜토리얼: 내려놓은 담요를 아무도 몰랐다)
  if (stowed.length) {
    const s1 = store.getState();
    const where = place ? "사물함" : "처음 선 자리의 바닥";
    store.append({ type: "belief_added", characterId: me.id, belief: { id: `b_${s1.nextBeliefNo}`, fact: `짐이 무거워 ${stowed.join(", ")}${josa(stowed.at(-1)!, "을/를").slice(stowed.at(-1)!.length)} ${where}에 두었다`, source: "seen", accuracy: "exact", learnedAt: s1.time } });
  }
  return stowed;
}

export const stashTool = defineTool({
  name: "stash",
  description:
    "내 물건 보관 (창고·가방). 무리에 들었으면 우리 무리 거점의 사물함, 떠돌이면 거처에 맡긴다. 용량 제한은 없고 게임 시간을 쓰지 않는다. " +
    "put: 지닌 물건을 맡긴다 (지금 그 자리에 있을 때만, 걸친 것은 먼저 벗는다. 든 가방은 bag_id로 그 가방째). take: 이 구역에 맡겨 둔 물건을 꺼낸다. " +
    "settle: 떠돌이가 지금 구역을 거처로 삼는다 (한 곳만. 옮기면 예전 거처의 물건은 거기 남는다). " +
    "pack: 지닌 물건을 가방에 넣는다 (bag_id: 상태의 가방 줄에 보이는 든 가방, 빈 가방이면 bag_item). unpack: 가방(bag_id)에서 꺼낸다. 가방은 용량이 있고 등에 멘 가방만 안의 무게가 준다 (메기는 equip). " +
    "플레이어가 맡기거나 꺼내거나 가방에 넣겠다고 할 때만 부른다. 가방 속 물건을 쓸 때는 따로 꺼내지 않아도 시스템이 꺼내 쓰고 다시 넣는다.",
  schema: z.strictObject({
    action: z.enum(["put", "take", "settle", "pack", "unpack"]),
    items: z
      .array(z.strictObject({ item_id: z.string().describe("아이템 id"), quantity: z.number().int().min(1), bag_id: z.string().nullable().default(null).describe("put·take에서 든 가방이면 그 가방 id") }))
      .default([])
      .describe("put·take·pack·unpack: 옮길 물건. settle은 비워 둔다"),
    bag_id: z.string().nullable().default(null).describe("pack·unpack: 가방 id (상태의 가방 줄)"),
    bag_item: z.string().nullable().default(null).describe("pack: 빈 가방에 넣을 때 그 가방 아이템 id"),
  }),
  run(input, ctx): ToolOutcome {
    const r = input.action === "settle" ? settleHome(ctx) : input.action === "pack" || input.action === "unpack" ? packMoves(ctx, input.action, input.items, input.bag_id, input.bag_item) : moveStash(ctx, input.action, input.items);
    if (!r.ok) return r;
    return {
      ok: true,
      resultText: r.lines.join("\n"),
      display: { type: "time", activityLabel: input.action === "settle" ? "거처 정하기" : input.action === "pack" || input.action === "unpack" ? "가방" : "창고", durationLabel: "", fromLabel: "", toLabel: "" },
      silent: true,
    };
  },
});

/** 가방에 넣기·꺼내기 (공통 규칙 26). 하나라도 안 되면 거기서 멈춘다 */
export function packMoves(ctx: ToolContext, action: "pack" | "unpack", items: readonly StashMove[], bagId: string | null, bagItem: string | null): { ok: true; lines: string[] } | { ok: false; error: string } {
  const me = ctx.store.getState().playerId;
  if (!items.length) return { ok: false, error: "옮길 물건이 없다." };
  const lines: string[] = [];
  let ref: BagRef | null = bagId ? { bagId } : bagItem ? { bagItem } : null;
  if (!ref) return { ok: false, error: "가방(bag_id, 빈 가방이면 bag_item)을 정한다." };
  for (const m of items) {
    const r = action === "pack" ? packItem(ctx, me, ref, m.item_id, m.quantity) : bagId ? unpackItem(ctx, me, bagId, m.item_id, m.quantity) : { ok: false as const, error: "꺼낼 가방(bag_id)을 정한다." };
    if (!r.ok) return lines.length ? { ok: true, lines: [...lines, `멈췄다: ${r.error}`] } : r;
    lines.push(r.line);
    // 빈 가방에 처음 넣으면 개체가 생긴다: 다음 물건도 그 가방에
    if (action === "pack" && "bagItem" in ref) {
      const want: string = ref.bagItem;
      const made = bagsAt(ctx.store.getState(), me).find(([, b]) => b.item === want && (b.contents[m.item_id] ?? 0) > 0);
      if (made) ref = { bagId: made[0] };
    }
  }
  return { ok: true, lines };
}

/** GM 상태의 창고 줄: 지금 넣을 수 있는 자리와 이 구역에 맡겨 둔 것, 떠돌이의 거처. 아무 일도 없으면 null */
export function describeStash(content: Content, state: GameState): string | null {
  const me = state.characters[state.playerId];
  if (!me || me.dead) return null;
  const place = stashPlace(content, state);
  const box = Object.entries(stashHere(state));
  const listed = box.map(([id, n]) => `${content.items[id]?.name ?? id}(${id})${n > 1 ? ` ×${n}` : ""}`).join(", ");
  const home = !me.factionId && state.homes[me.id] && state.homes[me.id] !== state.playerZone ? ` 거처: ${zoneName(content, state.homes[me.id]!)}.` : "";
  if (!place && !box.length) return home ? `창고:${home}` : null;
  const head = place ? `창고: 여기는 ${place.label}이다 (stash로 넣고 꺼낸다).` : "창고: 여기에 예전에 맡겨 둔 물건이 있다 (stash take로 꺼낼 수만 있다).";
  return `${head} 맡겨 둔 것: ${listed || "없음"}.${home}`;
}

/**
 * 짐이 무거워지면(소지품 무게가 한도를 넘으면) 창고를 한 번 알린다 (캐릭터마다 한 번).
 * 알렸으면 GM에게 줄 말을, 아니면 null
 */
export function stashHint(ctx: ToolContext): string | null {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || state.stashHinted.includes(me.id) || encumbrance(content, me, state) === 0) return null;
  store.append({ type: "stash_hinted", characterId: me.id });
  const where = me.factionId
    ? "우리 무리 거점 안이면 어디서나 사물함에 물건을 맡겨 둘 수 있다"
    : state.homes[me.id]
      ? `거처(${zoneName(content, state.homes[me.id]!)})에 물건을 맡겨 둘 수 있다`
      : "머물 곳을 거처로 정하면(stash settle) 거기에 물건을 맡겨 둘 수 있다";
  return `짐이 한도를 넘었다. 플레이어에게 한 번 알려 준다 (게임 밖 안내로 짧게): ${where}. 상태 화면에서도 옮길 수 있다.`;
}

/** 화면에서 바닥을 못 쓰는 까닭 (공통 규칙 26): 위협이 있는 장면, 갇힌 몸. 쓸 수 있으면 null */
export function groundBlocked(state: GameState, content: Content): string | null {
  const me = state.characters[state.playerId];
  if (!me || me.dead || !state.playerZone) return "지금은 바닥을 쓸 수 없다.";
  if (heldOf(me)) return "갇힌 몸이다.";
  if (state.battle || situationOf(state, content) === "threatened") return "위협이 있는 자리라 화면에서 줍거나 내려놓지 못한다 (GM에게 말한다).";
  return null;
}

/** 옮기는 자리 (상태 화면 팝오버): 맨몸, 가방(든 것 bag:<id>, 빈 것 newbag:<아이템>), 바닥, 창고 */
export type ItemPlace = "body" | "ground" | "stash" | `bag:${string}` | `newbag:${string}`;

/**
 * 물건 하나를 다른 자리로 옮긴다 (공통 규칙 26, 상태 화면). 시간이 들지 않는다.
 * bagId: 옮기는 것이 든 가방이면 그 개체 (내용물째). 가방 속 물건은 먼저 맨몸으로 꺼낸 뒤 옮긴다
 */
export function moveItem(ctx: ToolContext, input: { itemId: string; quantity: number; from: ItemPlace; to: ItemPlace; bagId?: string | null }): { ok: true; lines: string[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const { itemId, quantity, from, to } = input;
  const bagId = input.bagId ?? null;
  if (!me || me.dead) return { ok: false, error: "지금은 옮길 수 없다." };
  if (!content.items[itemId]) return { ok: false, error: `알 수 없는 아이템: ${itemId}` };
  if (from === to) return { ok: false, error: "같은 자리다." };
  if ((from === "ground" || to === "ground") && groundBlocked(state, content)) return { ok: false, error: groundBlocked(state, content)! };
  if (to === "stash" && !stashPlace(content, state)) return { ok: false, error: "여기에는 넣을 창고가 없다." };
  if ((to.startsWith("bag:") || to.startsWith("newbag:")) && bagSpec(content, itemId)) return { ok: false, error: "가방에 가방은 넣지 못한다." };
  const lines: string[] = [];
  // 1. 맨몸으로
  if (from.startsWith("bag:")) {
    const r = unpackItem(ctx, me.id, from.slice(4), itemId, quantity);
    if (!r.ok) return r;
    lines.push(r.line);
  } else if (from === "ground") {
    const have = store.getState().scene.items[itemId] ?? 0;
    if (have < quantity) return { ok: false, error: `바닥에 ${josa(content.items[itemId]!.name, "이/가")} ${have}개뿐이다.` };
    if (content.scenario.gear) {
      const load = bagId ? contentsWeight(content, bagById(store.getState(), bagId)?.contents ?? {}) : 0;
      const after = carriedWeight(content, me, store.getState()) + (content.items[itemId]!.weight ?? 0.5) * quantity + load;
      if (after > carryCapacity(content, me, store.getState()) * content.scenario.gear.carry.hard_limit) return { ok: false, error: `그만큼 주우면 너무 무겁다 (${after.toFixed(1)}kg).` };
    }
    store.append({ type: "item_transferred", from: SCENE_HOLDER, to: me.id, itemId, quantity, ...(bagId ? { bagId } : {}) });
    lines.push(`바닥에서 ${josa(content.items[itemId]!.name, "을/를")} 주웠다${quantity > 1 ? ` (${quantity}개)` : ""}.`);
  } else if (from === "stash") {
    const r = moveStash(ctx, "take", [{ item_id: itemId, quantity, bag_id: bagId }]);
    if (!r.ok) return r;
    lines.push(...r.lines);
  }
  if (to === "body") return { ok: true, lines };
  // 2. 맨몸에서 목적지로
  const fail = (error: string) => (lines.length ? { ok: true as const, lines: [...lines, `거기서 멈췄다: ${error}`] } : { ok: false as const, error });
  if (to.startsWith("bag:") || to.startsWith("newbag:")) {
    const ref: BagRef = to.startsWith("bag:") ? { bagId: to.slice(4) } : { bagItem: to.slice(7) };
    const r = packItem(ctx, me.id, ref, itemId, quantity);
    return r.ok ? { ok: true, lines: [...lines, r.line] } : fail(r.error);
  }
  if (to === "ground") {
    const now = store.getState().characters[me.id]!;
    if ((now.inventory[itemId] ?? 0) < quantity) return fail(`맨몸에 ${josa(content.items[itemId]!.name, "이/가")} ${now.inventory[itemId] ?? 0}개뿐이다.`);
    // 걸친 것을 내려놓으면 벗는다
    for (const slot of ["weapon", "body", "head", "arms", "outer", "back"] as const) if (now.equipped?.[slot] === itemId && (now.inventory[itemId] ?? 0) - quantity <= 0) store.append({ type: "item_equipped", characterId: me.id, slot, itemId: null });
    store.append({ type: "item_transferred", from: me.id, to: SCENE_HOLDER, itemId, quantity, ...(bagId ? { bagId } : {}) });
    return { ok: true, lines: [...lines, `${josa(content.items[itemId]!.name, "을/를")} 바닥에 내려놓았다${bagId ? " (안에 든 것째)" : ""}${quantity > 1 ? ` (${quantity}개)` : ""}.`] };
  }
  if (to === "stash") {
    const now = store.getState().characters[me.id]!;
    if (bagId) for (const slot of ["back"] as const) if (now.equipped?.[slot] === itemId && (now.inventory[itemId] ?? 0) - quantity <= 0) store.append({ type: "item_equipped", characterId: me.id, slot, itemId: null });
    const r = moveStash(ctx, "put", [{ item_id: itemId, quantity, bag_id: bagId }]);
    return r.ok ? { ok: true, lines: [...lines, ...r.lines] } : fail(r.error);
  }
  return { ok: false, error: `알 수 없는 자리: ${to}` };
}
