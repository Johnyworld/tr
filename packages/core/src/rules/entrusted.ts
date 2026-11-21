/**
 * 공통 규칙 10: 남의 물건 (docs/design.md "공통 규칙").
 *
 * 주인공이 지녔지만 주인공 것이 아닌 물건은 여기서 정한다:
 * - 무기고에서 빌린 장비 (loans, 임무가 끝나면 반납)
 * - 배달 짐과 받아 온 대금 (cargo, 임무 자리에서 넘기고 보고 때 상관에게 넘긴다)
 * 남의 물건은 값(치료·가르침)으로 나가지 않고, 자정에 저절로 먹고 마시고 피우지 않으며, 상태에 따로 보인다.
 * 플레이어가 골라 쓰는 것(use_item, 건네기)은 막지 않는다: 빼돌리면 보고 때 모자란다
 * (플레이 테스트 13: 빌린 탄이 치료 값으로 나갔고, 배달 물병이 내 물병과 섞였고, 받아 온 대금이 현장에서 오가지 않았다).
 * loans·cargo는 이 모듈로만 읽는다 (rules/guards.test.ts).
 */
import type { GameState } from "../game/state.ts";

type Items = Record<string, number>;

/** 그 임무로 무기고에서 빌린 것 (기록 그대로) */
export function loanOf(state: GameState, missionId: string): Items | undefined {
  return state.loans?.[missionId];
}

/** 그 임무로 맡은 짐·대금 (기록 그대로, 진행 중인 임무만) */
export function cargoOf(state: GameState, missionId: string): Items {
  return state.missions[missionId]?.status === "active" ? (state.cargo?.[missionId] ?? {}) : {};
}

const held = (state: GameState, items: Items | undefined): [string, number][] => {
  const inv = state.characters[state.playerId]?.inventory ?? {};
  return Object.entries(items ?? {}).map(([id, q]) => [id, Math.min(q, inv[id] ?? 0)] as [string, number]).filter(([, q]) => q > 0);
};

/** 그 임무로 맡아 지금 지닌 것 (빌린 것, 짐·대금) */
export function entrustedHeld(state: GameState, missionId: string): { loan: [string, number][]; cargo: [string, number][] } {
  return { loan: held(state, loanOf(state, missionId)), cargo: held(state, cargoOf(state, missionId)) };
}

/** 주인공이 지닌 남의 물건 모두 (아이템 → 수량, 지닌 만큼만) */
export function entrusted(state: GameState): Items {
  const sum: Items = {};
  for (const loan of Object.values(state.loans ?? {})) for (const [id, q] of Object.entries(loan)) sum[id] = (sum[id] ?? 0) + q;
  for (const mid of Object.keys(state.cargo ?? {})) for (const [id, q] of Object.entries(cargoOf(state, mid))) sum[id] = (sum[id] ?? 0) + q;
  const inv = state.characters[state.playerId]?.inventory ?? {};
  for (const id of Object.keys(sum)) sum[id] = Math.min(sum[id]!, inv[id] ?? 0);
  return sum;
}

/** 그 사람이 지닌 이 물건 가운데 제 것 (주인공이 아니면 모두 제 것) */
export function ownCount(state: GameState, holderId: string, item: string): number {
  const have = state.characters[holderId]?.inventory[item] ?? 0;
  return holderId === state.playerId ? Math.max(0, have - (entrusted(state)[item] ?? 0)) : have;
}
