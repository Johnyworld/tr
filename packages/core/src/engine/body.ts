import { hasAccess } from "../game/culture.ts";
import type { GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { bodyTraits } from "./traits.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import type { HarmSeverity } from "../rules/harm.ts";
import { harmTrack, shownLevel, trackOf } from "../scenario/scenario.ts";
import { daysOfStock } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { josa } from "../text.ts";
import { recordDeath } from "./succession.ts";
import { DEATH_GUIDE, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

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
  const called = playerCalls(state, ctx.content, characterId);
  return {
    line: `${called}의 ${track.label}: ${shownFrom.label} → ${shownTo.label} (${cause}).${to.fatal && characterId === state.playerId ? DEATH_GUIDE : ""}`,
    display: better
      ? { type: "heal", targetName: called, trackLabel: track.label, fromLabel: shownFrom.label, toLabel: shownTo.label, byLabel: cause }
      : { type: "harm", targetName: called, trackLabel: track.label, severityLabel: cause, fatal: to.fatal === true, fromLabel: shownFrom.label, toLabel: shownTo.label, cause },
    died: to.fatal === true,
  };
}

function levelIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return Math.max(0, track.levels.findIndex((l) => l.id === state.characters[characterId]?.conditions[trackId]));
}

/** 캐릭터가 아는 단계의 위치 (숨은 단계는 그 앞의 보이는 단계로). 쓸 필요가 있는지를 이걸로 정해야 잠복기가 새지 않는다 */
function shownIndex(ctx: ToolContext, state: GameState, characterId: string, trackId: string) {
  const track = trackOf(ctx.content.scenario, trackId);
  return track.levels.indexOf(shownLevel(track, state.characters[characterId]?.conditions[trackId] ?? track.levels[0]!.id));
}

/** 무력화됐는지 (부상이 scenario.combat.incapacitated_at 이상이거나 사망). 규칙이 없으면 사망만 */
export function isIncapacitated(content: Content, c: Character): boolean {
  if (c.dead) return true;
  const at = content.scenario.combat?.incapacitated_at;
  if (!at) return false;
  const track = harmTrack(content.scenario);
  return track.levels.findIndex((l) => l.id === c.conditions[track.id]) >= track.levels.findIndex((l) => l.id === at);
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
  const needed = Object.keys(effects).some((t) => shownIndex(ctx, state, player.id, t) > 0);
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
  const needed = Object.entries(recovery.healer).some(([t, steps]) => steps > 0 && shownIndex(ctx, state, player.id, t) > 0);
  if (!needed) return { ok: false, error: "다친 데가 없어 치료할 것이 없다." };
  if (state.recovery.lastHealerDay[player.id] === dayOf(state.time)) return { ok: false, error: "오늘은 이미 치료를 받았다. 내일 다시 받을 수 있다." };
  const name = playerCalls(state, ctx.content, healer);
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
    const days = Math.max(1, recovery.natural_days + bodyTraits(ctx.content, player).recoveryDays);
    if (state.time - since < days * MINUTES_PER_DAY) break;
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
  const me = state.characters[state.playerId];
  const factor = me ? bodyTraits(ctx.content, me).infection : 1;
  if (ctx.rng() >= Math.min(1, infection.chance[severity] * factor)) return null;
  return changeCondition(ctx, state.playerId, infection.track, 1, "infection", "감염체에게 입은 상처");
}

