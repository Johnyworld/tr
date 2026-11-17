import { TIE_KINDS } from "../game/ties.ts";
import { iconNameSchema } from "./icons.ts";
import { z } from "zod";
import { ACTIVITIES, TIME_SEGMENTS } from "../rules/time.ts";
import { beliefAccuracySchema, beliefSourceSchema } from "../game/belief.ts";
import { deedTagSchema, privacySchema, RELATION_AXES } from "../game/reputation.ts";
import { createStatsSchema } from "../game/character.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { historyPartSchema } from "../game/background.ts";
import { moveIds, rankIds, statIds } from "../scenario/scenario.ts";

/**
 * 콘텐츠 YAML 스키마. 키는 YAML과 같은 snake_case를 쓴다.
 * 능력치·등급·행동처럼 시나리오가 정하는 ID가 들어가므로 시나리오를 받아 만든다 (기획서 12.3).
 * 스키마를 바꾸면 content/ 의 기존 파일도 함께 고친다 (pnpm content:check 로 확인).
 */

export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");

const harmCap = z.enum(["light", "heavy"]);
/** 아이템 (기획서 4.8). 성질은 모두 선택이고, 스킬·슬롯 id는 시나리오에서 검증한다 */
export const itemContentSchema = z.strictObject({
  id: contentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  /** 무게 (kg). 없으면 0.5 */
  weight: z.number().min(0).max(50).optional(),
  /** 흥정 값. 없으면 1 */
  value: z.number().int().min(0).max(500).optional(),
  kind: z.enum(["weapon", "armor", "tool", "ammo", "material", "consumable", "food", "misc"]).optional(),
  /** 상태 화면 아이콘 (12-64). 없으면 무기·방어구·종류로 고른다 (content/icons.ts) */
  icon: iconNameSchema.optional(),
  /** 무기: 공격에 쓰는 스킬, 입힐 수 있는 피해 상한, 소음(0~2), 쏠 때 하나씩 쓰는 탄약, 판정 보정 */
  weapon: z
    .strictObject({
      moves: z.array(contentIdSchema).min(1),
      max_harm: harmCap,
      noise: z.number().int().min(0).max(2).default(0),
      ammo: contentIdSchema.optional(),
      /** 탄약을 쓰는 스킬 (없으면 moves 전부). 소총으로 개머리판을 휘두를 때는 탄약이 들지 않게 */
      ammo_moves: z.array(contentIdSchema).optional(),
      bonus: z.number().int().min(-1).max(1).default(0),
      /** 이 무기로 친 상처 종류 (스킬 → scenario.wounds.kinds, 12-91). 소총을 쏘면 총상, 개머리판이면 둔기 */
      wound: z.record(contentIdSchema, contentIdSchema).optional(),
      /** 사거리 (12-93): 스킬 → 거리(scenario.gear.distances) → 판정 보정. 없는 거리에서는 칠 수 없다. 없는 스킬은 gear.default_range */
      range: z.record(contentIdSchema, z.record(contentIdSchema, z.number().int().min(-3).max(3))).optional(),
    })
    .optional(),
  /** 방어구: 입는 자리, 받는 피해를 줄이는 단계, 입으면 불리해지는 스킬, 감염을 막을 확률 */
  armor: z
    .strictObject({
      /** outer: 외투 (방한복 등, 12-98). 몸 칸의 방어구 위에 따로 입는다 */
      slot: z.enum(["body", "head", "arms", "outer"]),
      reduces: z.number().int().min(0).max(2),
      penalty: z.record(contentIdSchema, z.number().int().min(-2).max(0)).default({}),
      blocks_infection: z.number().min(0).max(1).default(0),
    })
    .optional(),
  /**
   * 따뜻함 (12-98): 체감 기온에 더하는 도. worn: 입고 있을 때 (외투), resting: 지니고 자거나 쉴 때 덮는다 (담요)
   */
  warmth: z.strictObject({ degrees: z.number().int().min(1).max(15), when: z.enum(["worn", "resting"]) }).optional(),
  /** 지니고 있으면 들 수 있는 무게가 이만큼 는다 (배낭 틀 등, 가장 큰 것 하나) */
  carry_bonus: z.number().min(0).max(20).optional(),
  /** 메모 (12-75): paper(메모장)와 tool(펜·연필)을 함께 지니면 메모를 적는다. paper만 있으면 읽기만 */
  writing: z.enum(["paper", "tool"]).optional(),
  /** 도구: 지니고 있으면 그 스킬에 보정 (가장 큰 것 하나) */
  tool: z.strictObject({ bonus: z.record(contentIdSchema, z.number().int().min(1).max(2)) }).optional(),
  /** 몇 번 닳으면 망가지는지, 망가지면 남는 것 */
  durability: z.number().int().min(1).max(20).optional(),
  breaks_into: contentIdSchema.optional(),
  /** 소모품으로 쓰고 나면 이 아이템이 남는다 (물병 → 빈 물병) */
  used_into: contentIdSchema.optional(),
  /** 고치는 법 */
  repair: z.strictObject({ move: contentIdSchema, materials: z.record(contentIdSchema, z.number().int().min(1)), /** 목록이면 그중 하나 */ tools: z.array(z.union([contentIdSchema, z.array(contentIdSchema).min(1)])).default([]) }).optional(),
});
export type ItemContent = z.infer<typeof itemContentSchema>;

/** 가치관 점수 (-3 ~ +3). 평판·관계 계산에 쓴다 (기획서 8.1) */
export const valueScoreSchema = z.number().int().min(-3).max(3);

