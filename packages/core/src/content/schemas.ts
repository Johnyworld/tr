import { z } from "zod";
import { ACTIVITIES, TIME_SEGMENTS } from "../rules/time.ts";
import { beliefAccuracySchema, beliefSourceSchema } from "../game/belief.ts";
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
    start_stats: createStatsSchema(s),
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
    start_inventory: z.array(contentIdSchema).default([]),
    /** 사망 후 이 인물로 이어서 플레이할 수 있는지 */
    playable: z.boolean().default(false),
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
        z.strictObject({
          id: contentIdSchema,
          label: z.string().min(1),
          target: contentIdSchema,
          days: z.number().int().positive(),
        }),
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

  return { item: itemContentSchema, role, npc, beliefPreset, mission, faction, location };
}

type ContentSchemas = ReturnType<typeof createContentSchemas>;
export type RoleContent = z.infer<ContentSchemas["role"]>;
export type NpcContent = z.infer<ContentSchemas["npc"]>;
export type BeliefPreset = z.infer<ContentSchemas["beliefPreset"]>;
export type MissionContent = z.infer<ContentSchemas["mission"]>;
export type MissionRequirement = MissionContent["requirements"][number];
export type FactionContent = z.infer<ContentSchemas["faction"]>;
export type LocationContent = z.infer<ContentSchemas["location"]>;

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
};
