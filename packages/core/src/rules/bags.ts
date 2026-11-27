/**
 * 공통 규칙 26: 가방 (docs/design.md "공통 규칙", docs/bags-plan.md).
 *
 * 가방은 내용물을 직접 가진다 (C안, 사용자 결정 2026-11-27). 소지품에는 가방 물건 하나만 세고, 가방 개체(state.bags)가 안에 든 것을 가진다.
 * 개체는 안에 든 것이 있거나 메고 있을 때만 있고, 빈 가방은 그냥 물건이다. 가방이 옮겨 가면 연결(at)만 바뀐다 (리듀서).
 * 가방마다 용량(kg)과 무게 감소율(%)이 있고, 등 칸에 멘 가방 하나만 안의 무게가 준다.
 * 지닌 가방 속 물건도 "가진 것"이다: 필수품·도구 보정은 꺼내지 않고 보고, 실제로 쓰는 곳은 꺼내 쓰고 남은 것을 다시 넣는다 (takeOut).
 * state.bags는 이 모듈과 리듀서만 읽는다
 */
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import type { ToolContext } from "../engine/toolkit.ts";
import { josa } from "../text.ts";

type Inventory = Record<string, number>;
export type BagRecord = GameState["bags"][string];
export type BagView = { id: string | null; item: string; name: string; worn: boolean; capacity: number; reduce: number; load: number; contents: Inventory };

const DEFAULT_WEIGHT = 0.5;
const weightOf = (content: Pick<Content, "items">, id: string) => content.items[id]?.weight ?? DEFAULT_WEIGHT;
const nameOf = (content: Pick<Content, "items">, id: string) => content.items[id]?.name ?? id;

export function bagSpec(content: Pick<Content, "items">, itemId: string | null | undefined) {
  return itemId ? content.items[itemId]?.bag : undefined;
}

/** 그 자리(캐릭터 id, "scene", "ground:<자리>", "stash:<사람>:<구역>")에 있는 가방 개체 */
export function bagsAt(state: Pick<GameState, "bags">, at: string): [string, BagRecord][] {
  return Object.entries(state.bags ?? {}).filter(([, b]) => b.at === at);
}

export function bagById(state: Pick<GameState, "bags">, id: string): BagRecord | undefined {
  return state.bags?.[id];
}

export function contentsWeight(content: Pick<Content, "items">, contents: Inventory): number {
  return Object.entries(contents).reduce((n, [id, q]) => n + weightOf(content, id) * q, 0);
}

/** 지닌 가방 속까지 합친 소지품 (가진 것을 묻는 곳: 필수품·도구·재료·탄약). 가방 속은 쓰려면 takeOut으로 꺼낸다 */
export function heldInventory(state: Pick<GameState, "bags" | "characters">, charId: string): Inventory {
  const c = state.characters[charId];
  const out: Inventory = { ...(c?.inventory ?? {}) };
  for (const [, b] of bagsAt(state, charId)) for (const [id, n] of Object.entries(b.contents)) out[id] = (out[id] ?? 0) + n;
  return out;
}

/** 가방 속까지 본 캐릭터 (소지품을 읽는 판단 함수에 넘긴다) */
export function withBags<C extends Pick<Character, "id" | "inventory">>(state: Pick<GameState, "bags" | "characters">, c: C): C {
  if (!bagsAt(state, c.id).length) return c;
  return { ...c, inventory: heldInventory(state, c.id) };
}

export function heldCount(state: Pick<GameState, "bags" | "characters">, charId: string, itemId: string): number {
  return heldInventory(state, charId)[itemId] ?? 0;
}

