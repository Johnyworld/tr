import { z } from "zod";
import type { Scenario } from "../scenario/schema.ts";
import { idEnum } from "../scenario/schema.ts";
import { moveIds, rankIds, statIds, trackIds } from "../scenario/scenario.ts";

/** (이전) 능력치 범위. 지금은 시나리오의 ranges.ability를 쓴다 */
export const STAT_MIN = -1;
export const STAT_MAX = 3;

/** 아이템 id → 수량. 수량이 0이 되면 키를 지운다 */
export const inventorySchema = z.record(z.string(), z.number().int().positive());
export type Inventory = z.infer<typeof inventorySchema>;

/** 시나리오의 능력치를 모두 가진 객체 */
export function createStatsSchema(s: Scenario) {
  return z.record(idEnum(statIds(s)), z.number().int().min(s.ranges.ability.min).max(s.ranges.ability.max));
}

/**
 * 캐릭터의 능력: 이름이 바뀐 옛 능력을 옮기고, 없는 능력은 0으로 채우고, 모르는 것은 버린다 (이전 세이브)
 */
function createAbilitiesSchema(s: Scenario) {
  return z.preprocess((value) => {
    const raw = { ...(value as Record<string, number>) };
    for (const [from, to] of Object.entries(s.renamed.abilities)) {
      if (raw[from] !== undefined && raw[to] === undefined) raw[to] = raw[from]!;
    }
    return Object.fromEntries(s.stats.map((x) => [x.id, Math.max(s.ranges.ability.min, Math.min(s.ranges.ability.max, raw[x.id] ?? 0))]));
  }, createStatsSchema(s));
}

/** 캐릭터의 스킬: 없는 스킬은 그 스킬의 기본값 (이전 세이브 포함) */
function createSkillsSchema(s: Scenario) {
  return z.preprocess(
    (value) => ({ ...Object.fromEntries(s.moves.map((m) => [m.id, m.default])), ...(value as object) }),
    z.record(idEnum(moveIds(s)), z.number().int().min(s.ranges.skill.min).max(s.ranges.skill.max)),
  );
}

/**
 * 캐릭터 스키마. 플레이어와 NPC가 같은 스키마를 쓴다 (CLAUDE.md 원칙 6).
 * 능력치·등급·상태 트랙의 ID는 시나리오에서 오므로 시나리오를 받아 만든다.
 */
export function createCharacterSchema(s: Scenario) {
  return z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1),
    factionId: z.string(),
    rank: idEnum(rankIds(s)),
    /** 화법 규칙에 쓴다. 모르면 null */
    age: z.number().int().positive().nullable().default(null),
    /** 능력 (기획서 4.2): 타고난 것. 계급과 관계없고 바뀌지 않는다 */
    stats: createAbilitiesSchema(s),
    /** 스킬: 배우는 것. 레벨업으로 오른다 */
    skills: createSkillsSchema(s),
    /** 경험치와 레벨, 아직 쓰지 않은 스킬 포인트 */
    xp: z.number().int().min(0).default(0),
    level: z.number().int().min(0).default(0),
    skillPoints: z.number().int().min(0).default(0),
    /** 상태 트랙별 현재 단계 (예: harm → light) */
    // 새 상태 트랙이 생기기 전의 세이브는 그 트랙을 첫 단계로 본다
    conditions: z.preprocess(
      (value) => ({ ...Object.fromEntries(s.condition_tracks.map((t) => [t.id, t.levels[0]!.id])), ...(value as object) }),
      z.record(idEnum(trackIds(s)), z.string()),
    ).superRefine((conditions, ctx) => {
      for (const track of s.condition_tracks) {
        if (!track.levels.some((l) => l.id === conditions[track.id])) {
          ctx.addIssue({ code: "custom", message: `${track.id}: 알 수 없는 단계 ${conditions[track.id]}` });
        }
      }
    }),
    /** 사망 여부. 부상 트랙이 fatal 단계에 이르면 true (원칙 3: 사망은 부상 트랙으로만) */
    dead: z.boolean().default(false),
    /** 임무로 쌓은 공적 */
    merit: z.number().int().default(0),
    /** 명령 불복종 횟수 (임무 포기·기한 초과) */
    disobedience: z.number().int().nonnegative().default(0),
    inventory: inventorySchema,
  });
}
export type Character = z.infer<ReturnType<typeof createCharacterSchema>>;
