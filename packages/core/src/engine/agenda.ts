import type { Content, NpcContent } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { GameState } from "../game/state.ts";
import { harmTrack } from "../scenario/scenario.ts";
import { seasonAt } from "../sim/season.ts";
import { daysOfStock } from "../sim/war.ts";
import { fill, sentence } from "../text.ts";
import { changeCondition } from "./body.ts";
import { applyEffect } from "./storyletTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 인물의 자기 일 (기획서 7.12, 12-168). 사연이 있는 인물이 주인공 없이도 제 일을 밀고 나간다.
 * - 일은 콘텐츠 NPC의 agenda (차례대로). 하루에 한 칸, fill의 조건이 맞고 chance를 넘으면
 * - 다 차면 end(이야기 효과, 배역 self·other)와 death가 일어나고 다음 일로 넘어간다. 사망은 부상 트랙의 끝 단계로만 (원칙 3), 주인공은 대상이 될 수 없다
 * - 클락은 진짜 상태다 (원칙 4). 주인공은 반을 넘으면 GM 카드의 낌새(cue)와, 끝난 뒤의 소식(news)으로만 안다
 * - 주인공이 끼어드는 길: 이야기 효과 agenda {who, delta | stop}, 배역 agenda_half
 */

type Agenda = NonNullable<NpcContent["agenda"]>[number];

/** 이 인물이 지금 하는 일과 찬 칸 */
export function agendaOf(content: Content, state: GameState, npcId: string): { agenda: Agenda; filled: number } | null {
  const list = content.npcs[npcId]?.agenda ?? [];
  const at = state.agendas?.[npcId] ?? { index: 0, filled: 0 };
  const agenda = list[at.index];
  return agenda ? { agenda, filled: at.filled } : null;
}

/** 반을 넘었는가 (낌새가 보인다) */
export function agendaShowing(content: Content, state: GameState, npcId: string): boolean {
  const a = agendaOf(content, state, npcId);
  return !!a && a.filled * 2 >= a.agenda.steps;
}

/** GM 카드의 낌새 줄 */
export function agendaCue(content: Content, state: GameState, npcId: string): string | null {
  const a = agendaOf(content, state, npcId);
  if (!a || a.filled * 2 < a.agenda.steps) return null;
  return `[GM 전용] 요즘 이 인물은: ${a.agenda.cue} (속으로 하는 일: ${a.agenda.label}. 겉으로는 낌새로만 드러낸다)`;
}

function fills(content: Content, state: GameState, npcId: string, a: Agenda, day: number): boolean {
  const c = state.characters[npcId]!;
  const f = a.fill;
  const own = c.factionId ? state.factions[c.factionId] : undefined;
  if (f.morale_lte !== undefined && (!own || own.morale > f.morale_lte)) return false;
  const food = content.scenario.war?.ration.resource;
  if (f.food_days_lte !== undefined && (!own || !food || daysOfStock(content, own, food) > f.food_days_lte)) return false;
  if (f.seasons && !f.seasons.includes(seasonAt(content.scenario, (day - 1) * 24 * 60)?.id ?? "")) return false;
  return true;
}

/** 일을 끝낸다: 효과, 사망, 소식. 다음 일로 넘어간다 */
function finish(ctx: ToolContext, npcId: string, a: Agenda): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const displays: ToolDisplayEvent[] = [];
  const state = store.getState();
  const cast: Record<string, string> = { self: npcId, ...(a.other ? { other: a.other } : {}) };
  const vars = Object.fromEntries(Object.entries(cast).map(([k, id]) => [k, playerCalls(state, content, id)]));
  store.append({ type: "agenda_finished", npcId });
  for (const effect of a.end) applyEffect(ctx, effect, cast, vars, a.label);
  if (a.death) {
    const target = cast[a.death];
    const c = target ? store.getState().characters[target] : undefined;
    if (c && !c.dead && target !== store.getState().playerId) {
      const track = harmTrack(content.scenario);
      const index = Math.max(0, track.levels.findIndex((l) => l.id === c.conditions[track.id]));
      const fatal = track.levels.findIndex((l) => l.fatal);
      if (fatal > index) changeCondition(ctx, target!, track.id, fatal - index, "agenda", a.label);
    }
  }
  // 소식: 같은 무리이거나 그 인물을 아는 주인공이 듣는다
  const now = store.getState();
  const me = now.characters[now.playerId];
  const self = now.characters[npcId];
  const knows = (now.known[now.playerId] ?? []).includes(npcId) || (!!me?.factionId && me.factionId === state.characters[npcId]?.factionId);
  if (me && !me.dead && self && knows) {
    const fact = sentence(fill(a.news, vars));
    store.append({ type: "belief_added", characterId: now.playerId, belief: { id: `b_${now.nextBeliefNo}`, fact, source: "report", accuracy: "approximate", learnedAt: now.time } });
    displays.push({ type: "belief", fact, sourceLabel: "소식" });
  }
  return displays;
}

/** 하루가 지나면: 일을 가진 인물마다 한 칸. 다 차면 끝낸다 */
export function runAgendas(ctx: ToolContext, day: number): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const displays: ToolDisplayEvent[] = [];
  for (const [npcId, npc] of Object.entries(content.npcs)) {
    if (!npc.agenda?.length) continue;
    const state = store.getState();
    const c = state.characters[npcId];
    if (!c || c.dead || c.away || c.captive || npcId === state.playerId) continue;
    const cur = agendaOf(content, state, npcId);
    if (!cur || !fills(content, state, npcId, cur.agenda, day) || ctx.rng() >= cur.agenda.fill.chance) continue;
    store.append({ type: "agenda_filled", npcId, delta: 1 });
    if (cur.filled + 1 >= cur.agenda.steps) displays.push(...finish(ctx, npcId, cur.agenda));
  }
  return displays;
}

/** 이야기 효과 agenda: 주인공이 끼어들어 앞당기거나 늦추거나(delta) 멈추게(stop) 한다. 멈추면 끝 효과 없이 다음 일로 */
export function nudgeAgenda(ctx: ToolContext, npcId: string, delta: number, stop: boolean): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const cur = agendaOf(content, store.getState(), npcId);
  if (!cur) return [];
  if (stop) {
    store.append({ type: "agenda_finished", npcId });
    return [];
  }
  const next = Math.max(0, cur.filled + delta);
  store.append({ type: "agenda_filled", npcId, delta: next - cur.filled });
  return next >= cur.agenda.steps ? finish(ctx, npcId, cur.agenda) : [];
}
