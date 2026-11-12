import type { GameState } from "../game/state.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import type { HarmSeverity } from "../rules/harm.ts";
import { harmTrack, shownLevel, trackOf } from "../scenario/scenario.ts";
import { daysOfStock } from "../sim/war.ts";
import { josa } from "../text.ts";
import { recordDeath } from "./succession.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";

/**
 * 몸 상태 (기획서 4.4, 4.5): 부상 회복, 소모품, 허기, 감염. 수치는 시나리오(recovery, consumables, body)에서 온다.
 * - 사망은 부상 트랙으로만 (원칙 3). 굶주림·감염은 마지막 단계에서 부상을 준다
 * - 숨은 단계(감염 잠복기)는 캐릭터도 GM도 모른다. 보이는 단계가 바뀔 때만 화면에 알린다
 */

type Change = { line: string; display: ToolDisplayEvent | null; died: boolean };

/** 상태 트랙을 steps만큼 바꾼다 (양수 = 나빠짐, 음수 = 나아짐). 바뀌지 않으면 null */
export function changeCondition(ctx: ToolContext, characterId: string, trackId: string, steps: number, by: string, cause: string): Change | null {
  const state = ctx.store.getState();
  const character = state.characters[characterId];
  if (!character || character.dead || steps === 0) return null;
  const track = trackOf(ctx.content.scenario, trackId);
  const index = Math.max(0, track.levels.findIndex((l) => l.id === character.conditions[trackId]));
  const nextIndex = Math.max(0, Math.min(track.levels.length - 1, index + steps));
  if (nextIndex === index) return null;
  const from = track.levels[index]!;
  const to = track.levels[nextIndex]!;
  const isHarm = trackId === ctx.content.scenario.harm_track;
  ctx.store.append({
    type: "condition_changed",
    targetId: characterId,
    track: trackId,
    from: from.id,
    to: to.id,
    fatal: to.fatal === true,
    by,
    cause,
    day: dayOf(state.time),
    harmTrack: isHarm,
  });
  if (to.fatal && characterId === state.playerId) recordDeath(ctx, cause, null);
  const shownFrom = shownLevel(track, from.id);
  const shownTo = shownLevel(track, to.id);
  if (shownFrom.id === shownTo.id) return { line: "", display: null, died: false }; // 캐릭터는 아직 모른다
  const better = nextIndex < index;
  return {
    line: `${character.name}의 ${track.label}: ${shownFrom.label} → ${shownTo.label} (${cause}).${to.fatal ? " 캐릭터가 사망했다. 죽음을 담담하게 서술하고 write_epitaph로 묘비명을 남긴다." : ""}`,
    display: better
      ? { type: "heal", targetName: character.name, trackLabel: track.label, fromLabel: shownFrom.label, toLabel: shownTo.label, byLabel: cause }
      : { type: "harm", targetName: character.name, trackLabel: track.label, severityLabel: cause, fatal: to.fatal === true, fromLabel: shownFrom.label, toLabel: shownTo.label, cause },
    died: to.fatal === true,
  };
}

function levelIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, track.levels.findIndex((l) => l.id === state.characters[characterId]?.conditions[trackId]));
}

/** 소모품을 쓴다 (구급상자, 항생제, 통조림 등). 나아질 데가 없으면 쓰지 않는다 */
export function useItem(ctx: ToolContext, item: string): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const player = state.characters[state.playerId]!;
  const name = content.items[item]?.name ?? item;
  const effects = content.scenario.consumables[item];
  if (!effects) return { ok: false, error: `${josa(name, "은/는")} 써서 몸이 나아지는 물건이 아니다 (가능: ${Object.keys(content.scenario.consumables).join(", ")}).` };
  if ((player.inventory[item] ?? 0) < 1) return { ok: false, error: `${josa(name, "이/가")} 없다.` };
  const needed = Object.keys(effects).some((t) => levelIndex(ctx, state, player.id, t) > 0);
  if (!needed) return { ok: false, error: `지금은 ${josa(name, "을/를")} 쓸 필요가 없다.` };
  store.append({ type: "item_consumed", holder: player.id, itemId: item, quantity: 1 });
  const lines = [`${josa(name, "을/를")} 썼다.`];
  const displays: ToolDisplayEvent[] = [];
  for (const [t, steps] of Object.entries(effects)) {
    const c = changeCondition(ctx, player.id, t, -steps, item, name);
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  return { ok: true, lines, displays };
}

