import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { trackOf } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 피로 (기획서 4.5.3, 12-114): 깨어 있는 시간만큼 쌓이고 자면 풀린다. 단계는 쌓인 것에서 바로 정해진다.
 * 피로로 죽지 않는다 (판정만 어려워진다). 주인공만 계산한다. 수치는 scenario.body.fatigue
 */

const rulesOf = (content: Content) => content.scenario.body?.fatigue;

/** 쌓인 피로 → 트랙 단계 번호 */
export function fatigueLevel(content: Content, load: number): number {
  const r = rulesOf(content);
  if (!r || load < r.grace) return 0;
  const levels = trackOf(content.scenario, r.track).levels.length;
  return Math.min(levels - 1, 1 + Math.floor((load - r.grace) / r.per_step));
}

/** from부터 to까지 activity를 하며 보낸 시간만큼 피로를 쌓거나 푼다. take_action이 시간을 흘릴 때마다 부른다 */
export function exposeToFatigue(ctx: ToolContext, activity: string, from: number, to: number): ToolDisplayEvent[] {
  const r = rulesOf(ctx.content);
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!r || !me || me.dead || to <= from) return [];
  const before = state.fatigueLoad[me.id] ?? 0;
  const hours = (to - from) / 60;
  const load = Math.max(0, Math.round((before + (r.rates[activity] ?? 1) * hours) * 10) / 10);
  const displays: ToolDisplayEvent[] = [];
  const levels = trackOf(ctx.content.scenario, r.track).levels;
  const now = Math.max(0, levels.findIndex((l) => l.id === me.conditions[r.track]));
  const target = fatigueLevel(ctx.content, load);
  if (target !== now) {
    const cause = target > now ? `오래 깨어 있었다 (약 ${Math.round(load)}시간)` : "잠을 자서 피로가 풀렸다";
    const ch = changeCondition(ctx, me.id, r.track, target - now, "fatigue", cause);
    if (ch?.display) displays.push(ch.display);
  }
  if (load !== before) ctx.store.append({ type: "fatigue_load_set", characterId: me.id, load });
  return displays;
}

/** GM 상태의 한 줄: 피곤하면 잠이 필요하다고 알린다 (단계는 상태 줄에 이미 보인다) */
export function describeFatigue(content: Content, state: GameState): string | null {
  const r = rulesOf(content);
  const me = state.characters[state.playerId];
  if (!r || !me) return null;
  const level = Math.max(0, trackOf(content.scenario, r.track).levels.findIndex((l) => l.id === me.conditions[r.track]));
  if (level === 0) return null;
  const awake = Math.round(state.fatigueLoad[me.id] ?? 0);
  return `피로: 깨어 있은 지 오래다 (쌓인 피로 약 ${awake}시간). 하품·무거운 눈꺼풀·느린 반응으로 서술한다. 자면(take_action activity sleep) 시간당 풀린다. 쉬기만 하면 더 쌓이지 않을 뿐이다`;
}
