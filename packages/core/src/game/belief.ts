import { z } from "zod";

/**
 * Belief: 캐릭터가 사실이라고 믿는 것 (기획서 6.1).
 * accuracy는 시뮬레이션만 쓰는 진짜 정확도다. GM 프롬프트에는 절대 넣지 않는다.
 * unknown은 GM이 장면에서 기록한 것처럼 진위를 시스템이 따지지 않은 정보다.
 */
export const BELIEF_SOURCES = ["seen", "report", "rumor"] as const;
export type BeliefSource = (typeof BELIEF_SOURCES)[number];
export const beliefSourceSchema = z.enum(BELIEF_SOURCES);

export const BELIEF_SOURCE_LABELS: Record<BeliefSource, string> = {
  seen: "직접 봄",
  report: "전해 들음",
  rumor: "소문",
};

export const BELIEF_ACCURACIES = ["exact", "approximate", "false", "unknown"] as const;
export const beliefAccuracySchema = z.enum(BELIEF_ACCURACIES);

export const beliefSchema = z.strictObject({
  id: z.string(),
  fact: z.string().min(1).max(300),
  source: beliefSourceSchema,
  accuracy: beliefAccuracySchema,
  /** 알게 된 게임 시각. 세계가 시작되기 전부터 알던 것은 시작 시각 */
  learnedAt: z.number().int(),
  /** 분류 (예: war = 전황 소식). 명령어가 골라 보여 줄 때 쓴다 */
  topic: z.string().optional(),
});
export type Belief = z.infer<typeof beliefSchema>;
