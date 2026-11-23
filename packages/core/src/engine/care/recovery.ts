/** 치료 (recovery): engine/body.ts에서 떼어 냈다 (docs/design.md 12-236) */
import { heldOf, inQuarantine } from "../../rules/held.ts";
import { policyEffects } from "../../sim/war.ts";
import { fatigueBlocksRecovery } from "../fatigue.ts";
import type { GameState } from "../../game/state.ts";
import type { Content } from "../../content/schemas.ts";
import type { Character } from "../../game/character.ts";
import { bodyTraits } from "../traits.ts";
import { dayOf, MINUTES_PER_DAY } from "../../rules/time.ts";
import { harmTrack } from "../../scenario/scenario.ts";
import { bleedingBlocksRecovery } from "../bleeding.ts";
import { type ToolContext, type ToolDisplayEvent } from "../toolkit.ts";
import { changeCondition, isIncapacitated, type Change, levelIndex } from "../body.ts";
import { quarantineAfterCare } from "./quarantine.ts";
import { careUsedToday } from "./slots.ts";
import { canOperate, needsSurgery, operate, surgeonRoll } from "./surgery.ts";
import { whereIs } from "../../rules/place.ts";
import { playerCalls } from "../../game/acquaintance.ts";
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
    // 푹 잔 밤에 낫는 규칙이 있으면 그것으로만 (healFromSleep)
    if (recovery.sleep_heal) break;
    // 지친 동안은 저절로 낫지 않는다 (12-115). 자고 나면 밀린 만큼 낫는다
    if (fatigueBlocksRecovery(ctx.content, player)) break;
    const days = Math.max(1, recovery.natural_days + bodyTraits(ctx.content, player).recoveryDays);
    if (state.time - since < days * MINUTES_PER_DAY) break;
    const c = changeCondition(ctx, player.id, track.id, -1, "rest", "시간이 지나 아물었다");
    if (c?.display) displays.push(c.display);
  }
  return displays;
}

/**
 * 푹 잔 밤에 낫는다 (플레이 테스트 11, A1, recovery.sleep_heal): from~to 동안 잤으면 부른다.
 * min_hours 이상 잤고, 피가 멎어 있고, 자는 사이 새로 다치지 않았으면 max_level까지 한 단계. slow 단계는 마지막 변화에서 그만큼 지나야
 */
/** 푹 잤는데 상처가 아물지 않은 까닭 (플레이 테스트 13: 갇힌 동안 잠을 자도 그대로인데 까닭이 보이지 않았다). 아물었거나 다치지 않았으면 null */
export function sleepHealBlocker(ctx: ToolContext, from: number, to: number): string | null {
  const rule = ctx.content.scenario.recovery?.sleep_heal;
  if (!rule) return null;
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead) return null;
  const track = harmTrack(ctx.content.scenario);
  const index = levelIndex(ctx, state, me.id, track.id);
  if (index <= 0) return null;
  if (to - from < rule.min_hours * 60) return `${rule.min_hours}시간 넘게 자지 못해 상처가 아물지 않았다.`;
  if (bleedingBlocksRecovery(ctx, me)) return "피가 멎지 않아 상처가 아물지 않았다.";
  const max = track.levels.findIndex((l) => l.id === rule.max_level);
  if (index > max) return "이만한 상처는 잠만으로 아물지 않는다. 치료사의 치료나 수술이 있어야 한다.";
  const since = state.recovery.lastChangeAt[me.id] ?? state.runStartedAt;
  if (since > from) return "자는 사이 상처가 바뀌어 아물지 않았다.";
  const slow = rule.slow[track.levels[index]!.id];
  if (slow !== undefined && dayOf(to) - dayOf(since) < slow) return `이 상처는 마지막으로 바뀐 뒤 ${slow}일은 지나야 자고 나서 한 단계 아문다.`;
  return null;
}

