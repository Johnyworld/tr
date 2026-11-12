import { z } from "zod";
import type { Rng } from "../rng.ts";
import { segmentOf, type GameTime, type TimeSegment } from "../rules/time.ts";
import type { BeliefSource } from "./belief.ts";

/**
 * 평판과 소문 (기획서 8장).
 * 플레이어 행동 → 태그 → 목격자 → 하루 단위 전파 → 들은 NPC가 자기 가치관으로 판단해 관계 변화.
 * 숫자는 모두 코드가 계산한다. AI는 행동을 태그와 심각도로 분류할 뿐이다.
 */

// ── 관계 ──────────────────────────────────────────────

export const RELATION_AXES = ["trust", "affection", "respect"] as const;
export type RelationAxis = (typeof RELATION_AXES)[number];
export const RELATION_AXIS_LABELS: Record<RelationAxis, string> = { trust: "신뢰", affection: "호감", respect: "존중" };

export const RELATION_MIN = -5;
export const RELATION_MAX = 5;

const relationValue = z.number().int().min(RELATION_MIN).max(RELATION_MAX);
export const relationSchema = z.strictObject({ trust: relationValue, affection: relationValue, respect: relationValue });
export type Relation = z.infer<typeof relationSchema>;
export const NEUTRAL_RELATION: Relation = { trust: 0, affection: 0, respect: 0 };

export const relationDeltaSchema = z.strictObject({
  trust: z.number().int(),
  affection: z.number().int(),
  respect: z.number().int(),
});
export type RelationDelta = z.infer<typeof relationDeltaSchema>;

export function applyRelationDelta(relation: Relation, delta: RelationDelta): Relation {
  const clamp = (n: number) => Math.max(RELATION_MIN, Math.min(RELATION_MAX, n));
  return {
    trust: clamp(relation.trust + delta.trust),
    affection: clamp(relation.affection + delta.affection),
    respect: clamp(relation.respect + delta.respect),
  };
}

/** 관계 수치의 말 표현 */
export function relationLabel(value: number): string {
  if (value <= -3) return "적대";
  if (value <= -1) return "냉담";
  if (value === 0) return "보통";
  if (value <= 2) return "호의";
  return "각별";
}

// ── 행동 태그 ─────────────────────────────────────────

export const DEED_TAGS = [
  "diligence",
  "disobedience",
  "mercy",
  "cruelty",
  "theft",
  "deceit",
  "honesty",
  "bravery",
  "cowardice",
  "loyalty",
  "betrayal",
  "selfishness",
  "enemy_sympathy",
] as const;
export type DeedTag = (typeof DEED_TAGS)[number];
export const deedTagSchema = z.enum(DEED_TAGS);

export const DEED_TAG_LABELS: Record<DeedTag, string> = {
  diligence: "성실",
  disobedience: "명령 불복종",
  mercy: "자비",
  cruelty: "잔혹",
  theft: "도둑질",
  deceit: "거짓말",
  honesty: "정직",
  bravery: "용기",
  cowardice: "비겁",
  loyalty: "동료를 위함",
  betrayal: "배신",
  selfishness: "제 몫 챙기기",
  enemy_sympathy: "적에게 호의",
};

/**
 * 태그별 판단 규칙 (임시값).
 * - dim이 있으면: 듣는 NPC의 가치관 점수(-3~+3) × sign 만큼 반응한다 (규율을 중시하는 사람은 불복종에 크게 실망)
 * - base는 가치관과 무관하게 모두가 똑같이 반응하는 몫이다 (용기는 누구나 존중)
 * 계산: sign × (가치관 + base) × 심각도. sign이 -1이면 base도 함께 뒤집히므로 base는 "반응의 크기"로 양수를 쓴다
 */
type TagRule = { dim?: string; sign: 1 | -1; base?: number; axes: readonly RelationAxis[] };

export const TAG_RULES: Record<DeedTag, TagRule> = {
  diligence: { dim: "discipline", sign: 1, base: 1, axes: ["trust", "respect"] },
  disobedience: { dim: "discipline", sign: -1, axes: ["trust", "respect"] },
  mercy: { dim: "mercy", sign: 1, axes: ["affection"] },
  cruelty: { dim: "mercy", sign: -1, axes: ["affection", "trust"] },
  theft: { dim: "honesty", sign: -1, base: 1, axes: ["trust"] },
  deceit: { dim: "honesty", sign: -1, axes: ["trust"] },
  honesty: { dim: "honesty", sign: 1, axes: ["trust"] },
  bravery: { sign: 1, base: 2, axes: ["respect"] },
  cowardice: { sign: -1, base: 2, axes: ["respect"] },
  loyalty: { dim: "loyalty", sign: 1, base: 1, axes: ["affection", "trust"] },
  betrayal: { dim: "loyalty", sign: -1, base: 1, axes: ["trust", "affection"] },
  selfishness: { dim: "self_interest", sign: 1, axes: ["respect"] },
  enemy_sympathy: { dim: "loyalty", sign: -1, axes: ["trust"] },
};

/** 정보 출처별 영향력 (기획서 8.4: 직접 목격 > 전해 들음 > 소문) */
export const SOURCE_WEIGHT: Record<BeliefSource, number> = { seen: 1, report: 0.6, rumor: 0.3 };

/** 행동 하나로 한 축이 한 번에 움직이는 최대치 */
export const MAX_DELTA_PER_DEED = 3;

