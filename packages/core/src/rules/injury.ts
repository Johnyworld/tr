import { z } from "zod";

/** 부상 트랙 (기획서 4.4). 앞에서 뒤로 악화된다 */
export const INJURY_LEVELS = ["none", "light", "serious", "critical", "dead"] as const;
export type InjuryLevel = (typeof INJURY_LEVELS)[number];
export const injuryLevelSchema = z.enum(INJURY_LEVELS);

export const INJURY_LABELS: Record<InjuryLevel, string> = {
  none: "무사",
  light: "경상",
  serious: "중상",
  critical: "치명상",
  dead: "사망",
};

/** 부상 단계별 판정 보정 (임시값, 기획서 18장 미정) */
export const INJURY_PENALTY: Record<InjuryLevel, number> = {
  none: 0,
  light: -1,
  serious: -2,
  critical: -3,
  dead: 0,
};

/** 피해 강도. AI는 강도만 고르고 몇 단계 악화될지는 코드가 정한다 */
export const HARM_SEVERITIES = ["light", "heavy"] as const;
export type HarmSeverity = (typeof HARM_SEVERITIES)[number];
export const harmSeveritySchema = z.enum(HARM_SEVERITIES);

export const HARM_LABELS: Record<HarmSeverity, string> = {
  light: "가벼운 피해",
  heavy: "심각한 피해",
};

/** 부상을 steps 단계만큼 악화시킨다. 사망에서 멈춘다 */
export function worsenInjury(level: InjuryLevel, steps: number): InjuryLevel {
  const index = Math.min(INJURY_LEVELS.indexOf(level) + steps, INJURY_LEVELS.length - 1);
  return INJURY_LEVELS[index]!;
}
