/**
 * 공통 규칙 2: 탓할 수 없는 일에는 벌이 없다 (docs/design.md "공통 규칙").
 *
 * 주인공이 고르지 않은 일(붙잡힘, 쓰러짐, 갇혀 넘긴 시각, 자리를 떠 외면으로 처리된 선택지)로는
 * 행적·공적 감점·불복종·장비 문책이 생기지 않는다. 그 판단은 여기서만 한다.
 */
import type { Content } from "../content/schemas.ts";
import type { MissionInstance } from "../game/missions.ts";
import type { GameState } from "../game/state.ts";
import { harmTrack, incapacitatingSymptom } from "../scenario/scenario.ts";
import { heldOf, lastFreedAt } from "./held.ts";

/** 기한 이만큼(분) 앞까지 갇혀 있었으면 기한 초과를 탓하지 않는다 (빠져나와 돌아오는 길) */
export const FREED_GRACE_MINUTES = 6 * 60;

/** 탓할 수 없는 까닭 */
export type Excuse = { cause: "incapacitated" | "captured" | "grace"; label: string };

/**
 * 적응 기간에 받은 임무 (12-258, PT15 튜토리얼: 대표는 "일주일은 자유롭게"라 했는데 상태는 "버리면 불복종"): 버리거나 놓쳐도 탓하지 않는다
 */
export function graceExcuse(state: GameState, mission: MissionInstance): Excuse | null {
  return state.missionGraceUntil !== null && mission.assignedAt < state.missionGraceUntil ? { cause: "grace", label: "적응 기간이라 탓하지 않음" } : null;
}

/**
 * 기한을 넘긴 임무를 탓할 수 없는 까닭 (없으면 null):
 * - 쓰러졌거나 치명상 이상으로 몸을 못 쓴다 (플레이 테스트 8, 11)
 * - 갇혀 있다, 또는 기한 무렵 갇혀 있다 막 빠져나와 돌아오는 길이다 (플레이 테스트 12, 13)
 */
export function missionExcuse(state: GameState, content: Content, mission: MissionInstance): Excuse | null {
  const who = state.characters[mission.assigneeId];
  if (!who) return null;
  const harm = harmTrack(content.scenario);
  const badFrom = harm.levels.findIndex((l) => l.id === content.scenario.recovery?.surgery?.from);
  const badly = badFrom >= 0 && harm.levels.findIndex((l) => l.id === who.conditions[harm.id]) >= badFrom;
  const down = incapacitatingSymptom(content.scenario, who) ?? (badly ? { label: harm.label } : null);
  // 붙잡힌 것이 먼저다: 갇힌 채 다쳤어도 까닭은 붙잡힘 (12-262, PT17 졸병: "다쳐서 못 마침 (부상)")
  const held = heldOf(who);
  if (held) return { cause: "captured", label: `붙잡혀 못 마침 (${content.factions[held.by]?.name ?? held.by})` };
  if (down) return { cause: "incapacitated", label: `다쳐서 못 마침 (${down.label})` };
  const freed = lastFreedAt(state);
  if (freed !== null && freed > mission.assignedAt && freed >= mission.deadline - FREED_GRACE_MINUTES) {
    return { cause: "captured", label: "붙잡혀 못 마침 (붙잡혔다 빠져나온 길)" };
  }
  return graceExcuse(state, mission);
}

/** 이 임무 중에 붙잡힌 일이 있는가: 빼앗긴 빌린 장비를 잃어버린 것으로 치지 않는다 */
export function capturedDuringMission(state: GameState, mission: MissionInstance): boolean {
  return !!heldOf(state.characters[mission.assigneeId]) || (lastFreedAt(state) ?? -1) > mission.assignedAt;
}

/** 지금 탓하지 않는 중인가 (자리를 떠 외면으로 처리하는 동안: 그 선택지의 행적은 남기지 않는다) */
let suspended: "walked_away" | null = null;

export function blameSuspended(): boolean {
  return suspended !== null;
}

/** fn을 하는 동안은 행적을 남기지 않는다 */
export function withoutBlame<T>(cause: "walked_away", fn: () => T): T {
  const before = suspended;
  suspended = cause;
  try {
    return fn();
  } finally {
    suspended = before;
  }
}

/** 자리를 비운 동안(since부터)을 탓할 수 없는가: 그동안 임무가 있었거나, 붙잡혔다 풀려났다 */
export function absenceExcused(state: GameState, since: number): boolean {
  const onMission = Object.values(state.missions).some((m) => m.assigneeId === state.playerId && (m.status === "active" || m.assignedAt >= since));
  const freed = lastFreedAt(state);
  return onMission || (freed !== null && freed >= since);
}
