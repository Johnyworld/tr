import { z } from "zod";
import { ACTIVITIES, TIME_SEGMENTS } from "../rules/time.ts";
import { beliefAccuracySchema, beliefSourceSchema } from "../game/belief.ts";
import { deedTagSchema, privacySchema, RELATION_AXES } from "../game/reputation.ts";
import { createStatsSchema } from "../game/character.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { moveIds, rankIds, statIds } from "../scenario/scenario.ts";

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
    /** 새 게임의 시나리오 고르기에 보이는 것 (월드를 고른 뒤). 없으면 label만 */
    scenario: z
      .strictObject({
        /** 시나리오 이름 (예: 청솔형제단의 하급 전투원) */
        title: z.string().min(1),
        /** 고를 때 보여 주는 두세 문장 */
        pitch: z.string().min(1),
        /** 캐릭터를 만들기 전에 들려주는 지금 상황 (시작 캐릭터가 아는 것만) */
        intro: z.string().min(1).optional(),
      })
      .optional(),
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
    /** 주인공 밑의 분대원 (NPC id, 기획서 9.11). 분대 명령(squad_order)을 받는다 */
    squad: z.array(contentIdSchema).optional(),
    /** 시작할 때 진 빚 (세력 id → 양, 기획서 9.10) */
    start_debt: z.record(contentIdSchema, z.number().int().min(1)).optional(),
    /** 이 역할에 내려오는 임무 템플릿 */
    missions: z.array(contentIdSchema).default([]),
    storylet_tags: z.array(contentIdSchema).default([]),
  });


  /** NPC 정적 프로필 (기획서 7.1). 동적 상태(부상·소지품·Belief)는 세이브에 있다 */
  const npc = z.strictObject({
    id: contentIdSchema,
    name: z.string().min(1),
    /** 이름을 모르는 사람이 부르는 말 (기획서 6.3). 짧은 호칭: "귀가 반쯤 없는 분대장" */
    alias: z.string().min(1).max(30),
    faction: contentIdSchema,
    /** 세계가 시작될 때 이미 붙잡혀 있다 (포로, 기획서 7.6) */
    start_captive: z.strictObject({ by: contentIdSchema, zone: contentIdSchema }).optional(),
    rank: idEnum(rankIds(s)),
    age: z.number().int().positive(),
    look: z.string().min(1),
    /** 거점 사람들이 아는 모습. 이 인물을 아는 캐릭터에게 보인다 */
    reputation: z.string().min(1),
    want: z.string().min(1),
    fear: z.string().min(1),
    values: z.record(contentIdSchema, valueScoreSchema),
    /** 트레잇 id (시나리오 traits). 성격·체질·외모. 예전의 temperament를 대신한다 */
    traits: z.array(idEnum(s.traits.map((t) => t.id))).default([]),
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
    /** 완수하면 임무를 준 무리에 진 빚이 이만큼 준다 (일부 완수는 절반, 기획서 9.10) */
    repays_debt: z.number().int().min(1).optional(),
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
            /**
             * attack: 다 차면 구역을 친다 (기본) / shift: 다 차면 세력 사이 태도가 바뀐다 (이탈, 편들기). shift는 한 번 일어나고 끝난다
             */
            kind: z.enum(["attack", "shift"]).optional(),
            /** fixed: target 구역을 친다 / frontier: 다 찼을 때 맞닿은 적의 구역 중 가장 값진 곳 (잃은 땅 먼저) */
            target_rule: z.enum(["fixed", "frontier"]).default("fixed"),
            target: contentIdSchema.optional(),
            days: z.number().int().positive(),
            /** shift: 다 찼을 때의 새 태도. from이 없으면 이 세력. to가 strongest면 그때 가장 큰(전투원이 많은) 다른 세력 */
            shift: z
              .array(z.strictObject({ from: contentIdSchema.optional(), to: z.string().min(1), value: z.number().int().min(-3).max(3) }))
              .optional(),
            /** shift가 일어났을 때 퍼지는 소식 ({faction} = 이 세력, {to} = 대상) */
            news: z.string().optional(),
          })
          .refine((p) => p.kind === "shift" || p.target_rule === "frontier" || !!p.target, "fixed 공격 계획에는 target이 있어야 한다")
          .refine((p) => p.kind !== "shift" || (p.shift?.length ?? 0) > 0, "shift 계획에는 shift가 있어야 한다"),
      )
      .default([]),
    minor: z.boolean().default(false),
    /**
     * 무리의 문화와 규칙 (기획서 9.9). discipline은 시나리오 discipline의 id (규율의 기계적 무게).
     * 나머지는 GM이 연기에 쓰고, 그 무리 사람은 ?세력에서 본다
     */
    culture: z
      .strictObject({
        discipline: contentIdSchema,
        /** 한두 문장 */
        summary: z.string().min(1),
        rules: z.array(z.string().min(1)).default([]),
        /** 서로를 어떻게 부르는지 */
        address: z.string().optional(),
        /** 규칙을 어기면 어떻게 되는지 */
        punishment: z.string().optional(),
      })
      .optional(),
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
    /** 수색하면 나올 수 있는 것 (기획서 4.7). chance: 한 번 굴릴 때 무언가 나올 확률, items: 무게로 고른다 */
    loot: z
      .strictObject({
        chance: z.number().min(0).max(1),
        items: z.array(z.strictObject({ item: contentIdSchema, weight: z.number().positive(), qty: z.tuple([z.number().int().positive(), z.number().int().positive()]) })),
      })
      .optional(),
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
    /** 무리 방침을 바꾼다 (기획서 9.11, 지도부가 스스로 배급을 줄이는 날 등). own = 플레이어 소속 */
    z.strictObject({ faction_policy: z.strictObject({ faction: z.string().min(1), topic: contentIdSchema, option: contentIdSchema }) }),
    /** own = 플레이어 소속 */
    z.strictObject({ faction_morale: z.strictObject({ faction: z.string().min(1), delta: z.number().int().min(-1).max(1) }) }),
    /** 세력 사이 태도를 바꾼다 (from이 to를 보는 태도, -3~+3에서 멈춘다). mutual이면 양쪽 다. own = 플레이어 소속 */
    z.strictObject({ faction_relation: z.strictObject({ from: z.string().min(1), to: z.string().min(1), delta: z.number().int().min(-2).max(2), mutual: z.boolean().default(true) }) }),
    /**
     * 주인공의 몸 상태를 바꾼다 (먹을 것을 나눠 받았다, 젖은 옷으로 밤을 샜다 등). 부상 트랙은 안 된다 (원칙 3), 마지막 단계(죽음)까지는 가지 않는다.
     * delta 양수 = 나빠짐, 음수 = 나아짐
     */
    z.strictObject({ body: z.strictObject({ track: contentIdSchema, delta: z.number().int().min(-2).max(2) }) }),
    /** 세력 자원을 늘리거나 줄인다 (할당량, 약 재고, 물). own = 플레이어 소속. 양은 콘텐츠가 정한다 */
    z.strictObject({ faction_resource: z.strictObject({ faction: z.string().min(1), resource: contentIdSchema, delta: z.number().int().min(-50).max(50) }) }),
    /** 주인공이 그 무리에 들어간다: 무소속이면 가입, 다른 무리에 있으면 옮긴다 (rank가 없으면 가장 낮은 계급). 이미 그 무리면 아무 일도 없다 */
    z.strictObject({ join_faction: z.strictObject({ faction: contentIdSchema, rank: idEnum(rankIds(s)).optional(), title: z.string().min(1).max(24).optional() }) }),
    /**
     * 배역 NPC의 몸 상태 ± (기획서 7.7). chance면 그 확률로만 (긁혔는데 정말 감염됐나는 코드가 굴린다). 부상 트랙은 안 된다.
     * 양수 = 나빠짐, 음수 = 나아짐
     */
    z.strictObject({ npc_body: z.strictObject({ who: z.string().min(1), track: contentIdSchema, delta: z.number().int().min(-3).max(3), chance: z.number().min(0).max(1).default(1) }) }),
    /** 배역이 주인공과 함께 다닌다 (동행, 기획서 7.8) / 동행을 그만둔다 */
    z.strictObject({ companion_join: z.strictObject({ who: z.string().min(1) }) }),
    z.strictObject({ companion_leave: z.strictObject({ who: z.string().min(1) }) }),
    /** 주인공의 빚 ± (own = 플레이어 소속). 양수는 빌림, 음수는 갚음. 0 아래로 가지 않는다 (기획서 9.10) */
    z.strictObject({ debt: z.strictObject({ faction: z.string().min(1), delta: z.number().int().min(-50).max(50) }) }),
    /** 배역 NPC를 붙잡는다 (포로). by: own(플레이어 소속) 또는 세력 id, zone이 없으면 그 세력의 거점 */
    z.strictObject({ npc_capture: z.strictObject({ who: z.string().min(1), by: z.string().min(1), zone: contentIdSchema.optional() }) }),
    /** 붙잡힌 배역 NPC를 풀어 준다 (구출·석방). 원래 무리로 돌아간다 */
    z.strictObject({ npc_release: z.strictObject({ who: z.string().min(1) }) }),
    /** 배역 NPC가 떠난다: to_faction이면 그 세력으로 넘어가고(도시에 남는다), 없으면 도시를 떠난다 (탈영·피난) */
    z.strictObject({ npc_depart: z.strictObject({ who: z.string().min(1), to_faction: contentIdSchema.optional() }) }),
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
    /** 이 인물의 몸 상태 (기획서 7.7): track의 단계가 at_least 이상, at_most 이하 (단계 id). 진짜 상태로 본다 (연출은 GM 전용) */
    condition: z.strictObject({ track: contentIdSchema, at_least: contentIdSchema.optional(), at_most: contentIdSchema.optional() }).optional(),
    /** 붙잡혀 있는 인물만 (true) / 붙잡히지 않은 인물만 (기본). 포로를 배역으로 쓸 때 true */
    captive: z.boolean().optional(),
    /**
     * 이름 없는 인물로 채운다 (엑스트라 틀 id, 기획서 7.5): 발동할 때 코드가 그 틀로 캐릭터를 만들어 장면에 들인다.
     * label은 호칭 (없으면 틀 이름). 이 배역은 다른 조건(ids, faction 등)을 보지 않는다
     */
    extra: contentIdSchema.optional(),
    label: z.string().min(1).max(30).optional(),
    /** extra로 만든 인물을 이 이름표로 기억한다 (다음 이야기에서 recall로 다시 부른다) */
    keep: contentIdSchema.optional(),
    /** 앞서 keep으로 기억해 둔 이름 없는 인물. 살아 있고 떠나지 않았을 때만 채운다 */
    recall: contentIdSchema.optional(),
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
        day_lte: z.number().int().optional(),
        /** 플레이어의 공적·레벨 하한 (뛰어난 사람에게만 오는 일, 예: 다른 무리의 스카우트) */
        merit_gte: z.number().int().optional(),
        level_gte: z.number().int().optional(),
        /** 플레이어가 있는 구역 */
        zones: z.array(contentIdSchema).optional(),
        /** 우리 무리 구역에 있는지 */
        own_territory: z.boolean().optional(),
        /** 지금 구역의 주인: none 누구의 땅도 아님, own 우리, other 다른 무리 */
        zone_owner: z.array(z.enum(["none", "own", "other"])).optional(),
        /** 플레이어의 소속 세력 (none = 무소속) */
        factions: z.array(z.string().min(1)).optional(),
        flags_all: z.array(contentIdSchema).optional(),
        /** 주인공의 빚 (세력 id 또는 own → 하한/상한) */
        debt_gte: z.record(z.string(), z.number().int()).optional(),
        debt_lte: z.record(z.string(), z.number().int()).optional(),
        /** 이 중 하나라도 서 있으면 */
        flags_any: z.array(contentIdSchema).optional(),
        /** 세력 사이 지금 태도 (from이 to를 보는 값, own = 플레이어 소속). 이탈·편들기 뒤의 이야기 */
        dispositions: z
          .array(z.strictObject({ from: z.string().min(1), to: z.string().min(1), gte: z.number().int().optional(), lte: z.number().int().optional() }))
          .optional(),
        flags_none: z.array(contentIdSchema).optional(),
        /** 세력 클락 (플레이어는 모르는 값. 조건으로만 쓴다) */
        clock_gte: z.record(contentIdSchema, z.number().int()).optional(),
        clock_lte: z.record(contentIdSchema, z.number().int()).optional(),
        own_morale_lte: z.number().int().optional(),
        /** 우리 무리의 방침이 이 중 하나 (주제 id → 선택지 id 목록, 기획서 9.11). 무리 사람은 누구나 안다 */
        own_policy: z.record(contentIdSchema, z.array(contentIdSchema).min(1)).optional(),
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

  /**
   * 엑스트라 틀 (기획서 7.5): 이름 없는 인물이 주인공과 엮이면 GM이 이 틀을 골라 캐릭터로 만든다.
   * 능력·소지품·트레잇은 코드가 틀에서 굴린다 (GM은 물건을 지어내지 않는다)
   */
  const extra = z.strictObject({
    id: contentIdSchema,
    /** GM이 고를 때 보는 이름 (예: 붉은연합 보초 — 엽총) */
    label: z.string().min(1),
    /** 소속. 없으면 떠돌이 */
    faction: contentIdSchema.nullable().default(null),
    rank: idEnum(rankIds(s)),
    /** 성별 id. 없으면 무작위 */
    gender: (s.creation ? idEnum(s.creation.genders.map((g) => g.id)) : z.string()).nullable().default(null),
    age: z.tuple([z.number().int().positive(), z.number().int().positive()]).default([18, 50]),
    /** 겉모습 문구 후보 (하나를 고른다) */
    looks: z.array(z.string().min(1)).min(1),
    /** 능력별 [최소, 최대]. 없는 능력은 0 */
    stats: z.partialRecord(idEnum(statIds(s)), z.tuple([z.number().int(), z.number().int()])).default({}),
    skills: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(s.ranges.skill.min).max(s.ranges.skill.max)).default({}),
    /** 트레잇 후보에서 trait_count개 */
    traits: z.array(idEnum(s.traits.map((t) => t.id))).default([]),
    trait_count: z.number().int().min(0).default(1),
    /** 소지품 표: 아이템별 확률 */
    inventory: z.array(z.strictObject({ item: contentIdSchema, chance: z.number().min(0).max(1).default(1), quantity: z.number().int().positive().default(1) })).default([]),
    /** 행적을 보고 반응하는 가치관 */
    values: z.record(contentIdSchema, valueScoreSchema).default({}),
    /** 동물이다: 사람 이름을 짓지 않고 호칭(label)이 이름이 된다 (기획서 7.8 동행) */
    animal: z.boolean().optional(),
    /** 동행하면 주인공의 스킬에 더하는 보정 (예: 개 → 경계 +1). 능력+스킬 상한 안에서 */
    companion_bonus: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(-1).max(2)).optional(),
  });

  return { item: itemContentSchema, role, npc, beliefPreset, mission, faction, location, storylet, extra };
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
export type ExtraContent = z.infer<ContentSchemas["extra"]>;
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
  /** 엑스트라 틀 (기획서 7.5) */
  extras: Record<string, ExtraContent>;
};
