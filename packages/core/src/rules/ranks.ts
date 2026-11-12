import { z } from "zod";

/**
 * 소속 등급 (기획서 3.4). 화법 규칙과 진급에 쓴다.
 * staff는 의무·기술처럼 지휘 계통 밖의 인력이다.
 */
export const RANKS = ["loner", "grunt", "staff", "squad_leader", "officer", "leader"] as const;
export type Rank = (typeof RANKS)[number];
export const rankSchema = z.enum(RANKS);

export const RANK_LABELS: Record<Rank, string> = {
  loner: "혼자",
  grunt: "하급 전투원",
  staff: "지원 인력",
  squad_leader: "분대장",
  officer: "간부",
  leader: "지도자",
};

/** 지휘 계통상의 높이. staff는 하급 전투원과 같은 높이로 본다 */
const RANK_LEVEL: Record<Rank, number> = {
  loner: 0,
  grunt: 1,
  staff: 1,
  squad_leader: 2,
  officer: 3,
  leader: 4,
};

export type SpeechLevel = "반말" | "존댓말";

/**
 * 기본 화법 (기획서 7.4). 등급이 높으면 아랫사람에게 반말, 같은 등급이면 나이로 정한다.
 * NPC의 voice.style이 이를 덮어쓸 수 있다. 관계에 따른 변화는 관계 시스템과 함께 추가한다.
 */
export function speechLevel(
  speaker: { rank: Rank; age: number | null },
  listener: { rank: Rank; age: number | null },
): SpeechLevel {
  const diff = RANK_LEVEL[speaker.rank] - RANK_LEVEL[listener.rank];
  if (diff !== 0) return diff > 0 ? "반말" : "존댓말";
  if (speaker.age === null || listener.age === null) return "존댓말";
  return speaker.age >= listener.age ? "반말" : "존댓말";
}
