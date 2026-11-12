import type { Content } from "../content/schemas.ts";
import type { CheckOutcome } from "../rules/check.ts";
import type { BattleState, FactionState } from "../game/state.ts";
import type { Rng } from "../rng.ts";
import { clashForces, type ClashSpec, type WarWorld } from "./war.ts";

/**
 * 전투 장면 (기획서 9.5). 플레이어가 그 자리에 있는 교전을 라운드 단위로 푼다.
 * - 전세(momentum): 플레이어 편 기준. ±momentum_to_win에 이르면 끝난다
 * - 경보(alarm): 적이 침투를 알아챈 정도. 높으면 은밀한 행동을 못 한다
 * - 위치(position): 전선 → … → 적 후방. 뒤로 갈수록 기습·파괴를 할 수 있다
 * 효과의 종류와 크기는 시나리오 팩의 battle.effects에서 온다. 여기는 그 틀만 안다.
 */

export type BattleConfig = NonNullable<Content["scenario"]["battle"]>;
export type BattleEffect = BattleConfig["effects"][number];

export function battleConfig(content: Content): BattleConfig {
  const config = content.scenario.battle;
  if (!config) throw new Error("이 시나리오에는 전투 장면 설정이 없다");
  return config;
}

export function startBattle(
  content: Content,
  world: WarWorld,
  spec: ClashSpec,
  side: "attack" | "defense",
  options: { id: string; at: number },
): BattleState {
  const config = battleConfig(content);
  const { attackers, defenders } = clashForces(world, spec);
  const attack = { faction: spec.attacker, committed: attackers, losses: 0 };
  const defense = { faction: spec.defender, committed: defenders, losses: 0 };
  return {
    id: options.id,
    kind: spec.kind,
    attacker: spec.attacker,
    defender: spec.defender,
    zone: spec.zone,
    ...(spec.plan ? { plan: spec.plan } : {}),
    side,
    ours: side === "attack" ? attack : defense,
    theirs: side === "attack" ? defense : attack,
    momentum: 0,
    alarm: 0,
    position: config.positions[0]!.id,
    round: 0,
    objectives: config.objectives.map((o) => o.id),
    contribution: 0,
    startedAt: options.at,
  };
}

/** 플레이어가 지금 쓸 수 있는 효과인지. 안 되면 이유 */
export function effectBlocker(
  effect: BattleEffect,
  battle: BattleState,
  have: { items: Record<string, number>; preparations: readonly string[] },
): string | null {
  if (!effect.positions.includes(battle.position)) return `지금 위치에서는 쓸 수 없다 (가능: ${effect.positions.join(", ")})`;
  if (effect.max_alarm !== undefined && battle.alarm > effect.max_alarm) return "적이 이미 경계하고 있어 쓸 수 없다";
  if (effect.requires_item && (have.items[effect.requires_item] ?? 0) < 1) return `${effect.requires_item}이(가) 없다`;
  if (effect.requires_preparation && !have.preparations.includes(effect.requires_preparation)) {
    return `이 구역에 설치한 ${effect.requires_preparation}이(가) 없다`;
  }
  if (effect.targets_objective && battle.objectives.length === 0) return "남은 목표물이 없다";
  return null;
}

export type RoundAction = { effect: BattleEffect; outcome: CheckOutcome; objective: string | null };

