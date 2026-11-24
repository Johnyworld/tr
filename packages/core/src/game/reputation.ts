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

// 관계 범위 (12-251): ±5 → ±10. 기준(문턱·말 표현·시작값)은 두 배로, 이야기·행동이 주는 변화량은 그대로라 관계가 두 배 느리게 오른다
export const RELATION_MIN = -10;
export const RELATION_MAX = 10;

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
  // 첫인상(±2 안쪽)은 "보통"으로 읽힌다 (12-251, 플레이 테스트 14: 같은 마을 사람이 냉담에서 시작했다)
  if (value <= -6) return "적대";
  if (value <= -3) return "냉담";
  if (value < 3) return "보통";
  // 각별은 가장 높은 값에서만 (플레이 테스트 12: 첫 만남에 +3으로 각별이 됐다)
  if (value < RELATION_MAX) return "호의";
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
  /** 남의 땅에 몰래 들어갔다 들켰다 (플레이 테스트 13: [거짓말]로 남았다). 듣는 사람의 마음은 움직이지 않고 기록만 남는다. 그 무리와의 사이는 공통 규칙 3이 바꾼다 */
  "trespass",
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
  trespass: "침입",
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
  trespass: { sign: -1, axes: [] },
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
  /** 성인 옵션이 켜져 있을 때 보이는 글 (summary는 순화한 겉 글, 공통 규칙 21 rules/lens.ts) */
  mature: z.string().optional(),
  tags: z.array(deedTagSchema).min(1),
  severity: z.number().int().min(1).max(3),
  at: z.number().int(),
  /** 목격자. hidden은 플레이어 화면과 GM 프롬프트에 나오지 않는다 */
  witnesses: z.array(z.strictObject({ npcId: z.string(), hidden: z.boolean() })),
  /** 숨은 목격자를 살펴봤는지 (행적 하나에 한 번) */
  searched: z.boolean().default(false),
  /** 그 짓이 끝난 때 (오래 걸린 행동, 설계 목록 2-1: 규율 회의는 끝난 때부터 센다) */
  endedAt: z.number().int().optional(),
  /** 도둑질로 가져온 물건 (설계 목록 2-4: 벌을 받아들이면 돌려놓는다). returned면 돌려놓았다 */
  items: z.record(z.string(), z.number().int().positive()).optional(),
  returned: z.boolean().optional(),
  /**
   * 지어낸 행적 (12-151, 소문 조작): actorId는 하지 않은 일이다. by는 지어낸 사람.
   * 듣는 사람은 진짜로 믿고 똑같이 퍼뜨린다. 지어낸 사람과 누명을 쓴 사람만 거짓인 줄 안다
   */
  fabricatedBy: z.string().optional(),
  /** GM이 take_action.deed로 남긴 행적 (이야기의 같은 행적을 겹쳐 남기지 않을 때 이것만 본다, 플레이 테스트 12) */
  byGm: z.boolean().optional(),
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
  /** 날씨의 시야 배수 (비·안개는 1보다 작다). 없으면 1 */
  visibility?: number;
  /** 트레잇 배수 (목격자의 주의력 × 하는 사람이 눈에 띄는지). 없으면 1 */
  traitFactor?: number;
}): number {
  const alertness = 0.5 + 0.1 * input.senseStat;
  const stealth = input.stealth === "success" ? 0.3 : input.stealth === "partial" ? 0.6 : 1;
  const p =
    PRIVACY_EXPOSURE[input.privacy] *
    TIME_EXPOSURE[segmentOf(input.time)] *
    (input.noisy ? NOISE_FACTOR : 1) *
    alertness *
    stealth *
    (input.visibility ?? 1) *
    (input.traitFactor ?? 1);
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

export type SpreadCandidate = { deedId: string; npcId: string; source: BeliefSource; teller: string };

/**
 * 하루치 1단계 전파. 오늘 아침 기준으로 아는 사람만 옮긴다 (같은 날 여러 번 건너가지 않음).
 * knowledge: NPC → (행적 → 출처)
 */
export function spreadOneDay(input: {
  deeds: readonly Deed[];
  knowledge: Record<string, Record<string, BeliefSource>>;
  npcIds: readonly string[];
  /** 이 사람이 소문을 옮기는 배수 (트레잇: 수다쟁이 ×2 등) */
  spreadFactor: (npcId: string) => number;
  rng: Rng;
  /** teller가 listener에게 이 행적을 옮길 수 있는가 (12-127: 무리 안 / 말이 모이는 곳). 없으면 누구에게나 */
  canPass?: (deed: Deed, teller: string, listener: string) => boolean;
  /** 소문으로만 들은 사람도 다시 옮기는가 (12-127: 이름난 사람의 소문). 없으면 옮기지 않는다 */
  relayRumor?: (deed: Deed) => boolean;
}): SpreadCandidate[] {
  const learned: SpreadCandidate[] = [];
  const taken = new Set<string>();
  for (const deed of input.deeds) {
    for (const teller of input.npcIds) {
      const source = input.knowledge[teller]?.[deed.id];
      const passed = source ? (nextSource(source) ?? (source === "rumor" && input.relayRumor?.(deed) ? "rumor" : null)) : null;
      if (!passed) continue;
      const chance = Math.min(1, SPREAD_CHANCE * input.spreadFactor(teller));
      for (const listener of input.npcIds) {
        const key = `${deed.id}:${listener}`;
        if (listener === teller || listener === deed.actorId || input.knowledge[listener]?.[deed.id] || taken.has(key)) {
          continue;
        }
        if (input.canPass && !input.canPass(deed, teller, listener)) continue;
        if (input.rng() < chance) {
          taken.add(key);
          learned.push({ deedId: deed.id, npcId: listener, source: passed, teller });
        }
      }
    }
  }
  return learned;
}
