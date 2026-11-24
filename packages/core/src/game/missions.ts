import { preferRested } from "../rules/rest.ts";
import { heldOf, type Held } from "../rules/held.ts";
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
  /** alts: 이 판정 대신 써도 되는 판정 (배정할 때 시나리오의 mission_move_groups에서 복사) */
  z.strictObject({ check: z.string(), min_outcome: z.enum(["success", "partial"]), alts: z.array(z.string()).optional() }),
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
   * zones: 이 구역들 가운데 (near: 거점과 맞닿은 곳), zone: 그 구역, notZone: 그 구역(우리 거점)만 아니면 담 밖 어디든, enemyOf: 이 무리와 적대하는 무리의 땅. label은 보여 줄 말
   */
  place: z
    .strictObject({ zone: z.string().nullable(), notZone: z.string().nullable(), enemyOf: z.string().nullable(), label: z.string(), zones: z.array(z.string()).optional() })
    .nullable()
    .default(null),
  /** 요구 조건별 진행도: 활동은 누적 분, 판정은 충족 시 1 */
  progress: z.array(z.number().int().nonnegative()),
  /** 판정 조건별 실패 수 (플레이 테스트 11, C2): MISSION_CHECK_TRIES번 실패하면 그 조건은 이 임무에서 닫힌다 */
  fails: z.array(z.number().int().nonnegative()).default([]),
  /** 조건을 모두 채운 시각 (플레이 테스트 13: 기한은 보고·활동이 끝난 때가 아니라 이때로 본다) */
  metAt: z.number().int().optional(),
  /** 탓할 수 없이 못 마쳤다 (붙잡혀·다쳐서): 공적·불복종·진급 셈에서 뺀다. 보여 줄 말 (플레이 테스트 13) */
  excused: z.string().optional(),
  /** 들키지 않기가 조건인 일 (템플릿의 unseen 사본)과, 들켰는지 */
  unseen: z.boolean().optional(),
  spotted: z.boolean().optional(),
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
/** 이만큼(분) 이하의 시간 조건에 판정 하나뿐인 일감은 짧은 일감이다 (완수 공적 +2) */
export const SHORT_MISSION_MINUTES = 60;

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
  // 관계 범위 ±10에 맞춰 두 배 (12-251에서 빠졌던 것, 12-257)
  minCommanderTrust: 6,
  /** 최근 이만큼(일) 안의 흠을 본다: 실패·기한 초과·포기가 setbacks 이상이거나 상관이 덜 믿게 된 일이 있으면 미룬다 (일부 완수는 세지 않는다, 플레이 테스트 13) */
  recentDays: 3,
  setbacks: 2,
} as const;

/** 진급을 미루게 하는 최근의 흠 (C5). 없으면 null */
export function recentSetback(
  state: { time: GameTime; missions: Record<string, MissionInstance>; trustDroppedAt?: Record<string, number>; trustDroppedWhy?: Record<string, string> },
  characterId: string,
  commanderId: string | null,
): string | null {
  const since = state.time - PROMOTION.recentDays * MINUTES_PER_DAY;
  const bad = Object.values(state.missions).filter((m) => m.assigneeId === characterId && m.assignedAt >= since && ["failed", "expired", "abandoned"].includes(m.status) && !m.excused).length;
  if (bad >= PROMOTION.setbacks) return `최근 ${PROMOTION.recentDays}일 사이 임무 ${bad}번이 뜻대로 되지 않았다`;
  if (commanderId && (state.trustDroppedAt?.[commanderId] ?? -Infinity) >= since) {
    const at = state.trustDroppedAt![commanderId]!;
    const why = state.trustDroppedWhy?.[commanderId];
    // 까닭에 이미 날짜가 있으면 그것만 (12-261, PT16 졸병: "(4일차: 2일차의 일 — …)")
    return `최근 ${PROMOTION.recentDays}일 사이 상관의 믿음을 잃은 일이 있다 (${why && /\d+일차/.test(why) ? why : `${Math.floor(at / MINUTES_PER_DAY) + 1}일차${why ? `: ${why}` : ""}`})`;
  }
  return null;
}

/** 하루에 상관이 내놓는 임무 수 */
export const OFFERS_PER_DAY = 2;

/** 판정 조건이 실패로 닫혔는가 (C2) */
export function isRequirementClosed(mission: Pick<MissionInstance, "requirements" | "progress" | "fails">, i: number): boolean {
  const r = mission.requirements[i];
  return !!r && "check" in r && (mission.progress[i] ?? 0) < 1 && (mission.fails?.[i] ?? 0) >= MISSION_CHECK_TRIES;
}

