import { maybeCaptureAfterDefeat } from "./captivity.ts";
import type { Content } from "../content/schemas.ts";
import { gainMeritXp } from "./growth.ts";
import { BELIEF_SOURCE_LABELS } from "../game/belief.ts";
import type { BattleState, Clash, GameState, PendingClash } from "../game/state.ts";
import { formatTime, MINUTES_PER_DAY } from "../rules/time.ts";
import type { CheckOutcome } from "../rules/check.ts";
import type { Rng } from "../rng.ts";
import {
  battleConfig,
  battleMerit,
  effectBlocker,
  finishWithoutPlayer,
  moraleOf,
  resolveRound,
  startBattle,
  wonBy,
  type BattleEffect,
} from "../sim/battle.ts";
import { applyBattleOutcome, neighbors, resolveClash, type ClashSpec } from "../sim/war.ts";
import { josa } from "../text.ts";
import { recordDeed } from "./reputationTools.ts";
import type { ToolContext, ToolDisplayEvent } from "./toolkit.ts";
import { describeClash, WAR_TOPIC } from "./warTools.ts";
import { endActiveStorylet } from "./storyletTools.ts";

/**
 * 전투 장면 연결 (기획서 9.5).
 * - 하루 틱에서 플레이어가 낄 교전은 그날 새벽으로 예정한다 (예정은 플레이어도 GM도 모른다)
 * - 예정 시각에 그 자리에 있으면 전투 장면을 열고, 없으면 화면 밖에서 계산한다
 * - 전투 중 take_action 한 번이 한 라운드다
 */

/** 예정 시각: 그날 04:00 ~ 05:30 */
export const BATTLE_WINDOW = { startMinute: 240, spread: 90 } as const;

export function scheduleTime(day: number, rng: Rng): number {
  return (day - 1) * MINUTES_PER_DAY + BATTLE_WINDOW.startMinute + Math.floor(rng() * (BATTLE_WINDOW.spread + 1));
}

/** 플레이어가 이 교전에 끼는지: 방어(그 구역에 있다) / 공격(맞닿은 우리 구역에 있다) */
export function playerInvolvement(state: GameState, content: Content, spec: ClashSpec): "attack" | "defense" | null {
  if (!content.scenario.battle) return null;
  const player = state.characters[state.playerId];
  const zone = state.playerZone;
  // 갇혀 있으면 싸움에 끼지 않는다 (12-55)
  if (!player || player.dead || player.captive || !zone || state.battle) return null;
  if (spec.defender === player.factionId && zone === spec.zone) return "defense";
  if (spec.attacker === player.factionId && state.zones[zone]?.owner === player.factionId && neighbors(content, spec.zone).includes(zone)) {
    return "attack";
  }
  return null;
}

/** 예정 시각이 된 교전: 그 자리에 있으면 전투 장면, 아니면 화면 밖에서 계산 */
export function runPendingClashes(ctx: ToolContext): ToolDisplayEvent[] {
  const displays: ToolDisplayEvent[] = [];
  for (;;) {
    const state = ctx.store.getState();
    const due = state.pendingClashes.filter((p) => p.at <= state.time).sort((a, b) => a.at - b.at)[0];
    if (!due) return displays;
    const side = playerInvolvement(state, ctx.content, due);
    if (side) {
      // 전투가 벌어지면 진행 중이던 이야기는 끝난다
      displays.push(...endActiveStorylet(ctx, "전투가 벌어졌다"));
      const battle = startBattle(ctx.content, ctx.store.getState(), due, side, { id: due.id, at: state.time });
      ctx.store.append({ type: "battle_started", pendingId: due.id, battle });
      displays.push({ type: "battle", event: "started", title: battleTitle(ctx.content, battle), detail: describeStart(ctx.content, battle) });
      return displays;
    }
    const { world, clash } = resolveClash(state, ctx.content, ctx.rng, due);
    ctx.store.append({ type: "clash_resolved", pendingId: due.id, clash, factions: world.factions, zones: world.zones });
    displays.push(...reportClash(ctx, clash));
  }
}

