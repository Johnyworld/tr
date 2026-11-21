/**
 * 공통 규칙 1: 갇힘 (docs/design.md "공통 규칙").
 *
 * 누가 갇혀 있는지는 이 모듈로만 읽는다 (rules/held.test.ts가 다른 곳에서 `.captive`를 직접 읽으면 실패시킨다).
 * 갇혀 있는 동안 멈추는 바깥의 셈은 HELD_PAUSES에 모아 둔다. 새 기능이 갇힌 동안 멈춰야 하면 여기에 이름을 더하고 pausedWhileHeld로 묻는다.
 * 쓰는 곳은 세이브의 기록(game/state.ts의 리듀서)만 직접 고친다.
 */

/** 갇힌 사람의 기록 (붙잡은 무리, 갇힌 구역, 노역, 갇힌 시각, 탈출 실패로 쌓인 감시) */
export type Held = { by: string; zone: string; labor?: boolean | undefined; since?: number | undefined; watch?: number | undefined };

/** 이 사람이 갇혀 있으면 그 기록, 아니면 null */
export function heldOf(c: { captive?: Held | null } | null | undefined): Held | null {
  return c?.captive ?? null;
}

/** 주인공이 갇혀 있으면 그 기록 */
export function playerHeld(state: { playerId: string; characters: Record<string, { captive?: Held | null } | undefined> }): Held | null {
  return heldOf(state.characters[state.playerId]);
}

/**
 * 갇혀 있는 동안 멈추는 바깥의 셈 (플레이 테스트 12·13에서 하나씩 빠져 나온 것들):
 * - mission: 임무 진행·임무 판정·기한 탓 (붙잡혀 못 마침)
 * - resolve_reach: 다짐의 "그곳에 닿았다"
 * - ration: 우리 무리 배급 (풀려나 그날 거점에 닿으면 받는다)
 * - guest: 남의 거점의 손님 대접 (불 땐 거처)
 * - strangers: 마주칠 낯선 사람 (같이 갇힌 사람·치료사만)
 * - alarm: 적 땅 경보 (다시 끌려온다)
 * - assign: 임무 받기
 * - helpless: 쓰러진 동안 곁의 사람이 할 일
 */
export const HELD_PAUSES = ["mission", "resolve_reach", "ration", "guest", "strangers", "alarm", "assign", "helpless"] as const;
export type HeldPause = (typeof HELD_PAUSES)[number];

/** 주인공이 갇혀 있어 이 셈이 멈췄는가 */
export function pausedWhileHeld(state: Parameters<typeof playerHeld>[0], _what: HeldPause): boolean {
  return playerHeld(state) !== null;
}
