import { atSpot, spotHere } from "../rules/place.ts";
import { heldOf } from "../rules/held.ts";
import type { Character } from "../game/character.ts";
import { aliasOf, knowsName } from "../game/acquaintance.ts";
import type { GameState, Remains } from "../game/state.ts";
import { josa } from "../text.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { zoneOf } from "../rules/place.ts";
import { changeRelation } from "../rules/regard.ts";

/**
 * 유해와 무덤 (기획서 3.4, 12-130).
 * 주인공·이름 있는 인물이 죽으면 그 구역에 유해가 남는다 (짐은 그 사람이 그대로 지닌다).
 * 감염으로 죽으면 변이하므로 유해가 없고, 변이한 그 사람을 쓰러뜨리면 그때 유해가 남는다.
 * 그 구역에 있으면 유해의 짐을 뒤질 수 있고(transfer_item), 묻으면(take_action.bury) 무덤이 된다.
 * 묻지 않은 유해는 날마다 누군가 조금씩 털어 간다
 */

/** 묻지 않은 유해에서 하루에 짐 한 가지가 털려 갈 확률 (*임시*) */
export const REMAINS_LOOT_CHANCE = 0.3;
/** 같은 무리 사람을 묻으면 무리 사기 (*임시*) */
export const BURIAL_MORALE = 1;
/** 묻는 것을 본 같은 무리 사람의 호감 (*임시*) */
export const BURIAL_AFFECTION = 1;

/** 유해를 남기는 사람인가: 주인공(이었던 사람), 콘텐츠 인물. 이름 없는 엑스트라는 남기지 않는다 */
function leavesRemains(ctx: ToolContext, state: GameState, c: Character): boolean {
  return c.id === state.playerId || !!ctx.content.npcs[c.id];
}

/** 도구를 실행하기 전 주인공 곁에 있던 사람 (곁에서 죽으면 동행 목록에서 빠지므로 미리 잡아 둔다, PT36) */
const withMeBefore = new WeakMap<Set<string>, Set<string>>();

function withMe(state: GameState, id: string): boolean {
  return state.scene.present.includes(id) || (state.companions.includes(id) && !state.bonds[id]?.apart);
}

/** 그 사람이 죽은 곳 */
function placeOf(ctx: ToolContext, state: GameState, c: Character, before?: Set<string>): string | null {
  // 주인공 앞(장면·곁의 동행)에서 죽었으면 여기다. 평소 있던 자리가 아니라 (인물은 어디에, 공통 규칙 15)
  // 함께 걷다 죽은 동행은 죽으며 곁에서 빠진다: 평소 자리(집)로 가지 않게 도구 전의 곁을 본다 (PT36 약탈조원)
  if (withMe(state, c.id) || (before && withMeBefore.get(before)?.has(c.id))) return state.playerZone;
  return zoneOf(state, ctx.content, c.id);
}

/** 감염으로 죽었는가 (변이한다) */
function diedOfInfection(ctx: ToolContext, c: Character): boolean {
  const track = ctx.content.scenario.body?.infection?.track;
  if (!track || !ctx.content.scenario.body?.infection?.turns_into) return false;
  const levels = ctx.content.scenario.condition_tracks.find((t) => t.id === track)?.levels ?? [];
  return !!levels.find((l) => l.id === c.conditions[track])?.fatal;
}

/** 살아 있는 사람 id (도구를 실행하기 전에 잡아 둔다) */
export function livingIds(state: GameState): Set<string> {
  const living = new Set(Object.values(state.characters).filter((c) => !c.dead).map((c) => c.id));
  withMeBefore.set(living, new Set([...living].filter((id) => withMe(state, id))));
  return living;
}

/** 이번에 새로 죽은 사람의 유해를 남긴다 */
export function leaveRemainsForNewDeaths(ctx: ToolContext, before: Set<string>): void {
  const state = ctx.store.getState();
  for (const id of before) {
    const c = state.characters[id];
    if (!c?.dead) continue;
    if (state.remains.some((r) => r.holder === id)) continue;
    // 변이한 사람을 쓰러뜨렸다: 그 사람의 유해 (짐은 변이체가 지니던 것)
    const of = c.extra?.turnedFrom ?? (leavesRemains(ctx, state, c) && !diedOfInfection(ctx, c) ? c.id : null);
    if (!of) continue;
    const zone = placeOf(ctx, state, c, before);
    if (!zone) continue;
    // 주인공 곁에서 죽었으면 그 자리 (공통 규칙 15 spotHere)
    const spot = zone === state.playerZone ? spotHere(state) : null;
    ctx.store.append({ type: "remains_left", remains: { of, holder: id, zone, diedAt: state.time, buriedAt: null, marker: null, spot } });
  }
}

/** 지금 구역에 묻히지 않은 유해 (그 짐에 손이 닿는다) */
export function remainsHere(state: GameState): Remains[] {
  return state.remains.filter((r) => r.zone === state.playerZone && r.buriedAt === null && atSpot(state, r.spot));
}

