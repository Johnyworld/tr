import { onPersonDeath } from "./people.ts";
import { lightFire } from "./climate.ts";
import { hasAccess } from "../game/culture.ts";
import type { GameState } from "../game/state.ts";
import { playerCalls } from "../game/acquaintance.ts";
import type { Content } from "../content/schemas.ts";
import type { Character } from "../game/character.ts";
import { bodyTraits } from "./traits.ts";
import { dayOf, MINUTES_PER_DAY } from "../rules/time.ts";
import type { HarmSeverity } from "../rules/harm.ts";
import { harmTrack, shownLevel, trackOf } from "../scenario/scenario.ts";
import { daysOfStock, rationLevel } from "../sim/war.ts";
import { seasonAt } from "../sim/season.ts";
import { weatherNow } from "../sim/weather.ts";
import { josa } from "../text.ts";
import { recordDeath } from "./succession.ts";
import { bleedingBlocksRecovery, staunch, stopBleeding } from "./bleeding.ts";
import type { CheckOutcome } from "../rules/check.ts";
import { DEATH_GUIDE, type ToolContext, type ToolDisplayEvent } from "./toolkit.ts";

/**
 * 몸 상태 (기획서 4.4, 4.5): 부상 회복, 소모품, 허기, 감염. 수치는 시나리오(recovery, consumables, body)에서 온다.
 * - 사망은 상태 트랙의 fatal 단계로만 (원칙 3, 코드가 정한다). 부상 외에 허기·추위·감염도 끝까지 가면 죽는다 (12-74)
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
  // 이름 있는 인물이 죽으면 가족·친구가 듣는다 (기획서 7.10)
  if (to.fatal && characterId !== state.playerId) onPersonDeath(ctx, characterId, by);
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
export function useItem(ctx: ToolContext, item: string, targetId?: string | null): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const state = store.getState();
  const player = state.characters[state.playerId]!;
  const name = content.items[item]?.name ?? item;
  // 모닥불 연료 (12-98)
  const fire = lightFire(ctx, item);
  if (fire) return fire.ok ? { ok: true, lines: fire.lines, displays: [] } : fire;
  const effects = content.scenario.consumables[item];
  if (!effects) return { ok: false, error: `${josa(name, "은/는")} 써서 몸이 나아지는 물건이 아니다 (가능: ${Object.keys(content.scenario.consumables).join(", ")}).` };
  if ((player.inventory[item] ?? 0) < 1) return { ok: false, error: `${josa(name, "이/가")} 없다.` };
  // 다른 사람에게 쓴다 (12-52): 장면에 있는 살아 있는 사람만
  const target = targetId && targetId !== player.id ? targetId : player.id;
  if (target !== player.id && (!state.scene.present.includes(target) || state.characters[target]?.dead)) return { ok: false, error: "그 사람이 장면에 없다." };
  // 겉으로 드러난 것만 본다 (숨은 잠복기는 주인공도 모른다)
  const needed = Object.entries(effects).some(([t, n]) => n > 0 && shownIndex(ctx, state, target, t) > 0);
  if (!needed) return { ok: false, error: `지금은 ${josa(name, "을/를")} 쓸 필요가 없다.` };
  store.append({ type: "item_consumed", holder: player.id, itemId: item, quantity: 1 });
  const leftover = content.items[item]?.used_into;
  if (leftover) store.append({ type: "item_granted", to: player.id, itemId: leftover, quantity: 1 });
  const lines = [target === player.id ? `${josa(name, "을/를")} 썼다.` : `${playerCalls(state, content, target)}에게 ${josa(name, "을/를")} 썼다.`];
  const displays: ToolDisplayEvent[] = [];
  for (const [t, steps] of Object.entries(effects)) {
    const c = changeCondition(ctx, target, t, -steps, item, name);
    if (c?.line) lines.push(c.line);
    if (c?.display) displays.push(c.display);
  }
  return { ok: true, lines, displays };
}

/** 치료사에게 치료받는다 (하루 한 번). 아이템이면 useItem */
export function applyTreatment(
  ctx: ToolContext,
  item: string | null,
  targetId: string | null = null,
  check: { move: string; outcome: CheckOutcome } | null = null,
): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  if (item) return useItem(ctx, item, targetId);
  if (targetId && targetId !== ctx.store.getState().playerId) {
    // 남의 피를 맨손으로 멎게 한다 (12-91): 지혈 판정을 걸었으면 그것으로
    const w = ctx.content.scenario.wounds;
    const s = ctx.store.getState();
    if (w && check?.move === w.staunch_move && s.scene.present.includes(targetId) && levelIndex(ctx, s, targetId, w.track) > 0) return staunch(ctx, check, targetId);
    return firstAid(ctx, targetId);
  }
  const recovery = ctx.content.scenario.recovery;
  if (!recovery) return { ok: false, error: "이 시나리오에는 치료 규칙이 없다." };
  const state = ctx.store.getState();
  const player = state.characters[state.playerId]!;
  const healer = state.scene.present.find((id) => ctx.content.npcs[id]?.healer);
  if (!healer) {
    // 맨손 지혈 (12-91): 피가 나면 판정으로 멎게 한다
    const w = ctx.content.scenario.wounds;
    if (w && levelIndex(ctx, state, player.id, w.track) > 0) return staunch(ctx, check);
    return { ok: false, error: "치료해 줄 사람이 장면에 없다. 치료 아이템을 쓰거나 치료사를 찾아간다." };
  }
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
    // 피가 멎지 않으면 정신이 들지도, 저절로 낫지도 않는다 (12-91)
    if (bleedingBlocksRecovery(ctx, player)) break;
    const index = levelIndex(ctx, state, player.id, track.id);
    const since = state.recovery.lastChangeAt[player.id] ?? state.runStartedAt;
    // 의식불명 등: 그 단계에 wake_hours만큼 머물면 정신이 든다 (한 단계 나아진다)
    const out = track.levels[index]?.symptoms?.some((id) => ctx.content.scenario.symptoms?.find((x) => x.id === id)?.incapacitates);
    if (out && recovery.wake_hours !== undefined) {
      if (state.time - since < recovery.wake_hours * 60) break;
      const c = changeCondition(ctx, player.id, track.id, -1, "rest", "정신이 들었다");
      if (c?.display) displays.push(c.display);
      break;
    }
    if (index <= 0 || index > maxIndex) break;
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
    // 갇혀 있으면 우리 무리의 배급을 못 받는다 (붙잡은 쪽이 겨우 먹인다, 12-55)
    const captive = !!player()!.captive;
    const own = !captive && hasAccess(content, state, "ration") ? state.factions[player()!.factionId] : undefined;
    const level = own ? rationLevel(content, own) : undefined;
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
    const floor = captive && content.scenario.captivity?.hunger_floor ? track.levels.findIndex((l) => l.id === content.scenario.captivity!.hunger_floor) : -1;
    if (floor >= 0 && delta > 0) delta = Math.max(0, Math.min(delta, floor - levelIndex(ctx, state, state.playerId, track.id)));
    if (push(changeCondition(ctx, state.playerId, body.hunger.track, delta, "daily", captive ? "갇힌 곳의 끼니" : delta < 0 ? `배급 (${level?.label ?? ""})` : `배급 부족 (${level?.label ?? "없음"})`))) return displays;
    if (levelIndex(ctx, ctx.store.getState(), state.playerId, track.id) === track.levels.length - 1 && body.hunger.starving_harm > 0) {
      if (push(changeCondition(ctx, state.playerId, harm, body.hunger.starving_harm, "daily", "굶주림"))) return displays;
    }
  }
  if (body.thirst && push(dailyThirst(ctx, body.thirst))) return displays;
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
  // 기온이 있는 월드는 시간대마다 냉기를 쌓는다 (climate.ts, 12-98). 하루 단위 추위는 없는 월드만
  if (body.cold && !body.cold.climate) {
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
  if (body.nerves) displays.push(...runDailyNerves(ctx));
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

/**
 * NPC의 하루 몸 (기획서 7.7): 감염된 인물은 하루에 한 단계 나빠지고, 마지막 단계면 부상을 입는다 (죽을 수 있다, 코드가 정한다).
 * 장면에 있는 사람의 보이는 변화만 화면에 알린다
 */
export function runDailyNpcBody(ctx: ToolContext): ToolDisplayEvent[] {
  const infection = ctx.content.scenario.body?.infection;
  if (!infection) return [];
  const harm = ctx.content.scenario.harm_track;
  const track = trackOf(ctx.content.scenario, infection.track);
  const displays: ToolDisplayEvent[] = [];
  const start = ctx.store.getState();
  for (const c of Object.values(start.characters)) {
    if (c.id === start.playerId || c.dead || c.away) continue;
    const index = Math.max(0, track.levels.findIndex((l) => l.id === c.conditions[track.id]));
    if (index === 0) continue;
    const change =
      index < track.levels.length - 1
        ? changeCondition(ctx, c.id, track.id, 1, "infection", "감염이 퍼진다")
        : infection.worst_harm > 0
          ? changeCondition(ctx, c.id, harm, infection.worst_harm, "infection", "감염")
          : null;
    if (change?.display && ctx.store.getState().scene.present.includes(c.id)) displays.push(change.display);
  }
  return displays;
}

/** 지금 몸이 괴로운가 (질병에 걸리기 쉽고 낫기 어렵다): 굶주림·추위는 판정 보정이 있는 단계부터, 목마름은 무리의 물이 하루치보다 적을 때 */
/** 이 트랙 때문에 판정 보정 -2 이상을 받고 있는가 (굶주림, 오한) */
function severe(ctx: ToolContext, me: Character, trackId: string | undefined): boolean {
  if (!trackId) return false;
  const track = trackOf(ctx.content.scenario, trackId);
  return (track.levels.find((l) => l.id === me.conditions[trackId])?.penalty ?? 0) <= -2;
}

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
  const thirst = s.body?.thirst;
  const parched = (() => {
    if (!thirst?.suffering_from) return false;
    const track = trackOf(s, thirst.track);
    return track.levels.findIndex((l) => l.id === me.conditions[thirst.track]) >= track.levels.findIndex((l) => l.id === thirst.suffering_from);
  })();
  return {
    starving: hurting(s.body?.hunger?.track),
    cold: hurting(s.body?.cold?.track),
    thirst: thirst ? parched : !!thirstResource && !!own && daysOfStock(ctx.content, own, thirstResource) < 1,
  };
}