export type RoundResult = {
  battle: BattleState;
  /** 이번 라운드에 플레이어 효과가 바꾼 전세 */
  delta: number;
  destroyed: string | null;
  withdrew: boolean;
  ended: boolean;
  /** 끝났을 때 우리 편이 이겼는지 */
  won: boolean | null;
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** 한 라운드: 플레이어 효과 → 배경 교전 → 끝 검사 */
export function resolveRound(
  content: Content,
  battle: BattleState,
  action: RoundAction | null,
  morale: { ours: number; theirs: number },
  rng: Rng,
): RoundResult {
  const config = battleConfig(content);
  const b: BattleState = structuredClone(battle);
  const win = config.momentum_to_win;
  let delta = 0;
  let destroyed: string | null = null;
  let withdrew = false;

  if (action) {
    const o = action.effect.outcomes[action.outcome];
    const surprise = action.outcome !== "miss" && b.alarm === 0 ? action.effect.surprise_bonus : 0;
    delta = o.momentum + surprise;
    b.alarm = clamp(b.alarm + o.alarm, 0, config.max_alarm);
    const order = config.positions.map((p) => p.id);
    b.position = order[Math.min(order.length - 1, order.indexOf(b.position) + o.advance)]!;
    b.theirs.losses = Math.min(b.theirs.committed, b.theirs.losses + o.enemy_losses);
    if (o.destroy_objective) {
      const target = action.objective && b.objectives.includes(action.objective) ? action.objective : b.objectives[0];
      if (target) {
        b.objectives = b.objectives.filter((x) => x !== target);
        destroyed = target;
      }
    }
    if (action.effect.withdraw && action.outcome !== "miss") withdrew = true;
  }
  b.momentum = clamp(b.momentum + delta, -win, win);
  b.contribution += delta;

  // 플레이어의 한 수가 승부를 냈으면 배경 교전 없이 끝난다
  if (Math.abs(b.momentum) < win && !withdrew) exchange(b, config, morale, rng);
  b.round += 1;
  const ended = Math.abs(b.momentum) >= win || b.round >= config.max_rounds || withdrew;
  return { battle: b, delta, destroyed, withdrew, ended, won: ended && !withdrew ? wonBy(b) : null };
}

/** 플레이어 없이 남은 라운드를 굴린다 (물러났거나 쓰러졌을 때) */
export function finishWithoutPlayer(content: Content, battle: BattleState, morale: { ours: number; theirs: number }, rng: Rng): BattleState {
  const config = battleConfig(content);
  const b: BattleState = structuredClone(battle);
  while (Math.abs(b.momentum) < config.momentum_to_win && b.round < config.max_rounds) {
    exchange(b, config, morale, rng);
    b.round += 1;
  }
  return b;
}

/** 우리 편이 이겼는지. 전세 0이면 방어 쪽이 버틴 것으로 본다 */
export function wonBy(b: BattleState): boolean {
  if (b.momentum !== 0) return b.momentum > 0;
  return b.side === "defense";
}

/** 배경 교전: 남은 병력·사기·파괴된 목표물로 전세가 ±1 움직이고, 진 쪽이 사람을 잃는다 */
function exchange(b: BattleState, config: BattleConfig, morale: { ours: number; theirs: number }, rng: Rng) {
  const destroyedShare = 1 - b.objectives.length / config.objectives.length;
  const ours = Math.max(0, b.ours.committed - b.ours.losses) * (1 + 0.1 * morale.ours);
  const theirs = Math.max(0, b.theirs.committed - b.theirs.losses) * (1 + 0.1 * morale.theirs) * (1 - 0.3 * destroyedShare);
  const p = ours + theirs > 0 ? ours / (ours + theirs) : 0.5;
  if (rng() < p) {
    b.momentum = Math.min(config.momentum_to_win, b.momentum + 1);
    if (rng() < 0.5) b.theirs.losses = Math.min(b.theirs.committed, b.theirs.losses + 1);
  } else {
    b.momentum = Math.max(-config.momentum_to_win, b.momentum - 1);
    if (rng() < 0.5) b.ours.losses = Math.min(b.ours.committed, b.ours.losses + 1);
  }
}

/** 기여로 받는 공적 (최대 3) */
export function battleMerit(b: BattleState): number {
  return clamp(Math.floor(b.contribution / 2), 0, 3);
}

export function moraleOf(factions: Record<string, FactionState>, id: string): number {
  return factions[id]?.morale ?? 0;
}