export type BattleTurn = {
  lines: string[];
  displays: ToolDisplayEvent[];
};

/** take_action.battle 입력 검사. 문제가 있으면 오류 문장 */
export function validateBattleAction(
  ctx: ToolContext,
  input: { effect: string; objective: string | null } | null,
): { effect: BattleEffect; objective: string | null } | null | string {
  const state = ctx.store.getState();
  if (!input) return null;
  if (!state.battle) return "지금은 전투 중이 아니다. battle은 null로 둔다.";
  const config = battleConfig(ctx.content);
  const effect = config.effects.find((e) => e.id === input.effect);
  if (!effect) return `알 수 없는 전투 효과: ${input.effect} (가능: ${config.effects.map((e) => e.id).join(", ")})`;
  const player = state.characters[state.playerId]!;
  const blocker = effectBlocker(effect, state.battle, { items: player.inventory, preparations: state.preparations[state.battle.zone] ?? [] });
  if (blocker) return `${effect.label}: ${blocker}`;
  if (input.objective && !state.battle.objectives.includes(input.objective)) return `남은 목표물이 아니다: ${input.objective}`;
  return { effect, objective: input.objective };
}

/** 전투 한 라운드를 진행한다. 판정은 이미 끝났다 (outcome) */
export function playBattleRound(
  ctx: ToolContext,
  action: { effect: BattleEffect; objective: string | null; outcome: CheckOutcome; checkId: string } | null,
): BattleTurn {
  const state = ctx.store.getState();
  const battle = state.battle!;
  const config = battleConfig(ctx.content);
  const morale = { ours: moraleOf(state.factions, battle.ours.faction), theirs: moraleOf(state.factions, battle.theirs.faction) };
  const r = resolveRound(ctx.content, battle, action && { effect: action.effect, outcome: action.outcome, objective: action.objective }, morale, ctx.rng);

  if (action?.effect.requires_item && action.effect.consumes_item) {
    ctx.store.append({ type: "item_consumed", holder: state.playerId, itemId: action.effect.requires_item, quantity: 1 });
  }
  ctx.store.append({
    type: "battle_round",
    effect: action?.effect.id ?? null,
    checkId: action?.checkId ?? null,
    momentum: r.battle.momentum,
    alarm: r.battle.alarm,
    position: r.battle.position,
    objectives: r.battle.objectives,
    ourLosses: r.battle.ours.losses,
    theirLosses: r.battle.theirs.losses,
    contribution: r.battle.contribution,
    ...(action?.effect.requires_preparation ? { preparationUsed: action.effect.requires_preparation } : {}),
  });

  const label = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
  const lines = [
    `전투 ${r.battle.round}/${config.max_rounds}라운드: ${action ? `${action.effect.label} → 전세 ${signedNum(r.delta)}` : "플레이어는 전세를 바꾸지 않았다"}. ` +
      `배경 교전 뒤 전세 ${momentumLabel(r.battle.momentum, config.momentum_to_win)}, 경보 ${alarmLabel(r.battle.alarm, config.max_alarm)}, 위치 ${label(config.positions, r.battle.position)}.`,
  ];
  if (r.destroyed) lines.push(`${josa(label(config.objectives, r.destroyed), "을/를")} 무너뜨렸다.`);
  if (r.battle.alarm >= config.max_alarm && r.battle.position !== config.positions[0]!.id) {
    lines.push("적이 당신을 알아챘다. 적 진영 안에서 노출되었다.");
  }
  const displays: ToolDisplayEvent[] = [
    { type: "battle", event: "round", title: battleTitle(ctx.content, r.battle), detail: lines.join(" ") },
  ];
  if (r.ended) {
    const end = endBattle(ctx, r.withdrew);
    lines.push(...end.lines);
    displays.push(...end.displays);
  } else {
    lines.push("승패·사상자는 시스템이 정한다. 이번 라운드의 장면만 서술하고, 다음 행동을 기다려라.");
  }
  return { lines, displays };
}

