import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import type { Character } from "../game/character.ts";
import { trackOf } from "../scenario/scenario.ts";
import { changeCondition } from "./body.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 피로 (기획서 4.5.3, 12-114): 깨어 있는 시간만큼 쌓이고 자면 풀린다. 단계는 쌓인 것에서 바로 정해진다.
 * 피로로 죽지 않는다 (판정만 어려워진다). 주인공만 계산한다. 수치는 scenario.body.fatigue
 */

const rulesOf = (content: Content) => content.scenario.body?.fatigue;

/** 지쳐서 몸이 낫지 않는가 (blocks_recovery_from 이상): 부상이 저절로 낫지 않고 질병도 낫지 않는다 */
export function fatigueBlocksRecovery(content: Content, c: Character): boolean {
  const r = rulesOf(content);
  if (!r?.blocks_recovery_from) return false;
  const levels = trackOf(content.scenario, r.track).levels;
  const at = levels.findIndex((l) => l.id === r.blocks_recovery_from);
  return at >= 0 && levels.findIndex((l) => l.id === c.conditions[r.track]) >= at;
}

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
  const levels = trackOf(ctx.content.scenario, r.track).levels;
  const now = Math.max(0, levels.findIndex((l) => l.id === me.conditions[r.track]));
  // 다른 일(이야기·즉흥 이야기의 대가)이 단계를 직접 올렸으면 쌓인 피로도 그 단계만큼으로 본다.
  // 전에는 5분 걷기에 쌓인 값으로 다시 셈해 "잠을 자서 피로가 풀렸다"로 내려갔다 (PT14)
  const floor = now > 0 ? r.grace + (now - 1) * r.per_step : 0;
  const before = Math.max(state.fatigueLoad[me.id] ?? 0, floor);
  const hours = (to - from) / 60;
  const load = Math.max(0, Math.round((before + (r.rates[activity] ?? 1) * hours) * 10) / 10);
  const displays: ToolDisplayEvent[] = [];
  const target = fatigueLevel(ctx.content, load);
  if (target !== now) {
    const cause = target > now ? "오래 깨어 있었거나 몸을 많이 썼다" : "잠을 자서 피로가 풀렸다";
    const ch = changeCondition(ctx, me.id, r.track, target - now, "fatigue", cause);
    if (ch?.display) displays.push(ch.display);
  }
  if (load !== (state.fatigueLoad[me.id] ?? 0)) ctx.store.append({ type: "fatigue_load_set", characterId: me.id, load });
  return displays;
}

/** GM 상태의 한 줄: 피곤하면 잠이 필요하다고 알린다 (단계는 상태 줄에 이미 보인다) */
export function describeFatigue(content: Content, state: GameState): string | null {
  const r = rulesOf(content);
  const me = state.characters[state.playerId];
  if (!r || !me) return null;
  const level = Math.max(0, trackOf(content.scenario, r.track).levels.findIndex((l) => l.id === me.conditions[r.track]));
  if (level === 0) return null;
  // 쌓인 피로는 깨어 있은 시간이 아니다 (몸을 쓰면 더, 짧게 자면 덜 풀린다). 숫자는 싣지 않는다 (플레이 테스트 8)
  return `피로: 오래 깨어 있었거나 몸을 많이 썼다. 짧게 자면 덜 풀려 금방 다시 쌓인다. 하품·무거운 눈꺼풀·느린 반응으로 서술한다. 자면(take_action activity sleep) 시간당 풀린다. 쉬기만 하면 더 쌓이지 않을 뿐이다${fatigueBlocksRecovery(content, me) ? ". 지친 동안은 상처가 저절로 낫지 않고 병도 낫지 않는다" : ""}`;
}