/**
 * 관계 변화량 = 태그 × NPC 가치관 × 심각도 × 정보 신뢰도 (기획서 8.1, 관계 축별)
 */
export function computeRelationDelta(
  values: Record<string, number>,
  tags: readonly DeedTag[],
  severity: number,
  source: BeliefSource,
): RelationDelta {
  const acc: Record<RelationAxis, number> = { trust: 0, affection: 0, respect: 0 };
  for (const tag of tags) {
    const rule = TAG_RULES[tag];
    const raw = rule.sign * ((rule.dim ? (values[rule.dim] ?? 0) : 0) + (rule.base ?? 0)) * severity;
    for (const axis of rule.axes) acc[axis] += raw;
  }
  const scale = (n: number) => {
    const v = Math.round((n * SOURCE_WEIGHT[source]) / 3);
    return Math.max(-MAX_DELTA_PER_DEED, Math.min(MAX_DELTA_PER_DEED, v)) || 0;
  };
  return { trust: scale(acc.trust), affection: scale(acc.affection), respect: scale(acc.respect) };
}

// ── 행적과 목격자 ─────────────────────────────────────

/** 장소의 노출도. 장소 시스템이 생기기 전까지 GM이 분류한다 (임시값) */
export const PRIVACY_LEVELS = ["public", "semi_private", "private"] as const;
export type Privacy = (typeof PRIVACY_LEVELS)[number];
export const privacySchema = z.enum(PRIVACY_LEVELS);
export const PRIVACY_EXPOSURE: Record<Privacy, number> = { public: 0.6, semi_private: 0.25, private: 0.05 };

export const TIME_EXPOSURE: Record<TimeSegment, number> = {
  dawn: 0.6,
  morning: 1,
  day: 1,
  evening: 0.7,
  night: 0.4,
};

export const NOISE_FACTOR = 1.8;

export const deedSchema = z.strictObject({
  id: z.string(),
  actorId: z.string(),
  summary: z.string(),
  tags: z.array(deedTagSchema).min(1),
  severity: z.number().int().min(1).max(3),
  at: z.number().int(),
  /** 목격자. hidden은 플레이어 화면과 GM 프롬프트에 나오지 않는다 */
  witnesses: z.array(z.strictObject({ npcId: z.string(), hidden: z.boolean() })),
  /** 숨은 목격자를 살펴봤는지 (행적 하나에 한 번) */
  searched: z.boolean().default(false),
});
export type Deed = z.infer<typeof deedSchema>;

/**
 * 숨은 목격자 확률 (기획서 8.2). 장면에 없는 NPC마다 따로 굴린다.
 * exposure × 시간대 × 소음 × 주의력 × 은밀 보정
 */
export function hiddenWitnessChance(input: {
  privacy: Privacy;
  time: GameTime;
  noisy: boolean;
  senseStat: number;
  /** 이번 턴 은밀 행동 판정 결과 (없으면 null) */
  stealth: "success" | "partial" | "miss" | null;
}): number {
  const alertness = 0.5 + 0.1 * input.senseStat;
  const stealth = input.stealth === "success" ? 0.3 : input.stealth === "partial" ? 0.6 : 1;
  const p =
    PRIVACY_EXPOSURE[input.privacy] *
    TIME_EXPOSURE[segmentOf(input.time)] *
    (input.noisy ? NOISE_FACTOR : 1) *
    alertness *
    stealth;
  return Math.min(0.95, Math.max(0, p));
}

// ── 소문 전파 ─────────────────────────────────────────

/** 하루에 한 사람이 다른 한 사람에게 이야기를 옮길 확률 (임시값). 말 많은 사람은 두 배 */
export const SPREAD_CHANCE = 0.2;
export const TALKATIVE_FACTOR = 2;

/** 이야기를 옮기면 출처가 한 단계 흐려진다. 소문은 더 퍼지지 않는다 (MVP: 왜곡 없음) */
export function nextSource(source: BeliefSource): BeliefSource | null {
  return source === "seen" ? "report" : source === "report" ? "rumor" : null;
}

export type SpreadCandidate = { deedId: string; npcId: string; source: BeliefSource };

/**
 * 하루치 1단계 전파. 오늘 아침 기준으로 아는 사람만 옮긴다 (같은 날 여러 번 건너가지 않음).
 * knowledge: NPC → (행적 → 출처)
 */
export function spreadOneDay(input: {
  deeds: readonly Deed[];
  knowledge: Record<string, Record<string, BeliefSource>>;
  npcIds: readonly string[];
  isTalkative: (npcId: string) => boolean;
  rng: Rng;
}): SpreadCandidate[] {
  const learned: SpreadCandidate[] = [];
  const taken = new Set<string>();
  for (const deed of input.deeds) {
    for (const teller of input.npcIds) {
      const source = input.knowledge[teller]?.[deed.id];
      const passed = source ? nextSource(source) : null;
      if (!passed) continue;
      const chance = SPREAD_CHANCE * (input.isTalkative(teller) ? TALKATIVE_FACTOR : 1);
      for (const listener of input.npcIds) {
        const key = `${deed.id}:${listener}`;
        if (listener === teller || listener === deed.actorId || input.knowledge[listener]?.[deed.id] || taken.has(key)) {
          continue;
        }
        if (input.rng() < chance) {
          taken.add(key);
          learned.push({ deedId: deed.id, npcId: listener, source: passed });
        }
      }
    }
  }
  return learned;
}