type ThirstRules = NonNullable<NonNullable<Content["scenario"]["body"]>["thirst"]>;

/**
 * 지금 있는 곳의 물 (12-97).
 * - spring: 물이 나는 바깥 구역(강·우물·정수장). 마음껏 마시고 채운다
 * - supply: 우리 거점(우리 땅이면서 거점). 무리의 물 보급을 받는다: 넉넉하면 full, 하루치도 안 남으면 limited(조금만), 바닥이거나 배급 권한이 없으면 refused
 */
export type WaterSource = { kind: "spring" | "supply"; grant: "full" | "limited" | "refused" };

export function waterHere(content: Content, state: GameState): WaterSource | null {
  const rules = content.scenario.body?.thirst;
  const me = state.characters[state.playerId];
  const zone = state.playerZone;
  if (!rules || !me || me.dead || me.captive || !zone) return null;
  const base = content.locations[zone]?.kind === "base" && state.zones[zone]?.owner === me.factionId;
  if (base) {
    const own = state.factions[me.factionId];
    if (!own || !hasAccess(content, state, "ration")) return { kind: "supply", grant: "refused" };
    const days = daysOfStock(content, own, rules.resource);
    return { kind: "supply", grant: days >= rules.min_days ? "full" : (own.resources[rules.resource] ?? 0) >= 1 ? "limited" : "refused" };
  }
  return (content.locations[zone]?.yields[rules.resource] ?? 0) > 0 ? { kind: "spring", grant: "full" } : null;
}