/**
 * 하루가 지날 때의 몸 (전쟁 틱과 함께 하루에 한 번):
 * - 허기: 우리 무리의 배급 수준만큼 바뀐다. 마지막 단계면 굶주림으로 부상
 * - 감염: 걸려 있으면 한 단계 나빠진다. 마지막 단계면 부상
 * - 추위: 계절·날씨만큼 (거점의 불, 방한 장비가 막는다). 마지막 단계면 부상
 * - 질병: 확률로 걸리고(잠복), 드러나고, 배부르고 따뜻하면 확률로 낫고 아니면 깊어진다. 마지막 단계면 부상
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
    // 배급 권한이 있어야 무리의 배급을 받는다 (역할의 access, 기획서 9.9)
    const own = hasAccess(content, state, "ration") ? state.factions[player()!.factionId] : undefined;
    const level = own ? war.ration.levels.find((l) => daysOfStock(content, own, war.ration.resource) >= l.min_days) : undefined;
    const track = trackOf(content.scenario, body.hunger.track);
    let delta = level?.hunger ?? 1; // 배급을 받지 못하면 배가 고파진다
    if (delta > 0 && level?.hunger_max) {
      // 이 배급으로는 이 단계보다 더 배고파지지 않는다
      const cap = track.levels.findIndex((l) => l.id === level.hunger_max);
      delta = Math.max(0, Math.min(delta, cap - levelIndex(ctx, state, state.playerId, track.id)));
    }
    // 트레잇: 정량이 아니면 대식가는 더, 소식가는 덜 배고파진다
    const hungerTrait = bodyTraits(content, player()!).hunger;
    if (hungerTrait !== 0 && level !== war.ration.levels[0]) delta = Math.max(0, delta + hungerTrait);
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
  if (body.cold) {
    const cold = body.cold;
    const state = ctx.store.getState();
    const me = player()!;
    const delta = dailyCold(ctx, state);
    if (push(changeCondition(ctx, me.id, cold.track, delta.steps, "cold", delta.cause))) return displays;
    const track = trackOf(content.scenario, cold.track);
    if (delta.steps >= 0 && levelIndex(ctx, ctx.store.getState(), me.id, track.id) === track.levels.length - 1 && cold.worst_harm > 0) {
      if (push(changeCondition(ctx, me.id, harm, cold.worst_harm, "cold", "저체온"))) return displays;
    }
  }
  if (body.disease) {
    const disease = body.disease;
    const state = ctx.store.getState();
    const me = player()!;
    const track = trackOf(content.scenario, disease.track);
    const index = levelIndex(ctx, state, me.id, track.id);
    const vitality = me.stats[disease.resist.ability] ?? 0;
    const suffering = sufferingOf(ctx, state);
    if (index === 0) {
      let chance = disease.chance.base;
      if (suffering.starving) chance += disease.chance.starving;
      if (suffering.cold) chance += disease.chance.cold;
      if (suffering.thirst) chance += disease.chance.thirst;
      chance *= Math.max(0.1, 1 - disease.resist.per_point * vitality);
      chance *= bodyTraits(content, me).disease;
      if (ctx.rng() < chance) push(changeCondition(ctx, me.id, track.id, 1, "disease", "병에 걸렸다"));
    } else if (track.levels[index]!.hidden) {
      push(changeCondition(ctx, me.id, track.id, 1, "disease", "병이 드러났다"));
    } else {
      const resting = !suffering.starving && !suffering.cold;
      const recover = resting ? Math.max(0, disease.recover.chance + disease.recover.per_point * vitality) : 0;
      const roll = ctx.rng();
      if (roll < recover) {
        // 나으면 숨은 단계를 건너뛰고 한 단계씩 (위중 → 앓음 → 없음)
        const steps = track.levels[index - 1]?.hidden ? -2 : -1;
        push(changeCondition(ctx, me.id, track.id, steps, "disease", "몸이 이겨 냈다"));
      } else if (index < track.levels.length - 1) {
        if (roll < recover + disease.worsen) push(changeCondition(ctx, me.id, track.id, 1, "disease", "병이 깊어진다"));
      } else if (disease.worst_harm > 0) {
        if (push(changeCondition(ctx, me.id, harm, disease.worst_harm, "disease", "병"))) return displays;
      }
    }
  }
  return displays;
}

/** 지금 몸이 괴로운가 (질병에 걸리기 쉽고 낫기 어렵다): 굶주림·추위는 판정 보정이 있는 단계부터, 목마름은 무리의 물이 하루치보다 적을 때 */
function sufferingOf(ctx: ToolContext, state: GameState): { starving: boolean; cold: boolean; thirst: boolean } {
  const s = ctx.content.scenario;
  const me = state.characters[state.playerId]!;
  const hurting = (trackId: string | undefined) => {
    if (!trackId) return false;
    const track = trackOf(s, trackId);
    return (track.levels.find((l) => l.id === me.conditions[trackId])?.penalty ?? 0) < 0;
  };
  const own = state.factions[me.factionId];
  const thirstResource = s.body?.disease?.thirst_resource;
  return {
    starving: hurting(s.body?.hunger?.track),
    cold: hurting(s.body?.cold?.track),
    thirst: !!thirstResource && !!own && daysOfStock(ctx.content, own, thirstResource) < 1,
  };
}

/** 우리 거점에서 무리의 연료로 몸을 녹일 수 있는가 */
export function sheltered(ctx: ToolContext, state: GameState): boolean {
  const cold = ctx.content.scenario.body?.cold;
  const me = state.characters[state.playerId];
  if (!cold || !me || !state.playerZone) return false;
  if (state.zones[state.playerZone]?.owner !== me.factionId) return false;
  const own = state.factions[me.factionId];
  return !!own && daysOfStock(ctx.content, own, cold.shelter.resource) >= cold.shelter.min_days;
}

/** 오늘의 추위: 양수면 그만큼 추워지고, 음수면 몸이 녹는다 */
export function dailyCold(ctx: ToolContext, state: GameState): { steps: number; cause: string } {
  const s = ctx.content.scenario;
  const cold = s.body!.cold!;
  if (sheltered(ctx, state)) return { steps: cold.shelter.warm, cause: "불을 땐 거처" };
  const season = seasonAt(s, state.time);
  const weather = weatherNow(s, state);
  const exposure = (season ? (cold.season[season.id] ?? 0) : 0) + (weather ? (cold.weather[weather.id] ?? 0) : 0);
  const me = state.characters[state.playerId]!;
  const gear = Object.entries(cold.gear).reduce((n, [item, amount]) => n + ((me.inventory[item] ?? 0) > 0 ? amount : 0), 0);
  // 트레잇: 추운 날에만 더하거나 덜한다 (추위를 탐 +1, 추위에 강함 -1)
  const steps = Math.max(0, exposure - gear + (exposure > 0 ? bodyTraits(ctx.content, me).cold : 0));
  if (steps === 0) return { steps: -1, cause: exposure > 0 ? "방한 장비" : "견딜 만한 날씨" };
  return { steps, cause: [season && cold.season[season.id] ? season.label : null, weather && cold.weather[weather.id] ? weather.label : null].filter(Boolean).join(", ") + "의 추위" };
}