/** 전투를 끝낸다. 물러났거나 쓰러졌으면 남은 라운드를 코드가 굴린다 */
export function endBattle(ctx: ToolContext, withdrew: boolean): BattleTurn {
  const state = ctx.store.getState();
  let battle = state.battle!;
  const morale = { ours: moraleOf(state.factions, battle.ours.faction), theirs: moraleOf(state.factions, battle.theirs.faction) };
  const config = battleConfig(ctx.content);
  const player = state.characters[state.playerId]!;
  if (withdrew || player.dead || (Math.abs(battle.momentum) < config.momentum_to_win && battle.round < config.max_rounds)) {
    battle = finishWithoutPlayer(ctx.content, battle, morale, ctx.rng);
  }
  const won = wonBy(battle);
  const attackerWon = battle.side === "attack" ? won : !won;
  const attackerLosses = battle.side === "attack" ? battle.ours.losses : battle.theirs.losses;
  const defenderLosses = battle.side === "attack" ? battle.theirs.losses : battle.ours.losses;
  const spec: ClashSpec = { kind: battle.kind, attacker: battle.attacker, defender: battle.defender, zone: battle.zone, ...(battle.plan ? { plan: battle.plan } : {}) };
  const { world, clash } = applyBattleOutcome(state, ctx.content, spec, { success: attackerWon, attackerLosses, defenderLosses });
  const merit = player.dead ? 0 : battleMerit(battle);
  ctx.store.append({ type: "battle_ended", won, withdrew, clash, factions: world.factions, zones: world.zones, merit });

  const lines = [
    `전투가 끝났다: ${won ? "우리 편이 이겼다" : "우리 편이 졌다"}${withdrew ? " (당신은 먼저 물러났다)" : ""}. ` +
      `우리 쪽 사상자 ${battle.ours.losses}명, 적 ${battle.theirs.losses}명.` +
      (merit > 0 ? ` 당신의 활약으로 공적 +${merit}.` : ""),
    "결과에 맞게 전투가 끝나는 장면을 서술하라. 사상자 수를 바꾸지 마라.",
  ];
  const growthNote = gainMeritXp(ctx, player.id, merit);
  if (growthNote) lines.push(growthNote);
  // 지고도 물러나지 않았으면 쓰러진 채 끌려갈 수 있다 (12-55, 코드가 굴린다)
  if (!won && !withdrew && !player.dead) {
    const caught = maybeCaptureAfterDefeat(ctx, battle.theirs.faction);
    if (caught) lines.push(caught);
  }
  const displays: ToolDisplayEvent[] = [
    { type: "battle", event: "ended", title: battleTitle(ctx.content, battle), detail: lines[0]! },
    ...reportClash(ctx, clash),
  ];
  // 공이 크면 용기 있는 행적으로 남는다 (소문이 된다)
  if (!player.dead && battle.contribution >= 3) {
    const zoneName = ctx.content.locations[battle.zone]?.name ?? battle.zone;
    const { deed } = recordDeed(ctx, {
      summary: `${zoneName} 전투에서 앞장서 판세를 바꿨다`,
      tags: ["bravery"],
      severity: 2,
      privacy: "public",
      noisy: true,
    });
    displays.push({ type: "deed", summary: deed.summary, tagLabels: ["용기"], visibleWitnesses: [] });
  }
  return { lines, displays };
}

/** 교전 결과를 플레이어의 보고로 남긴다 (우리 무리가 낀 것) */
function reportClash(ctx: ToolContext, clash: Clash): ToolDisplayEvent[] {
  const state = ctx.store.getState();
  const player = state.characters[state.playerId];
  if (!player || player.dead) return [];
  if (clash.attacker !== player.factionId && clash.defender !== player.factionId) return [];
  const fact = describeClash(ctx.content, clash);
  ctx.store.append({
    type: "belief_added",
    characterId: state.playerId,
    belief: { id: `b_${state.nextBeliefNo}`, fact, source: "report", accuracy: "approximate", learnedAt: state.time, topic: WAR_TOPIC },
  });
  return [{ type: "belief", fact, sourceLabel: BELIEF_SOURCE_LABELS.report }];
}