type WaterResult = { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string };

function waterSource(ctx: ToolContext): { rules: ThirstRules; source: WaterSource } | { error: string } {
  const rules = ctx.content.scenario.body?.thirst;
  if (!rules) return { error: "이 월드에는 갈증 규칙이 없다." };
  const source = waterHere(ctx.content, ctx.store.getState());
  if (!source) return { error: "여기에는 물이 없다. 물병을 쓰거나(use_item) 물이 나는 곳·우리 거점으로 간다." };
  if (source.grant === "refused") return { error: "물 보급을 거절당했다: 무리의 물이 바닥났거나 받을 자격이 없다. 보급 담당 NPC가 거절하는 장면으로 서술한다." };
  return { rules, source };
}

/** 물을 마신다 (take_action.drink). 거점에서 물이 모자라면 조금만 받는다 */
export function drinkWater(ctx: ToolContext): WaterResult {
  const w = waterSource(ctx);
  if ("error" in w) return { ok: false, error: w.error };
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  if (levelIndex(ctx, state, me.id, w.rules.track) <= 0) return { ok: false, error: "목이 마르지 않다." };
  const limited = w.source.grant === "limited";
  const c = changeCondition(ctx, me.id, w.rules.track, limited ? -1 : -w.rules.drink, "drink", w.source.kind === "spring" ? "물을 떠 마셨다" : limited ? "물 보급 (아껴서 조금만)" : "물 보급");
  const lines = [c?.line ?? "물을 마셨다."];
  if (limited) lines.push("물이 모자라 보급 담당이 한 모금만 나눠 줬다. 아끼는 기색으로 서술한다.");
  return { ok: true, lines, displays: c?.display ? [c.display] : [] };
}

