import { z } from "zod";
import type { Rng } from "../rng.ts";
import { segmentOf, type GameTime } from "../rules/time.ts";
import type { Scenario } from "../scenario/schema.ts";
import type { GameState } from "../game/state.ts";

/** 빨리감기를 멈추게 한 사건 */
export const INTERRUPT_KINDS = ["disturbance", "battle", "storylet"] as const;
export type InterruptKind = (typeof INTERRUPT_KINDS)[number];

export const interruptSchema = z.strictObject({
  kind: z.enum(INTERRUPT_KINDS),
  /** 사건의 구체적인 갈래. GM이 서술의 출발점으로 쓴다 */
  detail: z.string(),
  at: z.number().int(),
});
export type Interrupt = z.infer<typeof interruptSchema>;

/**
 * 끼어들기 검사. 한 틱(기본 1시간)이 지날 때마다 호출된다.
 * 사건이 생기면 그 틱 안의 발생 시각과 함께 돌려준다.
 * 조우·월드 클락·스토리렛·자원 위기 검사는 해당 시스템이 생기면 여기에 더한다 (기획서 5.2).
 */
export type InterruptCheck = (input: {
  state: GameState;
  from: GameTime;
  to: GameTime;
  rng: Rng;
}) => Interrupt | null;

/**
 * 이상 징후: 무언가가 일어났다는 낌새만 정한다. 정체는 정하지 않는다.
 * 시간대별 확률과 낌새 문구는 시나리오의 환경 위협(threats)에서 온다.
 * 조우 테이블(장소·위협)이 생기면 그쪽으로 바꾼다.
 */
export function createDisturbanceCheck(s: Scenario): InterruptCheck {
  const { disturbance_chance_per_hour: chances, disturbance_details: details } = s.threats;
  return ({ from, to, rng }) => {
    const hours = (to - from) / 60;
    const chance = (chances[segmentOf(from)] ?? 0) * hours;
    if (rng() >= chance) return null;
    const detail = details[Math.floor(rng() * details.length)]!;
    const at = from + Math.max(1, Math.ceil(rng() * (to - from)));
    return { kind: "disturbance", detail, at };
  };
}

/** 예정된 교전 시각이 되면 멈춘다 (플레이어가 그 자리에 있으면 전투 장면이 열린다) */
export const battleCheck: InterruptCheck = ({ state, from, to }) => {
  const due = state.pendingClashes.filter((p) => p.at > from && p.at <= to).sort((a, b) => a.at - b.at)[0];
  return due ? { kind: "battle", detail: "교전", at: due.at } : null;
};

/** 기본 끼어들기 검사 목록. 교전 → 그 밖의 검사(스토리렛 등) → 이상 징후 순 */
export function createInterruptChecks(s: Scenario, more: readonly InterruptCheck[] = []): readonly InterruptCheck[] {
  return [battleCheck, ...more, createDisturbanceCheck(s)];
}

export type FastForwardResult = {
  /** 멈춘 시각 */
  end: GameTime;
  interrupt: Interrupt | null;
};

/**
 * 빨리감기 (기획서 5.2). 건너뛰기가 아니라 틱 단위로 시뮬레이션을 돌리다가
 * 의미 있는 일이 생기면 멈춘다. 상태는 바꾸지 않고 결과만 계산한다.
 */
export function fastForward(options: {
  state: GameState;
  start: GameTime;
  until: GameTime;
  rng: Rng;
  checks: readonly InterruptCheck[];
  tickMinutes?: number;
}): FastForwardResult {
  const { state, start, until, rng, checks, tickMinutes = 60 } = options;
  let time = start;
  while (time < until) {
    const next = Math.min(time + tickMinutes, until);
    // 틱 시스템(NPC 일과, 세력 시뮬레이션 등)은 생기면 여기서 돌린다
    for (const check of checks) {
      const interrupt = check({ state, from: time, to: next, rng });
      if (interrupt) return { end: Math.min(interrupt.at, next), interrupt };
    }
    time = next;
  }
  return { end: until, interrupt: null };
}
