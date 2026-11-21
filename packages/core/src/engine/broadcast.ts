import { heldOf } from "../rules/held.ts";
import type { Content } from "../content/schemas.ts";
import type { GameState } from "../game/state.ts";
import { dayOf } from "../rules/time.ts";
import { josa } from "../text.ts";
import { fillStorylet, pickCast, pickStorylet, roadStorylets, storyletVars } from "../story/storylets.ts";
import { fireStorylet, storySetup, storyTitle, maskUnknownNames } from "./storyletTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 무전 송출 (기획서 10.5.3, 12-173). 무전기를 가진 주인공이 열린 주파수로 먼저 부른다.
 * 하루 한 번. chance로 태그(radio_call.tag) 이야기 중 조건이 맞는 하나가 열린다. 누가 응답하는지(위험도)는 이야기 안에 있다
 */

const rules = (content: Content) => content.scenario.radio_call;

/** 송출할 수 없는 까닭 (없으면 null) */
export function planBroadcast(content: Content, state: GameState): string | null {
  const r = rules(content);
  if (!r) return "이 월드에는 무전 송출이 없다.";
  const me = state.characters[state.playerId];
  if (!me || (me.inventory[r.item] ?? 0) <= 0) return `${josa(content.items[r.item]?.name ?? r.item, "이/가")} 있어야 송출한다.`;
  if (heldOf(me)) return "갇힌 동안에는 송출할 수 없다.";
  if (state.battle) return "전투 중에는 송출할 수 없다.";
  if (state.activeStorylet) return "진행 중인 이야기를 먼저 끝낸다.";
  if (state.lastBroadcastDay === dayOf(state.time)) return "오늘은 이미 송출했다. 배터리를 아낀다.";
  return null;
}

/** 송출한다. 응답이 오면 이야기가 열린다 */
export function runBroadcast(ctx: ToolContext): { lines: string[]; displays: ToolDisplayEvent[] } {
  const { store, content, rng } = ctx;
  const r = rules(content)!;
  store.append({ type: "radio_broadcast", day: dayOf(store.getState().time) });
  const state = store.getState();
  const candidates = roadStorylets(state, content, r.tag, state.time);
  const storylet = rng() < r.chance ? pickStorylet(candidates, rng) : null;
  if (!storylet) return { lines: ["송신 버튼을 놓고 기다렸지만 잡음뿐이다. 아무도 응답하지 않았다."], displays: [] };
  const displays = fireStorylet(ctx, storylet, pickCast(state, content, storylet, rng)!);
  const now = store.getState();
  const cast = now.activeStorylet?.cast ?? {};
  displays.push({ type: "storylet", event: "started", title: storyTitle(now, content, storylet), detail: maskUnknownNames(now, content, fillStorylet(storySetup(now, storylet), storyletVars(now, content, cast))) });
  return { lines: [`무전에 누군가 응답했다: "${storyTitle(now, content, storylet)}". 그 장면으로 연출하라 (상태의 '진행 중인 이야기'). 열린 송신은 누구나 듣는다.`], displays };
}