/** 빈 물병을 채운다 (take_action.refill). 거점에서는 보급을 받으며 마시기까지 한다. 물이 모자라면 하나만 */
export function refillWater(ctx: ToolContext): WaterResult {
  const w = waterSource(ctx);
  if ("error" in w) return { ok: false, error: w.error };
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const limited = w.source.grant === "limited";
  const lines: string[] = [];
  const displays: ToolDisplayEvent[] = [];
  // 거점에서 보급을 받으면 그 자리에서 마시기까지 한다
  if (w.source.kind === "supply" && levelIndex(ctx, state, me.id, w.rules.track) > 0) {
    const d = drinkWater(ctx);
    if (d.ok) {
      lines.push(...d.lines);
      displays.push(...d.displays);
    }
  }
  let left = limited ? 1 : Infinity;
  for (const [empty, full] of Object.entries(w.rules.refill)) {
    const n = Math.min(left, me.inventory[empty] ?? 0);
    if (n <= 0) continue;
    left -= n;
    ctx.store.append({ type: "item_consumed", holder: me.id, itemId: empty, quantity: n });
    ctx.store.append({ type: "item_granted", to: me.id, itemId: full, quantity: n });
    lines.push(`${ctx.content.items[empty]?.name ?? empty} ${n}개를 채웠다.`);
  }
  if (!lines.length) return { ok: false, error: "채울 빈 그릇이 없다." };
  if (limited && lines.some((l) => l.includes("채웠다"))) lines.push("물이 모자라 보급 담당이 하나만 채워 줬다.");
  return { ok: true, lines, displays };
}

/** 하루의 갈증 (12-97). 끝 단계(fatal)에 이르면 changeCondition이 죽음을 처리한다 */
function dailyThirst(ctx: ToolContext, rules: ThirstRules): Change | null {
  const state = ctx.store.getState();
  const me = state.characters[state.playerId]!;
  const track = trackOf(ctx.content.scenario, rules.track);
  let delta = rules.daily;
  if (me.captive && rules.captive_max) delta = Math.max(0, Math.min(delta, track.levels.findIndex((l) => l.id === rules.captive_max) - levelIndex(ctx, state, me.id, track.id)));
  return changeCondition(ctx, me.id, track.id, delta, "daily", me.captive ? "갇힌 곳의 물" : "하루가 지나 목이 마르다");
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

/**
 * 마음이 흔들린다 (12-48): 크게 다쳤거나 곁의 사람이 죽는 것을 봤을 때. 냉정이 높으면 확률로 버틴다.
 * 바뀐 한 줄을 돌려준다 (GM이 서술에 반영한다)
 */
export function shakeNerves(ctx: ToolContext, steps: number, cause: string): Change | null {
  const nerves = ctx.content.scenario.body?.nerves;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !me || me.dead || steps <= 0) return null;
  const hold = Math.min(0.8, Math.max(0, nerves.resist.per_point * (me.stats[nerves.resist.ability] ?? 0)));
  if (ctx.rng() < hold) return null; // 버텼다
  return changeCondition(ctx, me.id, nerves.track, steps, "nerves", cause);
}

