import type { Content } from "../content/schemas.ts";
import { playerCalls } from "../game/acquaintance.ts";
import { companionKnows } from "../game/companions.ts";
import type { GameState } from "../game/state.ts";
import type { CheckOutcome, Difficulty } from "../rules/check.ts";
import { formatTime } from "../rules/time.ts";
import { josa } from "../text.ts";
import type { Part } from "./opposition.ts";
import type { ToolContext } from "./toolkit.ts";

/**
 * 매복 (기획서 9.5.2 B, 12-177). 수치는 월드의 ambush.
 * - 내 매복: take_action.ambush + 판정(move, 어려움으로 굴린다). 성공 = hours 동안 매복 (첫 공격 bonus, 그 공격이 성공하면 상대 혼란),
 *   대가 있는 성공 = partial_bonus만, 실패 = 자리가 드러나 서지 않는다. 구역을 떠나거나 한 번 치면 끝난다
 * - 적의 매복: 이야기의 ambush: true로 열리면 다음 판정 하나에 ambushed. 그 판정이 실패하면 주인공이 혼란
 * - 혼란: 주인공은 다음 판정 하나 confused, 상대는 다음 판정 하나 동안 맞서지 못한다 (맞서는 상대 보정 0, 실패해도 다치지 않는다)
 */

const rules = (content: Content) => content.scenario.ambush;

/** 지금 이 구역에 선 내 매복 */
export function activeAmbush(state: GameState): NonNullable<GameState["ambush"]> | null {
  const a = state.ambush;
  return a && a.zone === state.playerZone && a.until > state.time ? a : null;
}

const ambushedNow = (state: GameState) => !!state.ambushed && state.ambushed.until > state.time;
export const isConfused = (state: GameState, id: string | null | undefined) => !!id && (state.confused ?? []).includes(id);

/** 매복을 놓는 판정은 어렵다: 보통 이하로 고른 난이도는 어려움으로 */
export function ambushDifficulty(d: Difficulty): Difficulty {
  return d === "very_hard" || d === "hard" ? d : "hard";
}

/** 매복을 놓을 수 없는 까닭 (없으면 null) */
export function planAmbush(content: Content, state: GameState, move: string | undefined): string | null {
  const r = rules(content);
  if (!r) return "이 월드에는 매복 규칙이 없다.";
  if (!state.playerZone) return "구역이 없다.";
  if (state.battle) return "전투 중에는 따로 매복하지 않는다.";
  if (move !== r.move) return `매복하려면 check.move가 ${r.move}여야 한다.`;
  return null;
}

/** 판정 결과대로 매복을 놓는다 */
export function applyAmbush(ctx: ToolContext, outcome: CheckOutcome): string[] {
  const r = rules(ctx.content)!;
  const state = ctx.store.getState();
  if (outcome === "miss") {
    if (state.ambush) ctx.store.append({ type: "ambush_changed", ambush: null });
    return ["자리를 잡다가 드러났다. 매복은 서지 않았다."];
  }
  const until = state.time + Math.round(r.hours * 60);
  const bonus = outcome === "success" ? r.bonus : r.partial_bonus;
  if (bonus <= 0) return ["자리는 잡았지만 몸을 제대로 숨기지 못했다. 매복이라 할 만한 것은 없다."];
  ctx.store.append({ type: "ambush_changed", ambush: { zone: state.playerZone!, until, bonus, confuse: outcome === "success" } });
  return [
    `매복이 섰다 (${formatTime(until)}까지). 이 구역에 나타난 상대에게 하는 첫 공격이 +${bonus}${outcome === "success" ? ", 상대가 허둥댈 수도 있다" : ""}. 기다리려면 activity wait.`,
  ];
}

/** 판정 줄에 붙는 매복·혼란 보정 (주인공의 판정만) */
export function ambushParts(content: Content, state: GameState, move: string, opponent: string | null): Part[] {
  const r = rules(content);
  if (!r) return [];
  const parts: Part[] = [];
  const mine = activeAmbush(state);
  if (mine && opponent && r.attack_moves.includes(move)) parts.push({ label: "매복", value: mine.bonus });
  if (ambushedNow(state)) parts.push({ label: "매복당함", value: r.ambushed });
  if (isConfused(state, state.playerId)) parts.push({ label: "혼란", value: r.confused });
  return parts.filter((p) => p.value !== 0);
}

