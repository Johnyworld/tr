import { z } from "zod";
import { rollDie, type Rng } from "../rng.ts";

/** 판정 결과 (기획서 4.1) */
export const CHECK_OUTCOMES = ["success", "partial", "miss"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const CHECK_OUTCOME_LABELS: Record<CheckOutcome, string> = {
  success: "성공",
  partial: "대가 있는 성공",
  miss: "실패",
};

/** 난이도. AI는 enum만 고르고 보정치는 코드가 정한다 (임시값) */
export const DIFFICULTIES = ["very_easy", "easy", "normal", "hard", "very_hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const difficultySchema = z.enum(DIFFICULTIES);

export const DIFFICULTY_MODIFIER: Record<Difficulty, number> = {
  very_easy: 2,
  easy: 1,
  normal: 0,
  hard: -1,
  very_hard: -2,
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  very_easy: "매우 쉬움",
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  very_hard: "매우 어려움",
};

export type CheckRoll = {
  dice: [number, number];
  modifier: number;
  total: number;
  outcome: CheckOutcome;
};

/** 합계로 결과 등급을 정한다. 분포 조정이 필요하면 이 함수를 바꾼다 */
export type OutcomeTable = (total: number) => CheckOutcome;

export const standardOutcomeTable: OutcomeTable = (total) =>
  total >= 10 ? "success" : total >= 7 ? "partial" : "miss";

/** 2d6 + 보정 판정 */
export function roll2d6(
  rng: Rng,
  modifier: number,
  table: OutcomeTable = standardOutcomeTable,
): CheckRoll {
  const dice: [number, number] = [rollDie(rng, 6), rollDie(rng, 6)];
  const total = dice[0] + dice[1] + modifier;
  return { dice, modifier, total, outcome: table(total) };
}
