import { z } from "zod";

/**
 * 피해 강도. AI는 강도만 고르고 몇 단계 악화될지는 코드가 정한다 (기획서 4.4).
 * 부상 트랙의 단계 이름과 판정 보정은 시나리오가 정한다.
 */
export const HARM_SEVERITIES = ["light", "heavy"] as const;
export type HarmSeverity = (typeof HARM_SEVERITIES)[number];
export const harmSeveritySchema = z.enum(HARM_SEVERITIES);

export const HARM_LABELS: Record<HarmSeverity, string> = {
  light: "가벼운 피해",
  heavy: "심각한 피해",
};
