import { z } from "zod";
import type { Rng } from "../rng.ts";
import { CHECK_OUTCOMES, type CheckOutcome } from "../rules/check.ts";
import { dayOf, MINUTES_PER_DAY, type GameTime } from "../rules/time.ts";
import { ACTIVITIES } from "../rules/time.ts";
import type { Content, MissionRequirement } from "../content/schemas.ts";
import type { Character } from "./character.ts";

/**
 * 임무와 진급 (기획서 15.1: 배정 → 수행 → 보고, 명령 불복종 반영, 분대원 → 분대장).
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
  z.strictObject({ goal: z.string() }),
  z.strictObject({ bring: z.string(), quantity: z.number().int().positive() }),
  z.strictObject({ deliver: z.string(), quantity: z.number().int().positive() }),
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
  /**
   * 임무를 해야 하는 곳 (플레이 테스트 4). 그 자리에서 한 판정·활동만 진행으로 센다. null이면 어디서든.
   * zone: 그 구역, notZone: 그 구역(우리 거점)만 아니면 담 밖 어디든, enemyOf: 이 무리와 적대하는 무리의 땅. label은 보여 줄 말
   */
  place: z
    .strictObject({ zone: z.string().nullable(), notZone: z.string().nullable(), enemyOf: z.string().nullable(), label: z.string() })
    .nullable()
    .default(null),
  /** 요구 조건별 진행도: 활동은 누적 분, 판정은 충족 시 1 */
  progress: z.array(z.number().int().nonnegative()),
  /** 판정 조건별 실패 수 (플레이 테스트 11, C2): MISSION_CHECK_TRIES번 실패하면 그 조건은 이 임무에서 닫힌다 */
  fails: z.array(z.number().int().nonnegative()).default([]),
  status: z.enum(MISSION_STATUSES),
});
export type MissionInstance = z.infer<typeof missionInstanceSchema>;

/** 임무의 판정 조건은 이만큼 실패하면 닫힌다 (C2: 5분마다 다시 굴려 채웠다) */
export const MISSION_CHECK_TRIES = 3;
/** 임무 판정이 빗나가면 드는 시간 (분, C2) */
export const MISSION_FAIL_MINUTES = 30;
/** 하루에 받을 수 있는 임무 수 (C3) */
export const MISSIONS_PER_DAY = 2;

/** 결과별 공적 (임시값, 기획서 18장 미정) */
export const MERIT = {
  success: 3,
  /** 시간만 채우면 되는 임무(판정 조건 없음)의 완수 (C4) */
  success_time_only: 2,
  partial: 1,
  failed: 0,
  late: -1,
  abandoned: -2,
  expired: -2,
} as const;

/** 진급 조건 (임시값). 어느 등급에서 어느 등급으로 오르는지는 시나리오(promotion)가 정한다 */
export const PROMOTION = {
  // 플레이 테스트 11 (C5): 공적은 2일차, 신뢰는 3일차에 채워져 복무일만 막고 있었다 (9·4·2 → 15·7·3)
  minMerit: 15,
  minDaysServed: 7,
  maxDisobedience: 1,
  /** 직속 상관의 신뢰 */
  minCommanderTrust: 3,
  /** 최근 이만큼(일) 안의 흠을 본다: 실패·일부 완수가 setbacks 이상이거나 상관이 덜 믿게 된 일이 있으면 미룬다 */
  recentDays: 3,
  setbacks: 2,
} as const;

/** 진급을 미루게 하는 최근의 흠 (C5). 없으면 null */
export function recentSetback(
  state: { time: GameTime; missions: Record<string, MissionInstance>; trustDroppedAt?: Record<string, number> },
  characterId: string,
  commanderId: string | null,
): string | null {
  const since = state.time - PROMOTION.recentDays * MINUTES_PER_DAY;
  const bad = Object.values(state.missions).filter((m) => m.assigneeId === characterId && m.assignedAt >= since && ["partial", "failed", "expired", "abandoned"].includes(m.status)).length;
  if (bad >= PROMOTION.setbacks) return `최근 ${PROMOTION.recentDays}일 사이 임무 ${bad}번이 뜻대로 되지 않았다`;
  if (commanderId && (state.trustDroppedAt?.[commanderId] ?? -Infinity) >= since) return `최근 ${PROMOTION.recentDays}일 사이 상관의 믿음을 잃은 일이 있다`;
  return null;
}

/** 하루에 상관이 내놓는 임무 수 */
export const OFFERS_PER_DAY = 2;

/** 판정 조건이 실패로 닫혔는가 (C2) */
export function isRequirementClosed(mission: Pick<MissionInstance, "requirements" | "progress" | "fails">, i: number): boolean {
  const r = mission.requirements[i];
  return !!r && "check" in r && (mission.progress[i] ?? 0) < 1 && (mission.fails?.[i] ?? 0) >= MISSION_CHECK_TRIES;
}

export function isRequirementMet(requirement: MissionRequirement, progress: number): boolean {
  return "activity" in requirement ? progress >= requirement.minutes : progress >= 1;
}

export type MissionEvaluation = { outcome: "success" | "partial" | "failed"; late: boolean; merit: number };

/** 보고 시점의 결과와 공적 */
export function evaluateMission(mission: MissionInstance, now: GameTime): MissionEvaluation {
  const met = mission.requirements.filter((r, i) => isRequirementMet(r, mission.progress[i] ?? 0)).length;
  const outcome = met === mission.requirements.length ? "success" : met > 0 ? "partial" : "failed";
  const late = now > mission.deadline;
  const timeOnly = mission.requirements.every((r) => "activity" in r);
  const base = outcome === "success" && timeOnly ? MERIT.success_time_only : MERIT[outcome];
  return { outcome, late, merit: base + (late ? MERIT.late : 0) };
}