/**
 * 하루마다 마음이 가라앉는다: 굶주리거나 얼지 않으면 확률로, 우리 땅이거나 곁에 사람이 있으면 더 잘 (떠돌이도 천천히 낫는다).
 * 막는 것은 굶주림·오한(보정 -2) 이상만이다. 허기짐·추움(-1)으로는 막지 않는다
 */
export function runDailyNerves(ctx: ToolContext): ToolDisplayEvent[] {
  const nerves = ctx.content.scenario.body?.nerves;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !me || me.dead) return [];
  if (levelIndex(ctx, state, me.id, nerves.track) <= 0) return [];
  if (severe(ctx, me, ctx.content.scenario.body?.hunger?.track) || severe(ctx, me, ctx.content.scenario.body?.cold?.track)) return [];
  const { mine, company } = safety(state, me);
  const chance = nerves.recover.chance + nerves.recover.per_point * (me.stats[nerves.resist.ability] ?? 0) + (mine || company ? nerves.recover.safe : 0);
  if (ctx.rng() >= chance) return [];
  const c = changeCondition(ctx, me.id, nerves.track, -1, "nerves", mine ? "익숙한 담 안에서 하루를 보냈다" : company ? "곁에 사람이 있었다" : "하루를 버텨 냈다");
  return c?.display ? [c.display] : [];
}

/** 마음이 쉬는 곳: 우리 땅이거나 곁에 동행이 있다 */
function safety(state: GameState, me: Character): { mine: boolean; company: boolean } {
  return {
    mine: !!state.playerZone && !!me.factionId && state.zones[state.playerZone]?.owner === me.factionId,
    company: state.companions.length > 0,
  };
}

/**
 * 푹 자고 나면 마음이 가라앉을 기회 (body.nerves.sleep). take_action이 끊기지 않은 잠 뒤에 부른다.
 * slept: 실제로 잔 분. min_hours보다 짧으면 없다
 */
export function sleepNerves(ctx: ToolContext, slept: number): Change | null {
  const nerves = ctx.content.scenario.body?.nerves;
  const rule = nerves?.sleep;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!nerves || !rule || !me || me.dead || slept < rule.min_hours * 60) return null;
  if (levelIndex(ctx, state, me.id, nerves.track) <= 0) return null;
  if (severe(ctx, me, ctx.content.scenario.body?.hunger?.track) || severe(ctx, me, ctx.content.scenario.body?.cold?.track)) return null;
  const { mine, company } = safety(state, me);
  const chance = (mine || company ? rule.safe : rule.unsafe) + nerves.recover.per_point * (me.stats[nerves.resist.ability] ?? 0);
  if (ctx.rng() >= chance) return null;
  return changeCondition(ctx, me.id, nerves.track, -1, "nerves", mine ? "익숙한 담 안에서 푹 잤다" : company ? "곁에 사람을 두고 푹 잤다" : "모처럼 푹 잤다");
}

/**
 * 주인공이 아이템 없이 다른 사람을 돌본다 (12-52): 의무병이거나 응급처치를 익힌 사람만. 한 사람에게 하루 한 번, 부상 한 단계
 */
function firstAid(ctx: ToolContext, targetId: string): { ok: true; lines: string[]; displays: ToolDisplayEvent[] } | { ok: false; error: string } {
  const { store, content } = ctx;
  const rule = content.scenario.recovery?.first_aid;
  const state = store.getState();
  const me = state.characters[state.playerId]!;
  const target = state.characters[targetId];
  if (!rule) return { ok: false, error: "이 월드에서는 아이템 없이 남을 치료할 수 없다." };
  if (!target || target.dead || !state.scene.present.includes(targetId)) return { ok: false, error: "그 사람이 장면에 없다." };
  const skilled = (!!me.occupation && rule.occupations.includes(me.occupation.id)) || (me.skills[rule.skill] ?? -9) >= rule.min;
  if (!skilled) return { ok: false, error: "아이템 없이 남을 꿰매고 돌볼 줄 모른다. 치료 아이템을 쓰거나 치료사를 데려온다." };
  const harm = harmTrack(content.scenario);
  // 치료할 줄 알면 피부터 멎게 한다 (12-91)
  const staunched = stopBleeding(ctx, targetId, `${me.name}의 지혈`);
  if (shownIndex(ctx, state, targetId, harm.id) <= 0 || state.recovery.lastHealerDay[targetId] === dayOf(state.time)) {
    if (staunched.length) return { ok: true, lines: [`${playerCalls(state, content, targetId)}의 피를 멎게 했다.`], displays: staunched };
    return { ok: false, error: shownIndex(ctx, state, targetId, harm.id) <= 0 ? "그 사람은 다친 데가 없다." : "그 사람은 오늘 이미 치료를 받았다." };
  }
  const c = changeCondition(ctx, targetId, harm.id, -1, "healer", `${me.name}의 치료`);
  return { ok: true, lines: [`${playerCalls(state, content, targetId)}의 상처를 돌봤다.`, ...(c?.line ? [c.line] : [])], displays: [...staunched, ...(c?.display ? [c.display] : [])] };
}

