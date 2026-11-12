import { z } from "zod";
import { TIME_SEGMENTS } from "../rules/time.ts";

/**
 * 시나리오 팩 설정 (기획서 12.3). 장르 요소의 이름과 목록을 데이터로 둔다.
 * core는 여기서 읽은 ID로만 다루고, 리터럴 타입으로 하드코딩하지 않는다.
 */

const id = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");
const labeled = z.strictObject({ id, label: z.string().min(1), description: z.string().optional() });

export const scenarioFileSchema = z
  .strictObject({
    id,
    name: z.string().min(1),
    resources: z.array(labeled).min(1),
    stats: z.array(labeled).min(1),
    moves: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          stats: z.array(id).min(1),
          description: z.string().optional(),
        }),
      )
      .min(1),
    /** 시스템이 특정 역할로 쓰는 행동 */
    move_roles: z.strictObject({ notice: id, stealth: id }),
    condition_tracks: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          levels: z
            .array(
              z.strictObject({
                id,
                label: z.string().min(1),
                penalty: z.number().int(),
                fatal: z.boolean().optional(),
              }),
            )
            .min(2),
        }),
      )
      .min(1),
    harm_track: id,
    rank_ladder: z.array(z.strictObject({ id, label: z.string().min(1), level: z.number().int() })).min(1),
    promotion: z.strictObject({ from: id, to: id }),
    speech_rules: z.string().min(1),
    gm_tone: z.string().min(1),
    gm_rules: z.string().min(1),
    mcp_guide: z.string().min(1),
    threats: z.strictObject({
      disturbance_chance_per_hour: z.record(z.enum(TIME_SEGMENTS), z.number().min(0).max(1)),
      disturbance_details: z.array(z.string().min(1)).min(1),
    }),
  })
  .superRefine((s, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const [name, list] of Object.entries({
      resources: s.resources,
      stats: s.stats,
      moves: s.moves,
      condition_tracks: s.condition_tracks,
      rank_ladder: s.rank_ladder,
    })) {
      const ids = list.map((x) => x.id);
      if (new Set(ids).size !== ids.length) problem(`${name}에 중복된 id가 있다`);
    }
    const stats = new Set(s.stats.map((x) => x.id));
    for (const move of s.moves) {
      for (const stat of move.stats) if (!stats.has(stat)) problem(`moves.${move.id}: 알 수 없는 능력치 ${stat}`);
    }
    const moves = new Set(s.moves.map((x) => x.id));
    for (const [role, move] of Object.entries(s.move_roles)) {
      if (!moves.has(move)) problem(`move_roles.${role}: 알 수 없는 행동 ${move}`);
    }
    for (const track of s.condition_tracks) {
      const fatal = track.levels.findIndex((l) => l.fatal);
      if (fatal !== -1 && fatal !== track.levels.length - 1) problem(`condition_tracks.${track.id}: fatal은 마지막 단계여야 한다`);
    }
    const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
    if (!harm) problem(`harm_track: 알 수 없는 상태 트랙 ${s.harm_track}`);
    else if (!harm.levels.at(-1)?.fatal) problem(`harm_track ${s.harm_track}의 마지막 단계는 fatal이어야 한다 (사망은 부상 트랙으로만)`);
    const ranks = new Set(s.rank_ladder.map((r) => r.id));
    for (const rank of [s.promotion.from, s.promotion.to]) {
      if (!ranks.has(rank)) problem(`promotion: 알 수 없는 등급 ${rank}`);
    }
  });
export type ScenarioFile = z.infer<typeof scenarioFileSchema>;

export const speechRulesSchema = z.strictObject({
  forms: z.strictObject({ casual: z.string().min(1), polite: z.string().min(1) }),
  to_lower_rank: z.enum(["casual", "polite"]),
  to_higher_rank: z.enum(["casual", "polite"]),
  same_rank_older_or_same_age: z.enum(["casual", "polite"]),
  same_rank_younger: z.enum(["casual", "polite"]),
  unknown_age: z.enum(["casual", "polite"]),
});
export type SpeechRules = z.infer<typeof speechRulesSchema>;

/** 불러온 시나리오: 설정 + 연결된 파일 내용 */
export type Scenario = ScenarioFile & {
  speech: SpeechRules;
  /** GM 톤 프롬프트 원문 */
  tone: string;
  /** GM 공통 규칙 원문 */
  rules: string;
  /** MCP 모드 진행 규칙 원문 */
  mcpGuide: string;
};

export type ConditionTrack = Scenario["condition_tracks"][number];

/** 시나리오 ID 목록을 zod enum으로. 타입은 string으로 다룬다 */
export function idEnum(ids: readonly string[]) {
  return z.enum(ids as unknown as [string, ...string[]]);
}