/** 조건을 이제 막 다 채웠으면 그 시각을 적는다 (이미 적었으면 그대로) */
export function markMissionMet(mission: MissionInstance, at: number): void {
  if (mission.metAt === undefined && mission.requirements.every((r, i) => isRequirementMet(r, mission.progress[i] ?? 0))) mission.metAt = at;
}

/** 끝난 임무의 결과 표시 (탓할 수 없이 못 마친 것은 그 까닭으로) */
export function missionStatusLabel(m: Pick<MissionInstance, "status" | "excused">): string {
  return m.excused ?? MISSION_STATUS_LABELS[m.status];
}

export function isRequirementMet(requirement: MissionRequirement, progress: number): boolean {
  return "activity" in requirement ? progress >= requirement.minutes : progress >= 1;
}

export type MissionEvaluation = { outcome: "success" | "partial" | "failed"; late: boolean; merit: number };

/** 보고 시점의 결과와 공적 */
export function evaluateMission(mission: MissionInstance, now: GameTime, collectShort = false): MissionEvaluation {
  const met = mission.requirements.filter((r, i) => isRequirementMet(r, mission.progress[i] ?? 0)).length;
  const full = met === mission.requirements.length ? "success" : met > 0 ? "partial" : "failed";
  // 들키지 않기가 조건인 일에서 들켰으면 일부 완수까지 (플레이 테스트 13)
  // 받아 올 값이 모자라도 일부 완수까지 (collectShort, 12-237)
  const outcome = full === "success" && ((mission.unseen && mission.spotted) || collectShort) ? "partial" : full;
  // 조건을 기한 안에 다 채웠으면 보고가 늦어도 기한 초과가 아니다 (플레이 테스트 13)
  const late = (mission.metAt ?? now) > mission.deadline;
  const timeOnly = mission.requirements.every((r) => "activity" in r);
  // 짧은 일감 (플레이 테스트 13: 판정 하나와 1시간으로 +3, 3일차에 공적 15): 판정 조건 하나에 시간 조건이 1시간 이하면 시간만 채우는 일감과 같게
  const checks = mission.requirements.filter((r) => "check" in r).length;
  const minutes = mission.requirements.reduce((n, r) => n + ("activity" in r ? r.minutes : 0), 0);
  const short = checks === 1 && minutes <= SHORT_MISSION_MINUTES && mission.requirements.every((r) => "check" in r || "activity" in r);
  const base = outcome === "success" && (timeOnly || short) ? MERIT.success_time_only : MERIT[outcome];
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
  if (p.zones) return p.zones.includes(zone);
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

/** 다 채운 복무 날 수: 날짜로 센다 (12-292, PT22~24 섬·튜토리얼: 머리 줄은 "복무 4일째", 진급 줄은 "복무 3일째") */
export function daysServed(now: GameTime, runStartedAt: GameTime): number {
  return Math.max(0, Math.floor(now / MINUTES_PER_DAY) - Math.floor(runStartedAt / MINUTES_PER_DAY));
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
  // 다 채운 날 수로 센다. 보여 주는 말은 시계("복무 N일째")와 같은 셈으로 (플레이 테스트 12·14: "복무 1일째"인데 "복무 0/7일"로 어긋나 보였다)
  if (days < PROMOTION.minDaysServed) missing.push(`복무 ${days + 1}일째 (${PROMOTION.minDaysServed}일을 다 채운 ${PROMOTION.minDaysServed + 1}일째부터)`);
  if (character.disobedience > maxDisobedience) {
    missing.push(`임무 불복종 ${character.disobedience}회 (최대 ${maxDisobedience}회)`);
  }
  if (commanderTrust !== null && commanderTrust < PROMOTION.minCommanderTrust) {
    // 신뢰를 올리는 길을 함께 (12-221: 판정이 걸린 임무를 완전히 해내면 하루 +1까지)
    missing.push(`상관 신뢰 ${commanderTrust}/${PROMOTION.minCommanderTrust} (판정이 걸린 임무를 완전히 해내면 하루에 1씩 오른다)`);
  }
  return { eligible: missing.length === 0, missing };
}

/** 오늘의 임무 후보를 고른다. 이미 오늘 골랐으면 null */
/** 위험 임무: 무기고가 무기를 빌려주는 작전이거나 적 땅에서 하는 일 (12-239) */
export function riskyMission(m: { armed?: boolean | undefined; where?: string | readonly string[] | undefined }): boolean {
  return !!m.armed || m.where === "enemy";
}

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
  /** 받을 사람이 할 수 있는 판정인지 (플레이 테스트 12: 배우지 않은 전문 기술의 임무가 나와 일부 완수가 쌓였다) */
  canDo?: (move: string) => boolean,
  /** 최근에 받은 일감 (플레이 테스트 13: "약 찾아오기"가 1·3·4·7일차). 다른 후보가 모자랄 때만 다시 낸다 */
  recent: readonly string[] = [],
  /** 위험 임무(작전·적 땅)를 내지 않는다: 막 들어온 유예, 중상 이상 (12-239) */
  safeOnly = false,
  /** 받을 사람에게 보정이 음수인 판정인지 (설계 목록 5-3, PT16·17 섬: 스킬 -1인 새 식구에게 판정 두 개짜리). 다른 후보가 있으면 뒤로 미룬다 */
  weakAt?: (move: string) => boolean,
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
    .filter((id) => !canDo || content.missions[id]!.requirements.every((r) => !("check" in r) || canDo(r.check)))
    .filter((id) => !safeOnly || !riskyMission(content.missions[id]!))
    .filter((id) => {
      const where = content.missions[id]!.where;
      if (!lost?.factionId || !where || where === "outside" || where === "near" || where === "enemy") return true;
      return (Array.isArray(where) ? where : [where]).every((z) => content.locations[z]?.owner !== lost.factionId || lost.owners[z]?.owner === lost.factionId);
    });
  if (pool.length === 0) return null;
  const picked: string[] = [];
  const count = Math.min(OFFERS_PER_DAY, pool.length);
  // 최근에 받은 일감은 다른 후보가 있으면 쉰다 (공통 규칙 5)
  // 약한 일감(받을 사람의 보정이 음수인 판정이 든 것)은 최근에 한 일감보다도 뒤다 (설계 목록 5-3, PT21 섬: 같은 통에서 무작위로 뽑혔다)
  const weak = (id: string) => !!weakAt && content.missions[id]!.requirements.some((r) => "check" in r && weakAt(r.check));
  const strong = pool.filter((id) => !weak(id));
  const fresh = preferRested(strong, (id) => recent.includes(id));
  const stale = strong.filter((id) => !fresh.includes(id));
  const weakest = pool.filter(weak);
  // 하나는 늘 역할 일감에서, 직분 일감은 하루 하나까지 (플레이 테스트 13: 한 통에서 뽑아 상단 일감 8종 중 3종만 나왔다)
  // 역할 일감이 모두 약하면 그 몫을 고집하지 않는다 (PT21 분대장: 안전 모드에서 통솔 -3인 분대 훈련만 이틀 내리)
  const own = new Set(content.roles[roleId]?.missions ?? []);
  const isExtra = (id: string) => !own.has(id) && extra.includes(id);
  const roleFirst = pool.some((x) => !isExtra(x) && !weak(x));
  const allowed = (id: string) => (picked.length === 0 && roleFirst ? !isExtra(id) : !isExtra(id) || !picked.some(isExtra));
  while (picked.length < count) {
    // 역할·직분 몫이 쉬기보다 먼저다: 쉬는 일감밖에 없으면 쉬는 역할 일감을 다시 낸다. 약한 일감은 맨 뒤
    const choice = [fresh.filter(allowed), stale.filter(allowed), fresh, stale, weakest.filter(allowed), weakest].find((c) => c.length)!;
    const id = choice[Math.floor(rng() * choice.length)]!;
    for (const list of [fresh, stale, weakest]) if (list.includes(id)) list.splice(list.indexOf(id), 1);
    picked.push(id);
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
    characters: Record<string, { dead: boolean; away?: unknown; captive?: Held | null; rank?: string; factionId?: string | null }>;
  },
  content: { roles: Record<string, { commander?: string | undefined; faction?: string | null | undefined; rank?: string | undefined }>; scenario?: { rank_ladder: readonly { id: string; level: number }[] }; npcs?: Record<string, unknown> },
): string | null {
  const id = content.roles[state.roleId]?.commander;
  const usable = (cid: string) => cid !== state.playerId && !!state.characters[cid] && !state.characters[cid]!.dead && !state.characters[cid]!.away && !heldOf(state.characters[cid]!);
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

/**
 * 이 스킬의 판정이 진행 중인 임무의 요건이면 그 임무 id (임무 장소에서만). 잠입처럼 도구가 굴리는 판정도 임무로 센다
 * (12-261, PT16 졸병: 잠입의 은밀·수색이 "붉은연합 보급 털기"로 세지지 않았다)
 */
export function missionForCheck(state: import("../game/state.ts").GameState, move: string): string | null {
  const m = activeMissionOf(state.missions, state.playerId);
  if (!m || heldOf(state.characters[state.playerId])) return null;
  if (!atMissionPlace(m, state.playerZone, state.zones, state.factions)) return null;
  return m.requirements.some((r) => "check" in r && (r.check === move || !!r.alts?.includes(move))) ? m.id : null;
}