/**
 * 시나리오의 해금 조건·클리어 목표 (기획서 12.4.1). 코드가 이벤트와 상태로 판정한다. 목록이면 그중 하나만 맞으면 된다
 * - scenario_ended: 그 시나리오가 끝났다 (클리어했거나 주인공이 죽었다)
 * - scenario_cleared: 그 시나리오의 클리어 목표를 이뤘다
 * - enter: 그 구역에 처음 들어갔다
 * - fight: 그 무리 사람과 싸웠다 (공격 판정의 상대, 또는 그 무리와의 전투 장면)
 * - join: 그 무리에 들어갔다
 * - promoted: 계급이 올랐다
 * - reunite: 찾던 가족(역할의 family)을 만났다 (가족이 주인공 앞에 나타났다, 클리어 목표에서만)
 */
export const scenarioConditionSchema = z.union([
  z.strictObject({ scenario_ended: contentIdSchema }),
  z.strictObject({ scenario_cleared: contentIdSchema }),
  z.strictObject({ enter: contentIdSchema }),
  z.strictObject({ fight: contentIdSchema }),
  z.strictObject({ join: contentIdSchema }),
  z.strictObject({ promoted: z.literal(true) }),
  z.strictObject({ reunite: z.literal("family") }),
]);
export type ScenarioCondition = z.infer<typeof scenarioConditionSchema>;