/**
 * NPC가 낫는다 (12-52): 하루마다.
 * - 저절로: 주인공과 같은 규칙 (새 부상 없이 natural_days가 지나면 한 단계, natural_max_level까지). 붙잡힌 사람은 낫지 않는다
 * - 무리의 돌봄: 무리에 의무병(faction_care.occupation)이 있으면 무리의 의약품을 써서 가장 많이 다친 사람부터 돌본다. 드러난 감염도 뗀다
 * 장면에 있는 사람의 보이는 변화만 화면에 알린다
 */
export function runNpcRecovery(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const recovery = content.scenario.recovery;
  if (!recovery) return [];
  const displays: ToolDisplayEvent[] = [];
  const show = (c: Change | null, id: string) => {
    if (c?.display && store.getState().scene.present.includes(id)) displays.push(c.display);
  };
  const harm = harmTrack(content.scenario);
  const maxIndex = harm.levels.findIndex((l) => l.id === recovery.natural_max_level);
  const npcs = () => Object.values(store.getState().characters).filter((c) => c.id !== store.getState().playerId && !c.dead && !c.away);
  for (const c of npcs()) {
    if (c.captive) continue;
    // 피가 멎지 않으면 저절로 낫지 않는다 (12-91)
    if (bleedingBlocksRecovery(ctx, c)) continue;
    const state = store.getState();
    const index = harm.levels.findIndex((l) => l.id === c.conditions[harm.id]);
    if (index <= 0 || index > maxIndex) continue;
    const since = state.recovery.lastChangeAt[c.id] ?? 0;
    if (state.time - since < recovery.natural_days * MINUTES_PER_DAY) continue;
    show(changeCondition(ctx, c.id, harm.id, -1, "rest", "쉬면서 나음"), c.id);
  }
  const care = recovery.faction_care;
  const infection = content.scenario.body?.infection;
  if (!care) return displays;
  for (const factionId of Object.keys(store.getState().factions)) {
    const members = npcs().filter((c) => c.factionId === factionId && !c.captive);
    const medics = members.filter((c) => !!c.occupation && care.occupations.includes(c.occupation.id) && !isIncapacitated(content, c)).length;
    let slots = medics * care.per_medic;
    if (slots === 0) continue;
    const severity = (c: (typeof members)[number]) => harm.levels.findIndex((l) => l.id === c.conditions[harm.id]);
    for (const c of [...members].sort((a, b) => severity(b) - severity(a) || a.id.localeCompare(b.id))) {
      if (slots <= 0) break;
      const stock = () => store.getState().factions[factionId]?.resources[care.resource] ?? 0;
      let treated = false;
      if (severity(c) > 0 && stock() >= 1) {
        store.append({ type: "faction_resource_changed", factionId, resource: care.resource, delta: -1 });
        show(changeCondition(ctx, c.id, harm.id, -1, "healer", "무리 의무실의 치료"), c.id);
        treated = true;
      }
      // 드러난 감염 (잠복은 의무병도 모른다)
      if (infection) {
        const t = trackOf(content.scenario, infection.track);
        const at = t.levels.findIndex((l) => l.id === store.getState().characters[c.id]!.conditions[t.id]);
        if (at > 0 && !t.levels[at]!.hidden && stock() >= care.infection_cost) {
          store.append({ type: "faction_resource_changed", factionId, resource: care.resource, delta: -care.infection_cost });
          show(changeCondition(ctx, c.id, t.id, -at, "healer", "무리 의무실의 약"), c.id);
          treated = true;
        }
      }
      if (treated) slots--;
    }
  }
  return displays;
}
