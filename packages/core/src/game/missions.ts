import { z } from "zod";
import type { Rng } from "../rng.ts";
import { CHECK_OUTCOMES, type CheckOutcome } from "../rules/check.ts";
import { dayOf, MINUTES_PER_DAY, type GameTime } from "../rules/time.ts";
import { missionRequirementSchema, type Content, type MissionRequirement } from "../content/schemas.ts";
import type { Character } from "./character.ts";

/**
 * 임무와 진급 (기획서 15.1: 배정 → 수행 → 보고, 명령 불복종 반영, 하급 전투원 → 분대장).
 * 진행도는 임무를 받은 뒤의 이벤트(시간 소비, 판정)로 코드가 집계한다. AI는 보고를 요청할 뿐이다.
 */

export const MISSION_STATUSES = ["active", "completed", "partial", "failed", "abandoned", "expired"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  active: "수행 중",
  completed: "완수",
  partial: "일부 완수",
  failed: "실패",
  abandoned: "포기",
  expired: "기한 초과",
};

export const missionInstanceSchema = z.strictObject({
  id: z.string(),
  templateId: z.string(),
  title: z.string(),
  briefing: z.string(),
  assigneeId: z.string(),
  giverId: z.string(),
  assignedAt: z.number().int(),
  deadline: z.number().int(),
  /** 배정 시점의 요구 조건 사본 (콘텐츠가 바뀌어도 세이브가 깨지지 않게) */
  requirements: z.array(missionRequirementSchema),
  /** 요구 조건별 진행도: 활동은 누적 분, 판정은 충족 시 1 */
  progress: z.array(z.number().int().nonnegative()),
  status: z.enum(MISSION_STATUSES),
});
export type MissionInstance = z.infer<typeof missionInstanceSchema>;

/** 결과별 공적 (임시값, 기획서 18장 미정) */
export const MERIT = {
  success: 3,
  partial: 1,
  failed: 0,
  late: -1,
  abandoned: -2,
  expired: -2,
} as const;

/** 진급 조건: 하급 전투원 → 분대장 (임시값). 상관 신뢰는 관계 시스템(8단계)과 함께 추가한다 */
export const PROMOTION = {
  from: "grunt",
  to: "squad_leader",
  minMerit: 9,
  minDaysServed: 4,
  maxDisobedience: 1,
} as const;

/** 하루에 상관이 내놓는 임무 수 */
export const OFFERS_PER_DAY = 2;

export function isRequirementMet(requirement: MissionRequirement, progress: number): boolean {
  return "activity" in requirement ? progress >= requirement.minutes : progress >= 1;
}

export type MissionEvaluation = { outcome: "success" | "partial" | "failed"; late: boolean; merit: number };

/** 보고 시점의 결과와 공적 */
export function evaluateMission(mission: MissionInstance, now: GameTime): MissionEvaluation {
  const met = mission.requirements.filter((r, i) => isRequirementMet(r, mission.progress[i] ?? 0)).length;
  const outcome = met === mission.requirements.length ? "success" : met > 0 ? "partial" : "failed";
  const late = now > mission.deadline;
  return { outcome, late, merit: MERIT[outcome] + (late ? MERIT.late : 0) };
}

const OUTCOME_RANK: Record<CheckOutcome, number> = Object.fromEntries(
  CHECK_OUTCOMES.map((o, i) => [o, CHECK_OUTCOMES.length - i]),
) as Record<CheckOutcome, number>;

/** 판정 결과가 요구 수준 이상인지 (success > partial > miss) */
export function outcomeAtLeast(outcome: CheckOutcome, min: "success" | "partial"): boolean {
  return OUTCOME_RANK[outcome] >= OUTCOME_RANK[min];
}

export function activeMissionOf(missions: Record<string, MissionInstance>, characterId: string) {
  return Object.values(missions).find((m) => m.assigneeId === characterId && m.status === "active");
}

export function daysServed(now: GameTime, runStartedAt: GameTime): number {
  return Math.floor((now - runStartedAt) / MINUTES_PER_DAY);
}

export type PromotionCheck = { eligible: boolean; missing: string[] };

export function checkPromotion(character: Character, now: GameTime, runStartedAt: GameTime): PromotionCheck {
  const missing: string[] = [];
  if (character.rank !== PROMOTION.from) return { eligible: false, missing: ["진급 대상 등급이 아님"] };
  if (character.merit < PROMOTION.minMerit) missing.push(`공적 ${character.merit}/${PROMOTION.minMerit}`);
  const days = daysServed(now, runStartedAt);
  if (days < PROMOTION.minDaysServed) missing.push(`복무 ${days}/${PROMOTION.minDaysServed}일`);
  if (character.disobedience > PROMOTION.maxDisobedience) {
    missing.push(`불복종 ${character.disobedience}회 (최대 ${PROMOTION.maxDisobedience}회)`);
  }
  return { eligible: missing.length === 0, missing };
}

/** 오늘의 임무 후보를 고른다. 이미 오늘 골랐으면 null */
export function pickDailyOffers(
  content: Content,
  roleId: string,
  now: GameTime,
  lastOfferDay: number | null,
  rng: Rng,
): { day: number; templateIds: string[] } | null {
  const day = dayOf(now);
  if (lastOfferDay === day) return null;
  const pool = [...(content.roles[roleId]?.missions ?? [])].filter((id) => content.missions[id]);
  if (pool.length === 0) return null;
  const picked: string[] = [];
  const count = Math.min(OFFERS_PER_DAY, pool.length);
  while (picked.length < count) {
    const [id] = pool.splice(Math.floor(rng() * pool.length), 1);
    picked.push(id!);
  }
  return { day, templateIds: picked };
}