/** 지금 구역의 무덤 */
export function gravesHere(state: GameState): Remains[] {
  return state.remains.filter((r) => r.zone === state.playerZone && r.buriedAt !== null);
}

/** 지금 주인공이 그 사람을 부르는 말 (이름을 알면 이름) */
function callOf(ctx: ToolContext | { content: ToolContext["content"] }, state: GameState, id: string): string {
  return knowsName(state, state.playerId, id) ? state.characters[id]!.name : aliasOf(state, ctx.content, id);
}

/** GM 상태의 유해·무덤 줄 */
export function describeRemains(state: GameState, content: ToolContext["content"]): string[] {
  const lines: string[] = [];
  const here = remainsHere(state);
  if (here.length) {
    const list = here.map((r) => {
      const inv = Object.entries(state.characters[r.holder]?.inventory ?? {})
        .filter(([, n]) => n > 0)
        .map(([i, n]) => `${content.items[i]?.name ?? i}${n > 1 ? ` ×${n}` : ""}`);
      // 앞 주인공이면 그렇다고 (12-239, 플레이 테스트 13: "보관 위치 player"가 무엇인지 알 수 없었다)
      const former = state.chronicle.some((c) => c.characterId === r.of) ? "앞 주인공 " : "";
      return `${former}${callOf({ content }, state, r.of)}의 유해 (뒤질 때 from=${r.holder}, 짐: ${inv.join(", ") || "없음"})`;
    });
    lines.push(`이 구역의 묻히지 않은 유해: ${list.join(" / ")}. 짐은 transfer_item(from=그 id)으로 뒤진다. 묻어 주면 take_action.bury(who=그 id)`);
  }
  const graves = gravesHere(state);
  if (graves.length) {
    lines.push(`이 구역의 무덤: ${graves.map((r) => `${r.marker ?? "이름 없는 무덤"}`).join(" / ")}. 묘비에 적힌 것만 보인다`);
  }
  return lines;
}

/** 묻는다 (take_action.bury). who: 유해 줄의 from= 뒤 id 또는 그 사람 id */
export function buryRemains(ctx: ToolContext, who: string, words: string | null): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const target = remainsHere(state).find((r) => r.holder === who || r.of === who);
  if (!target) return { ok: false, error: "이 구역에 묻을 유해가 없다 (상태의 '묻히지 않은 유해' 줄의 from= 뒤 id를 쓴다)." };
  const dead = state.characters[target.of];
  const call = callOf(ctx, state, target.of);
  // 묘비: 이름을 알면 이름, 아니면 호칭. 주인공이었던 사람이면 연대기의 묘비명을 함께 새긴다
  const record = state.chronicle.find((r) => r.characterId === target.of);
  const epitaph = (record?.epitaph ?? words?.trim()) || null;
  const marker = `${call}${epitaph ? ` — "${epitaph}"` : ""}`;
  store.append({ type: "remains_buried", holder: target.holder, at: state.time, marker });
  const lines = [`${josa(call, "을/를")} 묻었다. 짐은 함께 묻혔다. 묘비: ${marker}`];
  // 같은 무리 사람을 묻으면 무리가 위로받고, 지켜본 같은 무리 사람들이 고마워한다
  if (dead && me.factionId && dead.factionId === me.factionId) {
    store.append({ type: "faction_morale_changed", factionId: me.factionId, delta: BURIAL_MORALE });
    lines.push(`우리 무리 사람을 거두어 묻었다. 무리의 사기가 조금 오른다.`);
    for (const id of store.getState().scene.present) {
      const c = store.getState().characters[id];
      if (!c || c.dead || id === me.id || c.factionId !== dead.factionId) continue;
      changeRelation(ctx, { from: id, to: me.id, delta: { trust: 0, affection: BURIAL_AFFECTION, respect: 0 }, reason: `${josa(dead.name, "을/를")} 묻어 주었다`, kind: "burial" });
    }
  }
  return { ok: true, lines, displays: [] };
}

/** 하루가 지나면 묻지 않은 유해에서 누군가 짐을 털어 간다 (그 자리에 주인공이 있으면 털리지 않는다) */
export function lootRemainsDaily(ctx: ToolContext): void {
  const state = ctx.store.getState();
  for (const r of state.remains) {
    if (r.buriedAt !== null || r.zone === state.playerZone) continue;
    const inv = Object.entries(ctx.store.getState().characters[r.holder]?.inventory ?? {}).filter(([, n]) => n > 0);
    if (!inv.length || ctx.rng() >= REMAINS_LOOT_CHANCE) continue;
    const [itemId, quantity] = inv[Math.floor(ctx.rng() * inv.length)]!;
    ctx.store.append({ type: "item_consumed", holder: r.holder, itemId, quantity });
  }
}
