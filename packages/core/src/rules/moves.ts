import { z } from "zod";
import type { Stat } from "./stats.ts";

/**
 * 기본 행동 (기획서 4.3, 초안).
 * "돕기·방해"는 관계 수치가 필요하므로 관계 시스템(6단계 이후)과 함께 추가한다.
 */
export const MOVES = ["fight", "search", "sense_danger", "stealth", "endure", "persuade"] as const;
export type Move = (typeof MOVES)[number];
export const moveSchema = z.enum(MOVES);

export const MOVE_LABELS: Record<Move, string> = {
  fight: "싸우기",
  search: "수색하기",
  sense_danger: "위험 감지",
  stealth: "은밀 행동",
  endure: "버티기",
  persuade: "설득·압박",
};

/** 행동별로 쓸 수 있는 능력치 */
export const MOVE_STATS: Record<Move, readonly Stat[]> = {
  fight: ["strength", "agility"],
  search: ["sense"],
  sense_danger: ["sense"],
  stealth: ["agility"],
  endure: ["cool"],
  persuade: ["persuasion"],
};