/** 판정이 끝난 뒤: 쓴 매복·혼란을 치우고, 매복이 상대를 흔들거나 매복당해 흔들린다. 알릴 줄 */
export function afterCheckAmbush(ctx: ToolContext, move: string, opponent: string | null, outcome: CheckOutcome, before: GameState): string[] {
  const r = rules(ctx.content);
  if (!r) return [];
  const { store, content } = ctx;
  const lines: string[] = [];
  const mine = activeAmbush(before);
  if (mine && opponent && r.attack_moves.includes(move)) {
    store.append({ type: "ambush_changed", ambush: null });
    // 매복한 공격이 성공하면 상대가 혼란에 빠진다 (12-220, 숨은 확률 대신 판정 결과)
    if (mine.confuse && outcome === "success" && !store.getState().characters[opponent]?.dead) {
      store.append({ type: "confusion_changed", characterId: opponent, on: true });
      lines.push(`매복에 걸린 ${josa(playerCalls(store.getState(), content, opponent), "이/가")} 허둥댄다 (혼란: 다음 판정 하나 동안 맞서지 못한다).`);
    } else lines.push("매복을 썼다. 이제부터는 맞붙는 싸움이다.");
  }
  if (isConfused(before, opponent) && opponent) store.append({ type: "confusion_changed", characterId: opponent, on: false });
  if (isConfused(before, before.playerId)) store.append({ type: "confusion_changed", characterId: before.playerId, on: false });
  if (ambushedNow(before)) {
    store.append({ type: "ambushed_changed", until: null });
    if (outcome === "miss") {
      store.append({ type: "confusion_changed", characterId: before.playerId, on: true });
      lines.push(`매복에 당해 정신이 없다 (혼란: 다음 판정 ${r.confused}).`);
    }
  }
  return lines;
}

/** 적의 매복이 있는 이야기가 열렸다. 곁의 동물이 미리 알아채면 매복당하지 않는다. 알릴 줄 */
export function springEnemyAmbush(ctx: ToolContext): string {
  const r = rules(ctx.content);
  if (!r) return "";
  const state = ctx.store.getState();
  if (r.forewarn_trick && companionKnows(state, ctx.content, r.forewarn_trick)) {
    const fact = "곁의 개가 먼저 냄새를 맡고 으르렁거렸다. 숨어 기다리던 것을 미리 알아챘다";
    ctx.store.append({ type: "belief_added", characterId: state.playerId, belief: { id: `b_${state.nextBeliefNo}`, fact, source: "seen", accuracy: "exact", learnedAt: state.time } });
    return `${fact} (매복의 불리함 없음).`;
  }
  ctx.store.append({ type: "ambushed_changed", until: state.time + 120 });
  return `매복이다. 상대가 먼저 움직인다: 다음 판정 ${r.ambushed}, 실패하면 혼란.`;
}

/** 구역을 떠나면 매복은 풀린다 */
export function leaveAmbush(ctx: ToolContext): void {
  if (ctx.store.getState().ambush) ctx.store.append({ type: "ambush_changed", ambush: null });
}

/** GM 상태의 줄 */
export function describeAmbush(content: Content, state: GameState): string[] {
  const r = rules(content);
  if (!r) return [];
  const out: string[] = [];
  const mine = activeAmbush(state);
  if (mine) out.push(`매복 중 (${formatTime(mine.until)}까지): 이 구역에 나타난 상대에게 하는 첫 공격(${r.attack_moves.join("·")}) +${mine.bonus}. 상대가 나타나기 전에는 들키지 않는다`);
  if (ambushedNow(state)) out.push(`매복에 걸렸다: 주인공의 다음 판정 ${r.ambushed} (상대가 먼저 움직였다). 실패하면 혼란`);
  for (const id of state.confused ?? []) {
    if (id === state.playerId) out.push(`주인공이 혼란에 빠졌다: 다음 판정 ${r.confused}`);
    else if (state.scene.present.includes(id)) out.push(`${playerCalls(state, content, id)}(${id}): 혼란에 빠졌다. 다음 판정 하나 동안 맞서지 못하고, 주인공이 실패해도 그에게 다치지 않는다`);
  }
  return out;
}
