import { z } from "zod";
import type { Rng } from "../rng.ts";
import { CHECK_OUTCOMES, type CheckOutcome } from "../rules/check.ts";
import { dayOf, MINUTES_PER_DAY, type GameTime } from "../rules/time.ts";
import { ACTIVITIES } from "../rules/time.ts";
import type { Content, MissionRequirement } from "../content/schemas.ts";
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

/** 세이브 안의 요구 조건. 콘텐츠에서 검증된 것을 복사하므로 행동 ID는 문자열로 둔다 */
const missionRequirementSchema = z.union([
  z.strictObject({ activity: z.enum(ACTIVITIES), minutes: z.number().int().positive() }),
  z.strictObject({ check: z.string(), min_outcome: z.enum(["success", "partial"]) }),
]);

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

/** 진급 조건 (임시값). 어느 등급에서 어느 등급으로 오르는지는 시나리오(promotion)가 정한다 */
export const PROMOTION = {
  minMerit: 9,
  minDaysServed: 4,
  maxDisobedience: 1,
  /** 직속 상관의 신뢰 */
  minCommanderTrust: 2,
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

/** commanderTrust: 직속 상관의 이 캐릭터에 대한 신뢰. 상관이 없으면 null (조건 생략) */
export function checkPromotion(
  character: Character,
  promotion: { from: string; to: string },
  now: GameTime,
  runStartedAt: GameTime,
  commanderTrust: number | null,
  /** 무리의 규율이 허용하는 불복종 수 (기획서 9.9). 없으면 기본 */
  maxDisobedience: number = PROMOTION.maxDisobedience,
): PromotionCheck {
  const missing: string[] = [];
  if (character.rank !== promotion.from) return { eligible: false, missing: ["진급 대상 등급이 아님"] };
  if (character.merit < PROMOTION.minMerit) missing.push(`공적 ${character.merit}/${PROMOTION.minMerit}`);
  const days = daysServed(now, runStartedAt);
  if (days < PROMOTION.minDaysServed) missing.push(`복무 ${days}/${PROMOTION.minDaysServed}일`);
  if (character.disobedience > maxDisobedience) {
    missing.push(`불복종 ${character.disobedience}회 (최대 ${maxDisobedience}회)`);
  }
  if (commanderTrust !== null && commanderTrust < PROMOTION.minCommanderTrust) {
    missing.push(`상관 신뢰 ${commanderTrust}/${PROMOTION.minCommanderTrust}`);
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

/**
 * 현재 캐릭터의 직속 상관 (역할의 commander). 계승으로 그 상관 자신이 플레이어가 됐거나 상관이 죽었으면 없다
 */
export function commanderOf(state: { playerId: string; roleId: string; characters: Record<string, { dead: boolean; away?: boolean; captive?: unknown }> }, content: { roles: Record<string, { commander?: string | undefined }> }): string | null {
  const id = content.roles[state.roleId]?.commander;
  if (!id || id === state.playerId || state.characters[id]?.dead || state.characters[id]?.away || state.characters[id]?.captive) return null;
  return id;
}