/** 지닌 가방 (개체 + 빈 가방). 빈 가방은 id가 null */
export function carriedBags(content: Pick<Content, "items">, state: Pick<GameState, "bags" | "characters">, charId: string): BagView[] {
  const c = state.characters[charId];
  if (!c) return [];
  const out: BagView[] = [];
  const records = bagsAt(state, charId);
  const wornRecord = records.some(([, b]) => b.worn);
  for (const [itemId, n] of Object.entries(c.inventory)) {
    const spec = bagSpec(content, itemId);
    if (!spec || n <= 0) continue;
    const mine = records.filter(([, b]) => b.item === itemId);
    for (const [id, b] of mine) out.push({ id, item: itemId, name: nameOf(content, itemId), worn: !!b.worn, capacity: spec.capacity, reduce: spec.reduce, load: contentsWeight(content, b.contents), contents: { ...b.contents } });
    // 빈 가방: 메고 있는데 개체가 없으면 첫 빈 가방을 멘 것으로 본다
    for (let i = 0; i < n - mine.length; i++) {
      const worn = !wornRecord && i === 0 && c.equipped?.back === itemId;
      out.push({ id: null, item: itemId, name: nameOf(content, itemId), worn, capacity: spec.capacity, reduce: spec.reduce, load: 0, contents: {} });
    }
  }
  return out.sort((a, b) => Number(b.worn) - Number(a.worn));
}

/** 가방 속 무게: 지닌 가방 속 전부, 멘 가방은 감소율만큼 덜어서 */
export function bagsCarriedWeight(content: Pick<Content, "items">, state: Pick<GameState, "bags" | "characters">, charId: string): number {
  let w = 0;
  for (const [, b] of bagsAt(state, charId)) {
    const load = contentsWeight(content, b.contents);
    const reduce = b.worn ? (bagSpec(content, b.item)?.reduce ?? 0) / 100 : 0;
    w += load * (1 - reduce);
  }
  return w;
}

/** 바닥·창고의 가방 개체 (그 자리 물건 칸에 "안에 n kg"으로 보인다) */
export function placeBags(content: Pick<Content, "items">, state: Pick<GameState, "bags">, at: string): BagView[] {
  return bagsAt(state, at).map(([id, b]) => {
    const spec = bagSpec(content, b.item);
    return { id, item: b.item, name: nameOf(content, b.item), worn: false, capacity: spec?.capacity ?? 0, reduce: spec?.reduce ?? 0, load: contentsWeight(content, b.contents), contents: { ...b.contents } };
  });
}

function newBagId(state: Pick<GameState, "bagSeq">): string {
  return `bag${(state.bagSeq ?? 0) + 1}`;
}

/** 가방 고르기: bagId가 있으면 그 개체, 없으면 그 가방 물건(빈 것이면 새 개체). worn: 등 칸의 빈 가방을 고른다 */
export type BagRef = { bagId: string } | { bagItem: string; worn?: boolean };

function resolveBag(content: Pick<Content, "items">, state: GameState, charId: string, ref: BagRef): { ok: true; id: string; item: string; contents: Inventory; isNew: boolean; worn: boolean } | { ok: false; error: string } {
  if ("bagId" in ref) {
    const b = state.bags?.[ref.bagId];
    if (!b || b.at !== charId) return { ok: false, error: "지닌 가방이 아니다." };
    return { ok: true, id: ref.bagId, item: b.item, contents: b.contents, isNew: false, worn: !!b.worn };
  }
  const c = state.characters[charId];
  if (!bagSpec(content, ref.bagItem)) return { ok: false, error: `${josa(nameOf(content, ref.bagItem), "은/는")} 가방이 아니다.` };
  const have = c?.inventory[ref.bagItem] ?? 0;
  const records = bagsAt(state, charId).filter(([, b]) => b.item === ref.bagItem);
  // 등 칸의 빈 가방이면 그것, 아니면 빈 것 하나
  const wornRecord = records.find(([, b]) => b.worn);
  if (ref.worn && wornRecord) return { ok: true, id: wornRecord[0], item: ref.bagItem, contents: wornRecord[1].contents, isNew: false, worn: true };
  if (have > records.length) return { ok: true, id: newBagId(state), item: ref.bagItem, contents: {}, isNew: true, worn: !!ref.worn || (!bagsAt(state, charId).some(([, b]) => b.worn) && c?.equipped?.back === ref.bagItem && records.length === 0) };
  if (records.length) return { ok: true, id: records[0]![0], item: ref.bagItem, contents: records[0]![1].contents, isNew: false, worn: !!records[0]![1].worn };
  return { ok: false, error: `${josa(nameOf(content, ref.bagItem), "이/가")} 없다.` };
}