// ── 문구 ───────────────────────────────────────────

const signedNum = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export function momentumLabel(m: number, win: number): string {
  if (m <= -Math.ceil(win * 0.6)) return "크게 밀림";
  if (m < 0) return "밀림";
  if (m === 0) return "팽팽함";
  if (m < Math.ceil(win * 0.6)) return "우세";
  return "크게 우세";
}

export function alarmLabel(a: number, max: number): string {
  if (a <= 0) return "적이 모름";
  if (a >= max) return "발각";
  return a === 1 ? "낌새" : "경계";
}

function factionName(content: Content, id: string) {
  return content.factions[id]?.name ?? id;
}

export function battleTitle(content: Content, b: BattleState): string {
  return `${content.locations[b.zone]?.name ?? b.zone} 전투`;
}

/** 대략적인 병력 ("열 명 남짓") */
export function forceWords(n: number): string {
  if (n <= 3) return "몇 명";
  if (n <= 7) return "대여섯 명";
  if (n <= 14) return "열 명 남짓";
  if (n <= 25) return "스무 명 안팎";
  return "수십 명";
}

function describeStart(content: Content, b: BattleState): string {
  const zone = content.locations[b.zone]?.name ?? b.zone;
  return b.side === "defense"
    ? `${josa(factionName(content, b.attacker), "이/가")} ${josa(zone, "을/를")} 덮쳤다. 적은 ${forceWords(b.theirs.committed)}, 우리 편은 ${forceWords(b.ours.committed)}.`
    : `${factionName(content, b.attacker)} 쪽이 ${josa(zone, "을/를")} 친다. 당신도 차출됐다. 우리 편은 ${forceWords(b.ours.committed)}, 적은 ${forceWords(b.theirs.committed)}.`;
}

/** GM 컨텍스트: 진행 중인 전투. 예정된 교전은 넣지 않는다 (아무도 모른다) */
export function describeBattleForGm(state: GameState, content: Content): string {
  const b = state.battle;
  if (!b || !content.scenario.battle) return "";
  const config = content.scenario.battle;
  const player = state.characters[state.playerId]!;
  const label = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
  const have = { items: player.inventory, preparations: state.preparations[b.zone] ?? [] };
  const usable = config.effects.filter((e) => effectBlocker(e, b, have) === null);
  return [
    `전투 중: ${battleTitle(content, b)} (${b.side === "defense" ? "방어" : "공격"}) · ${b.round + 1}/${config.max_rounds}라운드 (한 라운드 ${config.round_minutes}분)`,
    `  적 ${factionName(content, b.theirs.faction)}: ${forceWords(b.theirs.committed - b.theirs.losses)} · 우리 편: ${forceWords(b.ours.committed - b.ours.losses)}`,
    `  전세 ${momentumLabel(b.momentum, config.momentum_to_win)} · 경보 ${alarmLabel(b.alarm, config.max_alarm)} · 위치 ${label(config.positions, b.position)}`,
    `  남은 적 목표물: ${b.objectives.length ? b.objectives.map((o) => `${o}(${label(config.objectives, o)})`).join(", ") : "없음"}`,
    `  지금 쓸 수 있는 전투 효과 (take_action.battle.effect): ${usable.map((e) => `${e.id} ${e.label} [위험 ${e.min_harm} 이상] — ${e.description}`).join(" / ") || "없음"}`,
    "  전투 중 행동은 take_action 한 번이 한 라운드다. 판정을 반드시 넣고, 몸의 위험은 효과마다 적힌 수준 이상으로 선언한다. 승패·사상자는 시스템이 정한다.",
  ].join("\n");
}

/** 예정 시각 문구 (디버깅·테스트용) */
export function describePending(p: PendingClash): string {
  return `${p.id} ${p.attacker}→${p.zone} ${formatTime(p.at)}`;
}