/** 치료사에게 치료받는다 (하루 한 번). 아이템이면 useItem */
export function applyTreatment(ctx: ToolContext, item: string | null): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  if (item) return useItem(ctx, item);
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return { ok: false, error: "이 시나리오에는 치료 규칙이 없다." };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const healer = state.scene.present.find((id) => ctx.content.npcs[id]?.healer);
  if (!healer) return { ok: false, error: "치료해 줄 사람이 장면에 없다. 치료 아이템을 쓰거나 치료사를 찾아간다." };
  const needed = Object.entries(recovery.healer).some(([t, steps]) => steps > 0 && levelIndex(ctx, state, player.id, t) > 0);
  if (!needed) return { ok: false, error: "다친 데가 없어 치료할 것이 없다." };
  if (state.recovery.lastHealerDay[player.id] === dayOf(state.time)) return { ok: false, error: "오늘은 이미 치료를 받았다. 내일 다시 받을 수 있다." };
  const name = ctx.content.npcs[healer]!.name;
  const lines = [`${name}에게 치료를 받았다.`];
  const displays: ToolDisplayEvent[] = [];
  for (const [t, steps] of Object.entries(recovery.healer)) {
    const c = changeCondition(ctx, player.id, t, -steps, "healer", "치료");
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  return { ok: true, lines, displays };
}

/** 저절로 낫기 (부상 트랙). 시간이 흐른 뒤마다 부른다 */
export function runNaturalRecovery(ctx: ToolContext): ToolDisplayEvent[] {
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return [];
  const displays: ToolDisplayEvent[] = [];
  const track = harmTrack(ctx.content.scenario);
  const maxIndex = track.levels.findIndex((l) => l.id === recovery.natural_max_level);
  for (let guard = 0; guard < 5; guard++) {
    const state = ctx.store.getState();
    const player = state.characters[state.playerId];
    if (!player || player.dead) break;
    const index = levelIndex(ctx, state, player.id, track.id);
    if (index <= 0 || index > maxIndex) break;
    const since = state.recovery.lastChangeAt[player.id] ?? state.runStartedAt;
    if (state.time - since < recovery.natural_days * MINUTES_PER_DAY) break;
    const c = changeCondition(ctx, player.id, track.id, -1, "rest", "쉬면서 나음");
    if (c?.display) displays.push(c.display);
  }
  return displays;
}

/** 감염체에게 다쳤을 때 감염되는지 (선언한 위험의 크기에 따른 확률) */
export function maybeInfect(ctx: ToolContext, severity: HarmSeverity | "none"): Change | null {
  const infection = ctx.content.scenario.body?.infection;
  if (!infection || severity === "none") return null;
  const state = ctx.store.getState();
  if (levelIndex(ctx, state, state.playerId, infection.track) > 0) return null;
  if (ctx.rng() >= infection.chance[severity]) return null;
  return changeCondition(ctx, state.playerId, infection.track, 1, "infection", "감염체에게 입은 상처");
}

/**
 * 하루가 지날 때의 몸 (전쟁 틱과 함께 하루에 한 번):
 * - 허기: 우리 무리의 배급 수준만큼 바뀐다. 마지막 단계면 굶주림으로 부상
 * - 감염: 걸려 있으면 한 단계 나빠진다. 마지막 단계면 부상
 */
export function runDailyBody(ctx: ToolContext): ToolDisplayEvent[] {
  const { content } = ctx;
  const body = content.scenario.body;
  const war = content.scenario.war;
  if (!body) return [];
  const displays: ToolDisplayEvent[] = [];
  const push = (c: Change | null) => {
    if (c?.display) displays.push(c.display);
    return c?.died ?? false;
  };
  const player = () => ctx.store.getState().characters[ctx.store.getState().playerId];
  const harm = content.scenario.harm_track;

  if (body.hunger && war) {
    const state = ctx.store.getState();
    const own = state.factions[player()!.factionId];
    const level = own ? war.ration.levels.find((l) => daysOfStock(content, own, war.ration.resource) >= l.min_days) : undefined;
    const track = trackOf(content.scenario, body.hunger.track);
    let delta = level?.hunger ?? 1; // 배급을 받지 못하면 배가 고파진다
    if (delta > 0 && level?.hunger_max) {
      // 이 배급으로는 이 단계보다 더 배고파지지 않는다
      const cap = track.levels.findIndex((l) => l.id === level.hunger_max);
      delta = Math.max(0, Math.min(delta, cap - levelIndex(ctx, state, state.playerId, track.id)));
    }
    if (push(changeCondition(ctx, state.playerId, body.hunger.track, delta, "daily", delta < 0 ? `배급 (${level?.label ?? ""})` : `배급 부족 (${level?.label ?? "없음"})`))) return displays;
    if (levelIndex(ctx, ctx.store.getState(), state.playerId, track.id) === track.levels.length - 1 && body.hunger.starving_harm > 0) {
      if (push(changeCondition(ctx, state.playerId, harm, body.hunger.starving_harm, "daily", "굶주림"))) return displays;
    }
  }
  if (body.infection) {
    const state = ctx.store.getState();
    const track = trackOf(content.scenario, body.infection.track);
    const index = levelIndex(ctx, state, state.playerId, track.id);
    if (index > 0) {
      if (index < track.levels.length - 1) {
        push(changeCondition(ctx, state.playerId, track.id, 1, "infection", "감염이 퍼진다"));
      } else if (body.infection.worst_harm > 0) {
        if (push(changeCondition(ctx, state.playerId, harm, body.infection.worst_harm, "infection", "감염"))) return displays;
      }
    }
  }
  return displays;
}
