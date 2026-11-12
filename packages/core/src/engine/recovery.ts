import type { GameState } from "../game/state.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import { harmTrack, levelOf } from "../scenario/scenario.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 부상 회복 (플레이 테스트 1회차 문제 4). 수치는 시나리오의 recovery에서 온다.
 * - 치료: 아이템(구급상자 등)을 쓰거나, 장면에 있는 치료사에게 받는다 (하루 한 번)
 * - 저절로: 새 부상 없이 natural_days일이 지나면 한 단계. natural_max_level보다 나쁘면 치료가 필요하다
 * 회복은 코드가 정한다. GM은 "꿰맸다"고 서술할 수 있지만 단계는 이 규칙으로만 바뀐다
 */

function levelIndex(ctx: ToolContext, state: GameState, characterId: string) {
  const track = harmTrack(ctx.content.scenario);
  const current = state.characters[characterId]?.conditions[track.id] ?? track.levels[0]!.id;
  return { track, index: track.levels.findIndex((l) => l.id === current), current };
}

function heal(ctx: ToolContext, characterId: string, steps: number, by: string): ToolDisplayEvent | null {
  const state = ctx.store.getState();
  const { track, index, current } = levelIndex(ctx, state, characterId);
  if (index <= 0) return null;
  const to = track.levels[Math.max(0, index - steps)]!.id;
  ctx.store.append({ type: "harm_healed", targetId: characterId, track: track.id, from: current, to, by, day: dayOf(state.time) });
  return {
    type: "heal",
    targetName: state.characters[characterId]!.name,
    trackLabel: track.label,
    fromLabel: levelOf(track, current).label,
    toLabel: levelOf(track, to).label,
    byLabel: by === "rest" ? "쉬면서 나음" : by === "healer" ? "치료" : (ctx.content.items[by]?.name ?? by),
  };
}

/** 저절로 낫기. 시간이 흐른 뒤마다 부른다 */
export function runNaturalRecovery(ctx: ToolContext): ToolDisplayEvent[] {
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return [];
  const displays: ToolDisplayEvent[] = [];
  for (let guard = 0; guard < 5; guard++) {
    const state = ctx.store.getState();
    const player = state.characters[state.playerId];
    if (!player || player.dead) break;
    const { track, index } = levelIndex(ctx, state, player.id);
    const maxIndex = track.levels.findIndex((l) => l.id === recovery.natural_max_level);
    if (index <= 0 || index > maxIndex) break;
    const since = state.recovery.lastChangeAt[player.id] ?? state.runStartedAt;
    if (state.time - since < recovery.natural_days * MINUTES_PER_DAY) break;
    const d = heal(ctx, player.id, 1, "rest");
    if (!d) break;
    displays.push(d);
  }
  return displays;
}

/** 치료 요청 검사와 적용. item이 없으면 장면에 있는 치료사에게 받는다 */
export function applyTreatment(ctx: ToolContext, item: string | null): { ok: true; line: string; display: ToolDisplayEvent } | { ok: false; error: string } {
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return { ok: false, error: "이 시나리오에는 회복 규칙이 없다." };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const { index } = levelIndex(ctx, state, player.id);
  if (index <= 0) return { ok: false, error: "다친 데가 없어 치료할 것이 없다." };
  if (item) {
    const steps = recovery.items[item];
    if (!steps) return { ok: false, error: `${ctx.content.items[item]?.name ?? item}(으)로는 치료할 수 없다 (가능: ${Object.keys(recovery.items).join(", ")}).` };
    if ((player.inventory[item] ?? 0) < 1) return { ok: false, error: `${ctx.content.items[item]?.name ?? item}이(가) 없다.` };
    ctx.store.append({ type: "item_consumed", holder: player.id, itemId: item, quantity: 1 });
    const display = heal(ctx, player.id, steps, item)!;
    return { ok: true, line: `${ctx.content.items[item]?.name ?? item}을(를) 써서 치료했다.`, display };
  }
  const healer = state.scene.present.find((id) => ctx.content.npcs[id]?.healer);
  if (!healer || recovery.healer_steps <= 0) return { ok: false, error: "치료해 줄 사람이 장면에 없다. 치료 아이템을 쓰거나 치료사를 찾아간다." };
  if (state.recovery.lastHealerDay[player.id] === dayOf(state.time)) return { ok: false, error: "오늘은 이미 치료를 받았다. 내일 다시 받을 수 있다." };
  const display = heal(ctx, player.id, recovery.healer_steps, "healer")!;
  return { ok: true, line: `${ctx.content.npcs[healer]!.name}에게 치료를 받았다.`, display };
}