export function healFromSleep(ctx: ToolContext, from: number, to: number): ToolDisplayEvent[] {
  const rule = ctx.content.scenario.recovery?.sleep_heal;
  if (!rule || to - from < rule.min_hours * 60) return [];
  const state = ctx.store.getState();
  const me = state.characters[state.playerId];
  if (!me || me.dead || bleedingBlocksRecovery(ctx, me)) return [];
  const track = harmTrack(ctx.content.scenario);
  const index = levelIndex(ctx, state, me.id, track.id);
  const max = track.levels.findIndex((l) => l.id === rule.max_level);
  if (index <= 0 || index > max) return [];
  const since = state.recovery.lastChangeAt[me.id] ?? state.runStartedAt;
  if (since > from) return []; // 자는 사이 다쳤다
  const slow = rule.slow[track.levels[index]!.id];
  // 날짜로 센다: 1일차에 다쳤으면 3일차 아침에 깬 잠에서 아문다 (12-266, 분으로 세면 04:00에 깨어 하룻밤 더 걸렸다)
  if (slow !== undefined && dayOf(to) - dayOf(since) < slow) return [];
  const c = changeCondition(ctx, me.id, track.id, -1, "rest", "푹 자고 나니 상처가 조금 아물었다");
  return c?.display ? [c.display] : [];
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
    if (heldOf(c)) continue;
    // 피가 멎지 않으면 저절로 낫지 않는다 (12-91)
    if (bleedingBlocksRecovery(ctx, c)) continue;
    const state = store.getState();
    const index = harm.levels.findIndex((l) => l.id === c.conditions[harm.id]);
    if (index <= 0 || index > maxIndex) continue;
    const since = state.recovery.lastChangeAt[c.id] ?? 0;
    if (state.time - since < recovery.natural_days * MINUTES_PER_DAY) continue;
    show(changeCondition(ctx, c.id, harm.id, -1, "rest", "시간이 지나 아물었다"), c.id);
  }
  const care = recovery.faction_care;
  if (!care) return displays;
  for (const factionId of Object.keys(store.getState().factions)) {
    const members = npcs().filter((c) => c.factionId === factionId && !heldOf(c));
    const medics = members.filter((c) => !!c.occupation && care.occupations.includes(c.occupation.id) && !isIncapacitated(content, c)).length;
    // 분배 (12-128): 의약품을 아끼면 덜, 아낌없이 쓰면 더 돌본다
    let slots = Math.round(medics * care.per_medic * policyEffects(content, store.getState().factions[factionId]).care);
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
        // 감염체에게 다친 상처를 무리 의무실이 보면 격리한다 (12-238)
        if (c.id === store.getState().playerId) quarantineAfterCare(ctx, factionId);
      }
      if (treated) slots--;
    }
  }
  return displays;
}

/**
 * 붙잡은 쪽의 치료 (12-263, PT17 졸병: 적의 수용소에서 상처가 끝내 아물지 않아 탈출 판정이 -8까지 갔다).
 * 쓸 데 있는 포로는 살려 둔다: 붙잡은 무리의 치료사(갇힌 구역의 사람 먼저)가 하루 한 번 주인공을 돌본다.
 * 치료사의 치료와 같은 규칙이다: 부상 한 단계 (수술감이면 수술할 줄 아는 사람만, 그 무리 땅이라 실패해도 덧나지 않는다), 붙잡은 무리의 의약품 1.
 * 그 무리에 치료사가 없거나 의약품이 떨어졌으면 돌보지 않는다 (피는 bleeding의 "붙잡은 쪽이 상처를 묶었다"가 멎게 한다)
 */
export function runCaptorCare(ctx: ToolContext): ToolDisplayEvent[] {
  const { store, content } = ctx;
  const recovery = content.scenario.recovery;
  const state = store.getState();
  const me = state.characters[state.playerId];
  const held = heldOf(me);
  if (!recovery || !me || me.dead || !held || inQuarantine(me)) return [];
  const harm = harmTrack(content.scenario);
  if (levelIndex(ctx, state, me.id, harm.id) <= 0 || careUsedToday(state, content, me.id, "healer")) return [];
  // 갇힌 구역의 치료사 먼저, 없으면 그 무리의 다른 치료사를 불러온다 (붉은연합의 치료사는 물류창고에 있다)
  const near = (id: string) => (whereIs(state, content, id)?.zone === state.playerZone ? 0 : 1);
  const healers = Object.values(content.npcs)
    .filter((n) => n.healer && state.characters[n.id]?.factionId === held.by && !state.characters[n.id]?.dead && !heldOf(state.characters[n.id]))
    .map((n) => n.id)
    .sort((a, b) => near(a) - near(b));
  const cutting = needsSurgery(ctx, me.id);
  const healer = cutting ? (healers.find((id) => canOperate(ctx, id)) ?? null) : (healers[0] ?? null);
  const resource = recovery.healer_cost?.resource ?? recovery.faction_care?.resource;
  if (!healer || (resource && (state.factions[held.by]?.resources[resource] ?? 0) < 1)) return [];
  if (resource) store.append({ type: "faction_resource_changed", factionId: held.by, resource, delta: -1 });
  if (cutting) return operate(ctx, me.id, surgeonRoll(ctx, healer).outcome, `붙잡은 쪽 치료사 ${playerCalls(state, content, healer)}`, true).displays;
  const c = changeCondition(ctx, me.id, harm.id, -1, "healer", `붙잡은 쪽 치료사 ${playerCalls(state, content, healer)}의 치료 (쓸 데 있는 포로는 살려 둔다)`);
  return c?.display ? [c.display] : [];
}