const OUTCOME_RANK: Record<CheckOutcome, number> = Object.fromEntries(
  CHECK_OUTCOMES.map((o, i) => [o, CHECK_OUTCOMES.length - i]),
) as Record<CheckOutcome, number>;

/** 판정 결과가 요구 수준 이상인지 (success > partial > miss) */
export function outcomeAtLeast(outcome: CheckOutcome, min: "success" | "partial"): boolean {
  return OUTCOME_RANK[outcome] >= OUTCOME_RANK[min];
}

/** 지금 있는 곳이 임무의 장소인가 (장소가 없으면 늘 그렇다) */
export function atMissionPlace(
  mission: Pick<MissionInstance, "place">,
  zone: string | null,
  zones: Record<string, { owner: string | null } | undefined>,
  factions: Record<string, { disposition?: Record<string, number> } | undefined>,
): boolean {
  const p = mission.place;
  if (!p) return true;
  if (!zone) return false;
  if (p.zone) return zone === p.zone;
  if (p.notZone) return zone !== p.notZone;
  if (p.enemyOf) {
    const owner = zones[zone]?.owner;
    return !!owner && owner !== p.enemyOf && (factions[p.enemyOf]?.disposition?.[owner] ?? 0) < 0;
  }
  return true;
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
  /** 최근의 흠 (recentSetback) */
  setback: string | null = null,
): PromotionCheck {
  const missing: string[] = [];
  if (setback) missing.push(setback);
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
  /** 직분의 일감 (기획서 12.6) */
  extra: readonly string[] = [],
  /** 우리 무리 땅에 감염체가 몰려들었는지 (12-120). 그날만 소탕 임무(clears)가 후보에 오른다 */
  overrun = false,
  /** 임무를 받을 사람의 무리와 지금 땅 주인 (플레이 테스트 11): 우리 땅이던 곳을 빼앗겼으면 그곳으로 가는 임무(증원, 시찰)는 내지 않는다 */
  lost?: { factionId: string | null; owners: Record<string, { owner: string | null } | undefined> },
  /** 받을 사람의 계급 (min_rank가 있는 일감을 거른다) */
  rank?: string,
): { day: number; templateIds: string[] } | null {
  const day = dayOf(now);
  if (lastOfferDay === day) return null;
  const clearing = overrun ? Object.values(content.missions).filter((m) => m.clears).map((m) => m.id) : [];
  const pool = [...new Set([...(content.roles[roleId]?.missions ?? []), ...extra, ...clearing])].filter((id) => content.missions[id] && (overrun || !content.missions[id]!.clears))
    .filter((id) => {
      const min = content.missions[id]!.min_rank;
      if (!min || !rank) return true;
      const level = (r: string) => content.scenario.rank_ladder.find((x) => x.id === r)?.level ?? 0;
      return level(rank) >= level(min);
    })
    .filter((id) => {
      const where = content.missions[id]!.where;
      if (!lost?.factionId || !where || where === "outside" || where === "enemy") return true;
      return content.locations[where]?.owner !== lost.factionId || lost.owners[where]?.owner === lost.factionId;
    });
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
export function commanderOf(
  state: {
    playerId: string;
    roleId: string;
    characters: Record<string, { dead: boolean; away?: unknown; captive?: unknown; rank?: string; factionId?: string | null }>;
  },
  content: { roles: Record<string, { commander?: string | undefined; faction?: string | null | undefined; rank?: string | undefined }>; scenario?: { rank_ladder: readonly { id: string; level: number }[] }; npcs?: Record<string, unknown> },
): string | null {
  const id = content.roles[state.roleId]?.commander;
  const usable = (cid: string) => cid !== state.playerId && !!state.characters[cid] && !state.characters[cid]!.dead && !state.characters[cid]!.away && !state.characters[cid]!.captive;
  if (!id || !usable(id)) return null;
  // 진급해서 상관과 같은 계급이 되면, 같은 무리에서 바로 위 계급인 사람이 상관이다 (플레이 테스트 4)
  const ladder = content.scenario?.rank_ladder;
  const me = state.characters[state.playerId];
  if (ladder && me) {
    const level = (rank?: string) => ladder.find((r) => r.id === rank)?.level ?? 0;
    const mine = level(me.rank);
    if (level(state.characters[id]!.rank) <= mine) {
      // 그 계급으로 시작하는 역할에 정해진 상관이 먼저다 (플레이 테스트 11: 이름순으로 고르다 비리를 알린 사람이 상관이 됐다)
      const byRole = Object.values(content.roles).find((r) => r.faction === me.factionId && r.rank === me.rank && r.commander)?.commander;
      if (byRole && usable(byRole) && level(state.characters[byRole]!.rank) > mine) return byRole;
      const above = Object.entries(state.characters)
        .filter(([cid, c]) => usable(cid) && (!content.npcs || !!content.npcs[cid]) && c.factionId === me.factionId && level(c.rank) > mine)
        .sort(([a, x], [b, y]) => level(x.rank) - level(y.rank) || a.localeCompare(b));
      return above[0]?.[0] ?? null;
    }
  }
  return id;
}

/** 임무를 하나도 끝내지 않은 날 수 (G1): 마지막으로 끝낸(완수·일부 완수) 임무를 받은 때, 없으면 이야기를 시작한 때부터 */
export function idleDays(state: { time: GameTime; runStartedAt: GameTime; missions: Record<string, MissionInstance> }, characterId: string): number {
  const last = Object.values(state.missions)
    .filter((m) => m.assigneeId === characterId && (m.status === "completed" || m.status === "partial"))
    .reduce((t, m) => Math.max(t, m.assignedAt), state.runStartedAt);
  return Math.floor((state.time - last) / MINUTES_PER_DAY);
}