/** 시나리오에 맞춘 콘텐츠 스키마들 */
export function createContentSchemas(s: Scenario) {
  const role = z.strictObject({
    id: contentIdSchema,
    label: z.string().min(1),
    /** 소속 무리. 빈 글이면 무리 없이 시작한다 (떠돌이, 튜토리얼의 방문자) */
    faction: contentIdSchema.or(z.literal("")),
    rank: idEnum(rankIds(s)),
    /** 직분 (기획서 12.6). 직분의 일감·이야기가 더해진다 */
    occupation: contentIdSchema.optional(),
    default_name: z.string().min(1),
    age: z.number().int().positive(),
    /** 시작 장면. 화면에 먼저 보여 주고 GM 프롬프트에도 넣는다 */
    opening_scene: z.string().min(1),
    /**
     * 새 게임의 시나리오 (기획서 12.4.1). order가 있으면 월드를 고른 뒤의 시나리오 목록에 그 순서로 보인다.
     * order가 없는 역할은 목록에 없고, 무리에 들거나 다음 캐릭터로 이어 갈 때 그 자리의 규칙(상관·임무·이야기)으로만 쓴다
     */
    scenario: z
      .strictObject({
        /** 시나리오 이름 (예: 비극의 고리) */
        title: z.string().min(1),
        /** 목록의 짧은 설명 (주인공의 말로 두세 문장) */
        pitch: z.string().min(1),
        /** 캐릭터를 만들기 전에 들려주는 지금 상황 (시작 캐릭터가 아는 것만) */
        intro: z.string().min(1).optional(),
        /** 목록 순서 (작을수록 위). 없으면 목록에 없다 */
        order: z.number().int().min(0).optional(),
        /** 해금 조건. 없으면 처음부터 고를 수 있다. text는 잠긴 카드에 보이는 말 */
        unlock: z.strictObject({ text: z.string().min(1), when: z.array(scenarioConditionSchema).min(1) }).optional(),
        /** 클리어 목표. 이루면 GM이 엔딩을 연출하고, 계속할지 끝낼지 묻는다. 없으면 죽음이 끝이다 */
        goal: z.strictObject({ text: z.string().min(1), when: z.array(scenarioConditionSchema).min(1), ending: z.string().min(1) }).optional(),
        /** 주인공이 죽으면 같은 세계의 다음 캐릭터로 이어 갈 수 있는지. false면 그 판은 죽음으로 끝난다 (튜토리얼) */
        heirs: z.boolean().default(true),
        /** 이 시나리오 내내 GM이 따를 연출 지침 (GM 지침에 들어간다. 시작 캐릭터가 모르는 진실은 쓰지 않는다) */
        gm: z.string().min(1).optional(),
      })
      .optional(),
    /** 미리 정해진 사연 (기획서 12.6의 배경 부품). 세계를 만들 때 세이브의 역사가 된다 */
    history: z.array(historyPartSchema()).default([]),
    /** 미리 정해진 지난 삶 (주인공의 기억 몇 문장) */
    background: z.array(z.string().min(1).max(200)).default([]),
    /**
     * 시작할 때 가까운 사람들 (오래 함께 버틴 동료 등): 이 인물들이 주인공을 보는 관계를 축마다 [하한, 상한] 안에서 무작위로 올린다.
     * 서로 이름을 알게 하려면 known_npcs에도 넣는다
     */
    start_bonds: z
      .strictObject({
        ids: z.array(contentIdSchema).min(1),
        trust: z.tuple([z.number().int(), z.number().int()]).default([1, 2]),
        affection: z.tuple([z.number().int(), z.number().int()]).default([1, 2]),
        respect: z.tuple([z.number().int(), z.number().int()]).default([0, 1]),
        /** 이 중 한 사람(가장 가까운 친구)은 축마다 하나씩 더 */
        best: contentIdSchema.optional(),
      })
      .optional(),
    /** 찾는 가족 (튜토리얼): 코드가 주인공 나이에 맞춰 가족 몇 사람을 만들어 이 구역에 둔다. 주인공은 어디 있는지 모른다 */
    family: z
      .strictObject({
        zone: contentIdSchema,
        count: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([2, 3]),
        /** 가족과 주인공이 서로를 보는 관계 (축마다, 관계의 범위 안) */
        bond: z.strictObject({ trust: z.number().int(), affection: z.number().int(), respect: z.number().int() }).default({ trust: 5, affection: 5, respect: 4 }),
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
    /** 처음부터 함께 다니는 사람·동물 (엑스트라 틀, 기획서 7.9). 떠돌이의 가족 등. kind가 없으면 동물은 animal, 사람은 kin */
    start_companions: z
      .array(
        z.strictObject({
          template: contentIdSchema,
          label: z.string().min(1).max(20),
          kind: z.enum(["animal", "kin", "purpose"]).optional(),
          /** 플레이어가 정한 사람 (떠돌이의 소규모 무리, 12-77). 없으면 틀에서 무작위 */
          name: z.string().min(1).optional(),
          age: z.number().int().min(0).optional(),
          gender: z.string().optional(),
        }),
      )
      .optional(),
    /** 주인공 밑의 분대원 (NPC id, 기획서 9.11). 분대 명령(squad_order)을 받는다 */
    squad: z.array(contentIdSchema).optional(),
    /** 주인공이 분대원일 때 같은 분대의 다른 분대원 (NPC id). 분대장은 commander. 명령은 받지 않고 시트에 보이기만 한다 */
    squad_mates: z.array(contentIdSchema).optional(),
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
    /** 소속 무리. 없으면(null) 무리에 속하지 않은 떠돌이·외톨이·유랑상인 (기획서 7.11) */
    faction: contentIdSchema.nullable().optional(),
    /** 세계가 시작될 때 이미 붙잡혀 있다 (포로, 기획서 7.6) */
    start_captive: z.strictObject({ by: contentIdSchema, zone: contentIdSchema }).optional(),
    rank: idEnum(rankIds(s)),
    /** 직분 (기획서 12.6). 플레이어와 같은 스키마 (원칙 6) */
    occupation: contentIdSchema.optional(),
    /** 끌리는 성별 id 목록 (12-58). 빈 목록이면 아무에게도 끌리지 않는다. 없으면 월드의 비율로 정해진다 */
    attracted_to: z.array(z.string()).optional(),
    /**
     * 성적 위협 (12-59, 수위가 켜져 있을 때만): harass 성적인 농담·괴롭힘, coerce 몸을 거래 조건으로 요구, assault 위협과 시도.
     * 이 인물이 끌리는 사람에게만 (성별로 정하지 않는다). GM이 즉석에서 정하지 않고 데이터로 둔다
     */
    menace: z.enum(["harass", "coerce", "assault"]).optional(),
    age: z.number().int().positive(),
    look: z.string().min(1),
    /** 거점 사람들이 아는 모습. 이 인물을 아는 캐릭터에게 보인다 */
    reputation: z.string().min(1),
    want: z.string().min(1),
    fear: z.string().min(1),
    values: z.record(contentIdSchema, valueScoreSchema),
    /** 트레잇 id (시나리오 traits). 성격·체질·외모. 예전의 temperament를 대신한다 */
    traits: z.array(idEnum(s.traits.map((t) => t.id))).default([]),
    /** 성격 축 덮어쓰기 (12-99): 적은 축만 이 값으로 (나머지는 트레잇과 빈 축 채우기). 말투·설정과 어긋날 때 */
    persona: z.partialRecord(idEnum((s.persona?.axes ?? []).map((a) => a.id)), z.number().int().min(-2).max(2)).optional(),
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
    /**
     * 다른 인물과의 관계 (기획서 7.10). 한쪽에만 적어도 양쪽으로 본다. 무리가 달라도 된다.
     * secret이 있으면 숨은 관계: 이 인물의 신뢰가 min_trust 이상일 때만 GM에게 보이고 reveal_tie로 털어놓는다
     */
    ties: z
      .array(
        z.strictObject({
          to: contentIdSchema,
          kind: z.enum(TIE_KINDS),
          secret: z.strictObject({ reveal_when: z.string().min(1), min_trust: z.number().int().min(1).max(5) }).optional(),
        }),
      )
      .optional(),
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
    /** 상인 (기획서 4.8): 날마다 이만큼까지 다시 채운다, 흥정할 때 값에 곱한다 */
    merchant: z
      .strictObject({
        restock: z.record(contentIdSchema, z.number().int().min(1)),
        markup: z.number().min(1).max(3).default(1.2),
        /** 가끔만 들여오는 귀한 물건: 아이템 → 떨어졌을 때 하루마다 하나 들여올 확률 (12-106) */
        rare: z.record(contentIdSchema, z.number().min(0).max(1)).default({}),
      })
      .optional(),
    /** 떠도는 인물: 날마다 이 구역들 중 한 곳에 있다 (유랑상인 등). 있으면 zone 대신 쓴다 (기획서 7.11) */
    roams: z.array(contentIdSchema).min(1).optional(),
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
    /** 무장이 필요한 작전: 받으면 무리의 무기고가 무기·탄약을 빌려주고, 끝나면 반납한다 (기획서 4.8) */
    armed: z.boolean().optional(),
    /** 2인 1조: 받으면 같은 무리 동료 하나가 짝으로 붙고, 임무가 끝나면 돌아간다 (기획서 7.9) */
    buddy: z.boolean().optional(),
    /** 완수하면 임무를 준 무리에 진 빚이 이만큼 준다 (일부 완수는 절반, 기획서 9.10) */
    repays_debt: z.number().int().min(1).optional(),
    /** 완수하면 임무를 준 무리의 거점을 보강한다 (담 메우기, 12-48). 일부 완수는 절반(내림) */
    fortifies: z.number().int().min(1).max(2).optional(),
    /** 완수하면 이 세력 클락을 당긴다 (일부 완수는 절반). 전선 임무가 우리 무리의 계획을 앞당긴다 */
    advances: z.strictObject({ clock: contentIdSchema, delta: z.number().int().min(-5).max(5) }).optional(),
    /** 완수하면 임무를 준 무리의 창고에 이만큼 들어간다 (수색·채집으로 구해 온 몫). 일부 완수는 절반(내림). 플레이어 소지품과는 따로 */
    supplies: z.partialRecord(idEnum(s.resources.map((r) => r.id)), z.number().int().min(1)).optional(),
    /**
     * 소탕 (12-120): 임무를 준 무리 땅 가운데 감염체가 가장 많이 몰려든 구역의 압력을 이만큼 낮춘다 (일부 완수는 절반, 내림).
     * 역할의 임무 목록과 상관없이, 그 무리 땅에 기준값보다 높은 구역이 있는 날에만 오늘의 후보에 오른다
     */
    clears: z.number().int().min(1).max(2).optional(),
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
    /**
     * 무기고 (기획서 4.8): 무장이 필요한 작전(armed)에 빌려주는 것. 이미 가진 만큼은 빼고 모자란 것만.
     * ammo_cost: 한 번 빌려줄 때마다 무리 창고에서 줄어드는 탄약 (모자라면 탄약 없이 무기만)
     */
    armory: z.strictObject({ items: z.record(contentIdSchema, z.number().int().min(1)), ammo_cost: z.number().int().min(0).default(0) }).optional(),
    /** 이 무리에서 부르는 계급 이름 (12-84, 예: grunt → 약탈조원). 없는 계급은 월드의 이름 */
    rank_labels: z.record(z.string(), z.string().min(1)).default({}),
    /** false면 이 무리로 시작할 수 없다 (처음 시나리오·자유 시나리오에 없다. 해금된 시나리오로만, 기획서 9.12) */
    startable: z.boolean().optional(),
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
    /** 피난처: 어느 무리도 차지하거나 치지 않는다 (성당, 학자들의 캠퍼스, 12-53) */
    sanctuary: z.boolean().optional(),
    /** 실내 (12-98): 들어가 쉬면 바깥보다 따뜻한 도. 0이면 덮을 곳이 없다 (쉬어도 노숙). 폐허 4, 온전한 건물 7 정도 */
    cover: z.number().int().min(0).max(12).optional(),
    /** 위험 (0 안전 ~ 3 아주 위험, 12-53). 오가는 길에서 일이 생길 확률(scenario.travel)을 정한다 */
    danger: z.number().int().min(0).max(3).default(1),
    /**
     * 맞닿지 않은 곳에서 건너오는 길 (배, 기획서 9.12). from에서만 건넌다.
     * pass_flags 중 하나가 있으면 그냥 건너고, 없으면 attempt.moves 판정과 무거운 위험(heavy)을 걸고 시도한다 (실패하면 되돌아온다)
     */
    crossing: z
      .strictObject({
        from: z.array(contentIdSchema).min(1),
        pass_flags: z.array(contentIdSchema).default([]),
        attempt: z.strictObject({ moves: z.array(z.string()).min(1), label: z.string().min(1) }),
      })
      .optional(),
    /** 외딴곳: 도시 공통 이야기(world)와 엑스트라 틀은 이 구역을 zones로 직접 적은 것만 나온다 (닫힌 섬 등, 기획서 9.12) */
    isolated: z.boolean().optional(),
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
    /** 두 배역 사이의 관계 (from이 to를 보는 마음). 주인공 말고 NPC끼리 (기획서 7.10) */
    z.strictObject({ npc_relation: z.strictObject({ from: z.string().min(1), to: z.string().min(1), axis: z.enum(RELATION_AXES), delta: z.number().int().min(-3).max(3), mutual: z.boolean().default(false) }) }),
    /**
     * 다른 무리의 속사정을 엿듣는다 (무전, 술자리, 장부, 12-48): 그 무리가 지금 준비하는 일(세력 클락)이 어디쯤인지 대략 안다.
     * faction: other(우리 말고 아무 무리, 가장 진척된 일을 꾸미는 쪽), enemy(우리와 사이가 나쁜 무리 중), 또는 세력 id. 진짜 상태에서 코드가 고른다
     */
    z.strictObject({ overhear: z.strictObject({ faction: z.string().min(1), source: z.enum(["seen", "report", "rumor"]).default("report") }) }),
    /** 지금 구역을 보강한다 (담·망루, 12-48). 우리 땅일 때만. 빼앗기면 사라진다. 음수면 허문다 */
    z.strictObject({ fortify: z.number().int().min(-1).max(2) }),
    /** 지금 구역에 소리가 난다 (총소리·쇳소리, 기획서 4.8). 감염체가 몰려드는 조건이 된다 */
    z.strictObject({ zone_noise: z.number().int().min(1).max(3) }),
    /** 주인공의 옷이 흠뻑 젖는다 (12-121: 강·하수구·물웅덩이). 기온 규칙의 wet.hours 동안 체감이 떨어진다 */
    z.strictObject({ soak: z.literal(true) }),
    /** 지금 구역의 감염체 압력을 바꾼다 (12-112). 음수면 소탕, 양수면 불러 모음 */
    z.strictObject({ infested: z.number().int().min(-2).max(2).refine((n) => n !== 0, "0이 아닌 정수") }),
    /** 배역 NPC가 다친다 (부상 트랙 steps 단계). 죽음 바로 앞에서 멈춘다 (원칙 3: 이야기는 사람을 죽이지 않는다) */
    z.strictObject({ npc_hurt: z.strictObject({ who: z.string().min(1), steps: z.number().int().min(1).max(2) }) }),
    /** 배역 NPC의 계급을 바꾼다 (지도부 교체·강등) */
    z.strictObject({ npc_rank: z.strictObject({ who: z.string().min(1), rank: idEnum(rankIds(s)) }) }),
    /** 주인공의 상관이 이 배역으로 바뀐다 (지도부가 바뀐 뒤). who: reset이면 역할의 상관으로 돌아간다 */
    z.strictObject({ set_commander: z.strictObject({ who: z.string().min(1) }) }),
    z.strictObject({ belief: z.strictObject({ fact: z.string().min(1).max(300), source: beliefSourceSchema.default("seen") }) }),
    z.strictObject({ merit: z.number().int().min(-3).max(3) }),
    /** 직분의 평판 ± (기획서 12.6). 쌓이면 직분 사다리를 오른다. 직분이 없으면 아무 일도 없다 */
    z.strictObject({ standing: z.number().int().min(-2).max(3) }),
    /** from이 있으면 그 배역에게서 옮기고(가진 것만), 없으면 새로 생긴다 (콘텐츠가 정한 보상) */
    z.strictObject({ give_item: z.strictObject({ item: contentIdSchema, from: z.string().optional(), quantity: z.number().int().positive().default(1) }) }),
    /**
     * 주인공이 다친다 (12-56): 판정이 붙은 선택지의 대가 있는 성공·실패에서만 (콘텐츠 검증이 막는다).
     * 부상 트랙 steps 단계, 죽음 바로 앞에서 멈춘다 (이야기는 사람을 죽이지 않는다, 원칙 3)
     */
    z.strictObject({ wound: z.strictObject({ steps: z.number().int().min(1).max(2), cause: z.string().min(1).max(60) }) }),
    /** 주인공과 이 배역의 연애가 끝난다 (12-60: "그만하자") */
    z.strictObject({ end_romance: z.strictObject({ who: z.string().min(1) }) }),
    /** 배역 NPC의 상처를 돌본다 (부상 트랙 steps 단계 낫는다, 12-60) */
    z.strictObject({ npc_heal: z.strictObject({ who: z.string().min(1), steps: z.number().int().min(1).max(2) }) }),
    /** 이 배역을 주인공의 원수로 삼는다 (12-59: 위협한 자를 잊지 않는다). 배경 부품 enemy가 더해진다 */
    z.strictObject({ grudge: z.strictObject({ who: z.string().min(1), why: z.string().min(1).max(80) }) }),
    /** 붙잡힌 배역이 어디 갇혔는지 주인공이 알게 된다 (진짜 상태에서 코드가 채운다, 12-56) */
    z.strictObject({ locate: z.strictObject({ who: z.string().min(1), source: z.enum(["seen", "report", "rumor"]).default("report") }) }),
    /** 주인공이 붙잡힌다 (12-55): by 무리(own 외에 zone_owner 등 별칭), zone이 없으면 그 무리의 거점에 갇힌다 */
    z.strictObject({ capture_player: z.strictObject({ by: z.string().min(1), zone: contentIdSchema.optional() }) }),
    /** 갇힌 주인공이 풀려난다: returned면 빼앗긴 것을 돌려받는다, home이면 우리 무리의 거점으로 돌아간다 */
    z.strictObject({ release_player: z.strictObject({ returned: z.boolean().default(true), home: z.boolean().default(false) }) }),
    /** 지니고 있던 무기를 이 구역에 맡긴다 (성당 문 앞 등, 12-54). 이 구역을 떠날 때 저절로 돌려받는다 */
    z.strictObject({ deposit_weapons: z.literal(true) }),
    /** 우리 땅의 산출을 늘린다 (씨앗을 심었다, 우물을 팠다, 12-54). where: here 지금 구역(우리 땅일 때만), base 우리 무리 거점. 빼앗기면 사라진다 */
    z.strictObject({ cultivate: z.strictObject({ resource: contentIdSchema, delta: z.number().int().min(1).max(10), where: z.enum(["here", "base"]).default("here") }) }),
    /** 주인공이 배운다: 스킬이 한 단계 오른다 (max까지, 레벨업 포인트를 쓰지 않는다, 12-54) */
    z.strictObject({ train: z.strictObject({ skill: contentIdSchema, max: z.number().int() }) }),
    /** 시간이 더 걸린다 (돌아가는 길, 기다림, 12-54). 그동안의 세계 처리(배급·소문·전쟁)는 코드가 돌린다 */
    z.strictObject({ delay: z.number().int().min(30).max(480) }),
    /** 주인공이 잃는다 (놓치고, 떨어뜨리고, 빼앗긴다). 가진 만큼만 잃고, 없으면 아무 일도 없다 (선택지를 막지 않는다) */
    z.strictObject({ lose_item: z.strictObject({ item: contentIdSchema, quantity: z.number().int().positive().default(1) }) }),
    /** 플레이어가 내놓는다 (거래). 가진 것이 없으면 이 선택지를 고를 수 없다 */
    z.strictObject({ take_item: z.strictObject({ item: contentIdSchema, quantity: z.number().int().positive().default(1) }) }),
    /** 세력 클락을 당기거나 늦춘다 (플레이어 행동이 전황에 닿는 길) */
    z.strictObject({ clock: z.strictObject({ id: contentIdSchema, delta: z.number().int().min(-5).max(5) }) }),
    /** 주인공을 다른 구역으로 보낸다 (쫓겨남, 끌려감, 배에 실려 감. 기획서 9.12) */
    z.strictObject({ send_to: contentIdSchema }),
    /** 두 배역 사이의 숨은 관계를 주인공이 알게 된다 (기획서 7.10) */
    z.strictObject({ reveal_tie: z.strictObject({ who: z.string().min(1), other: z.string().min(1) }) }),
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
    z.strictObject({ body: z.strictObject({ track: contentIdSchema, delta: z.number().int().min(-2).max(2), chance: z.number().min(0).max(1).default(1) }) }),
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
    /**
     * 함께 다니기 시작한다 (기획서 7.9). kind가 없으면 동물은 animal, 사람은 purpose.
     * until: 목적 동행이 끝나는 조건 (플래그, 도착 구역, 몇 시간 뒤). 하나라도 차면 갈림길. 사람인데 until이 없으면 48시간
     */
    z.strictObject({
      companion_join: z.strictObject({
        who: z.string().min(1),
        kind: z.enum(["animal", "purpose", "kin"]).optional(),
        until: z.strictObject({ flag: contentIdSchema.optional(), zone: contentIdSchema.optional(), hours: z.number().int().min(1).max(240).optional() }).optional(),
      }),
    }),
    z.strictObject({ companion_leave: z.strictObject({ who: z.string().min(1) }) }),
    /** 동행이 잠시 떨어진다: hours가 있으면 볼일을 보고 그 뒤 돌아오고, 없으면 지금 구역에 남아 기다린다 */
    z.strictObject({ companion_part: z.strictObject({ who: z.string().min(1), hours: z.number().int().min(1).max(72).optional() }) }),
    /** 주인공의 빚 ± (own = 플레이어 소속). 양수는 빌림, 음수는 갚음. 0 아래로 가지 않는다 (기획서 9.10) */
    z.strictObject({ debt: z.strictObject({ faction: z.string().min(1), delta: z.number().int().min(-50).max(50) }) }),
    /** 배역 NPC를 붙잡는다 (포로). by: own(플레이어 소속) 또는 세력 id, zone이 없으면 그 세력의 거점 */
    z.strictObject({ npc_capture: z.strictObject({ who: z.string().min(1), by: z.string().min(1), zone: contentIdSchema.optional() }) }),
    /** 붙잡힌 배역 NPC를 풀어 준다 (구출·석방). 원래 무리로 돌아간다 */
    z.strictObject({ npc_release: z.strictObject({ who: z.string().min(1) }) }),
    /** 배역 NPC가 떠난다: to_faction이면 그 세력으로 넘어가고(도시에 남는다, own이면 주인공의 무리로 데려온다), 없으면 도시를 떠난다 (탈영·피난) */
    z.strictObject({ npc_depart: z.strictObject({ who: z.string().min(1), to_faction: z.string().min(1).optional() }) }),
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
    /** 앞의 배역(of)과 이어진 사람 (kinds: 관계 종류, 기획서 7.10). of는 이 배역보다 앞에 적는다 */
    tie: z.strictObject({ of: contentIdSchema, kinds: z.array(z.enum(TIE_KINDS)).optional(), cross: z.boolean().default(false).describe("true면 of와 무리가 다른 사람만") }).optional(),
    /** 지금 곁에 있는 동행 중에서 (이름 없는 인물·동물 포함, 기획서 7.9). kinds: 함께 다니는 이유, templates: 엑스트라 틀 */
    companion: z.strictObject({ kinds: z.array(z.enum(["animal", "buddy", "squad", "purpose", "kin", "prisoner"])).optional(), templates: z.array(contentIdSchema).optional() }).optional(),
    /** 플레이어의 직속 상관 */
    commander: z.boolean().default(false),
    /** own = 플레이어 소속, 또는 세력 id */
    faction: z.string().optional(),
    ranks: z.array(idEnum(rankIds(s))).optional(),
    /** 이 직분인 사람만 (기획서 12.6: 같은 부엌의 요리사, 같은 진료소의 의무병). same이면 주인공과 같은 직분 */
    occupations: z.array(z.string().min(1)).optional(),
    /** 플레이어가 아는 인물만 */
    known: z.boolean().default(false),
    /** 이 인물의 플레이어에 대한 신뢰 하한 */
    trust_gte: z.number().int().optional(),
    /** 소문으로만 주인공을 아는 팬(fan) 또는 안티(anti)만 (12-127) */
    stance: z.enum(["fan", "anti"]).optional(),
    /** 발동할 때 장면에 들어온다 */
    enter: z.boolean().default(true),
    /** 이 인물의 몸 상태 (기획서 7.7): track의 단계가 at_least 이상, at_most 이하 (단계 id). 진짜 상태로 본다 (연출은 GM 전용) */
    condition: z.strictObject({ track: contentIdSchema, at_least: contentIdSchema.optional(), at_most: contentIdSchema.optional() }).optional(),
    /** 어디에 붙잡혀 있든 붙잡힌 사람 (그 자리에 없어도 이름만 부를 때, 12-56). enter는 false로 둔다 */
    captive_anywhere: z.boolean().optional(),
    /** 붙잡혀 있는 인물만 (true) / 붙잡히지 않은 인물만 (기본). 포로를 배역으로 쓸 때 true */
    captive: z.boolean().optional(),
    /**
     * 이름 없는 인물로 채운다 (엑스트라 틀 id, 기획서 7.5): 발동할 때 코드가 그 틀로 캐릭터를 만들어 장면에 들인다.
     * label은 호칭 (없으면 틀 이름). 이 배역은 다른 조건(ids, faction 등)을 보지 않는다
     */
    extra: contentIdSchema.optional(),
    label: z.string().min(1).max(30).optional(),
    /** 이 배역을 맡은 인물을 이름표로 기억한다 (다음 이야기에서 recall로 다시 부른다). 이름 없는 인물도, 이름 있는 NPC도 */
    keep: contentIdSchema.optional(),
    /**
     * 주인공의 배경에서 (기획서 12.6): enemy 원수인 인물(또는 가해자), enemy_member 원수 무리의 사람,
     * kin 살아서 기다리는 가족, sought 찾고 있는 사람, family 찾는 가족 (역할의 family, 튜토리얼)
     */
    background: z.enum(["enemy", "enemy_member", "kin", "sought", "creditor", "deserted", "family"]).optional(),
    /** 성적 위협을 가진 사람만 (12-59, 이 중 하나). 그 사람이 주인공에게 끌릴 때만 */
    menace: z.array(z.enum(["harass", "coerce", "assault"])).optional(),
    /** 연애 (12-58): lover 주인공의 연인, suitor 주인공에게 마음이 있는 사람, jealous 다른 연인을 알아챈 연인, rival_lover 주인공이 다가간 사람의 다른 연인 */
    romance: z.enum(["lover", "suitor", "jealous", "rival_lover"]).optional(),
    /** 지금 주인공이 있는 구역에 있는 사람만 (찾던 사람을 마주치는 장면). 함께 다니는 사람은 늘 여기 있다 */
    here: z.boolean().default(false),
    /** 앞서 keep으로 기억해 둔 인물. 살아 있고 떠나지 않았고 붙잡히지 않았을 때만 채운다 */
    recall: contentIdSchema.optional(),
    /**
     * 있으면 쓰는 배역: 채울 수 없어도 이야기는 열린다. 상황(setup)·연출에는 쓰지 못하고,
     * 이 배역을 쓰는 선택지는 when.cast에 적는다 (없으면 그 선택지가 빠진다)
     */
    optional: z.boolean().default(false),
  });

  /** 플래그·물건 조건 (이야기의 when과 선택지의 when이 함께 쓴다) */
  const itemFlagConditions = {
    flags_all: z.array(contentIdSchema).optional(),
    /** 이 중 하나라도 서 있으면 */
    flags_any: z.array(contentIdSchema).optional(),
    flags_none: z.array(contentIdSchema).optional(),
    /** 이것을 모두 지녔으면 */
    has_items: z.array(contentIdSchema).optional(),
    /** 이 중 하나라도 지녔으면 */
    has_items_any: z.array(contentIdSchema).optional(),
    /** 이 중 하나를 지금 들거나 입고 있으면 (기획서 4.8) */
    equipped: z.array(contentIdSchema).optional(),
  };

  const storyletChoice = z
    .strictObject({
      id: contentIdSchema,
      label: z.string().min(1),
      /**
       * 이 선택지를 고를 수 있는 조건. 맞지 않으면 GM에게 보이지 않는다 (주인공이 모르는 길을 내밀지 않는다).
       * 내놓는 물건(take_item)은 따로 적지 않아도 지녔는지 본다
       */
      when: z
        .strictObject({
          ...itemFlagConditions,
          /** 있으면 쓰는 배역(optional)이 채워졌을 때만 */
          cast: z.array(contentIdSchema).optional(),
          /** 있으면 쓰는 배역이 비었을 때만 (그 사람이 없을 때의 길) */
          cast_empty: z.array(contentIdSchema).optional(),
          /** 주인공이 무리에 속해 있을 때만 (true) / 무소속일 때만 (false) */
          in_faction: z.boolean().optional(),
          /** 주인공의 무리가 이 중 하나일 때만 (none = 무소속) */
          factions: z.array(z.string().min(1)).optional(),
        })
        .optional(),
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
        /** 주인공에게 연인이 있다/없다 (12-58) */
        has_lover: z.boolean().optional(),
        /** 주인공을 가둔 무리가 이 중 하나일 때만 (갇힌 동안의 이야기, 12-55) */
        captors: z.array(z.string().min(1)).optional(),
        /** 주인공이 갇힌 지 이만큼(일) 지났다 (12-56) */
        captive_days_gte: z.number().min(0).optional(),
        /** 우리 무리 사람이 다른 무리에 붙잡혀 있는지 (어디인지는 몰라도, 12-55) */
        own_people_captive: z.boolean().optional(),
        /** 플레이어의 직분 (none = 직분 없음, 기획서 12.6) */
        occupations: z.array(z.string().min(1)).optional(),
        /** 플레이어의 직분이 이 중 어느 것도 아닐 때만 */
        occupations_not: z.array(z.string().min(1)).optional(),
        /** 길 위의 이야기 (12-53, 태그 road): 지금 오가는 길의 한쪽 끝이 이 중 하나일 때만 */
        road_touches: z.array(contentIdSchema).optional(),
        /** 길 위의 이야기: 오가는 길의 위험(두 구역 중 높은 쪽)이 이 이상일 때만 */
        road_danger_gte: z.number().int().min(0).max(3).optional(),
        /** 길 위의 이야기: 오가는 길의 위험이 이 이하일 때만 (작은 일) */
        road_danger_lte: z.number().int().min(0).max(3).optional(),
        /** 주인공이 배경의 그 일이 있었던 구역(잃은 곳)에 있을 때만 (기획서 12.6) */
        at_loss_place: z.boolean().optional(),
        /** 직분 사다리의 칸이 이 이상 (0 = 첫 칸) */
        occupation_step_gte: z.number().int().min(0).optional(),
        ...itemFlagConditions,
        /** 주인공의 빚 (세력 id 또는 own → 하한/상한) */
        debt_gte: z.record(z.string(), z.number().int()).optional(),
        debt_lte: z.record(z.string(), z.number().int()).optional(),
        /** 세력 사이 지금 태도 (from이 to를 보는 값, own = 플레이어 소속). 이탈·편들기 뒤의 이야기 */
        dispositions: z
          .array(z.strictObject({ from: z.string().min(1), to: z.string().min(1), gte: z.number().int().optional(), lte: z.number().int().optional() }))
          .optional(),
        /** 세력 클락 (플레이어는 모르는 값. 조건으로만 쓴다) */
        clock_gte: z.record(contentIdSchema, z.number().int()).optional(),
        clock_lte: z.record(contentIdSchema, z.number().int()).optional(),
        own_morale_lte: z.number().int().optional(),
        /** 지금 구역의 오늘 소음이 이 이상 (총소리, 기획서 4.8) */
        zone_noise_gte: z.number().int().min(1).max(5).optional(),
        /** 지금 구역의 감염체 압력이 이 이상 (12-112) */
        zone_infested_gte: z.number().int().min(0).max(3).optional(),
        /** 지금 구역의 감염체 압력이 평소(기준값)보다 높다 (12-123: 담 밖의 전조) */
        zone_overrun: z.boolean().optional(),
        /** 주인공의 명성 단계가 이 이상 (12-127, scenario.fame.tiers의 차례) */
        fame_gte: z.number().int().min(0).optional(),
        /** 우리 무리의 방침이 이 중 하나 (주제 id → 선택지 id 목록, 기획서 9.11). 무리 사람은 누구나 안다 */
        own_policy: z.record(contentIdSchema, z.array(contentIdSchema).min(1)).optional(),
        /** 우리 무리 식량이 며칠 치 이하 */
        own_food_days_lte: z.number().optional(),
        /** 부상 트랙이 이 단계 이상 */
        harm_at_least: z.string().optional(),
        /** 몸 상태 트랙이 이 단계 이상 (트랙 id → 단계 id. 숨은 단계는 보지 않는다) */
        conditions_at_least: z.record(z.string(), z.string()).optional(),
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
    /** 열릴 때 주인공의 공포가 오르는 단계 (12-95, 감염체 무리 같은 이야기) */
    fright: z.number().int().min(0).max(3).optional(),
    /**
     * 무엇이 부른 공포인지 (예: infected, enclosed, water). 그것을 아는 스킬은 공포를 덜고(body.fear.lore), 그것이 무서운 사람(트레잇 phobia)은 더한다.
     * fright가 0이어도 태그가 있으면 공포증이 있는 사람에게만 공포가 온다
     */
    fright_tags: z.array(contentIdSchema).default([]),
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
    /** 성적 위협 (12-59): 이 틀로 만든 사람이 chance 확률로 그런 자다 */
    menace: z.strictObject({ kind: z.enum(["harass", "coerce", "assault"]), chance: z.number().min(0).max(1) }).optional(),
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
    /**
     * 무엇인가 (12-111). person 사람 / animal 동물: 사람 이름을 짓지 않고 호칭(label)이 이름이 된다 (기획서 7.8 동행) /
     * infected 감염체: 동물처럼 이름이 없고, 말이 통하지 않아 사람의 일(대화·흥정·포로·관계·목격·소문·자라기·동행)에서 빠진다.
     * 감염체가 맞서는 판정에서 다치면 감염 위험이 저절로 붙는다 (scenario.opposition.mindless)
     */
    kind: z.enum(["person", "animal", "infected"]).default("person"),
    /** 이것에게 다칠 때의 상처 종류 (wounds.kinds). 감염체·동물의 물림·할큄. GM이 상처 종류를 비우면 이것을 쓴다 */
    wound: contentIdSchema.optional(),
    /**
     * 자랄 때(이름 없는 인물 → 이름 있는 인물, 기획서 7.10) 코드가 하나씩 고르는 재료. 없으면 자라지 않는다
     */
    profile: z
      .strictObject({
        wants: z.array(z.string().min(1)).min(1),
        fears: z.array(z.string().min(1)).min(1),
        voices: z.array(z.strictObject({ style: z.string().min(1), samples: z.array(z.string().min(1)).min(1) })).min(1),
        rules: z.array(z.string().min(1)).default([]),
        reputations: z.array(z.string().min(1)).min(1),
        secrets: z.array(z.strictObject({ content: z.string().min(1), reveal_when: z.string().min(1), min_trust: z.number().int().min(1).max(5) })).default([]),
      })
      .optional(),
    /** 자랄 때 이 확률로 이름 있는 인물과 이어진다 (kinds 중 하나, 상대는 나이가 맞는 사람) */
    ties: z.strictObject({ chance: z.number().min(0).max(1), kinds: z.array(z.enum(TIE_KINDS)).min(1) }).optional(),
    /** 지금 여기서 마주칠 만한지 (GM 상태의 틀 목록을 거른다). 없으면 언제나 */
    appears: z
      .strictObject({
        zones: z.array(contentIdSchema).optional(),
        /** none: 누구의 땅도 아닌 곳, own: 주인공 무리의 땅, other: 다른 무리의 땅 */
        zone_owner: z.array(z.enum(["none", "own", "other"])).optional(),
        segments: z.array(z.enum(TIME_SEGMENTS)).optional(),
        /** 구역 위험(danger)이 이 이상인 곳에서만 (12-111: 감염체는 위험한 곳에) */
        min_danger: z.number().int().min(0).max(3).optional(),
        /** 구역의 감염체 압력이 이 이상인 곳에서만 (12-112) */
        min_infested: z.number().int().min(0).max(3).optional(),
      })
      .optional(),
    /** 동행하면 주인공의 스킬에 더하는 보정 (예: 개 → 경계 +1). 능력+스킬 상한 안에서 */
    companion_bonus: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(-1).max(2)).optional(),
    /** 장면에 나타나면 주인공의 공포가 오르는 단계 (12-95). 한꺼번에 셋 이상 나타나면 한 단계 더 */
    fearsome: z.number().int().min(0).max(3).optional(),
    /** 무엇이 부른 공포인지 (예: infected, dog). fearsome이 0이어도 그것이 무서운 사람(트레잇 phobia)에게는 공포가 온다 */
    fright_tags: z.array(contentIdSchema).optional(),
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
