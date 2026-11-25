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
  /** 신표 (플레이 테스트 12): 무리 완장·통행패처럼 몸을 증명하는 물건. 치료 값 같은 자동 지불에서 빠진다 */
  keepsake: z.boolean().optional(),
  /** 시세가 따르는 무리 자원 (12-155). 없으면 월드의 market.kinds로 종류에서 정한다 */
  resource: contentIdSchema.optional(),
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
      /** 방수 (플레이 테스트 11, E3): 입고 있으면 비와 물일에 옷이 젖지 않는다 (물에 빠지면 젖는다) */
      waterproof: z.boolean().default(false),
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
  /** forage가 있으면 그 먹을 것 구하기(take_action.forage)에만 보정이 붙는다 (낚시 도구가 사냥을 거들지 않게, 플레이 테스트 8) */
  /** only: 이 거리(check.distance)나 활동일 때만 보정 (플레이 테스트 12: 쌍안경이 총구를 피해 뛰는 판정에도 +1) */
  tool: z
    .strictObject({
      bonus: z.record(contentIdSchema, z.number().int().min(1).max(2)),
      forage: z.array(contentIdSchema).optional(),
      /** dark: 어둡거나(opposition.dark 시간대, 불 켠 실내 빼고) 지붕 아래일 때만 (손전등, B①) */
      only: z.strictObject({ distances: z.array(z.string()).optional(), activities: z.array(z.string()).optional(), dark: z.boolean().optional() }).optional(),
    })
    .optional(),
  /** 몇 번 닳으면 망가지는지, 망가지면 남는 것 */
  durability: z.number().int().min(1).max(20).optional(),
  breaks_into: contentIdSchema.optional(),
  /** 소모품으로 쓰고 나면 이 아이템이 남는다 (물병 → 빈 물병) */
  used_into: contentIdSchema.optional(),
  /**
   * 이동 수단 (12-137): take_action.ride로 타고 이동하면 이동 시간 × speed. fuel이 있으면 한 번 이동에 하나를 쓴다 (없으면 못 탄다).
   * noise: 도착한 구역에 그만큼 소음 (감염체를 부른다). road_risk: 길 위의 일이 생길 확률 배수 (빨리 지나간다)
   */
  vehicle: z
    .strictObject({ speed: z.number().positive().max(1), fuel: contentIdSchema.optional(), noise: z.number().int().min(0).max(5).default(0), road_risk: z.number().min(0).max(1).default(1) })
    .optional(),
  /** 상하는 음식 (12-131): 하루가 지날 때 하나하나가 이 확률로 상해 없어진다 (계절 배수 scenario.spoilage) */
  perishable: z.number().min(0).max(1).optional(),
  /** 끓이지 않은 물 (12-131): 쓰면 이 확률로 병(body.disease)에 걸린다. 그 구역에 불이 피어 있으면 끓여 마셔 괜찮다 */
  contaminated: z.number().min(0).max(1).optional(),
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
     * 시작 구역 안의 시작 장소 (12-259). 없으면 시작 장면 글이 그 구역의 장소 하나만 말할 때 그 장소, 아니면 막 들어선 자리.
     * 글이 장소를 여럿 말하면 적는다 (content:check)
     */
    start_place: contentIdSchema.optional(),
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
    /** 다짐 (12-164): 이 시나리오 주인공의 큰 줄기. 없으면 배경(history)을 scenario.resolve.from_history로 읽는다 */
    resolve: z
      .strictObject({ kind: contentIdSchema, target: z.string().nullable().default(null), target2: z.string().nullable().default(null), n: z.number().int().nullable().default(null), text: z.string().min(1).max(80) })
      .optional(),
    /** 미리 정해진 지난 삶 (주인공의 기억 몇 문장) */
    background: z.array(z.string().min(1).max(200)).default([]),
    /**
     * 시작할 때 가까운 사람들 (오래 함께 버틴 동료 등): 이 인물들이 주인공을 보는 관계를 축마다 [하한, 상한] 안에서 무작위로 올린다.
     * 서로 이름을 알게 하려면 known_npcs에도 넣는다
     */
    start_bonds: z
      .strictObject({
        ids: z.array(contentIdSchema).min(1),
        trust: z.tuple([z.number().int(), z.number().int()]).default([2, 4]),
        affection: z.tuple([z.number().int(), z.number().int()]).default([2, 4]),
        respect: z.tuple([z.number().int(), z.number().int()]).default([0, 2]),
        /** 이 중 한 사람(가장 가까운 친구)은 축마다 둘씩 더 (12-251: 관계 ±10) */
        best: contentIdSchema.optional(),
      })
      .optional(),
    /** 찾는 가족 (튜토리얼): 코드가 주인공 나이에 맞춰 가족 몇 사람을 만들어 이 구역에 둔다. 주인공은 어디 있는지 모른다 */
    family: z
      .strictObject({
        zone: contentIdSchema,
        /** 가족이 사는 장소 (12-261, PT16 튜토리얼: 재회 뒤 시간대가 지나자 부모가 어느 장소 목록에도 없었다) */
        place: contentIdSchema.optional(),
        count: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([2, 3]),
        /** 가족과 주인공이 서로를 보는 관계 (축마다, 관계의 범위 안) */
        bond: z.strictObject({ trust: z.number().int(), affection: z.number().int(), respect: z.number().int() }).default({ trust: 10, affection: 10, respect: 8 }),
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
    /** 세계가 시작될 때의 몸 상태 (트랙 → 단계). 카드 글이 "다리를 다쳤다·열에 들떴다"면 진짜 상태도 그렇게 (플레이 테스트 14: 실종 정찰조장이 "부상 이상 없음") */
    starts: z.record(contentIdSchema, contentIdSchema).optional(),
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
    /** 성인 직업의 겉 직업 이름을 이 사람만 따로 (공통 규칙 21). 없으면 직업의 cover */
    occupation_cover: z.string().min(1).optional(),
    /** 성인 옵션이 켜져 있을 때만 카드에 더하는 줄 (공통 규칙 21). look·voice·knows는 늘 보이는 겉 글이다 */
    mature: z.strictObject({ look: z.string().min(1).optional(), note: z.string().min(1).optional() }).optional(),
    /** 거점 사람들이 아는 모습. 이 인물을 아는 캐릭터에게 보인다 */
    reputation: z.string().min(1),
    want: z.string().min(1),
    fear: z.string().min(1),
    values: z.record(contentIdSchema, valueScoreSchema),
    /** 트레잇 id (시나리오 traits). 성격·체질·외모. 예전의 temperament를 대신한다 */
    traits: z.array(idEnum(s.traits.map((t) => t.id))).default([]),
    /** 성격 축 덮어쓰기 (12-99): 적은 축만 이 값으로 (나머지는 트레잇과 빈 축 채우기). 말투·설정과 어긋날 때 */
    persona: z.partialRecord(idEnum((s.persona?.axes ?? []).map((a) => a.id)), z.number().int().min(-2).max(2)).optional(),
    /** 캐릭터 설정 (4.6.4, 12-246): 시나리오의 settings.items id. NPC는 굴리지 않고 연기에만 쓴다 */
    settings: z.array(contentIdSchema).optional(),
    voice: z.strictObject({
      style: z.string().min(1),
      samples: z.array(z.string().min(1)).min(1).max(4),
    }),
    routine: z.partialRecord(z.enum(TIME_SEGMENTS), z.string().min(1)),
    rules: z.array(z.string().min(1)),
    /** 이 인물이 아는 것. 시작 Belief가 된다 */
    knows: z.array(z.string().min(1)).default([]),
    /** 알지만 지키는 것 (플레이 테스트 12: 밀고자의 이름이 "물으면 말해 줄 수 있다"에 실렸다). 시작 Belief가 되고, 카드에는 따로 "먼저 말하지 않는 것"으로 */
    keeps: z.array(z.string().min(1)).default([]),
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
          secret: z.strictObject({ reveal_when: z.string().min(1), min_trust: z.number().int().min(1).max(10) }).optional(),
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
        min_trust: z.number().int().min(1).max(10),
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
    /**
     * 부탁 (12-174): 이 인물이 주인공에게 할 수 있는 사적인 부탁. 물건 부탁만 (코드가 확인한다).
     * 받으면 그 물건·기한으로 약속이 되고, 지키면 reward(물건·호감)를 건넨다
     */
    favors: z
      .array(
        z.strictObject({
          id: contentIdSchema,
          ask: z.string().min(1),
          item: z.strictObject({ id: contentIdSchema, quantity: z.number().int().min(1).default(1) }),
          days: z.number().int().min(1).max(30),
          reward: z.strictObject({ item: z.strictObject({ id: contentIdSchema, quantity: z.number().int().min(1).default(1) }).optional(), affection: z.number().int().min(0).max(3).default(1) }).default({ affection: 1 }),
        }),
      )
      .optional(),
    /**
     * 인물의 자기 일 (12-168): 주인공 없이도 진행되는 일. 차례대로 하나씩 (끝나면 다음 것).
     * steps칸이 다 차면 end(이야기 효과, 배역 self·other)와 death(self·other: 부상이 끝 단계로)가 일어난다.
     * 하루에 한 칸: fill의 조건이 맞고 chance를 넘으면. cue는 반을 넘으면 GM 카드에 보이는 낌새, news는 끝났을 때 아는 사람이 듣는 말
     */
    agenda: z
      .array(
        z.strictObject({
          id: contentIdSchema,
          label: z.string().min(1),
          steps: z.number().int().min(2).max(30),
          cue: z.string().min(1),
          news: z.string().min(1),
          other: contentIdSchema.optional(),
          fill: z
            .strictObject({
              chance: z.number().min(0).max(1).default(1),
              morale_lte: z.number().int().optional(),
              food_days_lte: z.number().optional(),
              seasons: z.array(contentIdSchema).optional(),
            })
            .default({ chance: 1 }),
          end: z.array(z.lazy(() => storyletEffect)).default([]),
          death: z.enum(["self", "other"]).optional(),
        }),
      )
      .optional(),
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
    /** 결과 조건 (플레이 테스트 11): 이야기 효과 mission_goal로 채운다. 데려오기(탈영병, 부상자)처럼 판정만으로는 알 수 없는 결과. label은 보여 줄 말 */
    z.strictObject({ goal: z.string().min(1).max(60) }),
    /** 찾아오기 (플레이 테스트 11): 보고할 때 이 무리 자원에 속하는 물건을 이만큼 지니고 있으면 채우고, 그 물건을 상관에게 건넨다 */
    z.strictObject({ bring: idEnum(s.resources.map((r) => r.id)), quantity: z.number().int().min(1).max(10) }),
    /** 배달 (플레이 테스트 11, F5): 임무 자리에서 임무 일을 할 때 이 물건을 지니고 있으면 넘기고 채운다 (받을 때 carries로 받은 짐) */
    z.strictObject({ deliver: contentIdSchema, quantity: z.number().int().min(1).max(10) }),
  ]);

  /** 임무 템플릿 (기획서 15.1: 배정 → 수행 → 보고) */
  const mission = z.strictObject({
    id: contentIdSchema,
    title: z.string().min(1),
    briefing: z.string().min(1),
    giver_rank: idEnum(rankIds(s)),
    /** 배달 일감의 짐 (F5): 받을 때 상관이 이것을 건넨다. 남의 물건이다 (공통 규칙 10) */
    carries: z.record(contentIdSchema, z.number().int().min(1).max(10)).optional(),
    /** 받아 올 값 (12-237): 짐을 넘기면 상대가 이것을 건네고, 보고 때 상관에게 넘긴다. 모자라면 일부 완수까지 (남의 물건, 공통 규칙 10) */
    collects: z.record(contentIdSchema, z.number().int().min(1).max(20)).optional(),
    /** 물일 (플레이 테스트 11, E3): 임무 자리에서 이 임무의 활동을 하면 옷이 젖는다 (방수복을 입으면 젖지 않는다) */
    wets: z.boolean().optional(),
    /** 이 계급 이상만 받는 일감 (플레이 테스트 11, C9: 신입이 신병 훈련을 맡았다) */
    min_rank: idEnum(rankIds(s)).optional(),
    deadline_hours: z.number().int().positive().max(72),
    requirements: z.array(missionRequirement).min(1),
    /**
     * 임무를 해야 하는 곳 (플레이 테스트 4). 그 자리에서 한 판정·활동만 진행으로 센다. 없으면 어디서든 (거점 안의 일).
     * 구역 id, outside(우리 거점 밖 어디든), enemy(적대하는 무리의 땅)
     */
    /** 구역 목록이면 그 가운데 어디서든 (설계 목록 5-4: 가는 길의 강변에서 조심하라는 일) */
    where: z.union([z.literal("outside"), z.literal("near"), z.literal("enemy"), contentIdSchema, z.array(contentIdSchema).min(2)]).optional(),
    /** 완수하면 알게 되는 것 (12-237: 따라가 보기·알아 오기 임무의 결과를 GM이 지어내야 했다). 주인공의 믿음으로 남는다 */
    learns: z.string().min(1).max(200).optional(),
    /** 들키지 않기가 조건인 일 (플레이 테스트 13): 임무 중에 경보가 울리거나 붙잡히면 조건을 채웠어도 일부 완수까지 */
    unseen: z.boolean().optional(),
    /** 무장이 필요한 작전: 받으면 무리의 무기고가 무기·탄약을 빌려주고, 끝나면 반납한다 (기획서 4.8) */
    armed: z.boolean().optional(),
    /** 2인 1조: 받으면 같은 무리 동료 하나가 짝으로 붙고, 임무가 끝나면 돌아간다 (기획서 7.9) */
    buddy: z.boolean().optional(),
    /** 완수하면 임무를 준 무리에 진 빚이 이만큼 준다 (일부 완수는 절반, 기획서 9.10) */
    repays_debt: z.number().int().min(1).optional(),
    /** 완수하면 임무를 준 무리의 거점을 보강한다 (담 메우기, 12-48). 일부 완수는 절반(내림) */
    fortifies: z.number().int().min(1).max(2).optional(),
    /** 정찰 임무 (움직이는 부대 파트 11): 해내면 그 구역과 맞닿은 구역의 적 부대를 보고, 당긴 클락의 공세가 기습이 된다 */
    scouts: z.boolean().optional(),
    /** 파괴공작 (파트 11): 완수하면 그 무리 창고에서 이만큼 깎는다 (일부 완수는 절반). 우리 몫(supplies)과 따로 */
    sabotages: z.strictObject({ faction: contentIdSchema, take: z.partialRecord(idEnum(s.resources.map((r) => r.id)), z.number().int().min(1)) }).optional(),
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
    /** spare: 무기를 다 잃고 우리 거점에 오면 하루 한 번 내주는 근접 무기 (플레이 테스트 13: 붙잡혀 빼앗긴 뒤 끝까지 맨손) */
    armory: z.strictObject({ items: z.record(contentIdSchema, z.number().int().min(1)), ammo_cost: z.number().int().min(0).default(0), spare: contentIdSchema.optional() }).optional(),
    /**
     * 포상 (12-171): 임무 보고로 공적이 every의 배수를 새로 넘을 때마다 items에서 하나.
     * 무리 식량이 hungry_days일치 아래면 말뿐인 포상 (상관의 존중 +1)
     */
    rewards: z
      .strictObject({
        every: z.number().int().min(1),
        hungry_days: z.number().int().min(0).default(3),
        items: z.array(z.strictObject({ id: contentIdSchema, qty: z.number().int().min(1).default(1), line: z.string().min(1) })).min(1),
      })
      .optional(),
    /** 이 무리에서 부르는 계급 이름 (12-84, 예: grunt → 약탈조원). 없는 계급은 월드의 이름 */
    rank_labels: z.record(z.string(), z.string().min(1)).default({}),
    /** false면 이 무리로 시작할 수 없다 (처음 시나리오·자유 시나리오에 없다. 해금된 시나리오로만, 기획서 9.12) */
    startable: z.boolean().optional(),
    /** 공격 성향 0 ~ 3. 0이면 먼저 공격하지 않는다 */
    aggression: z.number().int().min(0).max(3),
    /**
     * 이 전쟁에 돌릴 수 있는 몫 (12-139, 0 ~ 1, 기본 1). 나머지는 감염체와 게임에 나오지 않는 바깥의 적을 막는다.
     * 먼저 치는 확률과 치러 내보내는 병력에 곱한다. 지킬 때는 다 쓴다
     */
    war_share: z.number().gt(0).max(1).optional(),
    /** 다른 세력에 대한 태도 -3 ~ +3 (없으면 0). -2 이하면 적대 */
    disposition: z.record(contentIdSchema, z.number().int().min(-3).max(3)).default({}),
    /** 이 무리 부대와 맞붙을 때 장면에 들이는 엑스트라 틀 (움직이는 부대 ③). 없으면 그 무리의 첫 엑스트라 틀 */
    party_extra: contentIdSchema.optional(),
    /** 이 무리의 부대 이름 (움직이는 부대, 예: patrol → 순찰선). 없으면 시나리오의 war.parties 이름 */
    party_names: z.partialRecord(z.enum(["scout", "raid", "assault", "supply", "patrol"]), z.string().min(1)).default({}),
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
            /**
             * 하루에 한 칸 찰지를 두 세력의 힘으로 굴린다 (12-140). 찰 확률 = toward의 전투원 / (toward + against의 전투원).
             * 당기는 쪽(toward)이 강할수록 빨리 차고, 붙잡는 쪽(against)이 강해지면 더디다. 없으면 날마다 찬다
             */
            pull: z
              .strictObject({
                toward: contentIdSchema,
                against: contentIdSchema,
                /** 붙잡는 쪽의 힘에 곱하는 정 (함께 해 온 시간). 1이면 힘만 본다 */
                bond: z.number().min(1).max(5).default(1),
              })
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
        /** 쓸모 (플레이 테스트 11, G1): 이만큼(일) 임무를 하나도 끝내지 않으면 그 사람의 배급이 한 단계 준다 */
        idle_ration_days: z.number().int().min(1).optional(),
        /** 자리 비움 (공통 규칙 3): 임무 없이 이만큼(시간) 넘게 우리 땅 밖에 있다 돌아오면 상관이 안다 (플레이 테스트 13: 섬을 무단으로 떠났다 와도 아무도 몰랐다) */
        absence_hours: z.number().min(1).optional(),
        /** 격리 (12-238): 감염체에게 다친 뒤 이만큼(일) 안에 우리 무리 치료사가 상처를 보면 거점에 이만큼 갇힌다. 그사이 열이 드러나면 열이 내릴 때까지 (공통 규칙 1) */
        quarantine_days: z.number().int().min(1).optional(),
        /** 점호 (G2): 이 시간대가 시작될 때 잠들어 있으면 작은 불복종 행적이 남는다 */
        roll_call: z.array(z.enum(TIME_SEGMENTS)).optional(),
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
    /** base 거점, zone 그 밖 (12-313: 길목 corridor는 구역으로 합쳤다. 짧게 지나가는 것은 crossing_minutes) */
    kind: z.enum(["base", "zone"]),
    /** 이 구역을 드나드는 이동 시간 (12-313, 분): 거점 사이에 끼운 짧은 길처럼 작은 구역. 없으면 구역 짝마다 정해진 travel 범위 (routeMinutes) */
    crossing_minutes: z.number().int().positive().optional(),
    /** 시작 소유 세력. 없으면 누구의 땅도 아니다 */
    owner: contentIdSchema.nullable().default(null),
    adjacent: z.array(contentIdSchema).default([]),
    /** 지도 위 자리 (12-201, 상태 화면의 지도). 0~100 비율 좌표 (x 왼쪽→오른쪽, y 위→아래), label은 지도에 적는 짧은 이름 (없으면 name). 없으면 지도에 그리지 않는다 */
    map: z.strictObject({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), label: z.string().min(1).max(6).optional() }).optional(),
    /** 피난처: 어느 무리도 차지하거나 치지 않는다 (성당, 학자들의 캠퍼스, 12-53) */
    sanctuary: z.boolean().optional(),
    /** 갈아입을 옷이 있는 곳 (12-186, 옷가게·마트 폐허 등). 젖은 옷을 갈아입을 수 있다. 우리 무리의 거점과 내 거처는 늘 된다 */
    clothes: z.boolean().optional(),
    /** 실내 (12-98): 들어가 쉬면 바깥보다 따뜻한 도. 0이면 덮을 곳이 없다 (쉬어도 노숙). 폐허 4, 온전한 건물 7 정도 */
    cover: z.number().int().min(0).max(12).optional(),
    /**
     * 구역 안의 장소 (12-244, 공통 규칙 15): 모두가 쓰는 곳만. indoor면 지붕 아래(추위·젖음·날씨). aliases: 인물 일과(routine)에서 이 장소를 가리키는 말.
     * 개인 거처·화장실 같은 곳은 GM이 즉흥으로 만든다(spawn_place)
     */
    places: z
      .array(
        z.strictObject({
          id: contentIdSchema,
          name: z.string().min(1),
          indoor: z.boolean(),
          aliases: z.array(z.string().min(1)).default([]),
          /** 구역 안 지도 좌표 (12-304, 0~100, 위가 북쪽). 없으면 담 깊이로 층을 나눠 저절로 놓는다 (placeCoord) */
          map: z.strictObject({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
          /** 장소 종류 1~2개 (공통 규칙 15, 12-300): 이야기의 when.place_kinds가 이것으로 자리를 고른다. 월드 팩에서는 content:check가 빠짐을 잡는다 */
          kinds: z.array(contentIdSchema).max(2).default([]),
          /** 묘사 한 줄 (12-251, 플레이 테스트 14: 섬 장소에 GM이 그릴 재료가 없었다). 월드 팩에서는 content:check가 빠짐을 잡는다 */
          description: z.string().min(1).optional(),
          /** 붙잡은 사람을 가두는 곳 (PT14: 붙잡히면 그 무리의 가두는 장소가 있는 구역, 그 장소에 갇힌다) */
          jail: z.boolean().default(false),
          /** 격리하는 곳 (PT20 의무병: 격리됐는데 치료실에 남았다). 없으면 가두는 곳 */
          quarantine_room: z.boolean().optional(),
          /** 걸어 들어갈 수 있는 물가 (바다·갯가·강가, 12-261). 마시는 물(water)과 따로 */
          wade: z.boolean().optional(),
          /** 이웃 장소 (장소 개편, docs/places-v2-plan.md). 한쪽에만 적어도 로더가 양쪽으로 맞춘다 */
          near: z.array(contentIdSchema).default([]),
          /** 구역 안의 길: 구역에 들어오면 길에 도착한다. to = 이 길로 이어지는 구역 */
          road: z.boolean().default(false),
          to: z.array(contentIdSchema).default([]),
          /** 담을 지나 처음 닿는 곳 (장소 개편): 잠입 깊이를 여기서 센다. 길에서 gate를 거치지 않고 닿는 곳은 담 밖 */
          gate: z.boolean().default(false),
        }),
      )
      .default([]),
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
        /** 이 길을 들어서 안다 (12-251): 이 플래그 중 하나가 있으면 상태·?지도에 건너는 길로 보인다. 비면 보이지 않는다 (스스로는 모른다) */
        heard_flags: z.array(contentIdSchema).default([]),
        attempt: z.strictObject({ moves: z.array(z.string()).min(1), label: z.string().min(1) }),
      })
      .optional(),
    /** 외딴곳: 도시 공통 이야기(world)와 엑스트라 틀은 이 구역을 zones로 직접 적은 것만 나온다 (닫힌 섬 등, 기획서 9.12) */
    isolated: z.boolean().optional(),
    /** 소유 세력이 하루에 얻는 자원 */
    yields: resourceAmounts.default({}),
    /** 거점처럼 물 보급을 받는 곳 (플레이 테스트 11, E5: 취사 천막까지 있는 물류창고에 물이 없었다). 주인이 우리 무리일 때만 */
    water_supply: z.boolean().optional(),
    /** 끓이지 않은 물을 뜰 곳 (12-251, 플레이 테스트 14: 무소속이 물을 찾을 길이 없었다): 개천·빗물 고인 곳 같은 이름. 무리의 물 산출은 없고, 누구나 떠 마신다 (끓이지 않은 물) */
    stream: z.string().min(1).optional(),
    /** 수색하면 나올 수 있는 것 (기획서 4.7). modifier: 수색 판정 보정 (털린 곳 -1, 넉넉한 곳 +1, 12-220), items: 무게로 고른다 */
    loot: z
      .strictObject({
        modifier: z.number().int().min(-2).max(2).default(0),
        items: z.array(z.strictObject({ item: contentIdSchema, weight: z.number().positive(), qty: z.tuple([z.number().int().positive(), z.number().int().positive()]) })),
      })
      .optional(),
  });

  /** 스토리렛 효과. 코드가 검증하고 적용한다 (AI가 고르는 것은 선택지뿐이다) */
  const storyletEffect = z.union([
    z.strictObject({ set_flag: contentIdSchema }),
    z.strictObject({ clear_flag: contentIdSchema }),
    /** 벌을 받아들이면 도둑질로 가져온 물건을 돌려놓는다 (설계 목록 2-4, 규율 회의). 이미 써 버린 것은 남은 만큼 */
    z.strictObject({ return_stolen: z.literal(true) }),
    /** 배역(또는 commander)이 플레이어를 보는 관계 */
    /** kind: 까닭 열쇠 (공통 규칙 19). 비우면 이야기 id. 이야기 효과는 하루 상한 없이 같은 까닭 간격만 받는다 */
    z.strictObject({ relation: z.strictObject({ who: z.string().min(1), axis: z.enum(RELATION_AXES), delta: z.number().int().min(-3).max(3), kind: z.string().min(1).optional() }) }),
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
    /** 감염체를 쓰러뜨린다 (플레이 테스트 11). 사람에게는 아무 일도 없다 (원칙 3) */
    z.strictObject({ put_down: z.strictObject({ who: z.string().min(1) }) }),
    /** 위협이 지나갔다·떨쳐 냈다: 장면의 감염체·짐승 배역이 장면을 떠난다 (12-293, PT25 분대장: 숨어서 물결이 지나갔다는데 감염체 셋이 곁에 남았다) */
    z.strictObject({ threat_passes: z.literal(true) }),
    /** 배역 NPC의 계급을 바꾼다 (지도부 교체·강등) */
    z.strictObject({ npc_rank: z.strictObject({ who: z.string().min(1), rank: idEnum(rankIds(s)) }) }),
    /** mature: 성인 옵션이 켜져 있을 때 보이는 글 (fact는 늘 있는 순화한 겉 글, 공통 규칙 21) */
    z.strictObject({ belief: z.strictObject({ fact: z.string().min(1).max(300), mature: z.string().min(1).max(300).optional(), source: beliefSourceSchema.default("seen") }) }),
    z.strictObject({ merit: z.number().int().min(-3).max(3) }),
    /** 주인공의 계급을 바꾼다 (12-152: 강등·추대). 같은 무리 안에서. 무소속이면 아무 일도 없다 */
    z.strictObject({ player_rank: z.strictObject({ rank: idEnum(rankIds(s)) }) }),
    /** 주인공이 무리에서 쫓겨나 떠돌이가 된다 (12-152). 배급·임무·분대·회의가 끊긴다. 무소속이면 아무 일도 없다 */
    z.strictObject({ expel: z.literal(true) }),
    /** 직분의 평판 ± (기획서 12.6). 쌓이면 직분 사다리를 오른다. 직분이 없으면 아무 일도 없다 */
    z.strictObject({ standing: z.number().int().min(-2).max(3) }),
    /** from이 있으면 그 배역에게서 옮기고(가진 것만), 없으면 새로 생긴다 (콘텐츠가 정한 보상) */
    z.strictObject({ give_item: z.strictObject({ item: contentIdSchema, from: z.string().optional(), quantity: z.number().int().positive().default(1) }) }),
    /** 주인공이 그 배역의 이름을 알게 된다 (얼굴만 알던 원수 등). 이미 알면 아무 일도 없다 */
    z.strictObject({ reveal_name: z.strictObject({ who: z.string().min(1) }) }),
    /** 다가오는 재난에 대비한다 (12-169): 전조 동안에만. 한 번에 피해 25%, 최대 50% 준다 */
    z.strictObject({ disaster_prepare: z.literal(true) }),
    /** 인물의 자기 일에 끼어든다 (12-168): delta만큼 앞당기거나 늦춘다 (다 차면 그 자리에서 끝난다), stop이면 끝 효과 없이 그만두게 한다 */
    z.strictObject({ agenda: z.strictObject({ who: z.string().min(1), delta: z.number().int().min(-10).max(10).default(0), stop: z.boolean().default(false) }) }),
    /** 다짐의 단계를 한 칸 올린다 (12-164): text는 지금 어디까지 왔는지 한 줄 (상태 화면에 다짐 옆으로 보인다). 다짐이 없으면 아무 일도 없다 */
    z.strictObject({ resolve_step: z.strictObject({ text: z.string().min(1).max(60) }) }),
    /**
     * 다짐을 건넨다 (12-164): 이 선택지를 고르면 주인공의 다짐이 된다 (다짐이 없을 때만, 12-199. 이 효과가 있는 이야기는 다짐이 있으면 열리지 않는다). target은 배역 key나 콘텐츠 id (zone이면 지금 구역, own이면 우리 무리),
     * text는 다짐 한 줄 (문장의 자리를 쓸 수 있다)
     */
    z.strictObject({
      resolve: z.strictObject({ kind: contentIdSchema, target: z.string().nullable().default(null), target2: z.string().nullable().default(null), n: z.number().int().nullable().default(null), text: z.string().min(1).max(80) }),
    }),
    /**
     * 주인공이 다친다 (12-56): 판정이 붙은 선택지의 대가 있는 성공·실패에서만 (콘텐츠 검증이 막는다).
     * 부상 트랙 steps 단계, 죽음 바로 앞에서 멈춘다 (이야기는 사람을 죽이지 않는다, 원칙 3)
     */
    /** kind: 상처 종류 (wounds.kinds). 피가 나는 종류면 출혈도 붙는다 (플레이 테스트 12: "살이 찢겼다"에 출혈이 없었다) */
    z.strictObject({ wound: z.strictObject({ steps: z.number().int().min(1).max(2), cause: z.string().min(1).max(60), kind: contentIdSchema.optional() }) }),
    /** 주인공과 이 배역의 연애가 끝난다 (12-60: "그만하자") */
    z.strictObject({ end_romance: z.strictObject({ who: z.string().min(1) }) }),
    /** 배역 NPC의 상처를 돌본다 (부상 트랙 steps 단계 낫는다, 12-60) */
    z.strictObject({ npc_heal: z.strictObject({ who: z.string().min(1), steps: z.number().int().min(1).max(2) }) }),
    /** 이 배역을 주인공의 원수로 삼는다 (12-59: 위협한 자를 잊지 않는다). 배경 부품 enemy가 더해진다 */
    z.strictObject({ grudge: z.strictObject({ who: z.string().min(1), why: z.string().min(1).max(80) }) }),
    /**
     * 협박이 끝난다 (12-182): 그 배역이 더는 주인공에게 약점을 잡혀 있지 않고 원한도 풀린다.
     * drop이면 주인공이 쥔 그 사람의 약점도 내려놓는다 (다시 협박·폭로하지 못한다)
     */
    z.strictObject({ end_blackmail: z.strictObject({ who: z.string().min(1), drop: z.boolean().default(false) }) }),
    /** 현상금을 거둔다 (12-136): 먼저 건 무리({bounty_by})의 것 */
    z.strictObject({ clear_bounty: z.literal(true) }),
    /** 그 사람의 복수 다짐이 풀린다 (12-135: 화해, 대가를 치름, 결판) */
    z.strictObject({ settle_vendetta: z.strictObject({ who: z.string().min(1) }) }),
    /** 붙잡힌 배역이 어디 갇혔는지 주인공이 알게 된다 (진짜 상태에서 코드가 채운다, 12-56) */
    /** 장소를 알게 된다 (설계 목록 C-1, PT21 튜토리얼: 재회한 뒤에도 가족 집이 모르는 곳이었다). zone이 없으면 지금 구역 */
    z.strictObject({ learn_place: z.strictObject({ place: contentIdSchema, zone: contentIdSchema.optional() }) }),
    z.strictObject({ locate: z.strictObject({ who: z.string().min(1), source: z.enum(["seen", "report", "rumor"]).default("report") }) }),
    /** 주인공이 붙잡힌다 (12-55): by 무리(own 외에 zone_owner 등 별칭), zone이 없으면 그 무리의 거점에 갇힌다 */
    /** days: 우리 무리가 벌로 가둘 때(by: own) 며칠 뒤 저절로 풀린다 (12-257). 빼앗는 것도 무리 사이가 나빠지는 것도 없다 */
    z.strictObject({ capture_player: z.strictObject({ by: z.string().min(1), zone: contentIdSchema.optional(), days: z.number().int().min(1).max(7).optional() }) }),
    /** 갇힌 주인공이 풀려난다: returned면 빼앗긴 것을 돌려받는다, home이면 우리 무리의 거점으로 돌아간다 */
    /** 풀려난다. home: 우리 거점으로, out: 붙잡은 무리 땅이 아닌 맞닿은 구역으로 빠져나간다 (플레이 테스트 13: 탈출 기회) */
    z.strictObject({ release_player: z.strictObject({ returned: z.boolean().default(true), home: z.boolean().default(false), out: z.boolean().default(false) }) }),
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
    /** 주인공이 손에 든 무기를 닳게 한다 (플레이 테스트 12: "걸린 탄이 빠지지 않는다"인데 총은 멀쩡했다) */
    z.strictObject({ wear_weapon: z.strictObject({ amount: z.number().int().min(1).max(10).default(1) }) }),
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
    /** 수행 중인 임무의 결과 조건(goal)을 채운다 (플레이 테스트 11) */
    z.strictObject({ mission_goal: z.literal(true) }),
    z.strictObject({ faction_resource: z.strictObject({ faction: z.string().min(1), resource: contentIdSchema, delta: z.number().int().min(-50).max(50) }) }),
    /** 무리의 사람 수가 바뀐다 (12-133: 피난민을 받아들이거나 사람이 떠난다). 입이 늘면 소모가, 손이 늘면 산출이 는다 (전쟁 틱이 population을 읽는다) */
    z.strictObject({ faction_population: z.strictObject({ faction: z.string().min(1), delta: z.number().int().min(-10).max(10) }) }),
    /** 주인공이 그 무리에 들어간다: 무소속이면 가입, 다른 무리에 있으면 옮긴다 (rank가 없으면 가장 낮은 계급). 이미 그 무리면 아무 일도 없다 */
    /** grace_days: 들어온 뒤 이 날수 동안은 위험 임무(작전·적 땅)를 오늘의 일감에 내지 않는다 (12-239, 튜토리얼 "일주일은 적응 삼아") */
    /** occupation: 들어갈 자리(직분, 12-309). 없으면 무소속은 붕괴 전 직업으로 정하고(scenario.admission.posts), 무리를 옮기면 지금 직분 그대로. rank는 occupation을 적었을 때만 그 자리의 계급을 대신한다 */
    z.strictObject({
      join_faction: z.strictObject({
        faction: contentIdSchema,
        rank: idEnum(rankIds(s)).optional(),
        title: z.string().min(1).max(24).optional(),
        occupation: contentIdSchema.optional(),
        grace_days: z.number().int().min(1).max(30).optional(),
      }),
    }),
    /**
     * 대표의 면담에서 (공통 규칙 22 받아들임, when.admission 이야기): accept 손님으로 든 무리에 들어간다 (권한 자리로), decline 손님으로 남고 나중에 다시 권한다,
     * { ask: 직분 } 권한 자리 대신 그 자리로 들어간다 (scenario.admission.posts.ask 중 하나, 12-309)
     */
    z.strictObject({ admission: z.union([z.enum(["accept", "decline"]), z.strictObject({ ask: contentIdSchema })]) }),
    /**
     * 배역 NPC의 몸 상태 ± (기획서 7.7). chance면 그 확률로만 (긁혔는데 정말 감염됐나는 코드가 굴린다). 부상 트랙은 안 된다.
     * 양수 = 나빠짐, 음수 = 나아짐
     */
    z.strictObject({ npc_body: z.strictObject({ who: z.string().min(1), track: contentIdSchema, delta: z.number().int().min(-3).max(3), chance: z.number().min(0).max(1).default(1) }) }),
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
    /** 배역이 동행을 그만둔다 (기획서 7.8) */
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
        /** 성인 옵션이 켜져 있을 때 보이는 글 (summary는 순화한 겉 글, 공통 규칙 21) */
        mature: z.string().min(1).max(120).optional(),
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
    /** own = 플레이어 소속, other = 플레이어 소속이 아닌 사람 (12-135), 또는 세력 id */
    faction: z.string().optional(),
    ranks: z.array(idEnum(rankIds(s))).optional(),
    /** 이 직분인 사람만 (기획서 12.6: 같은 부엌의 요리사, 같은 진료소의 의무병). same이면 주인공과 같은 직분 */
    occupations: z.array(z.string().min(1)).optional(),
    /** 플레이어가 아는 인물만 */
    known: z.boolean().default(false),
    /** 이 인물의 플레이어에 대한 신뢰 하한 */
    /** 플레이 테스트 12: 곁에 함께 다니는 사람은 빼고 ("빈 침상"이 곁의 분대원을 없다고 썼다), 주인공을 덜 믿거나 덜 아끼는 사람만 ("누운 사람의 몫"의 날 선 사람이 다정한 사람으로 뽑혔다) */
    not_companion: z.boolean().optional(),
    /** 주인공의 분대원·같은 분대는 빼고 (PT20 분대장: 신병 이야기가 이미 사수인 분대원을 "총이 서툰 신병"으로 썼다) */
    not_squad: z.boolean().optional(),
    trust_lte: z.number().int().optional(),
    affection_lte: z.number().int().optional(),
    trust_gte: z.number().int().optional(),
    /** 어른만 (월드의 성인 나이 이상. 부모·보호자 자리에 아이가 들지 않게) */
    adult: z.boolean().optional(),
    /** 이 나이 이하만 (12-251, 플레이 테스트 14: 49세 고참이 신병 이야기의 신병이 됐다) */
    age_lte: z.number().int().min(1).optional(),
    /** 주인공에게 협박당해 되갚을 마음을 품은 사람만 (12-153) */
    blackmailed: z.boolean().optional(),
    /** 같은 무리의 이름 있는 사람 가운데 이 사람을 믿지 않는(신뢰 -4 이하) 사람이 이만큼 이상 (12-152: 재판·불신임) */
    distrusted_gte: z.number().int().min(1).optional(),
    /** 주인공에게 복수를 다짐한 사람만 (12-135: 주인공이 죽인 사람의 가족·친구) */
    vendetta: z.boolean().optional(),
    /** 죽은 앞 주인공을 기억하는 사람만 (12-158: 관계가 있거나 호감이 legacy.close_affection 이상). 문장의 {departed}가 그 앞 주인공 */
    mourner: z.boolean().optional(),
    /** 장례 이야기에서 죽은 사람(when.funeral의 {deceased})과 가까웠던 사람만 (12-163) */
    bereaved: z.boolean().optional(),
    /** 자기 일이 반을 넘은 사람만 (12-168: 낌새가 보이는 사람) */
    agenda_half: z.boolean().optional(),
    /** 주인공의 다짐의 대상인 사람 (12-164). here와 함께 쓰면 지금 이 구역에 있을 때만 */
    resolve_target: z.boolean().optional(),
    /** 소문으로만 주인공을 아는 팬(fan) 또는 안티(anti)만 (12-127) */
    stance: z.enum(["fan", "anti"]).optional(),
    /** 발동할 때 장면에 들어온다. 들어오는 배역은 지금 같은 장소에 있을 사람만 (공통 규칙 15 castHere, 12-292) */
    enter: z.boolean().default(true),
    /** 찾아오는 배역 (문병·부르러 옴·순찰): 같은 장소가 아니어도 같은 구역에서 스스로 움직일 수 있는 사람이면 찾아온다. 다른 구역에서는 오지 않는다 (12-292) */
    comes: z.boolean().optional(),
    /** 멀리서 오는 배역 (갇힌 주인공을 구하러 온 사람, 몸값 사절): 다른 구역에 있어도 스스로 움직일 수 있으면 온다 (12-292) */
    afar: z.boolean().optional(),
    /** 이름 없는 배역(extra)을 주인공을 가둔 무리의 포로로 만든다: 같이 갇힌 사람 (PT19·PT20 졸병: "같은 방 사람"이 시간대가 바뀌자 철망 밖으로 "자리를 떴다") */
    fellow_captive: z.boolean().optional(),
    /** 이 배역이 무리의 대표다: 몇 명인지 (2 이상이면 이 배역과 맞서는 판정에 -1, 플레이 테스트 13) */
    crowd: z.number().int().min(2).max(20).optional(),
    /** 이 인물의 몸 상태 (기획서 7.7): track의 단계가 at_least 이상, at_most 이하 (단계 id). 진짜 상태로 본다 (연출은 GM 전용) */
    condition: z.strictObject({ track: contentIdSchema, at_least: contentIdSchema.optional(), at_most: contentIdSchema.optional() }).optional(),
    /** 발동할 때 이 인물의 몸 상태를 적어도 이 단계로 (트랙 → 단계). 이야기가 "다쳤다·굶었다"라고 하면 진짜 상태도 그렇게 (플레이 테스트 12) */
    starts: z.record(contentIdSchema, contentIdSchema).optional(),
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
    /** 연애 (12-58): lover 주인공의 연인, suitor 주인공에게 마음이 있는 사람, ex 주인공과 헤어진 사람, jilted 주인공의 연인을 빼앗긴 사람 (12-185) */
    romance: z.enum(["lover", "suitor", "ex", "jilted"]).optional(),
    /** 지금 주인공이 있는 구역에 있는 사람만 (찾던 사람을 마주치는 장면). 함께 다니는 사람은 늘 여기 있다. 연애 배역(romance)은 적지 않아도 늘 그렇다 */
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
      /** 성인 선택지 (공통 규칙 21): 성인 옵션이 꺼져 있으면 숨긴다 */
      mature: z.boolean().optional(),
      /**
       * 이 선택지를 고를 수 있는 조건. 맞지 않으면 GM에게 보이지 않는다 (주인공이 모르는 길을 내밀지 않는다).
       * 내놓는 물건(take_item)은 따로 적지 않아도 지녔는지 본다
       */
      when: z
        .strictObject({
          ...itemFlagConditions,
          /** 있으면 쓰는 배역(optional)이 채워졌을 때만 */
          cast: z.array(contentIdSchema).optional(),
          /** 주인공이 무리에 속해 있을 때만 (true) / 무소속일 때만 (false) */
          in_faction: z.boolean().optional(),
          /** 주인공의 무리가 이 중 하나일 때만 (none = 무소속) */
          factions: z.array(z.string().min(1)).optional(),
          /** 대표가 권한 자리가 이 직분이 아닐 때만 (면담에서 다른 자리 청하기, 12-309) */
          post_not: contentIdSchema.optional(),
        })
        .optional(),
      /**
       * 얼굴을 보고 하는 선택지의 상대 배역 (12-259, PT15 졸병: 장면에 없는 오지호에게 편지를 "건넸다"). 그 배역이 장면에 없으면
       * 같은 구역에 있을 때 그 장소로 가서(장소를 모르면 찾아가) 장면에 들이고, 다른 구역이면 고를 수 없다
       */
      meets: contentIdSchema.optional(),
      /** 이 선택지로 주인공이 옮겨 가는 지금 구역의 장소 (따라 나가기 등, 12-262). 장면의 배역은 함께 간다 */
      goes_to: contentIdSchema.optional(),
      /** 달아나기 (PT20 졸병·튜토리얼·분대장: 달아나기에 성공해도 그 자리에 쫓던 사람과 남았다): 판정이 빗나가지 않으면 가장 가까운 길로 빠져나가고 배역은 그 자리에 남는다 */
      escapes: z.boolean().optional(),
      /** 되돌아가기 (12-307, PT30 하얀매: 매복 길목에서 "걸음을 돌린다"가 성공했는데 도착한 구역에 그대로 있었다): 길 위의 일에서 판정이 빗나가지 않으면 떠나온 구역으로 길을 되짚어 돌아가고, 배역은 그 자리에 남는다 */
      turns_back: z.boolean().optional(),
      /** 이 선택지 뒤 장면을 떠나는 배역 (어디론가 들어갔다·떠났다, 12-262. PT17 섬: 저장고로 들어간 사람이 장면에 남아 짝이 됐다) */
      leaves: z.array(contentIdSchema).optional(),
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
    /** 꼭 열려야 하는 이야기 (플레이 테스트 12: 튜토리얼 엔딩이 하루 상한에 막혔다). 하루 상한·위협 상한에 막히지 않는다 */
    essential: z.boolean().default(false),
    /** 자는 주인공을 깨워 열 수 있는가 (12-251, 플레이 테스트 14: 튜토리얼 안내가 자정에 잠을 깨웠다). false면 깨어 있을 때만 */
    wakes: z.boolean().default(true),
    /** 누워 있는 동안의 이야기 (플레이 테스트 11, D4): 몸이 위급해 급한 이야기만 열릴 때도 열린다 (문병, 간호, 침상의 소식) */
    bedside: z.boolean().optional(),
    /** 적의 매복 (12-177): 열리면 주인공은 매복당한 것이다 (다음 판정 하나가 불리하다, 실패하면 혼란) */
    ambush: z.boolean().optional(),
    /** 이 이야기가 맞는 주인공의 처지 (공통 규칙 4, rules/situation.ts). 적지 않으면 태그·bedside·urgent로 짐작한다 */
    situations: z.array(z.enum(["captive", "lying", "exploring", "infiltrating", "battle", "threatened", "awake"])).optional(),
    /** 연습 (대련): 이 이야기의 판정으로는 방어구·무기가 닳지 않는다 (플레이 테스트 13: 친구와의 대련에 갑옷이 망가졌다) */
    practice: z.boolean().optional(),
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
        /** 이 구역들에 있지 않을 때만 (플레이 테스트 11: 고향 동네에 와 있는데 "옛 동네 소식") */
        zones_none: z.array(contentIdSchema).optional(),
        /** 이야기가 열릴 때 주인공이 하던 일 (플레이 테스트 11: 자는 사람에게 "서 있지 말고", 보초 서는 사람에게 "걸으면 따라온다") */
        activities: z.array(z.enum(ACTIVITIES)).min(1).optional(),
        activities_none: z.array(z.enum(ACTIVITIES)).min(1).optional(),
        /**
         * 지붕 아래(true)·바깥(false)에서만, 어디서나("any") (12-244, 공통 규칙 15). 모든 이야기가 꼭 적는다 (설계 목록 6-3, content:check:
         * 낱말 목록으로 바깥 글을 잡아 오던 것이 판마다 새 낱말로 빠져나갔다)
         */
        indoor: z.union([z.boolean(), z.literal("any")]).optional(),
        /**
         * 이 장소에서만 (12-251, 공통 규칙 15). 구역 장소의 id. 적지 않으면 이야기 글(setup·variants)에 나오는 지금 구역의 장소 이름·aliases로 정한다.
         * 장소를 정하지 않은 자리(막 들어선 자리)에서는 거르지 않는다
         */
        places: z.array(contentIdSchema).min(1).optional(),
        /**
         * 이런 종류의 자리에서만 (12-300, 공통 규칙 15): 장소 kinds (시나리오 place_kinds). places를 적지 않았을 때 쓴다.
         * 그 종류의 장소가 지금 구역에 없으면 열리지 않는다. 장소 id(places)는 그 장소 하나에서만 말이 되는 이야기만
         */
        place_kinds: z.array(contentIdSchema).min(1).optional(),
        /** 이 이야기가 열린 지 이만큼 지난 뒤에만 (12-251, 플레이 테스트 14: "하룻밤 담 밖에서" 2시간 뒤 다시 정문 이야기) */
        after_storylet: z.strictObject({ id: contentIdSchema, hours: z.number().positive() }).optional(),
        /** 우리 무리 사람이 본 무거운 짓(시나리오 offense)이 있고 아직 다뤄지지 않았을 때만: 규율 회의 (12-257, 공통 규칙 3) */
        own_offense: z.boolean().optional(),
        /**
         * 부르는 이야기 (12-260): 상관이 주인공을 불러 가는 장면이라 어느 장소에서든 열리고, 글이 말하는 장소 하나로 주인공을 옮긴다
         * (PT15 파트 7: 규율 회의가 "광장"·"교무실"에서만 열려 사흘 안에 열리지 못할 수 있었다)
         */
        summons: z.boolean().optional(),
        /**
         * 손님으로 든 무리의 대표가 면담할 때 (공통 규칙 22 받아들임, rules/admission.ts offerDue). 외딴곳에서도 열린다.
         * due 면담 시각이 지났다, overdue 그 뒤로 하루가 지나도 면담이 없었다 (대표가 죽었거나 붙잡혔으면 간부가 대신)
         */
        admission: z.enum(["due", "overdue"]).optional(),
        /** 곁의 동행 수 (플레이 테스트 11: 동행이 있는데 "혼자 걷기엔 험해") */
        companions_lte: z.number().int().min(0).optional(),
        companions_gte: z.number().int().min(1).optional(),
        /** 우리 무리 구역에 있는지 */
        own_territory: z.boolean().optional(),
        /** 지금 구역의 주인: none 누구의 땅도 아님, own 우리, other 다른 무리 */
        zone_owner: z.array(z.enum(["none", "own", "other"])).optional(),
        /** 지금 구역의 주인이 이 무리 중 하나 (플레이 테스트 11, D6: 처음 땅이 전쟁으로 넘어가도 그 땅 주인의 보초가 나오게) */
        owners: z.array(contentIdSchema).min(1).optional(),
        /** 플레이어의 소속 세력 (none = 무소속) */
        factions: z.array(z.string().min(1)).optional(),
        /** 주인공에게 연인이 있다/없다 (12-58) */
        has_lover: z.boolean().optional(),
        /** 주인공을 가둔 무리가 이 중 하나일 때만 (갇힌 동안의 이야기, 12-55) */
        captors: z.array(z.string().min(1)).optional(),
        /** 주인공이 갇힌 지 이만큼(일) 지났다 (12-56) */
        captive_days_gte: z.number().min(0).optional(),
        /** 주인공이 무리에 들어 있다/없다 (12-263: 오래 갇힌 날 우리 무리가 데려오는지, 붙잡은 쪽이 내다 버리는지) */
        in_faction: z.boolean().optional(),
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
        /** 야영의 이야기 (12-148, 태그 camp): 지켜보는 밤(깨어 있거나 보초를 설 동행이 있다)일 때만 (true) / 아무도 지키지 않고 잠든 밤일 때만 (false) */
        camp_watched: z.boolean().optional(),
        /** 무리 안의 신망 (12-152): 같은 무리의 이름 있는 사람 가운데 주인공을 믿지 않는(신뢰 -4 이하) 사람이 이만큼 이상 */
        own_distrust_gte: z.number().int().min(1).optional(),
        /** 주인공을 믿는(신뢰 +4 이상) 같은 무리 사람이 이만큼 이상 */
        own_trust_gte: z.number().int().min(1).optional(),
        /** 지금 구역의 위험(위험과 감염체 압력 중 높은 쪽)이 이 이상 / 이하 (야영의 이야기) */
        camp_danger_gte: z.number().int().min(0).max(3).optional(),
        camp_danger_lte: z.number().int().min(0).max(3).optional(),
        /** 지금 구역에 모닥불이 타고 있다 (true) / 없다 (false) */
        campfire: z.boolean().optional(),
        /** 곁의 동물이 이 재주를 배웠다 (12-172) */
        companion_trick: contentIdSchema.optional(),
        /** 함께 다니는 동물이 있다(true) / 없다(false) (플레이 테스트 8: 누렁이가 있는데 누렁이가 또 따라왔다) */
        animal_companion: z.boolean().optional(),
        /** 지금 구역에 이 시설이 있다 (12-175 가축 등) */
        facility_here: contentIdSchema.optional(),
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
        /** 주인공에게 현상금이 걸려 있다 (12-136). 문장의 자리 {bounty_by}는 먼저 건 무리 */
        bounty: z.boolean().optional(),
        /** 주인공의 다짐 (12-164): 이 갈래 중 하나이고(kinds), 단계가 이 범위. near_target: 다짐의 대상 구역이나 맞닿은 구역에 있다 (12-193). 문장의 자리 {target}은 다짐의 대상, {resolve}는 다짐 한 줄 */
        resolve: z
          .strictObject({ kinds: z.array(contentIdSchema).min(1).optional(), stage: z.number().int().min(0).optional(), stage_gte: z.number().int().min(0).optional(), stage_lte: z.number().int().min(0).optional(), near_target: z.boolean().optional() })
          .optional(),
        /** 이 구역에 이전 주인공의 유해(remains, 묻히지 않은 것)나 무덤(grave)이 있다 (12-130: 계승의 흔적) */
        predecessor_here: z.enum(["remains", "grave"]).optional(),
        /** 큰 재난 (12-169): 그 재난이 이 단계 (omen 전조, struck 덮친 뒤)이고 주인공이 가까이 있을 때. kinds가 있으면 그 재난만. 문장의 {disaster_zone} */
        disaster: z.strictObject({ phase: z.enum(["omen", "struck"]), kinds: z.array(contentIdSchema).optional() }).optional(),
        /** 사흘 안에 우리 무리의 이름 있는 사람이 죽었다 (12-163: 장례). 문장의 자리 {deceased}는 그 사람 */
        funeral: z.boolean().optional(),
        /** 주인공의 명성 단계가 이 이상 (12-127, scenario.fame.tiers의 차례) */
        fame_gte: z.number().int().min(0).optional(),
        /** 우리 무리의 방침이 이 중 하나 (주제 id → 선택지 id 목록, 기획서 9.11). 무리 사람은 누구나 안다 */
        own_policy: z.record(contentIdSchema, z.array(contentIdSchema).min(1)).optional(),
        /** 우리 무리 식량이 며칠 치 이하 */
        own_food_days_lte: z.number().optional(),
        /** 부상 트랙이 이 단계 이상 */
        harm_at_least: z.string().optional(),
        /** 부상 트랙이 이 단계 이하 (설계 목록 6-6: 치명상인 포로에게 노역 할당량) */
        harm_at_most: z.string().optional(),
        /** 몸 상태 트랙이 이 단계 이상 (트랙 id → 단계 id. 숨은 단계는 보지 않는다) */
        conditions_at_least: z.record(z.string(), z.string()).optional(),
        mission_active: z.boolean().optional(),
        /** 임무를 하나도 끝내지 않은 날이 이만큼 이상 (G1: 쓸모를 재는 이야기) */
        idle_days_gte: z.number().int().min(1).optional(),
        /** 수행 중인 임무가 이 템플릿 중 하나이고 그 임무의 장소에 있다 (플레이 테스트 11: 탈영병·부상자를 실제로 마주치는 이야기) */
        mission: z.array(contentIdSchema).min(1).optional(),
        /** 최근 N시간 안에 전황 소식을 들었는지 */
        war_news_within_hours: z.number().positive().optional(),
        /** 이 구역이나 맞닿은 구역에 실제 부대가 있다 (움직이는 부대 5-2): 그 무리, 주인공을 적대하는 무리만(hostile), 부대 종류 */
        party_near: z
          .strictObject({ faction: contentIdSchema.optional(), hostile: z.boolean().optional(), kinds: z.array(z.enum(["scout", "raid", "assault", "supply", "patrol"])).min(1).optional() })
          .optional(),
        /** 이 구역에서 N시간 안에 부대끼리 부딪친 일이 있었다 (흔적 이야기, 5-2) */
        party_trace_hours: z.number().positive().optional(),
      })
      .default({}),
    cast: z.record(contentIdSchema, castRole).default({}),
    /** 상황 (GM이 서술의 출발점으로 쓴다). {배역} {zone} {scarce}, 조사는 {friend:이/가} */
    setup: z.string().min(1),
    /** 같은 이야기의 다른 상황 문장 (12-139). 되풀이될 때마다 setup → variants 차례로 돌아가며 쓴다 (같은 장면이 같은 말로 반복되지 않게) */
    variants: z.array(z.string().min(1)).default([]),
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
    /** 겉모습 후보. 성별이 드러나는 것은 { text, gender }로 적어 그 성별일 때만 고른다 (B12, 플레이 테스트 9: 여자로 적힌 사람이 남자로 생겼다) */
    looks: z.array(z.union([z.string().min(1), z.strictObject({ text: z.string().min(1), gender: contentIdSchema })])).min(1),
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
    /**
     * 이것에게 다칠 때의 상처 종류 (wounds.kinds). 감염체·동물의 물림·할큄. GM이 상처 종류를 비우면 이것을 쓴다.
     * 위험의 무게와 판정 결과로 나눌 수도 있다 (플레이 테스트 11): { light: { miss: cut }, heavy: { miss: bite, partial: claw } }
     */
    wound: z
      .union([
        contentIdSchema,
        z.strictObject({
          light: z.partialRecord(z.enum(["partial", "miss"]), contentIdSchema).default({}),
          heavy: z.partialRecord(z.enum(["partial", "miss"]), contentIdSchema).default({}),
        }),
      ])
      .optional(),
    /**
     * 자랄 때(이름 없는 인물 → 이름 있는 인물, 기획서 7.10) 코드가 하나씩 고르는 재료. 없으면 자라지 않는다
     */
    profile: z
      .strictObject({
        wants: z.array(z.string().min(1)).min(1),
        fears: z.array(z.string().min(1)).min(1),
        /**
         * 말투 후보. 자랄 때 그 사람의 성격·말씨와 어긋나지 않는 것을 고른다 (PT14: 수다쟁이에게 "말을 아끼는 존댓말")
         * persona: 이 말투가 기우는 성격 축 (예: { talk: -2 } 말을 아낀다). 그 사람의 축과 반대쪽이면 고르지 않는다
         * dialect: 사투리 말투. 표준어를 쓰는 사람에게는 고르지 않는다
         */
        voices: z
          .array(
            z.strictObject({
              style: z.string().min(1),
              samples: z.array(z.string().min(1)).min(1),
              persona: z.partialRecord(idEnum((s.persona?.axes ?? []).map((a) => a.id)), z.number().int().min(-2).max(2)).optional(),
              dialect: z.boolean().optional(),
            }),
          )
          .min(1),
        rules: z.array(z.string().min(1)).default([]),
        reputations: z.array(z.string().min(1)).min(1),
        secrets: z.array(z.strictObject({ content: z.string().min(1), reveal_when: z.string().min(1), min_trust: z.number().int().min(1).max(10) })).default([]),
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
    /**
     * 개 기르기 (12-172): 동물에게 가르치는 재주. move 판정, min_days 함께 지낸 날.
     * 효과는 bonus(동행 보정에 더한다, 동물마다 +2까지)와 carry(주인공의 짐 무게 한도 +)
     */
    tricks: z
      .array(
        z.strictObject({
          id: contentIdSchema,
          label: z.string().min(1),
          move: idEnum(moveIds(s)),
          min_days: z.number().int().min(0).default(0),
          bonus: z.partialRecord(idEnum(moveIds(s)), z.number().int().min(1).max(2)).optional(),
          carry: z.number().min(0).optional(),
        }),
      )
      .optional(),
    /** 장면에 나타나면 주인공의 공포가 오르는 단계 (12-95). 한꺼번에 셋 이상 나타나면 한 단계 더 */
    fearsome: z.number().int().min(0).max(3).optional(),
    /** 쫓아오지 못한다 (기어다니는 것 등): 판정 걸고 물러나다 빗나가도 따라오지 않는다 (PT22·PT23: 허리 아래가 뭉개진 감염체가 망루까지 쫓아왔다) */
    slow: z.boolean().optional(),
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