/** 가방에 넣기 (시간이 들지 않는다). 입거나 든 것은 벗고 넣는다. 용량을 넘거나 가방을 가방에 넣으면 막는다 */
export function packItem(ctx: ToolContext, charId: string, ref: BagRef, itemId: string, quantity: number): { ok: true; line: string } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const c = state.characters[charId];
  if (!c) return { ok: false, error: "알 수 없는 사람" };
  const bag = resolveBag(content, state, charId, ref);
  if (!bag.ok) return bag;
  if (bagSpec(content, itemId)) return { ok: false, error: "가방에 가방은 넣지 못한다." };
  const have = c.inventory[itemId] ?? 0;
  if (have < quantity) return { ok: false, error: `맨몸에 ${josa(nameOf(content, itemId), "이/가")} ${have}개뿐이다.` };
  const spec = bagSpec(content, bag.item)!;
  const after = contentsWeight(content, bag.contents) + weightOf(content, itemId) * quantity;
  if (after > spec.capacity + 1e-9) return { ok: false, error: `${nameOf(content, bag.item)}에 다 들어가지 않는다 (${after.toFixed(1)}/${spec.capacity}kg).` };
  // 입거나 든 것을 넣으면 벗는다 (마지막 하나일 때)
  for (const slot of ["weapon", "body", "head", "arms", "outer"] as const) if (c.equipped?.[slot] === itemId && have - quantity <= 0) store.append({ type: "item_equipped", characterId: charId, slot, itemId: null });
  store.append({ type: "bag_packed", characterId: charId, bagId: bag.id, bagItem: bag.item, itemId, quantity, direction: "pack", ...(bag.isNew && bag.worn ? { worn: true } : {}) });
  return { ok: true, line: `${josa(nameOf(content, itemId), "을/를")} ${nameOf(content, bag.item)}에 넣었다${quantity > 1 ? ` (${quantity}개)` : ""}.` };
}

/** 가방에서 꺼내기 (맨몸으로) */
export function unpackItem(ctx: ToolContext, charId: string, bagId: string, itemId: string, quantity: number): { ok: true; line: string } | { ok: false; error: string } {
  const { store, content } = ctx;
  const b = store.getState().bags?.[bagId];
  if (!b || b.at !== charId) return { ok: false, error: "지닌 가방이 아니다." };
  if ((b.contents[itemId] ?? 0) < quantity) return { ok: false, error: `${nameOf(content, b.item)}에 ${josa(nameOf(content, itemId), "이/가")} ${b.contents[itemId] ?? 0}개뿐이다.` };
  store.append({ type: "bag_packed", characterId: charId, bagId, bagItem: b.item, itemId, quantity, direction: "unpack" });
  return { ok: true, line: `${nameOf(content, b.item)}에서 ${josa(nameOf(content, itemId), "을/를")} 꺼냈다${quantity > 1 ? ` (${quantity}개)` : ""}.` };
}

/** 가방을 멘다 (등 칸). 든 가방이면 그 개체, 아니면 빈 가방 */
export function wearBag(ctx: ToolContext, charId: string, ref: BagRef | null): { ok: true; line: string } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  if (!ref) {
    const was = state.characters[charId]?.equipped?.back;
    store.append({ type: "item_equipped", characterId: charId, slot: "back", itemId: null });
    return { ok: true, line: was ? `${josa(nameOf(content, was), "을/를")} 벗었다 (소지품에는 남는다. 안의 무게가 그대로 실린다).` : "멘 가방이 없다." };
  }
  if ("bagId" in ref) {
    const b = state.bags?.[ref.bagId];
    if (!b || b.at !== charId) return { ok: false, error: "지닌 가방이 아니다." };
    store.append({ type: "item_equipped", characterId: charId, slot: "back", itemId: b.item, bagId: ref.bagId });
    return { ok: true, line: `${josa(nameOf(content, b.item), "을/를")} 멨다 (안의 무게 ${bagSpec(content, b.item)?.reduce ?? 0}% 줄임).` };
  }
  const spec = bagSpec(content, ref.bagItem);
  if (!spec) return { ok: false, error: `${josa(nameOf(content, ref.bagItem), "은/는")} 가방이 아니다.` };
  if ((state.characters[charId]?.inventory[ref.bagItem] ?? 0) < 1) return { ok: false, error: `${josa(nameOf(content, ref.bagItem), "이/가")} 없다.` };
  // 든 개체가 있으면 가장 무거운 것을 멘다
  const filled = bagsAt(state, charId).filter(([, b]) => b.item === ref.bagItem).sort(([, a], [, b]) => contentsWeight(content, b.contents) - contentsWeight(content, a.contents))[0];
  store.append({ type: "item_equipped", characterId: charId, slot: "back", itemId: ref.bagItem, ...(filled ? { bagId: filled[0] } : {}) });
  return { ok: true, line: `${josa(nameOf(content, ref.bagItem), "을/를")} 멨다 (안의 무게 ${spec.reduce}% 줄임).` };
}

