import { heldOf } from "../rules/held.ts";
import { z } from "zod";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import type { GameState } from "../game/state.ts";
import { josa } from "../text.ts";
import { carriedWeight, carryCapacity, encumbrance, equippedItem } from "./gear.ts";
import { defineTool, type ToolContext, type ToolOutcome } from "./toolkit.ts";
import { ownedBy } from "../rules/home.ts";

/**
 * 내 물건 보관 (기획서 4.8.1, 12-149). 무게 제한 때문에 다 들고 다닐 수 없는 물건을 맡겨 둔다. 용량 제한은 없다.
 * - 무리에 들었으면 우리 무리 거점의 사물함 (숙소·막사), 떠돌이면 스스로 정한 거처 (한 곳)
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
  const worn = (["weapon", "body", "head", "arms", "outer"] as const).filter((slot) => equippedItem(c, slot) === itemId).length;
  return Math.max(0, (c.inventory[itemId] ?? 0) - worn);
}

export type StashMove = { item_id: string; quantity: number };

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
      error: me.factionId ? "물건은 우리 무리 거점의 사물함에 맡긴다. 거점에 가야 한다." : state.homes[me.id] ? `물건은 거처(${zoneName(content, state.homes[me.id]!)})에 맡긴다.` : "아직 거처가 없다. 머물 곳을 정하면(stash settle) 거기에 맡길 수 있다.",
    };
  }
  if (direction === "take" && !Object.keys(box).length) return { ok: false, error: "이 구역에 맡겨 둔 물건이 없다." };
  // 같은 물건이 여러 번 적혀도 합쳐서 본다
  const total = new Map<string, number>();
  for (const m of moves) total.set(m.item_id, (total.get(m.item_id) ?? 0) + m.quantity);
  for (const [id, n] of total) {
    const item = content.items[id];
    if (!item) return { ok: false, error: `알 수 없는 아이템: ${id}` };
    const have = direction === "put" ? looseCount(me, id) : (box[id] ?? 0);
    if (have < n) {
      const worn = direction === "put" && (me.inventory[id] ?? 0) > have ? " (걸친 것은 먼저 벗어야 맡긴다)" : "";
      return { ok: false, error: `${direction === "put" ? "지닌" : "맡겨 둔"} ${josa(item.name, "이/가")} ${have}개뿐이다${worn}.` };
    }
  }
  // 꺼낼 때도 너무 무거우면 들지 못한다 (기획서 4.8)
  if (direction === "take" && content.scenario.gear) {
    const add = [...total].reduce((w, [id, n]) => w + (content.items[id]?.weight ?? 0.5) * n, 0);
    const after = carriedWeight(content, me) + add;
    if (after > carryCapacity(content, me, store.getState()) * content.scenario.gear.carry.hard_limit) return { ok: false, error: `그만큼 꺼내면 너무 무겁다 (${after.toFixed(1)}kg). 덜 꺼낸다.` };
  }
  for (const [id, n] of total) store.append({ type: "item_stashed", characterId: me.id, zone, itemId: id, quantity: n, direction });
  const listed = [...total].map(([id, n]) => `${content.items[id]?.name ?? id}${n > 1 ? ` ×${n}` : ""}`).join(", ");
  const where = place?.label ?? `${zoneName(content, zone)}에 맡겨 둔 곳`;
  const after = store.getState().characters[me.id]!;
  const weight = content.scenario.gear ? ` 짐 ${carriedWeight(content, after).toFixed(1)}/${carryCapacity(content, after, store.getState()).toFixed(0)}kg.` : "";
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

export const stashTool = defineTool({
  name: "stash",
  description:
    "내 물건 보관 (창고). 무리에 들었으면 우리 무리 거점의 사물함, 떠돌이면 거처에 맡긴다. 용량 제한은 없고 게임 시간을 쓰지 않는다. " +
    "put: 지닌 물건을 맡긴다 (지금 그 자리에 있을 때만, 걸친 것은 먼저 벗는다). take: 이 구역에 맡겨 둔 물건을 꺼낸다. " +
    "settle: 떠돌이가 지금 구역을 거처로 삼는다 (한 곳만. 옮기면 예전 거처의 물건은 거기 남는다). " +
    "플레이어가 맡기거나 꺼내겠다고 할 때만 부른다. 상태의 '창고' 줄에 지금 넣을 수 있는지와 맡겨 둔 것이 보인다.",
  schema: z.strictObject({
    action: z.enum(["put", "take", "settle"]),
    items: z
      .array(z.strictObject({ item_id: z.string().describe("아이템 id"), quantity: z.number().int().min(1) }))
      .default([])
      .describe("put·take: 옮길 물건. settle은 비워 둔다"),
  }),
  run(input, ctx): ToolOutcome {
    const r = input.action === "settle" ? settleHome(ctx) : moveStash(ctx, input.action, input.items);
    if (!r.ok) return r;
    return {
      ok: true,
      resultText: r.lines.join("\n"),
      display: { type: "time", activityLabel: input.action === "settle" ? "거처 정하기" : "창고", durationLabel: "", fromLabel: "", toLabel: "" },
      silent: true,
    };
  },
});

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
    ? "우리 무리 거점의 사물함(숙소·막사)에 물건을 맡겨 둘 수 있다"
    : state.homes[me.id]
      ? `거처(${zoneName(content, state.homes[me.id]!)})에 물건을 맡겨 둘 수 있다`
      : "머물 곳을 거처로 정하면(stash settle) 거기에 물건을 맡겨 둘 수 있다";
  return `짐이 한도를 넘었다. 플레이어에게 한 번 알려 준다 (게임 밖 안내로 짧게): ${where}. 상태 화면에서도 옮길 수 있다.`;
}
