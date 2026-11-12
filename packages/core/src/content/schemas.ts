import { z } from "zod";
import { statsSchema } from "../rules/stats.ts";
import { rankSchema } from "../rules/ranks.ts";
import { ACTIVITIES, TIME_SEGMENTS } from "../rules/time.ts";
import { MOVES } from "../rules/moves.ts";
import { beliefAccuracySchema, beliefSourceSchema } from "../game/belief.ts";

/**
 * 콘텐츠 YAML 스키마. 키는 YAML과 같은 snake_case를 쓴다.
 * 스키마를 바꾸면 content/ 의 기존 파일도 함께 고친다 (pnpm content:check 로 확인).
 */

export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");

export const itemContentSchema = z.strictObject({
  id: contentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
});
export type ItemContent = z.infer<typeof itemContentSchema>;

export const roleContentSchema = z.strictObject({
  id: contentIdSchema,
  label: z.string().min(1),
  faction: contentIdSchema,
  rank: rankSchema,
  default_name: z.string().min(1),
  age: z.number().int().positive(),
  start_stats: statsSchema,
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
export type RoleContent = z.infer<typeof roleContentSchema>;

/** 가치관 점수 (-3 ~ +3). 평판·관계 계산에 쓴다 (기획서 8.1) */
export const valueScoreSchema = z.number().int().min(-3).max(3);

/** NPC 정적 프로필 (기획서 7.1). 동적 상태(부상·소지품·Belief)는 세이브에 있다 */
export const npcContentSchema = z.strictObject({
  id: contentIdSchema,
  name: z.string().min(1),
  faction: contentIdSchema,
  rank: rankSchema,
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
  secret: z.strictObject({ content: z.string().min(1), reveal_when: z.string().min(1) }).optional(),
  stats: statsSchema,
  start_inventory: z.array(contentIdSchema).default([]),
  /** 사망 후 이 인물로 이어서 플레이할 수 있는지 */
  playable: z.boolean().default(false),
});
export type NpcContent = z.infer<typeof npcContentSchema>;

/** 역할별 시작 지식 */
export const beliefPresetSchema = z.strictObject({
  id: contentIdSchema,
  beliefs: z.array(
    z.strictObject({
      fact: z.string().min(1).max(300),
      source: beliefSourceSchema,
      accuracy: beliefAccuracySchema.exclude(["unknown"]),
    }),
  ),
});
export type BeliefPreset = z.infer<typeof beliefPresetSchema>;

/** 임무 요구 조건. 임무를 받은 뒤의 이벤트로 코드가 집계한다 */
export const missionRequirementSchema = z.union([
  z.strictObject({ activity: z.enum(ACTIVITIES), minutes: z.number().int().positive() }),
  z.strictObject({ check: z.enum(MOVES), min_outcome: z.enum(["success", "partial"]) }),
]);
export type MissionRequirement = z.infer<typeof missionRequirementSchema>;

/** 임무 템플릿 (기획서 15.1: 배정 → 수행 → 보고) */
export const missionContentSchema = z.strictObject({
  id: contentIdSchema,
  title: z.string().min(1),
  briefing: z.string().min(1),
  giver_rank: rankSchema,
  deadline_hours: z.number().int().positive().max(72),
  requirements: z.array(missionRequirementSchema).min(1),
});
export type MissionContent = z.infer<typeof missionContentSchema>;

/** 게임이 쓰는 콘텐츠 전체. 단계별로 종류가 늘어난다 */
export type Content = {
  items: Record<string, ItemContent>;
  roles: Record<string, RoleContent>;
  npcs: Record<string, NpcContent>;
  beliefs: Record<string, BeliefPreset>;
  missions: Record<string, MissionContent>;
};