/**
 * 쓰려고 꺼낸다 (관문, 사용자 결정): 맨몸에 모자라면 지닌 가방에서 꺼내고, restore()가 쓰고 남은 것(같은 물건, 또는 쓰고 남는 물건 leftover)을 같은 가방에 다시 넣는다.
 * 결과 줄은 GM이 서술한다: "가방에서 물병을 꺼냈다" … "빈 물병을 가방에 다시 넣었다"
 */
export function takeOut(ctx: ToolContext, charId: string, itemId: string, quantity = 1, leftover: string | null = null): { lines: string[]; restore: () => string[] } {
  const { store, content } = ctx;
  const state = store.getState();
  const c = state.characters[charId];
  const none = { lines: [], restore: () => [] };
  if (!c) return none;
  let short = quantity - (c.inventory[itemId] ?? 0);
  if (short <= 0) return none;
  const taken: { bagId: string; bagItem: string; n: number }[] = [];
  const bags = bagsAt(state, charId).filter(([, b]) => (b.contents[itemId] ?? 0) > 0).sort(([, a], [, b]) => Number(!!a.worn) - Number(!!b.worn));
  for (const [id, b] of bags) {
    if (short <= 0) break;
    const n = Math.min(short, b.contents[itemId] ?? 0);
    store.append({ type: "bag_packed", characterId: charId, bagId: id, bagItem: b.item, itemId, quantity: n, direction: "unpack" });
    taken.push({ bagId: id, bagItem: b.item, n });
    short -= n;
  }
  if (!taken.length) return none;
  const where = taken.map((t) => nameOf(content, t.bagItem)).join("·");
  const lines = [`가방(${where})에서 ${josa(nameOf(content, itemId), "을/를")} 꺼냈다.`];
  const restore = (): string[] => {
    const out: string[] = [];
    for (const t of taken) {
      for (const id of leftover ? [itemId, leftover] : [itemId]) {
        const now = store.getState();
        const loose = now.characters[charId]?.inventory[id] ?? 0;
        const n = Math.min(t.n, loose);
        if (n <= 0) continue;
        const r = packItem(ctx, charId, now.bags?.[t.bagId]?.at === charId ? { bagId: t.bagId } : { bagItem: t.bagItem }, id, n);
        if (r.ok) out.push(`${josa(nameOf(content, id), "을/를")} 가방(${nameOf(content, t.bagItem)})에 다시 넣었다.`);
      }
    }
    return out;
  };
  return { lines, restore };
}

/** GM 상태의 가방 줄: "등: 군용 배낭 11.2/18kg (80% 줄임) [물병 2, 통조림 3]" */
export function describeBags(content: Pick<Content, "items">, state: GameState, charId: string): string | null {
  const list = carriedBags(content, state, charId);
  if (!list.length) return null;
  return list
    .map((b) => {
      const inside = Object.entries(b.contents).map(([id, n]) => `${nameOf(content, id)}${n > 1 ? ` ${n}` : ""}`);
      return `${b.worn ? "등" : "가방"}: ${b.name}${b.id ? `(${b.id})` : `(빈 것, ${b.item})`} ${b.load.toFixed(1)}/${b.capacity}kg${b.worn ? ` (${b.reduce}% 줄임)` : " (메지 않음)"}${inside.length ? ` [${inside.join(", ")}]` : " [빔]"}`;
    })
    .join(" · ");
}
