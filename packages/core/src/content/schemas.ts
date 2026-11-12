import { z } from "zod";
import { ACTIVITIES, TIME_SEGMENTS } from "../rules/time.ts";
import { beliefAccuracySchema, beliefSourceSchema } from "../game/belief.ts";
import { deedTagSchema, privacySchema, RELATION_AXES } from "../game/reputation.ts";
import { createStatsSchema } from "../game/character.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { moveIds, rankIds } from "../scenario/scenario.ts";

/**
 * 콘텐츠 YAML 스키마. 키는 YAML과 같은 snake_case를 쓴다.
 * 능력치·등급·행동처럼 시나리오가 정하는 ID가 들어가므로 시나리오를 받아 만든다 (기획서 12.3).
 * 스키마를 바꾸면 content/ 의 기존 파일도 함께 고친다 (pnpm content:check 로 확인).
 */

export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");

export const itemContentSchema = z.strictObject({
  id: contentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ItemContent = z.infer<typeof itemContentSchema>;

/** 가치관 점수 (-3 ~ +3). 평판·관계 계산에 쓴다 (기획서 8.1) */
export const valueScoreSchema = z.number().int().min(-3).max(3);

/** 시나리오에 맞춘 콘텐츠 스키마들 */
export function createContentSchemas(s: Scenario) {
  const role = z.strictObject({
    id: contentIdSchema,
    label: z.string().min(1),
    faction: contentIdSchema,
    rank: idEnum(rankIds(s)),
    default_name: z.string().min(1),
    age: z.number().int().positive(),
    /** 시작 장면. 화면에 먼저 보여 주고 GM 프롬프트에도 넣는다 */
    opening_scene: z.string().min(1),
    /** 정해진 능력 (특별한 역할·테스트용). 없으면 시나리오의 ability_array를 무작위로 섞는다 — 능력은 계급과 무관하다 */
    start_stats: createStatsSchema(s).optional(),
    /** 이 역할이 받은 훈련 (스킬 id → 수준). 나머지는 스킬의 기본값 */
    start_skills: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(s.ranges.skill.min).max(s.ranges.skill.max)).default({}),
    start_inventory: z.array(contentIdSchema),
    start_location: contentIdSchema.optional(),
    access: z.array(contentIdSchema).default([]),
    beliefs_preset: contentIdSchema.optional(),
    /** 시작할 때 알고 있는 인물 */
    known_npcs: z.array(contentIdSchema).default([]),
    /** 직속 상관 NPC. 임무를 주고 보고를 받는다 */
    commander: contentIdSchema.optional(),
    /** 이 역할에 내려오는 임무 템플릿 */
    missions: z.array(contentIdSchema).default([]),
    storylet_tags: z.array(contentIdSchema).default([]),
  });


  /** NPC 정적 프로필 (기획서 7.1). 동적 상태(부상·소지품·Belief)는 세이브에 있다 */
  const npc = z.strictObject({
    id: contentIdSchema,
    name: z.string().min(1),
    faction: contentIdSchema,
    rank: idEnum(rankIds(s)),
    age: z.number().int().positive(),
    look: z.string().min(1),
    /** 거점 사람들이 아는 모습. 이 인물을 아는 캐릭터에게 보인다 */
    reputation: z.string().min(1),
    want: z.string().min(1),
    fear: z.string().min(1),
    values: z.record(contentIdSchema, valueScoreSchema),
    temperament: z.array(contentIdSchema),
    voice: z.strictObject({
      style: z.string().min(1),
      samples: z.array(z.string().min(1)).min(1).max(4),
    }),
    routine: z.partialRecord(z.enum(TIME_SEGMENTS), z.string().min(1)),
    rules: z.array(z.string().min(1)),
    /** 이 인물이 아는 것. 시작 Belief가 된다 */
    knows: z.array(z.string().min(1)).default([]),
    /** 이 인물이 모르는 것 (세계의 진실). 작성자 메모이며 GM 프롬프트에 절대 넣지 않는다 */
    doesnt_know: z.array(z.string().min(1)).default([]),
    /** 비밀. 공개 조건이 충족되기 전에는 GM 프롬프트에 넣지 않는다 */
    secret: z
      .strictObject({
        content: z.string().min(1),
        /** 공개 상황 (GM이 판단하는 서술 조건) */
        reveal_when: z.string().min(1),
        /** 공개에 필요한 이 인물의 플레이어에 대한 신뢰 (코드가 검사) */
        min_trust: z.number().int().min(1).max(5),
      })
      .optional(),
    stats: createStatsSchema(s),
    /** 이 인물의 스킬 (나머지는 기본값) */
    skills: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(s.ranges.skill.min).max(s.ranges.skill.max)).default({}),
    /** 성별 id (시나리오 creation.genders) */
    gender: (s.creation ? idEnum(s.creation.genders.map((g) => g.id)) : z.string()).optional(),
    start_inventory: z.array(contentIdSchema).default([]),
    /** 사망 후 이 인물로 이어서 플레이할 수 있는지 */
    playable: z.boolean().default(false),
    /** 치료사: 장면에 있으면 치료(take_action.treatment)를 해 줄 수 있다 */
    healer: z.boolean().default(false),
    /** 주로 머무는 전선 구역. 플레이어가 그 구역에 있으면 GM이 등장시킬 수 있다 */
    zone: contentIdSchema.optional(),
  });

  /** 역할별 시작 지식 */
  const beliefPreset = z.strictObject({
    id: contentIdSchema,
    beliefs: z.array(
      z.strictObject({
        fact: z.string().min(1).max(300),
        source: beliefSourceSchema,
        accuracy: beliefAccuracySchema.exclude(["unknown"]),
      }),
    ),
  });

  /** 임무 요구 조건. 임무를 받은 뒤의 이벤트로 코드가 집계한다 */
  const missionRequirement = z.union([
    z.strictObject({ activity: z.enum(ACTIVITIES), minutes: z.number().int().positive() }),
    z.strictObject({ check: idEnum(moveIds(s)), min_outcome: z.enum(["success", "partial"]) }),
  ]);

  /** 임무 템플릿 (기획서 15.1: 배정 → 수행 → 보고) */
  const mission = z.strictObject({
    id: contentIdSchema,
    title: z.string().min(1),
    briefing: z.string().min(1),
    giver_rank: idEnum(rankIds(s)),
    deadline_hours: z.number().int().positive().max(72),
    requirements: z.array(missionRequirement).min(1),
    /** 완수하면 이 세력 클락을 당긴다 (일부 완수는 절반). 전선 임무가 우리 무리의 계획을 앞당긴다 */
    advances: z.strictObject({ clock: contentIdSchema, delta: z.number().int().min(-5).max(5) }).optional(),
  });

  const resourceAmounts = z.partialRecord(idEnum(s.resources.map((r) => r.id)), z.number().min(0));

  /**
   * 세력 (기획서 9.1). 숫자는 시작값이고, 이후 값은 세이브의 세력 상태에 있다.
   * public만 플레이어가 아는 정보다. 나머지(자원, 클락)는 정보 필터를 거쳐 대략만 드러난다.
   */
  const faction = z.strictObject({
    id: contentIdSchema,
    name: z.string().min(1),
    /** 누구나 아는 평판 */
    public: z.string().min(1),
    population: z.number().int().positive(),
    combatants: z.number().int().min(0),
    resources: resourceAmounts,
    /** -3 ~ +3 */
    morale: z.number().int().min(-3).max(3),
    /** 내부 결속 -3 ~ +3. 낮으면 이탈이 생긴다 */
    cohesion: z.number().int().min(-3).max(3),
    /** 공격 성향 0 ~ 3. 0이면 먼저 공격하지 않는다 */
    aggression: z.number().int().min(0).max(3),
    /** 다른 세력에 대한 태도 -3 ~ +3 (없으면 0). -2 이하면 적대 */
    disposition: z.record(contentIdSchema, z.number().int().min(-3).max(3)).default({}),
    /** 세력 클락: 하루에 한 칸씩 차고, 다 차면 목표 구역을 총공격한다. 그 세력 사람만 안다 */
    plans: z
      .array(
        z
          .strictObject({
            id: contentIdSchema,
            label: z.string().min(1),
            /** fixed: target 구역을 친다 / frontier: 다 찼을 때 맞닿은 적의 구역 중 가장 값진 곳 (잃은 땅 먼저) */
            target_rule: z.enum(["fixed", "frontier"]).default("fixed"),
            target: contentIdSchema.optional(),
            days: z.number().int().positive(),
          })
          .refine((p) => p.target_rule === "frontier" || !!p.target, "fixed 계획에는 target이 있어야 한다"),
      )
      .default([]),
    minor: z.boolean().default(false),
  });

  /**
   * 전선의 구역 (9단계 전쟁 지도). 장소 시스템이 생기면 장소의 상위 단위가 된다.
   * 인접은 한쪽에만 적어도 양쪽으로 본다.
   */
  const location = z.strictObject({
    id: contentIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    /** base: 거점 (습격은 받지만 빼앗기지 않는다, MVP) */
    kind: z.enum(["base", "zone"]),
    /** 시작 소유 세력. 없으면 누구의 땅도 아니다 */
    owner: contentIdSchema.nullable().default(null),
    adjacent: z.array(contentIdSchema).default([]),
    /** 소유 세력이 하루에 얻는 자원 */
    yields: resourceAmounts.default({}),
  });

  /** 스토리렛 효과. 코드가 검증하고 적용한다 (AI가 고르는 것은 선택지뿐이다) */
  const storyletEffect = z.union([
    z.strictObject({ set_flag: contentIdSchema }),
    z.strictObject({ clear_flag: contentIdSchema }),
    /** 배역(또는 commander)이 플레이어를 보는 관계 */
    z.strictObject({ relation: z.strictObject({ who: z.string().min(1), axis: z.enum(RELATION_AXES), delta: z.number().int().min(-3).max(3) }) }),
    z.strictObject({ belief: z.strictObject({ fact: z.string().min(1).max(300), source: beliefSourceSchema.default("seen") }) }),
    z.strictObject({ merit: z.number().int().min(-3).max(3) }),
    /** from이 있으면 그 배역에게서 옮기고(가진 것만), 없으면 새로 생긴다 (콘텐츠가 정한 보상) */
    z.strictObject({ give_item: z.strictObject({ item: contentIdSchema, from: z.string().optional(), quantity: z.number().int().positive().default(1) }) }),
    /** 플레이어가 내놓는다 (거래). 가진 것이 없으면 이 선택지를 고를 수 없다 */
    z.strictObject({ take_item: z.strictObject({ item: contentIdSchema, quantity: z.number().int().positive().default(1) }) }),
    /** 세력 클락을 당기거나 늦춘다 (플레이어 행동이 전황에 닿는 길) */
    z.strictObject({ clock: z.strictObject({ id: contentIdSchema, delta: z.number().int().min(-5).max(5) }) }),
    /** own = 플레이어 소속 */
    z.strictObject({ faction_morale: z.strictObject({ faction: z.string().min(1), delta: z.number().int().min(-1).max(1) }) }),
    z.strictObject({
      deed: z.strictObject({
        summary: z.string().min(1).max(120),
        tags: z.array(deedTagSchema).min(1).max(3),
        severity: z.number().int().min(1).max(3),
        privacy: privacySchema,
      }),
    }),
  ]);

  /** 배역 조건: 조건에 맞는 살아 있는 NPC 중 하나를 고른다 (템플릿의 "누가") */
  const castRole = z.strictObject({
    /** 이 중에서만 */
    ids: z.array(contentIdSchema).optional(),
    /** 플레이어의 직속 상관 */
    commander: z.boolean().default(false),
    /** own = 플레이어 소속, 또는 세력 id */
    faction: z.string().optional(),
    ranks: z.array(idEnum(rankIds(s))).optional(),
    /** 플레이어가 아는 인물만 */
    known: z.boolean().default(false),
    /** 이 인물의 플레이어에 대한 신뢰 하한 */
    trust_gte: z.number().int().optional(),
    /** 발동할 때 장면에 들어온다 */
    enter: z.boolean().default(true),
  });

  const storyletChoice = z
    .strictObject({
      id: contentIdSchema,
      label: z.string().min(1),
      /** 이 선택지는 이번 턴 이 행동의 판정 결과에 따라 갈린다 */
      check: idEnum(moveIds(s)).optional(),
      effects: z.array(storyletEffect).default([]),
      outcomes: z
        .strictObject({ success: z.array(storyletEffect), partial: z.array(storyletEffect), miss: z.array(storyletEffect) })
        .optional(),
    })
    .refine((c) => (c.check ? !!c.outcomes : !c.outcomes), "check가 있으면 outcomes를, 없으면 effects를 쓴다");

  /**
   * 스토리렛 (기획서 10.3). 조건(when)이 맞고 배역(cast)을 채울 수 있으면 발동한다.
   * repeatable이면 템플릿: 배역과 {zone} {scarce} 같은 자리를 세계 상태에서 채워 반복된다.
   */
  const storylet = z.strictObject({
    id: contentIdSchema,
    title: z.string().min(1),
    /** 역할의 storylet_tags와 겹쳐야 한다 (비어 있으면 모든 역할) */
    tags: z.array(contentIdSchema).default([]),
    repeatable: z.boolean().default(false),
    /** 잠을 깨울 만큼 급한 일인지. 아니면 자는 동안에는 열리지 않는다 */
    urgent: z.boolean().default(false),
    cooldown_days: z.number().min(0).default(0),
    weight: z.number().positive().default(1),
    when: z
      .strictObject({
        ranks: z.array(idEnum(rankIds(s))).optional(),
        segments: z.array(z.enum(TIME_SEGMENTS)).optional(),
        /** 계절 id */
        seasons: z.array(contentIdSchema).optional(),
        /** 날씨 id */
        weather: z.array(contentIdSchema).optional(),
        day_gte: z.number().int().optional(),
        /** 플레이어가 있는 구역 */
        zones: z.array(contentIdSchema).optional(),
        /** 우리 무리 구역에 있는지 */
        own_territory: z.boolean().optional(),
        flags_all: z.array(contentIdSchema).optional(),
        flags_none: z.array(contentIdSchema).optional(),
        /** 세력 클락 (플레이어는 모르는 값. 조건으로만 쓴다) */
        clock_gte: z.record(contentIdSchema, z.number().int()).optional(),
        clock_lte: z.record(contentIdSchema, z.number().int()).optional(),
        own_morale_lte: z.number().int().optional(),
        /** 우리 무리 식량이 며칠 치 이하 */
        own_food_days_lte: z.number().optional(),
        /** 부상 트랙이 이 단계 이상 */
        harm_at_least: z.string().optional(),
        has_items: z.array(contentIdSchema).optional(),
        mission_active: z.boolean().optional(),
        /** 최근 N시간 안에 전황 소식을 들었는지 */
        war_news_within_hours: z.number().positive().optional(),
      })
      .default({}),
    cast: z.record(contentIdSchema, castRole).default({}),
    /** 상황 (GM이 서술의 출발점으로 쓴다). {배역} {zone} {scarce}, 조사는 {friend:이/가} */
    setup: z.string().min(1),
    /** GM 전용 연출 지시 */
    ai_direction: z.string().optional(),
    choices: z.array(storyletChoice).min(1),
  });

  return { item: itemContentSchema, role, npc, beliefPreset, mission, faction, location, storylet };
}

type ContentSchemas = ReturnType<typeof createContentSchemas>;
export type RoleContent = z.infer<ContentSchemas["role"]>;
export type NpcContent = z.infer<ContentSchemas["npc"]>;
export type BeliefPreset = z.infer<ContentSchemas["beliefPreset"]>;
export type MissionContent = z.infer<ContentSchemas["mission"]>;
export type MissionRequirement = MissionContent["requirements"][number];
export type FactionContent = z.infer<ContentSchemas["faction"]>;
export type LocationContent = z.infer<ContentSchemas["location"]>;
export type StoryletContent = z.infer<ContentSchemas["storylet"]>;
export type StoryletChoice = StoryletContent["choices"][number];
export type StoryletEffect = StoryletChoice["effects"][number];

/** 게임이 쓰는 콘텐츠 전체. 단계별로 종류가 늘어난다 */
export type Content = {
  scenario: Scenario;
  items: Record<string, ItemContent>;
  roles: Record<string, RoleContent>;
  npcs: Record<string, NpcContent>;
  beliefs: Record<string, BeliefPreset>;
  missions: Record<string, MissionContent>;
  factions: Record<string, FactionContent>;
  locations: Record<string, LocationContent>;
  storylets: Record<string, StoryletContent>;
};
