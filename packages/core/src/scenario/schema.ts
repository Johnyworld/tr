/** 다짐의 판정 종류 (12-164, engine/resolve.ts의 RESOLVE_CHECKS와 같다) */
export const RESOLVE_CHECK_IDS = [
  "meet", "gone", "released", "cured", "alive_days", "promise_kept", "rank", "debt_clear", "reach", "beliefs",
  "fame", "relation", "trait_gone", "season_passed", "buried", "truce", "faction_fallen", "zone_owned", "standing", "ruins_found", "trusted",
] as const;
/** 판정 종류마다 대상의 종류 (콘텐츠 검사용) */
export const RESOLVE_TARGET: Record<(typeof RESOLVE_CHECK_IDS)[number], "person" | "zone" | "faction" | "rank" | "trait" | "season" | "none"> = {
  meet: "person",
  gone: "person",
  released: "person",
  cured: "person",
  alive_days: "person",
  promise_kept: "person",
  relation: "person",
  buried: "person",
  rank: "rank",
  debt_clear: "faction",
  truce: "faction",
  faction_fallen: "faction",
  reach: "zone",
  zone_owned: "zone",
  trait_gone: "trait",
  season_passed: "season",
  beliefs: "none",
  fame: "none",
  standing: "none",
  ruins_found: "none",
  trusted: "none",
};

import { z } from "zod";
import { TIME_SEGMENTS } from "../rules/time.ts";
import { iconNameSchema } from "../content/icons.ts";

/**
 * 시나리오 팩 설정 (기획서 12.3). 장르 요소의 이름과 목록을 데이터로 둔다.
 * core는 여기서 읽은 ID로만 다루고, 리터럴 타입으로 하드코딩하지 않는다.
 */

const id = z.string().regex(/^[a-z][a-z0-9_]*$/, "id는 소문자·숫자·_ 만 쓴다");
const labeled = z.strictObject({ id, label: z.string().min(1), description: z.string().optional() });
/** 전투 효과 한 결과의 크기 */
const battleOutcome = z.strictObject({
  momentum: z.number().int().min(-5).max(5).default(0),
  alarm: z.number().int().min(-3).max(3).default(0),
  /** 위치를 앞으로(적 후방 쪽으로) 몇 칸 */
  advance: z.number().int().min(0).max(3).default(0),
  enemy_losses: z.number().int().min(0).max(10).default(0),
  destroy_objective: z.boolean().default(false),
});

export const scenarioFileSchema = z
  .strictObject({
    id,
    name: z.string().min(1),
    resources: z.array(labeled).min(1),
    stats: z.array(labeled).min(1),
    /**
     * 스킬 (기본 행동, 기획서 4.2.1). 판정은 능력 하나 + 이 스킬. stats: 쓸 수 있는 능력.
     * kind: common(누구나 하는 일, 찍지 않으면 스킬 최저값으로 시도한다) / expert(전문 기술, 배우기 전엔 판정할 수 없다)
     */
    moves: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          stats: z.array(id).min(1),
          description: z.string().optional(),
          kind: z.enum(["common", "expert"]).default("common"),
          category: z.string().optional(),
        }),
      )
      .min(1),
    /** 능력·스킬의 범위와 능력 + 스킬 상한 (기획서 4.2) */
    ranges: z
      .strictObject({
        ability: z.strictObject({ min: z.number().int(), max: z.number().int() }),
        skill: z.strictObject({ min: z.number().int(), max: z.number().int() }),
        cap: z.number().int(),
      })
      .default({ ability: { min: -1, max: 3 }, skill: { min: -1, max: 2 }, cap: 4 }),
    /** 새 캐릭터의 능력 배열. 역할에 start_stats가 없으면 이 값을 무작위로 섞어 준다 (능력은 계급과 무관) */
    ability_array: z.array(z.number().int()).optional(),
    /** 이름이 바뀐 능력 id (이전 세이브를 읽을 때 옮긴다): 옛 id → 새 id */
    renamed: z.strictObject({ abilities: z.record(id, id).default({}) }).default({ abilities: {} }),
    /** 경험치와 레벨업 (기획서 4.2). 없으면 성장하지 않는다 */
    growth: z
      .strictObject({
        /** 첫 레벨업에 필요한 경험치, 그 뒤로 늘어나는 양 */
        first: z.number().int().positive(),
        step: z.number().int().min(0),
        /** 레벨마다 필요한 경험치에 곱하는 배수 (12-109). 1이면 step만 더한다 */
        ratio: z.number().min(1).default(1),
        /** 최대 레벨 (12-109). 없으면 끝이 없다 */
        max_level: z.number().int().min(2).optional(),
        /**
         * 버팀 (12-109): 몸·마음이 한 단계 나빠질 때 그 단계를 피할 확률이 레벨업마다 오르는 양.
         * 구간마다 `from` 레벨부터 `per`씩 (다음 구간 전까지). 레벨 1은 0
         */
        resilience: z.array(z.strictObject({ from: z.number().int().min(2), per: z.number().min(0).max(1) })).default([]),
        xp: z.strictObject({ success: z.number().int().min(0), partial: z.number().int().min(0), miss: z.number().int().min(0), merit: z.number().int().min(0) }),
        /** 판정으로 하루에 얻을 수 있는 경험치 상한 */
        daily_check_cap: z.number().int().positive(),
        /** 스킬 한 단계를 올리는 데 드는 점수 (4.2.1): 스킬 최저값에서부터 단계마다. 없거나 모자라면 1 */
        raise_costs: z.array(z.number().int().min(1)).default([]),
        /**
         * 가르침 (4.2.1): 그 스킬이 min_skill 이상인 사람(신뢰 min_trust 이상) 곁에서 hours시간을 채우면 전문 기술을 배운다.
         * 다른 무리면 물건으로 값 fee (신뢰 free_trust 이상이면 공짜). 없으면 가르침이 없다
         */
        teaching: z
          .strictObject({ hours: z.number().int().positive(), min_skill: z.number().int(), min_trust: z.number().int(), fee: z.number().int().min(0), free_trust: z.number().int() })
          .optional(),
      })
      .optional(),
    /** 시스템이 특정 역할로 쓰는 행동 */
    move_roles: z.strictObject({
      notice: id,
      stealth: id,
      /** 거짓 소문을 퍼뜨릴 때의 판정 (12-151). 없으면 소문 조작을 쓸 수 없다 */
      deceive: id.optional(),
    }),
    /** 수색을 돕는 지식 (옛 지도·건물 용도를 안다): 이 스킬을 1 이상 익혔으면 수색 판정에 bonus (상한 밖의 상황 보정, 12-220) */
    search_lore: z.strictObject({ skill: id, bonus: z.number().int().min(0).max(2) }).optional(),
    /**
     * 캐릭터 생성 (12-6): 능력은 포인트 구매. 모두 0에서 시작해 points를 나눠 쓴다.
     * cost: 능력 값 → 드는 포인트 (음수면 돌려받는다), max_low: 기본값보다 낮출 수 있는 능력 수. genders: 고를 수 있는 성별
     */
    creation: z
      .strictObject({
        points: z.number().int().min(0),
        cost: z.record(z.string().regex(/^-?\d+$/), z.number().int()),
        max_low: z.number().int().min(0),
        genders: z.array(labeled).min(1),
        /** 나이를 고를 수 있는 범위 (12-69). 없으면 나이는 시나리오(역할)가 정한다 */
        age: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }).optional(),
        /** 트레잇 고르기 (기획서 4.6): 종류별 최대 개수. 긍정 비용 합 ≤ 부정 보상 합 */
        traits: z
          /** 성격은 연기 힌트라 max_personality가 없으면 개수 제한이 없다 (반대끼리만 막는다) */
          .strictObject({
            max_positive: z.number().int().min(0),
            max_negative: z.number().int().min(0),
            max_personality: z.number().int().min(0).optional(),
            /** 공포증(effects.phobia) 트레잇을 몇 개까지 (12-108). 없으면 제한 없음 */
            max_phobia: z.number().int().min(0).optional(),
          })
          .default({ max_positive: 3, max_negative: 3 }),
        /**
         * 과거 배경 (12-84): 붕괴 전에 무엇을 했는지. 능력 배치(stats: ability_array와 같은 값들)와 스킬(skills)의 기본값,
         * 지니고 시작하는 물건(items). 플레이어는 같은 포인트 안에서 능력과 스킬을 고칠 수 있다. 무리원·떠돌이 모두 고른다
         */
        pasts: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              summary: z.string().min(1),
              stats: z.record(id, z.number().int()),
              /** 시작 스킬 배치 (4.2.1): 스킬 → 단계 (-1이면 전문 기술을 배운 상태로만). creation.skills.points를 다 쓴 배치 */
              skills: z.record(id, z.number().int().min(-1).max(2)).default({}),
              items: z.array(id).default([]),
              /** 이 일을 했을 수 있는 최소 나이 (12-87) */
              min_age: z.number().int().min(0).optional(),
            }),
          )
          .default([]),
        /** 계급이 요구하는 전문 기술 (4.2.1): 그 계급으로 시작하면 점수 없이 배운 상태(스킬 최저값)로 준다 (계급 id → 스킬 id들) */
        rank_experts: z.record(id, z.array(id)).default({}),
        /** 계급의 최소 나이 (12-87, 계급 id → 나이) */
        rank_min_age: z.record(id, z.number().int().min(0)).default({}),
        /** 시작 스킬 (4.2.1): 포인트(points)를 growth.raise_costs의 값으로 나눈다. 과거 배경이 기본 배치를 준다. 남긴 점수는 레벨업 점수와 함께 쓴다 */
        skills: z.strictObject({ points: z.number().int().min(0) }).optional(),
        /** 대화로 만들 때(MCP) 단계별로 GM에게 주는 서술 힌트 */
        narration: z
          .strictObject({
            name: z.string().optional(),
            gender: z.string().optional(),
            age: z.string().optional(),
            past: z.string().optional(),
            abilities: z.string().optional(),
            skills: z.string().optional(),
            traits: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * 트레잇 (기획서 4.6): 타고난 기질·버릇·체질. 플레이어와 NPC가 같이 쓴다.
     * kind: positive(cost만큼 쓴다) / negative(cost만큼 얻는다) / personality(0). core는 효과 종류만 안다
     */
    traits: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          kind: z.enum(["positive", "negative", "personality"]),
          cost: z.number().int().min(0).default(0),
          description: z.string().min(1),
          /** GM에게 주는 연기 지침 한 줄 */
          acting: z.string().optional(),
          /** 처음 보는 사람에게도 보이는지 (외모, 드러나는 성격). 아니면 플레이어에게는 자기 것만 보인다 */
          visible: z.boolean().default(false),
          /** 함께 가질 수 없는 트레잇 */
          opposites: z.array(id).default([]),
          /** 캐릭터 생성에서 고를 수 있는지 */
          selectable: z.boolean().default(true),
          /** 성격 축 값 (12-99): 이 트레잇을 가진 NPC의 축 (예: 다혈질 → temper +2). 여러 트레잇이면 더하고 -2~2로 자른다 */
          persona: z.record(id, z.number().int().min(-2).max(2)).optional(),
          effects: z
            .strictObject({
              /** 스킬 보정 (능력 + 스킬 상한 안에서) */
              skills: z.record(id, z.number().int()).optional(),
              /** 경험치 배수 */
              xp: z.number().positive().optional(),
              /** 하루 허기가 나빠질 때 더하는 단계 (정량이 아닐 때. 음수면 덜 나빠진다) */
              hunger: z.number().int().optional(),
              /** 추운 날의 추위 노출 ± */
              cold: z.number().int().optional(),
              /** 질병·감염에 걸릴 확률 배수 */
              disease: z.number().min(0).optional(),
              /** 앓는 병이 하루마다 나을 확률 ± (튼튼하면 빨리 털고 일어난다) */
              disease_recover: z.number().min(-1).max(1).optional(),
              infection: z.number().min(0).optional(),
              /** 저절로 낫는 데 걸리는 날 ± */
              recovery_days: z.number().int().optional(),
              /** 공포가 오를 때 더하는 단계 (12-95. 겁이 많으면 +1, 담대하면 -1) */
              fear: z.number().int().optional(),
              /** 공포증 (12-103): 계기에 이 태그가 있으면 공포가 한 단계 더 오른다 (그 계기가 보통 사람에게 무섭지 않아도). dark는 어둠 시간대 전부 */
              phobia: z.array(id).optional(),
              /** 내가 한 일이 숨은 목격자에게 들킬 확률 배수 */
              noticed: z.number().min(0).optional(),
              /** 내가 남의 일을 목격할 확률 배수 */
              alertness: z.number().min(0).optional(),
              /** 내가 소문을 옮길 확률 배수 */
              rumor: z.number().min(0).optional(),
              /** 외모 등급 (첫인상, 끌림·질투) */
              looks: z.number().int().optional(),
              /** 이성에게 끌린다. moves: 이성이 나를 상대로 하면 쉬워지는 스킬 */
              attraction: z.strictObject({ moves: z.array(id).min(1) }).optional(),
              /**
               * 버릇 (12-129, 골초): 하루가 지날 때 items 중 하나를 저절로 하나 쓴다. 가진 게 없으면 track이 한 단계 오른다 (쓰면 바로 풀린다).
               * 낮에 풀려면 consumables에 그 아이템 → track을 적어 둔다. start: 새 캐릭터가 이만큼 가지고 시작한다
               */
              habit: z
                .strictObject({
                  items: z.array(id).min(1),
                  track: id,
                  start: z.number().int().min(0).default(0),
                  /** 끊기 (12-157): track이 마지막 단계에 이만큼(날) 머물면 버릇이 떨어진다 (트레잇을 뺀다). 없으면 끊을 수 없다 */
                  quit_days: z.number().int().positive().optional(),
                })
                .optional(),
            })
            .default({}),
        }),
      )
      .default([]),
    /** 상대를 쓰러뜨리기 (기획서 7.5): 부상이 이 단계 이상이면 무력화 (더 맞서지 못하고 소지품을 뒤질 수 있다) */
    combat: z.strictObject({ incapacitated_at: id }).optional(),
    /**
     * 출신과 말씨 (12-142): 동적으로 생기는 사람(엑스트라)의 출신을 weight로 뽑고, dialect가 있으면 chance로 그 말씨를 쓴다 (아니면 표준어).
     * GM이 인물 카드의 말씨 줄대로 연기한다 (예문만큼만)
     */
    origins: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          weight: z.number().positive(),
          dialect: z.strictObject({ label: z.string().min(1), chance: z.number().min(0).max(1), style: z.string().min(1), samples: z.array(z.string().min(1)).min(1) }).optional(),
        }),
      )
      .default([]),
    /** 이름 재료 (기획서 7.5): 성과 성별별 이름. 엑스트라가 이름을 얻을 때, 이름 없이 만든 캐릭터에 쓴다 */
    names: z
      .strictObject({
        surnames: z.array(z.string().min(1)).min(1),
        /** 성별 id → 이름 목록. 성별이 없으면 모두 섞는다 */
        given: z.record(id, z.array(z.string().min(1)).min(1)),
      })
      .optional(),
    /** 매력의 수동 효과 (기획서 4.2): 처음 만난 NPC의 호감 + (능력 ÷ first_impression_per, 내림), 능력이 bonus_at 이상이면 호감이 오를 때 +1 */
    charm: z.strictObject({ ability: id, first_impression_per: z.number().int().positive(), bonus_at: z.number().int() }).optional(),
    /**
     * 성격 축 (기획서 4.6.1, 12-99). 축마다 -2(low 쪽) ~ +2(high 쪽). 주인공은 만들 때 정하고, NPC는 성격 트레잇의 persona를 더한다.
     * 말투·태도는 GM이 acting대로 연기하고, 결과가 남는 순간(발끈, 말 새어 나감, 궁합, 연애 문턱)은 코드가 정한다
     */
    persona: z
      .strictObject({
        axes: z
          .array(
            z.strictObject({
              id,
              /** -쪽 이름과 +쪽 이름 (예: 온화함 / 다혈질) */
              low: z.string().min(1),
              high: z.string().min(1),
              /** 단계 1, 2의 연기 지침 (GM용) */
              low_acting: z.tuple([z.string().min(1), z.string().min(1)]),
              high_acting: z.tuple([z.string().min(1), z.string().min(1)]),
              /** 연애 축 (수위가 꺼지면 쓰이지 않는다) */
              romance: z.boolean().optional(),
            }),
          )
          .min(1),
        /** 발끈 (+쪽 단계별 확률): take_action.provoked면 굴리고, 터지면 target의 관계가 바뀐다 */
        blowup: z.strictObject({ axis: id, chance: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]), delta: z.strictObject({ trust: z.number().int(), affection: z.number().int(), respect: z.number().int() }) }).optional(),
        /** 말 새어 나감 (+쪽 단계별 확률): 장면의 인물과 이야기하면 굴리고, 터지면 주인공이 아는 사실 하나를 그 인물이 알게 된다 */
        leak: z.strictObject({ axis: id, chance: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]) }).optional(),
        /** 얻어듣기 (+쪽 단계별 확률, 12-107): 말이 오가면 상대도 털어놓는다. 장면의 인물과 이야기하면 굴리고, 터지면 그 인물이 아는 사실 하나를 주인공이 알게 된다 */
        hear: z.strictObject({ axis: id, chance: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]) }).optional(),
        /** 성격의 득 (12-107): 축이 +쪽(1 이상)이면 이 행동들의 판정에 bonus (상한 밖, 판정 줄에 성격 이름으로). 손해 규칙(blowup·leak)이 있는 쪽에 득도 준다 */
        edges: z.array(z.strictObject({ axis: id, moves: z.array(id).min(1), bonus: z.number().int() })).default([]),
        /** 궁합: 처음 만날 때 이 축들이 같은 쪽이면 same, 반대쪽이면 opposite만큼 호감 (합은 -2~2) */
        rapport: z.strictObject({ axes: z.array(id), same: z.number().int(), opposite: z.number().int() }).optional(),
        /**
         * 빈 축 채우기: NPC의 성격 트레잇이 정하지 않은 축은 인물 id에서 이 무게로 값을 뽑는다 (판마다 같다).
         * 축 id → { "-2": 무게, "-1": …, "0": …, "1": …, "2": … }. 없는 축은 0으로 둔다
         */
        fill: z.record(id, z.record(z.enum(["-2", "-1", "0", "1", "2"]), z.number().min(0))).optional(),
        /** 연애 문턱: NPC의 이 축 값 × per_level만큼 마음이 생기는 호감과 고백을 받아들이는 호감이 오른다 (+쪽 = 마음이 늦다) */
        romance: z.strictObject({ axis: id, per_level: z.number().int() }).optional(),
      })
      .optional(),
    /**
     * 증상 (12-74): 플레이어에게 보이는 몸 상태. 상태 트랙의 단계가 증상을 가리킨다 (원인은 숨긴다: 감염과 질병의 열은 같은 "고열").
     * group: 같은 묶음은 크기 차이라 가장 큰 것(목록에서 뒤에 있는 것) 하나만 보인다. 이름(id)이 같아도 하나만.
     * penalty: 판정 보정. 보이는 증상의 보정을 더한다
     */
    symptoms: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          group: id.optional(),
          penalty: z.number().int().max(0).default(0),
          /** 이 증상이면 스스로 아무것도 하지 못한다 (의식불명): 판정·이동·대화·이야기 없이 시간만 흐르고, 남이 돌볼 수만 있다 */
          incapacitates: z.boolean().optional(),
          /** 화면 색 (1 노랑 · 2 주황 · 3 빨강). 없으면 판정 보정 크기로. 보정은 작아도 위험한 증상(의식장애 등)은 3 */
          tone: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
          /** 이 증상이 있는 동안 이 묶음(group)의 증상은 판정 보정을 주지 않는다 (12-157: 진통제는 고통을, 술은 공포를 가린다). 증상은 그대로 보인다 */
          masks: z.array(id).optional(),
          /** 이 증상이 무엇이고 어떻게 나아지는지 한 줄 (12-193). ?상태에 증상 아래로 보인다 */
          hint: z.string().min(1).max(80).optional(),
        }),
      )
      .optional(),
    condition_tracks: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          /** 상태 화면 아이콘 (12-64) */
          icon: iconNameSchema.optional(),
          /** 처음 단계면 상태 문장에서 뺀다 (12-138: 골초만 쓰는 담배처럼 대부분에게 상관없는 트랙) */
          quiet: z.boolean().optional(),
          levels: z
            .array(
              z.strictObject({
                id,
                /** 단계 이름. 없으면 증상 이름을 이어 붙인다 (증상이 없으면 "이상 없음") */
                label: z.string().min(1).optional(),
                /** 판정 보정. 없으면 증상 보정의 합 */
                penalty: z.number().int().optional(),
                /** 이 단계의 증상 (symptoms의 id) */
                symptoms: z.array(id).optional(),
                fatal: z.boolean().optional(),
                /** 캐릭터가 아직 모르는 단계 (예: 감염 잠복기). 화면·GM에는 바로 앞 단계로 보인다 */
                hidden: z.boolean().optional(),
              }),
            )
            .min(2),
        }),
      )
      .min(1),
    harm_track: id,
    rank_ladder: z.array(z.strictObject({ id, label: z.string().min(1), level: z.number().int() })).min(1),
    promotion: z.strictObject({ from: id, to: id }),
    /**
     * 직분 (기획서 12.6): 무리 안에서 맡은 일. 시나리오(역할)와 인물이 정한다 (새 게임에서 따로 고르지 않는다, 12-80).
     * 직분마다 시작 훈련·소지품·일감·이야기(storylet_tag)가 붙는다. 직분 안의 사다리는 없고, 계급(분대원·분대장·간부)이 곧 사다리다 (12-82, 12-83)
     */
    occupations: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          summary: z.string().min(1),
          /** 직분 스킬 (4.2.1): 스킬을 주지는 않는다. 전문 기술이면 배운 상태(스킬 최저값)로 주고, 고쳐 쓸 때 그 전문 기술에 점수를 둘 수 있다 */
          skills: z.array(id).default([]),
          /** 시작 소지품에 더해지는 직분 도구 */
          kit: z.array(id).default([]),
          /** 직분의 일감 (임무 템플릿 id). 무리를 가리지 않는다 */
          missions: z.array(id).default([]),
          /** 직분 이야기의 태그 (없으면 occ_<id>) */
          storylet_tag: id.optional(),
        }),
      )
      .default([]),
    speech_rules: z.string().min(1),
    gm_tone: z.string().min(1),
    gm_rules: z.string().min(1),
    mcp_guide: z.string().min(1),
    /** 새 게임을 시작할 때 들려주는 세계 이야기 (시작 캐릭터가 아는 것만). 지금 상황은 시나리오(역할)의 intro */
    intro: z.string().min(1).optional(),
    /**
     * 자유 시나리오 (기획서 12.5): 플레이어가 쓴 시작을 이 범위 안의 부품으로 옮긴다. 없으면 자유 시나리오를 열지 않는다
     */
    custom_start: z
      .strictObject({
        /** 세력에 속해 시작할 때 고를 수 있는 계급 (한 자리뿐인 지도부는 뺀다) */
        ranks: z.array(id).min(1),
        /** 무소속으로 시작할 때의 계급. 없으면 무소속 시작을 막는다 */
        free_rank: id.optional(),
        /** 무소속으로 시작할 수 있는 장소 (세력에 속하면 그 세력의 구역 중에서) */
        free_locations: z.array(id).default([]),
        /** 시작 훈련 포인트와 스킬 하나의 최대 */
        skill_points: z.number().int().min(0),
        skill_max: z.number().int().min(0),
        age: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
        /** 무소속으로 시작할 때 고를 수 있는 연고 (엑스트라 틀 id, 기획서 7.9) */
        kin: z.array(id).default([]),
        /** 배경 부품의 빚 크기 (기획서 12.6) */
        debt_sizes: z.strictObject({ small: z.number().int().min(1), large: z.number().int().min(1) }).default({ small: 5, large: 15 }),
        /** 시작 소지품 꾸러미 */
        kits: z.array(z.strictObject({ id, label: z.string().min(1), description: z.string().default(""), items: z.array(id) })).min(1),
        /** 떠돌이로 시작할 때의 소지품 꾸러미 (12-77) */
        free_kit: id.optional(),
        /** 떠돌이가 "반려견과 함께"를 고르면 붙는 연고 틀 (kin 중에서) */
        pet: id.optional(),
        /**
         * 떠돌이의 소규모 무리 (12-77 3단계): 동행을 "소규모 무리"로 고르면 start명을 무작위로 만들고 max명까지 고친다.
         * 관계는 주인공 기준 (kind: spouse 배우자, parent 부모, child 자식, sibling 형제자매, other 그 밖). 부모·자식은 parent_gap살 이상 차이, 배우자는 다른 성별.
         * labels: 그 사람의 성별 → 부르는 말. templates: 나이·관계에 맞는 엑스트라 틀
         */
        group: z
          .strictObject({
            start: z.number().int().min(0),
            max: z.number().int().min(1),
            parent_gap: z.number().int().min(0).default(18),
            /** 부모·자식의 나이 차 상한 (12-239, 플레이 테스트 13: 25살 주인공의 아버지가 79살) */
            parent_max_gap: z.number().int().min(1).optional(),
            /** 무리에 사는 가족의 계급 (12-239: 버들마을에 사는 부모가 "버들마을 떠돌이"로 보였다) */
            settled_rank: id.optional(),
            relations: z
              .array(
                z.strictObject({
                  id,
                  label: z.string().min(1),
                  kind: z.enum(["spouse", "parent", "child", "sibling", "other"]),
                  max: z.number().int().min(1).optional(),
                  age: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
                  labels: z.record(z.string(), z.string().min(1)).default({}),
                  /** 주인공이 이 나이 이상이어야 이 관계가 있다 (12-195: 25세 주인공에게 자식이 있었다) */
                  min_me_age: z.number().int().min(0).optional(),
                  /** 찾는 가족(makeFamily)에서 이 관계가 있을 확률. 나이가 되어도 결혼하지 않았을 수 있다. 없으면 늘 후보 */
                  chance: z.number().min(0).max(1).optional(),
                }),
              )
              .min(1),
            sibling_labels: z
              .strictObject({ older: z.record(z.string(), z.record(z.string(), z.string().min(1))), younger: z.record(z.string(), z.string().min(1)) })
              .optional(),
            templates: z.strictObject({ young: id, elder: id, adult: id, partner: id, other: id }),
            young_below: z.number().int().default(16),
            elder_from: z.number().int().default(55),
          })
          .optional(),
      })
      .optional(),
    /**
     * 무리의 규율 단계 (기획서 9.9): 무리마다 culture.discipline으로 고른다. 임무를 버리거나 놓쳤을 때의 공적,
     * 불복종으로 치는지, 진급에 허용되는 불복종 수, 불복종 행적의 무게. 없으면 모든 무리가 질서(기본값)
     */
    discipline: z
      .record(
        id,
        z.strictObject({
          label: z.string().min(1),
          abandon_merit: z.number().int().max(0),
          expire_merit: z.number().int().max(0),
          /** 임무를 버리거나 놓치면 불복종으로 센다 */
          counts_disobedience: z.boolean(),
          max_disobedience: z.number().int().min(0),
          /** 불복종 행적의 무게 (0이면 행적을 남기지 않는다) */
          deed_severity: z.number().int().min(0).max(3),
          /** 임무를 부르는 말 (예: 명령, 당번, 일감) */
          order_word: z.string().min(1),
        }),
      )
      .default({}),
    /** 역할 권한(access)의 이름 (예: ration → 배급). ration·mission_board는 core가 쓰고, 나머지는 GM이 보는 특권 */
    access_labels: z.record(id, z.string().min(1)).default({}),
    /**
     * 지휘 (기획서 9.11): 분대 명령의 일과 지도부 회의의 방침. 규칙(따르는지, 결과 판정, 전쟁 틱 반영)은 core에 있고 이름과 숫자만 둔다.
     * 없으면 분대 명령과 회의가 없다
     */
    command: z
      .strictObject({
        /** 분대원에게 맡기는 일 */
        squad_tasks: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              /** follow: 동행이 된다. rest: 쉬며 회복한다. work: 나가서 일하고 결과를 굴린다 */
              kind: z.enum(["follow", "rest", "work"]),
              /** 걸리는 시간 (follow는 쓰지 않는다) */
              hours: z.number().positive().default(4),
              /** 결과 판정의 스킬과 능력 (work) */
              move: id.optional(),
              stat: id.optional(),
              /** 다른 구역으로 나가는 일인지 (zone이 필요하다) */
              needs_zone: z.boolean().default(false),
              /** 실패하면 다칠 수 있는 일 */
              dangerous: z.boolean().default(false),
              /** 성공했을 때 (대가 있는 성공은 절반, 내림) */
              rewards: z
                .strictObject({
                  /** 주인공 무리의 자원 */
                  resources: z.record(id, z.number().int().min(1)).default({}),
                  /** 주인공에게 가져다주는 물건 (구역 수색 표에서 고른다면 loot: true) */
                  loot: z.boolean().default(false),
                  merit: z.number().int().min(0).max(3).default(0),
                  /** 데려와 무리에 들이는 사람 수 (12-140: 외부인 찾기). 대가 있는 성공은 절반(내림) */
                  population: z.number().int().min(0).max(5).default(0),
                })
                .default({ resources: {}, loot: false, merit: 0, population: 0 }),
              /** 보고 문구. {member} {zone} */
              report: z.strictObject({ success: z.string().min(1), partial: z.string().min(1), miss: z.string().min(1) }),
            }),
          )
          .default([]),
        /** 주인공의 이 스킬이 1 이상이면 분대원의 일 판정에 +1 (지휘) */
        lead_skill: id.optional(),
        /** 회의에서 안을 올릴 때 쓰는 스킬 */
        council_moves: z.array(id).default([]),
        /** 분대원이 곁에 있을 때(follow) 주인공 판정 보정 (스킬 id → 보정) */
        follow_bonus: z.record(id, z.number().int().min(1).max(2)).default({}),
        /** 지도부 회의에 앉는 계급 */
        council_ranks: z.array(id).default([]),
        /** 무리 방침: 주제마다 선택지. 처음은 default */
        policies: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              default: id,
              options: z
                .array(
                  z.strictObject({
                    id,
                    label: z.string().min(1),
                    /** GM에게 보여 주는 한 줄 (이 방침이면 무엇이 달라지나) */
                    summary: z.string().min(1),
                    /** 전쟁 틱: 자원별 소모 배수 */
                    upkeep: z.record(id, z.number().min(0).max(3)).default({}),
                    /** 공격 성향 배수 */
                    aggression: z.number().min(0).max(3).default(1),
                    /** 지키는 병력 배수 */
                    defense: z.number().min(0).max(3).default(1),
                    /** 분배 (12-128): 교전의 화력 배수, 교전마다 쓰는 탄약 배수 */
                    firepower: z.number().min(0).max(3).default(1),
                    ammo_use: z.number().min(0).max(3).default(1),
                    /** 분배 (12-128): 무리 의무실이 하루에 돌보는 사람 수 배수 (한 사람에 의약품 하나) */
                    care: z.number().min(0).max(3).default(1),
                    /** 분배 (12-128): 이 무리 거점의 불 땐 거처 최저 체감에 더하는 도 (아끼면 음수) */
                    heated: z.number().int().min(-15).max(10).default(0),
                    /** 무리 사람이 받는 배급 단계를 이만큼 옮긴다 (+1이면 한 단계 적게, war.ration.levels) */
                    ration_shift: z.number().int().min(-2).max(2).default(0),
                    /** 하루마다 사기 변화 */
                    morale: z.strictObject({ delta: z.number().int().min(-1).max(1), chance: z.number().min(0).max(1) }).optional(),
                    /**
                     * 교역: 하루마다 상대 무리와 자원을 바꾼다. 서로의 태도가 min_disposition 이상이고 양쪽 창고에 있을 때만.
                     * 상대가 자기 자신이면 fallback_partner와 바꾸고, 그것도 없으면 하지 않는다
                     */
                    trade: z
                      .strictObject({
                        partner: id,
                        fallback_partner: id.optional(),
                        give: z.record(id, z.number().int().min(1)),
                        get: z.record(id, z.number().int().min(1)),
                        min_disposition: z.number().int().min(-3).max(3).default(0),
                      })
                      .optional(),
                    /** 이 안에 반대하는 사람 (NPC id). 대가 있는 성공이면 그들의 신뢰가 떨어진다 */
                    opposed_by: z.array(id).default([]),
                  }),
                )
                .min(2),
            }),
          )
          .default([]),
      })
      .optional(),
    /** 물건 규칙 (기획서 4.8): 맨손, 무게, 흥정. 없으면 무기·무게 규칙을 쓰지 않는다 */
    gear: z
      .strictObject({
        /** 무기 없이 공격할 수 있는 스킬과 피해 상한 */
        unarmed: z.strictObject({ moves: z.array(id).min(1), max_harm: z.enum(["light", "heavy"]), /** 맨손 상처 종류 (스킬 → wounds.kinds, 12-91) */ wound: z.record(id, id).optional() }),
        /** 전투 중에 공격으로 보는 스킬 (무기·탄약을 따진다) */
        attack_moves: z.array(id).min(1),
        /**
         * 거리 (12-93): 장면의 인물을 칠 때 GM이 고르는 상대와의 거리. 가까운 것부터. 없으면 거리를 따지지 않는다
         */
        distances: z.array(z.strictObject({ id, label: z.string().min(1) })).optional(),
        /** 무기에 range가 없을 때 스킬별로 닿는 거리와 그 거리의 판정 보정 (스킬 → 거리 → 보정). 없는 거리에서는 칠 수 없다 */
        default_range: z.record(id, z.record(id, z.number().int().min(-3).max(3))).default({}),
        carry: z.strictObject({
          base: z.number().min(1),
          per_strength: z.number().min(0),
          /** 무게를 넘으면 이 스킬들에 보정 */
          encumbered_moves: z.array(id).default([]),
          penalty: z.number().int().min(-2).max(0).default(-1),
          /** 들 수 있는 무게의 이 배를 넘으면 옮겨 가지 못한다 */
          hard_limit: z.number().min(1).default(1.5),
        }),
        /** 손질: 이 스킬이 0·1·2일 때 물건이 닳는 것을 피할 확률 (기획서 4.8) */
        maintenance: z.strictObject({ move: id, save_chance: z.array(z.number().min(0).max(1)).length(3) }).optional(),
        /** 흥정: 값의 이 비율 이상이면 판정으로 깎을 수 있다 (아래면 거절) */
        haggle_floor: z.number().min(0).max(1).default(0.7),
        /** 흥정에 쓰는 스킬 */
        haggle_moves: z.array(id).default([]),
      })
      .optional(),
    /** 제작 법 (기획서 4.8) */
    crafting: z
      .strictObject({
        recipes: z.array(
          z.strictObject({
            id,
            label: z.string().min(1),
            move: id,
            materials: z.record(id, z.number().int().min(1)),
            /** 있어야 하는 도구. 목록이면 그중 하나 (예: [[kitchen_knife, combat_knife]]) */
            tools: z.array(z.union([id, z.array(id).min(1)])).default([]),
            yields: z.strictObject({ item: id, qty: z.number().int().min(1) }),
          }),
        ),
      })
      .optional(),
    /** 세계를 만들 때 코드가 이름 있는 인물들을 이만큼 무작위로 잇는다 (기획서 7.10. 판마다 다른 관계) */
    dynamic_ties: z
      .strictObject({
        count: z.number().int().min(0).max(30),
        kinds: z.array(z.enum(["parent", "child", "sibling", "spouse", "friend", "rival"])).min(1),
      })
      .optional(),
    /** 새 게임의 월드 고르기에 보이는 것 (기획서 12.3). 없으면 name만 */
    world: z
      .strictObject({
        /** 월드 이름 (예: 무너진 도시 가람) */
        title: z.string().min(1),
        /** 한 줄 소개 */
        tagline: z.string().min(1),
        /** 고를 때 보여 주는 두세 문장 */
        description: z.string().min(1),
        /** 1일차의 달력 날짜 (YYYY-MM-DD). 있으면 상태 화면 머리에 날짜로 보여 준다 */
        calendar_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .optional(),
    /**
     * 세력 단위 전쟁 시뮬레이션의 수치 (기획서 9장). 규칙(틱 순서, 교전 판정)은 core에 있고 숫자와 문구만 둔다.
     * 없으면 세력 시뮬레이션을 돌리지 않는다.
     */
    war: z
      .strictObject({
        /** 1인당 하루 소모량 (자원 id → 양) */
        upkeep: z.record(id, z.number().min(0)),
        /** 모자라면 사기가 떨어지고 사람이 죽는 자원 */
        vital: z.array(id).min(1),
        /** 모자라면 사기만 떨어지는 자원 (예: 겨울의 연료) */
        hardship: z.array(id).default([]),
        ammo: id,
        medicine: id,
        ammo_per_clash: z.number().int().min(0),
        medicine_per_casualty: z.number().int().min(0),
        /** 공격 성향 1당 하루에 공격에 나설 확률 */
        attack_chance_per_aggression: z.number().min(0).max(1),
        /** 배급 수준: 무리의 이 자원이 며칠 치 남았는지로 정한다. min_days 내림차순 */
        ration: z.strictObject({
          resource: id,
          levels: z
            .array(
              z.strictObject({
                min_days: z.number().min(0),
                label: z.string().min(1),
                /** 이 배급을 받는 하루 동안 허기 트랙이 움직이는 단계 (음수면 나아진다) */
                hunger: z.number().int().optional(),
                /** 이 배급으로는 이 단계보다 더 배고파지지 않는다 */
                hunger_max: id.optional(),
              }),
            )
            .min(1),
        }),
        /** 사기 -3 ~ +3을 부르는 말 (7개) */
        morale_labels: z.array(z.string().min(1)).length(7),
        /**
         * 세계가 움직인 느낌 (12-242). traces: 교전이 있던 구역에 trace_days일 동안 남는 흔적 (교전 종류 → GM이 볼 한 줄).
         * named: 사상자 한 명마다 chance로 이름 있는 대원 하나에게 내려온다. 그중 death로 죽고 나머지는 다친다 (중상·경상 반반).
         * invested_from: 그 인물이 주인공에게 품은 신뢰나 호감이 이 값 이상이면 공들인 관계 (첫 죽음을 크게 다침으로 바꾼다)
         */
        felt: z
          .strictObject({
            traces: z.record(z.string(), z.string().min(1)).default({}),
            trace_days: z.number().int().min(1).default(2),
            named: z.strictObject({ chance: z.number().min(0).max(1), death: z.number().min(0).max(1) }).optional(),
            invested_from: z.number().int().default(4),
            /** 남의 일이 소문으로 닿을 확률 (공통 규칙 14) */
            rumor_chance: z.number().min(0).max(1).default(0.4),
          })
          .optional(),
        /**
         * 무리 형편을 대하는 말투 (12-105): 장면의 같은 무리 사람이 어려움(분위기·배급·창고·전황)을 어떻게 입에 올리는지.
         * 인물의 트레잇이 가장 많이 겹치는 태도를 고르고, 없으면 default. hint: GM의 연기 힌트
         */
        talk: z
          .strictObject({
            attitudes: z.array(z.strictObject({ id, label: z.string().min(1), hint: z.string().min(1), traits: z.array(id).min(1) })).min(1),
            default: z.strictObject({ label: z.string().min(1), hint: z.string().min(1) }),
            /** 다른 무리의 형편이 소문으로 들리는 곳(말이 모이는 곳)과 하루 확률 (무리마다). 들은 말은 그 무리의 지금 형편 그대로다 (부풀림·헛소문은 12-185에 뺐다) */
            rumor: z
              .strictObject({
                zones: z.array(id).min(1),
                chance: z.number().min(0).max(1),
              })
              .optional(),
          })
          .optional(),
        /** 남은 양 판단 (며칠 치) → 말. min_days 내림차순 */
        stock_labels: z.array(z.strictObject({ min_days: z.number().min(0), label: z.string().min(1) })).min(1),
        /**
         * 전황 소식 틀. {attacker} {defender} {zone} {attacker_loss} {defender_loss}, 조사는 {attacker:이/가}처럼.
         * 성공/실패별 (occupy는 빈 구역 차지)
         */
        news: z.strictObject({
          raid_success: z.string().min(1),
          raid_failure: z.string().min(1),
          skirmish_success: z.string().min(1),
          skirmish_failure: z.string().min(1),
          assault_success: z.string().min(1),
          assault_failure: z.string().min(1),
          occupy: z.string().min(1),
        }),
      })
      .optional(),
    /**
     * 전투 장면 (기획서 9.5). 틀(전세·경보·위치·목표물·준비물)은 core에 있고, 효과의 종류·조건·크기와 이름은 여기 둔다.
     * 없으면 교전을 장면으로 열지 않는다.
     */
    battle: z
      .strictObject({
        round_minutes: z.number().int().positive(),
        max_rounds: z.number().int().positive(),
        /** 이 전세에 이르면 끝난다 (±) */
        momentum_to_win: z.number().int().min(2).max(10),
        max_alarm: z.number().int().min(1).max(5),
        /** 위치: 앞에서부터 전선 → … → 적 후방 */
        positions: z.array(labeled).min(2),
        /** 적 쪽 목표물 (파괴할 수 있는 것) */
        objectives: z.array(labeled).min(1),
        /** 전투 전에 구역에 설치하는 준비물 (함정 등) */
        preparations: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              description: z.string().min(1),
              requires_item: id.optional(),
              /** 여러 재료가 들면 (12-176). requires_item과 함께 쓸 수 있다. 판정 결과와 관계없이 쓴다 */
              materials: z.record(id, z.number().int().min(1)).optional(),
            }),
          )
          .default([]),
        effects: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              description: z.string().min(1),
              /** 쓸 수 있는 위치 */
              positions: z.array(id).min(1),
              /** 경보가 이보다 높으면 쓸 수 없다 */
              max_alarm: z.number().int().min(0).optional(),
              requires_item: id.optional(),
              consumes_item: z.boolean().default(false),
              requires_preparation: id.optional(),
              /** 써도 준비물이 남는다 (엄폐·사격 자리, 12-176). 아니면 한 번 쓰면 없어진다 (덫) */
              keeps_preparation: z.boolean().optional(),
              /** 목표물을 하나 골라야 하는지 */
              targets_objective: z.boolean().default(false),
              /** GM이 선언해야 하는 최소 몸의 위험 (none이면 대가가 경보·전세로만 온다) */
              min_harm: z.enum(["none", "light", "heavy"]).default("light"),
              /** 물러나기: 성공하면 전투에서 빠진다 */
              withdraw: z.boolean().default(false),
              /** 경보 0일 때 성공·대가 있는 성공의 전세에 더한다 (기습) */
              surprise_bonus: z.number().int().min(0).default(0),
              outcomes: z.strictObject({
                success: battleOutcome,
                partial: battleOutcome,
                miss: battleOutcome,
              }),
            }),
          )
          .min(1),
      })
      .optional(),
    /**
     * 부상 회복 (플레이 테스트 1회차 문제 4). 치료사와 저절로 낫기. 아이템 치료는 consumables
     * 없으면 회복하지 않는다
     */
    recovery: z
      .strictObject({
        /** 새 부상 없이 이만큼(일) 지나면 한 단계 낫는다 */
        natural_days: z.number().positive(),
        /** 이 단계까지만 저절로 낫는다 (더 나쁘면 치료가 필요하다) */
        natural_max_level: id,
        /**
         * 푹 잔 밤에 낫기 (플레이 테스트 11, A1). 있으면 주인공은 natural_days 대신 이것으로 낫는다:
         * min_hours 이상 자고 나면, 피가 멎어 있고 자는 사이 새로 다치지 않았으면 max_level까지 한 단계. slow: 이 단계는 마지막 변화에서 며칠이 지나야 낫는다
         */
        sleep_heal: z.strictObject({ min_hours: z.number().positive(), max_level: id, slow: z.record(id, z.number().positive()).default({}) }).optional(),
        /** 스스로 아무것도 못 하는 증상(의식불명)의 단계에 이만큼(시간) 머물면 한 단계 나아져 정신이 든다. 없으면 치료로만 */
        wake_hours: z.number().positive().optional(),
        /** 치료사(장면에 있는 healer NPC)에게 받으면 트랙별로 낫는 단계 수. 하루에 한 번 */
        healer: z.record(id, z.number().int().min(0)),
        /**
         * 치료사의 재료와 값 (플레이 테스트 11: 치료가 공짜이고 무한했다). resource: 치료할 때마다 이 자원 1을 쓴다. 치료사 무리의 거점에서는 창고에서, 거점 밖에서는 치료사 본인과 곁의 같은 무리 사람이 지닌 물건에서 (없으면 치료하지 못한다).
         * fee: 다른 무리·무소속에게 받는 값(물건의 흥정 값 합). free_trust: 치료사의 신뢰가 이 이상이면 받지 않는다
         */
        healer_cost: z.strictObject({ resource: id, fee: z.number().int().min(0), free_trust: z.number().int() }).optional(),
        /**
         * 무리의 돌봄 (12-52): 무리에 이 직분(occupation)의 인물이 있으면, 하루마다 무리 자원(resource)을 써서 다친 사람을 돌본다.
         * 한 사람이 per_medic명까지. 부상 한 단계에 자원 1. 감염은 떼지 못한다 (혈청뿐, body.infection.cure)
         */
        faction_care: z
          .strictObject({ occupations: z.array(id).min(1), resource: id, per_medic: z.number().int().min(1) })
          .optional(),
        /** 주인공이 아이템 없이 다른 사람을 돌볼 수 있는 조건 (이 직분이거나 이 스킬이 min 이상), 하루에 한 사람 한 번, 부상 한 단계 */
        first_aid: z.strictObject({ occupations: z.array(id).default([]), skill: id, min: z.number().int() }).optional(),
        /**
         * 수술 (12-159): 부상이 from 이상인 사람을 돌보는 것은 판정이다. 치료사(NPC)면 코드가 2d6 + 능력·스킬(move) + 장소로 굴리고,
         * 주인공이 남을 돌보면 move 판정(check)이 있어야 한다. 성공 = 한 단계 낫는다, 대가 있는 성공 = 낫되 흔적(scars)을 굴린다, 실패 = 한 단계 나빠진다.
         * 장소: clinics(진료소) clinic_bonus, 거점이 아닌 곳 field_penalty (치료사의 굴림에만)
         */
        surgery: z
          .strictObject({
            from: id,
            move: id,
            stat: id,
            clinics: z.array(id).default([]),
            /** 이 스킬(move)이 이 이상이어야 수술할 수 있다 (배우지 않았으면 못 한다, 플레이 테스트 11). 치료사도 주인공도 같다 */
            min_skill: z.number().int().default(0),
            clinic_bonus: z.number().int().default(1),
            field_penalty: z.number().int().default(-1),
          })
          .optional(),
      })
      .optional(),
    /**
     * 수위 (12-57): 성인 주제(연애·성적 위협)를 다루는 이야기의 태그와 나이 하한.
     * 세계의 options.mature가 꺼져 있으면 그 태그 이야기는 열리지 않고, 켜져 있어도 주인공과 배역이 모두 adult_age 이상이어야 열린다
     */
    content_rating: z.strictObject({ tag: id, adult_age: z.number().int().min(18) }).optional(),
    /**
     * 연애 (12-58). 수위가 켜져 있고 둘 다 성인일 때만 동작한다.
     * 끌림은 인물마다 (content의 attracted_to, 없으면 orientation 비율로 인물 id에서 정해진다). 주인공은 누구에게나 마음을 둘 수 있다
     */
    romance: z
      .strictObject({
        /** 끌림 비율: 다른 성별, 둘 다, 같은 성별, 아무에게도 */
        orientation: z.strictObject({ other: z.number().min(0), both: z.number().min(0), same: z.number().min(0), none: z.number().min(0) }),
        /** 호감이 이 이상이고 끌리면 마음이 있다 (낌새가 보인다) */
        interest_affection: z.number().int(),
        /** 나이 차가 이보다 크면 마음이 생기지 않는다 (12-195: 71세 신부가 32세 주인공에게 눈길을 줬다). 없으면 보지 않는다 */
        age_gap: z.number().int().min(0).optional(),
        /** 고백을 받아들이는 문턱 */
        accept: z.strictObject({ affection: z.number().int(), trust: z.number().int() }),
        /** 다가가기에 쓰는 판정 */
        flirt_moves: z.array(id).min(1),
        /** 다른 연인이 생겼을 때 하루에 알아챌 확률 (함께 장면에 있으면 반드시) */
        /** 연인이 죽으면 마음 트랙이 오르는 단계 */
        grief_nerves: z.number().int().min(0),
      })
      .optional(),
    /**
     * 포로 (12-55). 없으면 주인공이 붙잡히지 않고 포로를 다루는 규칙도 없다
     */
    captivity: z
      .strictObject({
        /** 주인공이 갇혀 있는 동안 열리는 이야기의 태그 (이때는 이것만 열린다) */
        tag: id,
        /**
         * 진 전투에서 물러나지 않았을 때 빠져나가는 판정 (12-220). 주인공에게 가장 나은 것으로 굴린다.
         * 성공이면 빠져나가고, 대가 있는 성공이면 빼앗길 물건(confiscate)을 버리고 빠져나가고, 실패하면 붙잡힌다. 정신을 잃었으면 굴리지 않고 붙잡힌다
         */
        flee_moves: z.array(id).min(1),
        /** 갇혔을 때 빼앗기는 물건 종류 (돌려받으면 돌아온다) */
        confiscate: z.array(z.string()).default(["weapon", "ammo"]),
        /** 종류와 상관없이 빼앗는 물건 (빗장을 딸 수 있는 철사 등, 플레이 테스트 13) */
        confiscate_items: z.array(z.string()).default([]),
        /** 탈출: 갇힌 구역에서 옮겨 가려면 이 판정 중 하나를 무거운 위험으로 */
        escape_moves: z.array(id).min(1),
        /** 탈출의 빈틈을 기다리는 시간 (시간, [최소, 최대]). 실패할 때마다 감시가 심해져 다음 탈출 판정 -1 (플레이 테스트 12: 탈옥에 시간도 대가도 없었다) */
        escape_hours: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
        /** 갇힌 동안 허기가 이 단계보다 더 나빠지지 않는다 (붙잡은 쪽이 겨우 먹인다) */
        hunger_floor: id.optional(),
        /** 포로 하나를 하루 먹이는 데 드는 붙잡은 무리의 자원 */
        upkeep: z.strictObject({ resource: id, amount: z.number().min(0) }),
        /** 노역에 부리면 하루에 붙잡은 무리가 얻는 자원 */
        labor: z.strictObject({ resource: id, amount: z.number().int().min(0) }),
        /** 몸값: 풀어 주는 대신 상대 무리가 내는 자원 */
        ransom: z.strictObject({ resource: id, amount: z.number().int().min(1) }),
        /** 심문·회유에 쓰는 판정 */
        interrogate_moves: z.array(id).min(1),
        recruit_move: id,
        /** 무리 사이 싸움에서 이긴 쪽이 이름 있는 사람 하나를 붙잡아 갈 확률 */
        war_capture_chance: z.number().min(0).max(1).default(0),
        /** 무리 사이 싸움에서 붙잡혀 갈 수 있는 계급 (비우면 아무나, 12-243: 코드에 박혀 있던 것을 옮겼다) */
        war_capture_ranks: z.array(id).default([]),
      })
      .optional(),
    /**
     * 상처 종류와 출혈 (12-91). 없으면 상처 종류를 받지 않고 피를 흘리지 않는다.
     * GM이 몸의 위험을 걸 때 상처 종류(take_action.check.harm_kind)를 고르고, 피가 나는 종류로 다치면 부상 단계에 맞춰 출혈 트랙이 오른다.
     * 출혈은 판정 보정이 없고, 시간이 흐르면 부상을 키운다. 지혈해야 멎는다 (붕대 등 consumables, 치료사 recovery.healer, 맨손 지혈 판정)
     */
    wounds: z
      .strictObject({
        /** attack: 누가 낸 상처(총상·할큄·물림)라 맞서는 상대가 없어도 방어구가 막는다. 아니면 상대가 있을 때만 막는다 (플레이 테스트 11) */
        kinds: z.array(z.strictObject({ id, label: z.string().min(1), bleeds: z.boolean(), attack: z.boolean().default(false) })).min(1),
        /** 출혈 트랙 */
        track: id,
        /** 피가 나는 종류로 다쳐 부상이 이 단계가 되면 출혈이 이 단계까지 오른다 (부상 단계 id → 출혈 단계 id) */
        from_harm: z.record(id, id),
        /** 이 출혈 단계에 이만큼(시간) 머물 때마다 부상이 한 단계 나빠진다 */
        worsen_hours: z.record(id, z.number().positive()),
        /** 이 출혈 단계는 이만큼(시간) 지나면 저절로 멎는다 */
        clot_hours: z.record(id, z.number().positive()).default({}),
        /** 출혈이 이 단계 이상이면 정신이 들지 않고 저절로 낫지 않는다 */
        blocks_recovery_from: id,
        /** 아이템 없이 지혈하는 판정 (take_action.treatment {item: null} + check). 성공이면 멎고, 대가 있는 성공이면 한 단계 준다 */
        staunch_move: id,
        /** 감염체에게 다칠 위험(infected_source)인데 상처 종류를 비웠을 때 쓰는 종류 */
        infected_default: id.optional(),
      })
      .optional(),
    /**
     * 큰 재난 (12-169): 한 해에 per_year번쯤 (앞 재난에서 min_gap_days 지나서), warn_days 전에 전조. 대비하면 피해가 준다.
     * 재난마다: 계절, 덮칠 곳(target: base 무리 거점, water 물이 나는 곳, infested 감염체가 가장 많은 곳, faction 사람이 가장 많은 무리, all 도시 전체),
     * 잃는 자원 비율(resources), 인원 비율(population), 사기, 담, 시설 부서짐, 산출 멈춤(recover_days 동안), 감염체 압력, 날씨, 돌림병 확률, 거점을 잃을 수 있는지(collapse)
     */
    disasters: z
      .strictObject({
        per_year: z.number().min(0),
        min_gap_days: z.number().int().min(1),
        warn_days: z.number().int().min(1),
        collapse_chance: z.number().min(0).max(1),
        kinds: z.array(
          z.strictObject({
            id,
            label: z.string().min(1),
            seasons: z.array(id).default([]),
            target: z.enum(["base", "water", "infested", "faction", "all"]),
            omen: z.string().min(1),
            aftermath: z.string().min(1),
            /** 소식 문장. {zone} 덮친 곳, {faction} 그 무리 (조사 문법 {zone:이/가} 등을 쓴다) */
            news: z.string().min(1),
            recover_days: z.number().int().min(1),
            resources: z.record(id, z.number().min(0).max(1)).default({}),
            population: z.number().min(0).max(1).default(0),
            morale: z.number().int().min(0).max(3).default(0),
            fort: z.number().int().min(0).max(3).default(0),
            break_facilities: z.boolean().default(false),
            stall_yields: z.boolean().default(false),
            infestation: z.number().int().min(0).max(3).default(0),
            weather: id.optional(),
            disease: z.number().min(0).max(1).default(0),
            collapse: z.boolean().default(false),
          }),
        ),
      })
      .optional(),
    /**
     * 무전 송출 (12-173): item을 가진 주인공이 하루 한 번 송출하면 chance로 tag 이야기 하나가 열린다
     */
    radio_call: z.strictObject({ item: id, tag: id, chance: z.number().min(0).max(1) }).optional(),
    /**
     * 즉흥 이야기 (12-247, 기획서 10.5.5): 반복 템플릿(이미 seen_times번 이상 열린 것, 0이면 처음이어도)이 골리면 그 자리를 GM이 지은 이야기로 바꾼다 (앞 자리와 gap_hours 떨어진다: 하루 하나쯤).
     * GM은 보상 등급·종류만 고르고 숫자는 여기서 정한다 (원칙 2)
     */
    improv: z
      .strictObject({
        seen_times: z.number().int().min(0),
        gap_hours: z.number().min(0),
        /** 보상 물건의 갈래 (id → 이름). GM은 이야기에 맞는 갈래를 고르고, 물건은 그 갈래의 등급 목록에서 코드가 고른다 */
        item_kinds: z.record(id, z.string().min(1)),
        rewards: z.strictObject({
          small: z.strictObject({ items: z.record(id, z.array(z.strictObject({ item: id, quantity: z.number().int().positive().default(1) })).min(1)), relation: z.number().int().min(1).max(3), merit: z.number().int().min(0).max(3) }),
          medium: z.strictObject({ items: z.record(id, z.array(z.strictObject({ item: id, quantity: z.number().int().positive().default(1) })).min(1)), relation: z.number().int().min(1).max(3), merit: z.number().int().min(0).max(3) }),
        }),
        costs: z.strictObject({
          relation: z.number().int().min(-3).max(-1),
          noise: z.number().int().min(1).max(3),
          time: z.number().int().min(30).max(480),
          /** 몸 상태 한 칸 (부상 트랙은 안 된다, 원칙 3) */
          body: z.strictObject({ track: id, delta: z.number().int().min(1).max(2) }),
        }),
      })
      .optional(),
    /** 들킨 침입 (플레이 테스트 11, D6): 적대하는 무리의 땅에서 moves 판정이 실패하면 tag 이야기(경보·추격) 하나가 열린다 */
    alarm: z
      .strictObject({
        tag: id,
        moves: z.array(id).min(1),
      })
      .optional(),
    /**
     * 매복 (12-177). 내 매복: move 판정(어려움으로 굴린다)이 성공하면 hours 동안, 이 구역에 나타난 상대에게 하는 첫 attack_moves 판정에 bonus,
     * 그 판정이 성공이면 상대가 혼란 (다음 판정 하나 동안 맞서지 못한다, 12-220). 대가 있는 성공은 partial_bonus만.
     * 적의 매복: 이야기의 ambush: true로 열리면 다음 판정 하나에 ambushed, 실패하면 주인공이 혼란 (다음 판정 confused).
     * forewarn_trick을 곁의 동물이 알면 적의 매복을 미리 안다
     */
    ambush: z
      .strictObject({
        move: id,
        hours: z.number().min(1).max(24),
        attack_moves: z.array(id).min(1),
        bonus: z.number().int().min(1).max(3),
        partial_bonus: z.number().int().min(0).max(3),
        ambushed: z.number().int().min(-3).max(0),
        confused: z.number().int().min(-3).max(0),
        forewarn_trick: id.optional(),
      })
      .optional(),
    /**
     * 거점 손보기 (12-167): 떠돌이의 거처(home)와 무리의 거점(base)에 짓는 시설. move 판정, hours 시간, materials 재료.
     * 효과는 기존 장치로만: fort 담 단단함 +, camp 야영 이야기 확률 배수, watched 잠들어도 지켜보는 밤, water 물이 나는 곳,
     * garden 텃밭(거처: days마다 item×qty를 창고에, 거점: 날마다 무리 resource + resource_delta, seasons에만), preserve 날것이 안 상한다, fire 실내의 불
     */
    facilities: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          description: z.string().min(1),
          /** home 떠돌이의 거처, base 우리 무리의 거점, own 거점 밖 우리 무리의 땅 (12-184) */
          where: z.array(z.enum(["home", "base", "own"])).min(1),
          move: id,
          hours: z.number().min(1).max(24),
          materials: z.record(id, z.number().int().min(1)),
          effects: z
            .strictObject({
              fort: z.number().int().min(1).max(2).optional(),
              /** 막기 (12-176, 12-184에 시설로): 이 구역을 지키는 전투 장면에서 배경 교전에 밀리는 것을 이만큼 막고, 그 전투로 부서진다 */
              holds: z.number().int().min(1).max(5).optional(),
              /** 이 구역의 감염체 압력이 오를 때 실제로 오를 확률 (12-176). 없으면 1 */
              infested_rise: z.number().min(0).max(1).optional(),
              camp: z.number().min(0).max(1).optional(),
              watched: z.boolean().optional(),
              water: z.boolean().optional(),
              garden: z
                .strictObject({ item: id, qty: z.number().int().min(1), days: z.number().int().min(1), seasons: z.array(id).default([]), resource: id.optional(), resource_delta: z.number().int().default(0) })
                .optional(),
              preserve: z.boolean().optional(),
              fire: z.boolean().optional(),
            })
            .default({}),
        }),
      )
      .optional(),
    /**
     * 유품과 이어지는 끈 (12-158): 죽은 주인공과 가까운 사람 (관계가 있거나 호감이 close_affection 이상).
     * 가까운 사람이 뒤를 이으면 사물함·거처의 짐을 물려받고, 가까운 사람은 이야기에서 그를 기억하는 배역(mourner)이 된다
     */
    legacy: z.strictObject({ close_affection: z.number().int(), funeral_days: z.number().int().min(1).default(3) }).optional(),
    /**
     * 다짐 (12-164): 갈래(kind)마다 판정 종류(check, core가 아는 것), 내려놓을 수 있는지(let_go), 직분이 있는 사람만(occupation_only).
     * 이루면 xp와 relief_track 한 단계 회복, 꺾이면 relief_track 한 단계 악화. from_history: 배경의 원수·찾는 가족·빚을 어느 갈래로 읽는지
     */
    resolve: z
      .strictObject({
        xp: z.number().int().min(0),
        relief_track: id,
        from_history: z.strictObject({ enemy: id.optional(), family: id.optional(), debt: id.optional() }).default({}),
        /** 이미 있던 사람으로 이어 갈 때의 다짐 (플레이 테스트 12: 계승한 주인공에게 다짐이 없었다). close: 가까운 사람(피붙이·친구·연인)을 days일 지키는 갈래. 빚은 from_history.debt */
        heir: z.strictObject({ close: id.optional(), days: z.number().int().min(1).default(7) }).optional(),
        kinds: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              check: z.enum(RESOLVE_CHECK_IDS),
              let_go: z.boolean().default(false),
              occupation_only: z.boolean().default(false),
              /** 단계가 이 이상 오른 뒤에야 이룬 것으로 친다 (12-193: 돌아가기가 이동 한 번에 끝나지 않게). 그 전에 닿으면 지나간다 */
              min_stage: z.number().int().min(0).default(0),
            }),
          )
          .min(1),
      })
      .optional(),
    /**
     * 몸에 남는 상처 (12-156): 부상이 at 단계 이상이 되는 상처를 입으면 chance로 오래 가는 약점 트레잇 하나가 붙는다 (흉터·절뚝임 등).
     * 그 상처 종류(wounds)에 맞는 것 중에서, 아직 없는 것만. 한 사람에 max개까지. 플레이어와 NPC가 같다 (원칙 6)
     */
    scars: z
      .strictObject({
        at: id,
        chance: z.number().min(0).max(1),
        max: z.number().int().min(1).default(3),
        /** 붙을 수 있는 트레잇. wounds가 비면 어느 상처로든 */
        /** parts: 이 흉터가 남는 몸의 부위를 가리키는 말. 상처 원인 글에 어느 흉터의 부위 말이 나오면 그 부위가 맞는 흉터(또는 부위 없는 흉터)만 고른다 (플레이 테스트 11: 팔을 다쳤는데 "가슴을 다친 뒤로") */
        traits: z.array(z.strictObject({ trait: id, wounds: z.array(id).default([]), parts: z.array(z.string().min(1)).default([]) })).min(1),
      })
      .optional(),
    /**
     * 의식불명 중 곁의 사람 (12-90): 스스로 아무것도 못 하게 된 동안 곁에 누가 있느냐로 코드가 한 번 정한다.
     * 우리 편은 돌보거나 자기 거점으로 옮기고, 적은 끌고 가거나(captivity) 죽이고, 아무도 없으면 감염체를 만날 수 있다. 없으면 이 규칙을 쓰지 않는다
     */
    helpless: z
      .strictObject({
        /** 이 사람이 주인공을 보는 믿음+호감이 이 이상이면 돌봐 준다 */
        ally_regard: z.number().int(),
        /** 이 이하면 적으로 군다 (무리와 상관없이) */
        hostile_regard: z.number().int(),
        /** 무리의 태도가 이 이하면 그 무리 사람은 적이다 */
        hostile_disposition: z.number().int(),
        /** 무리 없는 사람(떠돌이)을 만나면 적으로 대하는 무리 */
        prey_on_strangers: z.array(id).default([]),
        /** 장면에 아무도 없을 때 그 구역 주인 무리의 사람이 찾아낼 확률 */
        found_chance: z.number().min(0).max(1),
        /** 아무도 찾지 않았을 때 감염체를 만날 확률 (구역 danger 0~3) */
        infected_chance: z.array(z.number().min(0).max(1)).length(4),
        /** 적이 죽일 확률: 기본 + 가치관 mercy 한 점마다 + 원수(hostile_regard 이하인 사람이 있을 때) */
        kill: z.strictObject({ base: z.number().min(0).max(1), per_mercy: z.number(), feud: z.number().min(0).max(1) }),
      })
      .optional(),
    /**
     * 길 위의 일 (12-53): 구역을 옮길 때마다 길의 위험(두 구역의 danger 중 높은 쪽)별 확률로 태그(tag)가 붙은 이야기 하나가 열린다.
     * 이야기 사이 간격(storylet_pacing)과 상관없다. 진행 중인 이야기가 있으면 열리지 않는다
     */
    travel: z.strictObject({ tag: id, chance: z.array(z.number().min(0).max(1)).length(4) }).optional(),
    /**
     * 시세 (12-155, 기획서 4.8.2). 그 땅 주인 무리의 창고가 처음보다 얼마나 남았는지(비율)로 물건 값이 오르내린다.
     * 비율이 scarce 이하면 high배, 1이면 그대로, plenty 이상이면 low배 (사이는 곧게 잇는다). seasons: 계절 → 자원 → 배수.
     * kinds: 아이템 종류 → 자원 (아이템의 resource가 먼저). 주인 없는 땅은 시세가 없다
     */
    market: z
      .strictObject({
        kinds: z.record(z.string(), id).default({}),
        scarce: z.number().min(0).max(1).default(0.25),
        plenty: z.number().min(1).default(2),
        high: z.number().min(1).default(1.5),
        low: z.number().min(0.1).max(1).default(0.7),
        seasons: z.record(z.string(), z.record(z.string(), z.number().positive())).default({}),
        /** GM 상태에 비싸다/싸다로 알리는 문턱 */
        note_above: z.number().default(1.2),
        note_below: z.number().default(0.85),
      })
      .optional(),
    /**
     * 잠입 장면 (12-154, 기획서 9.5.1). 다른 무리의 땅에 몰래 들어가 목표를 하고 나온다. 깊이(depths)와 경보(0~3)는 코드가 센다.
     * move: 전진·빠지기 판정, listen: 낌새 살피기 판정. 한 걸음에 step_minutes. 경보 숫자는 보이지 않는다 (낌새로만).
     * goals: 깊은 곳에서 하는 일. items(주인공이 얻는다)·resource(그 땅 주인 무리의 자원 증감)·morale·release(그 구역에 갇힌 사람을 푼다)·overhear(준비하는 일을 엿듣는다).
     * 대가 있는 성공은 items·resource 절반, morale 없음
     */
    /**
     * 탐험할 곳 (12-162): 구역의 숨은 곳. 그 구역을 뒤지다 수색이 성공하면 찾는다 (대가 있는 성공은 낌새만, 12-220).
     * 깊이 칸을 move 판정으로 내려가고, 칸마다 한 번 search_move로 뒤진다 (loot는 칸마다의 찾을 거리 표).
     * 소음이 3에 닿으면 wake[깊이]의 감염체가 깊이+1만큼 깨어난다. hazard: 실패해 다칠 때의 원인
     */
    exploration: z
      .strictObject({
        move: id,
        search_move: id,
        step_minutes: z.number().int().min(5).max(60).default(15),
        wake: z.array(id).min(1),
        ruins: z
          .array(
            z.strictObject({
              id,
              zone: id,
              label: z.string().min(1),
              hint: z.string().min(1),
              mood: z.string().min(1),
              hazard: z.string().min(1).max(60),
              depths: z.array(z.string().min(1)).min(2).max(5),
              loot: z.array(z.array(z.strictObject({ item: id, weight: z.number().positive(), qty: z.tuple([z.number().int().min(1), z.number().int().min(1)]) })).min(1)).min(1),
            }),
          )
          .default([]),
      })
      .optional(),
    infiltration: z
      .strictObject({
        move: id,
        listen: id,
        depths: z.array(z.string().min(1)).min(2).max(5),
        step_minutes: z.number().int().min(5).max(60).default(10),
        goals: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              move: id,
              items: z.record(z.string(), z.number().int().min(1)).default({}),
              resource: z.record(z.string(), z.number().int()).default({}),
              morale: z.number().int().min(-1).max(1).optional(),
              release: z.boolean().default(false),
              overhear: z.boolean().default(false),
            }),
          )
          .min(1),
      })
      .optional(),
    /**
     * 뇌물과 협박 (12-153). bribe: 값은 prices[계급](없으면 default) × (1 − greed_step × 욕심 가치관), 주인공을 믿으면(신뢰 +2) ×trusted.
     * 정직 가치관(scruple)이 refuse_at 이상이고 욕심이 0 이하인 사람은 값과 상관없이 거절한다. 모자라면(절반 이상) move로 판정.
     * blackmail: 협박 판정의 행동
     */
    /**
     * 약속 (12-160): 지키면·접으면·어기면 그 사람의 관계 변화, 한 번에 열어 둘 수 있는 약속 수.
     * asks (12-174, 12-181): 인물의 부탁. 하루에 chance로 하나를 품는다. 품은 부탁은 max_open까지, expire_days 안에 꺼내지 못하면 접는다
     */
    promises: z
      .strictObject({
        max_open: z.number().int().min(1).default(5),
        asks: z.strictObject({ chance: z.number().min(0).max(1), max_open: z.number().int().min(1).default(2), expire_days: z.number().int().min(1).default(4) }).optional(),
        kept: z.strictObject({ trust: z.number().int().default(0), affection: z.number().int().default(0), respect: z.number().int().default(0) }),
        folded: z.strictObject({ trust: z.number().int().default(0), affection: z.number().int().default(0), respect: z.number().int().default(0) }),
        broken: z.strictObject({ trust: z.number().int().default(0), affection: z.number().int().default(0), respect: z.number().int().default(0) }),
      })
      .optional(),
    leverage: z
      .strictObject({
        bribe: z.strictObject({
          move: id,
          greed: id,
          scruple: id,
          prices: z.record(z.string(), z.number().positive()),
          greed_step: z.number().min(0).max(0.4).default(0.25),
          trusted: z.number().positive().default(0.8),
          refuse_at: z.number().int().default(2),
        }),
        blackmail: z.strictObject({ move: id }),
      })
      .optional(),
    /**
     * 야영 (12-148): 지켜 주는 지붕이 없는 곳(우리 거점·재워 주는 거점·피난처가 아닌 곳)에서 자거나 쉬거나 기다리거나 보초를 서면,
     * 그 구역의 위험(위험과 감염체 압력 중 높은 쪽)별 시간당 확률로 태그(tag)가 붙은 이야기 하나가 열려 그 시간을 끊는다.
     * fire: 모닥불이 타는 동안 확률 배수 (불빛과 연기). own_land: 우리 무리 땅이면 확률 배수 (우리 순찰이 돈다).
     * 깨어 있거나(자지 않는 활동) 곁에 보초를 설 동행(깨어 있는 사람·동물)이 있으면 '지켜보는 밤'이다 (이야기 조건 camp_watched)
     */
    camp: z
      .strictObject({
        tag: id,
        chance: z.array(z.number().min(0).max(1)).length(4),
        fire: z.number().min(0).default(1.5),
        own_land: z.number().min(0).default(0.5),
        /**
         * 깊은 잠 (12-188): 상태 트랙 → 이 단계 이상이면 지쳐서·아파서 깊이 잠든다. 잠든 동안 지켜 주는 사람이 있어도 늦게 안다(camp_watched false),
         * 급한 이야기에 깨면 "몸이 무거워 늦게 깼다"를 GM에게 붙인다. 이야기는 그대로 열린다 (건너뛰지 않는다)
         */
        deep_sleep: z.record(id, id).default({}),
      })
      .optional(),
    /**
     * 명성 (12-127). 주인공이 남에게 보인 행적(목격자가 있는 것)의 크기 합이 points다. tiers는 낮은 것부터 (min 이상이면 그 단계).
     * cross_from: 이 단계부터 행적이 말이 모이는 곳을 거쳐 다른 무리로 넘어간다 (그 전에는 목격자의 무리 안에서만).
     * relay_from: 이 단계부터 소문으로만 들은 사람도 다시 옮긴다 (더 멀리 퍼진다).
     * fan_at·anti_at: 주인공을 직접 보지 않고 소문으로만 아는 사람의 호감 또는 존중이 이 이상이면 팬, 이 이하면 안티
     */
    fame: z
      .strictObject({
        tiers: z.array(z.strictObject({ min: z.number().int().min(0), label: z.string().min(1) })).min(2),
        cross_from: z.number().int().min(0),
        relay_from: z.number().int().min(0),
        fan_at: z.number().int(),
        anti_at: z.number().int(),
      })
      .optional(),
    /**
     * 외교 (12-126). 지도부 회의에 앉는 주인공이 다른 무리의 간부 이상(envoy_level)과 한 장면에 있을 때 협정을 제안한다 (negotiate).
     * pacts: 협정 종류. kind는 truce(days 동안 서로 치지 않는다) 또는 exchange(서로 잡은 포로를 돌려보낸다). cost는 대가 있는 성공에 우리 창고에서 내주는 것.
     * moves: 협상에 쓰는 스킬. retry_days: 거절당하면 그 무리에 다시 꺼내기까지. broken: 휴전을 깨면 두 무리의 태도
     */
    diplomacy: z
      .strictObject({
        envoy_level: z.number().int().min(0),
        moves: z.array(id).min(1),
        retry_days: z.number().int().min(0),
        broken: z.number().int().min(-3).max(3),
        pacts: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              kind: z.enum(["truce", "exchange"]),
              days: z.number().int().positive().optional(),
              summary: z.string().min(1),
              cost: z.record(id, z.number().int().min(1)).default({}),
            }),
          )
          .min(1),
      })
      .optional(),
    /**
     * 구역의 감염체 압력 (12-112): 0~3, 기준값은 구역의 danger. 날이 바뀔 때마다
     * 전날 그 구역의 소음이 noise_at 이상이면 +1, 그날 그 구역 교전의 사상자가 corpses_at 이상이면 +1 (최대 3).
     * 오르지 않은 날은 settle 확률로 기준값 쪽으로 한 단계 돌아간다. 이야기 효과 infested로 소탕한다.
     * 길 위의 일·감염체 틀의 등장·쓰러졌을 때 물릴 확률이 이 값을 쓴다.
     * yields_cut: 기준값보다 한 단계 높을 때마다 그 구역의 하루 산출이 이만큼 준다 (12-118: 감염체가 몰려든 밭과 우물은 덜 거둔다)
     */
    infestation: z
      .strictObject({
        noise_at: z.number().int().min(1),
        /** 소리가 noise_at에 닿은 뒤 감염체가 몰려드는 시간 (시간, [최소, 최대]에서 굴린다). 없으면 다음 날 자정에 (플레이 테스트 12) */
        swarm_hours: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
        corpses_at: z.number().int().min(1),
        settle: z.number().min(0).max(1),
        yields_cut: z.number().min(0).max(1).default(0),
        /** 자기 거점(kind: base)의 압력이 기준값보다 높으면 하루 이 확률로 그 무리의 사기 -1 (12-120) */
        morale_chance: z.number().min(0).max(1).default(0),
        /**
         * 감염체가 몰린 땅을 지키느라 전쟁에 돌리는 몫이 준다 (12-144): 자기 땅의 압력이 기준값보다 높은 단계의 합 하나당 이만큼.
         * war_share_floor: 기본 몫의 이 비율 아래로는 내려가지 않는다
         */
        war_share_cut: z.number().min(0).max(1).optional(),
        war_share_floor: z.number().min(0).max(1).optional(),
        /** 몰려든 구역에 들어서면 (플레이 테스트 11, D5): 기준값보다 높은 단계 하나당 per_level 확률로 tag 이야기 하나가 열린다 */
        arrival: z.strictObject({ tag: id, per_level: z.number().min(0).max(1) }).optional(),
        /**
         * 무리 형편(9.13)에 오르는 말 (12-120): 그 무리 땅의 압력이 기준값보다 1·2·3 높을 때. "{무리} 쪽 {말}는 말이 돈다"로 소문이 된다.
         * 없으면 형편에 오르지 않는다
         */
        trouble_labels: z.array(z.string().min(1)).length(3).optional(),
      })
      .optional(),
    /** 쓰면 몸 상태가 나아지는 아이템: 아이템 → 상태 트랙 → 나아지는 단계 수 (take_action.use_item) */
    /** 음수면 그만큼 나빠진다 (짠 음식은 목이 마르다). 나아지는 효과가 하나는 있어야 한다 */
    consumables: z.record(id, z.record(id, z.number().int().refine((n) => n !== 0, "0이 아닌 정수"))).default({}),
    /** 음식이 상하는 빠르기의 계절 배수 (12-131, 아이템 perishable에 곱한다). 없는 계절은 1 */
    spoilage: z.strictObject({ season: z.record(id, z.number().min(0)).default({}) }).optional(),
    /**
     * 먹을 것 구하기 (12-131, 12-220): take_action.forage. 판정 결과만큼 얻는다 (수색과 같다: 성공 2, 대가 1, 실패 0, 판정 없으면 0).
     * modifier: 그 일의 판정 보정 (낚시는 쉽고 사냥은 어렵다). 같은 날 같은 구역에서 같은 일을 다시 할 때마다 판정 -1.
     * water: 물이 나는 구역에서만 (아니면 거점이 아닌 구역). companions: 이 엑스트라 틀이 동행이면 하나 더
     * trap: 덫 (take_action.trap). item을 놓는 판정이 성공이면 다음 날, 대가 있는 성공이면 이틀 뒤에 catch가 걸린다. 확인하면 걸린 것과 덫을 거둔다
     */
    foraging: z
      .strictObject({
        move: id,
        kinds: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              water: z.boolean().default(false),
              modifier: z.number().int().min(-2).max(2).default(0),
              items: z.array(z.strictObject({ item: id, weight: z.number().positive(), qty: z.tuple([z.number().int().min(1), z.number().int().min(1)]) })).min(1),
              companions: z.array(id).default([]),
              /** 이 일의 판정 스킬 (없으면 foraging.move) */
              move: id.optional(),
            }),
          )
          .min(1),
        trap: z.strictObject({ /** 덫을 놓으려면 배워야 하는 스킬 (전문 기술, 4.2.1) */ move: id.optional(), item: id, catch: z.strictObject({ item: id, qty: z.tuple([z.number().int().min(1), z.number().int().min(1)]) }) }).optional(),
      })
      .optional(),
    /** 몸 상태 (12-1): 허기와 감염. 없으면 그 규칙을 쓰지 않는다 */
    body: z
      .strictObject({
        /**
         * 마음 다잡기 (12-220): 마음·공포가 오를 때 주인공이 굴리는 판정. 성공이면 오르지 않고, 대가 있는 성공이면 한 단계 덜 (적어도 한 단계), 실패면 그대로.
         * 공포 판정이 실패해 공황에 이르면 마음도 한 단계 오른다. stat은 마음이 하루마다·자고 나서 가라앉는 확률에도 더한다 (recover.per_point)
         */
        steady: z.strictObject({ move: id, stat: id }).optional(),
        /**
         * 기운 (12-157): 술·진통제·각성제처럼 쓰면 오르고 시간이 지나면 빠지는 트랙. 트랙 id → 한 단계 빠지는 데 걸리는 시간.
         * 이 트랙을 올리는 소모품(consumables에 음수)은 나아질 데가 없어도 쓸 수 있다
         */
        wear_off: z.record(id, z.number().positive()).optional(),
        /** 의존 (12-157): 이 아이템을 쓸 때마다 chance로 trait(버릇)이 붙는다. 쓴 사람에게 */
        dependence: z.record(id, z.strictObject({ trait: id, chance: z.number().min(0).max(1) })).optional(),
        /** 허기 트랙. 하루마다 배급 수준(war.ration.levels[].hunger)만큼 바뀐다. 마지막 단계에서는 하루마다 부상 */
        hunger: z.strictObject({ track: id, starving_harm: z.number().int().min(0).default(0) }).optional(),
        /**
         * 갈증 트랙 (12-97). 하루마다 daily만큼 마른다. 물이 넉넉한 곳에서 직접 마시면(take_action.drink) drink만큼 풀리고 빈 물병을 채운다.
         * 물이 넉넉한 곳: 산출에 resource가 있는 구역(강·우물·정수장), 또는 배급을 받는 우리 땅이면서 무리의 resource가 min_days 이상. 갇혀 있으면 captive_max까지만
         */
        /**
         * 피로 (12-114). 깨어 있는 동안 시간당 1(활동별로 rates가 덮어쓴다: 잠은 음수로 풀리고, 휴식은 0)씩 쌓인다.
         * 쌓인 것이 grace 이상이면 첫 단계, 그 뒤 per_step마다 한 단계. 피로로 죽지 않는다 (트랙에 fatal을 두지 않는다).
         * blocks_recovery_from: 이 단계 이상이면 부상이 저절로 낫지 않고 질병도 낫지 않는다 (자야 낫는다)
         */
        fatigue: z
          .strictObject({
            track: id,
            grace: z.number().min(0),
            per_step: z.number().positive(),
            rates: z.record(z.string(), z.number()).default({}),
            blocks_recovery_from: id.optional(),
            /** 이보다 짧은 잠은 피로를 풀지 못한다 (시간, 플레이 테스트 11 E4: 졸림이 한 시간 잠에 풀렸다) */
            min_sleep_hours: z.number().min(0).default(0),
            /** 피곤하지 않으면(첫 단계) 이만큼 자고 깬다 (시간, E4: 낮부터 15시간을 잤다) */
            rested_sleep_hours: z.number().positive().optional(),
          })
          .optional(),
        /**
         * 거점에 사는 사람들의 몸 (12-125). 무리의 배급·연료가 그 무리 사람들의 허기·추위가 된다. 이 단계까지만 (죽지 않는다)
         */
        residents: z.strictObject({ hunger_max: id.optional(), cold_max: id.optional() }).optional(),
        thirst: z
          .strictObject({
            track: id,
            resource: id,
            daily: z.number().int().min(0),
            drink: z.number().int().min(1),
            min_days: z.number().min(0).default(1),
            /** 마시면 채워지는 빈 그릇: 빈 아이템 → 채운 아이템 */
            refill: z.record(id, id).default({}),
            captive_max: id.optional(),
            /** 이 단계부터 몸이 괴롭다 (질병 확률 chance.thirst) */
            suffering_from: id.optional(),
            /**
             * 끓이지 않은 물 (12-131): 바깥의 물이 나는 곳에서 그냥 마시면 chance로 병(body.disease)에 걸린다.
             * 그곳에서 채우면 refill 대신 이 그릇이 된다 (빈 아이템 → 끓이지 않은 물). 그 구역에 불이 피어 있으면 끓여서 깨끗하다
             */
            dirty: z.strictObject({ chance: z.number().min(0).max(1), refill: z.record(id, id).default({}) }).optional(),
          })
          .optional(),
        /**
         * 감염 트랙. 감염체에게 다치면(take_action.check.infected_source) 상처 종류별 확률로 두 번째 단계(잠복)가 된다.
         * 하루마다 한 단계씩 나빠지고, 마지막 단계에서는 하루마다 부상 (12-106)
         */
        infection: z
          .strictObject({
            track: id,
            /** 감염체에게 입은 상처 종류(wounds.kinds) → 감염될 확률. 없는 종류는 감염되지 않는다 */
            chance: z.record(id, z.number().min(0).max(1)),
            worst_harm: z.number().int().min(0).default(0),
            /** 진행을 절반으로 늦추는 약: 하나 쓰면 하루 동안 듣는다 (그사이 하루치 진행이 반 단계) */
            slow: z.array(id).default([]),
            /** 감염을 떼는 약. 잠복에도 듣는다 (걸렸는지 몰라도 쓸 수 있다). 있으면 감염을 낫게 하는 것은 이것뿐 (치료사·소모품은 못 뗀다) */
            cure: z.array(id).default([]),
            /** 감염으로 죽으면(마지막 단계) 그 자리에 이 엑스트라 틀의 감염체로 남는다 (12-117). 겉모습과 짐은 그 사람의 것 */
            turns_into: id.optional(),
          })
          .optional(),
        /**
         * 추위 트랙 (12-4). 하루마다 계절·날씨의 추위만큼 나빠진다 (가진 방한 장비만큼 덜).
         * 우리 거점(소속 무리가 가진 구역)에서 무리의 연료가 있으면 shelter.warm만큼 나아진다. 춥지 않은 날은 1 나아진다
         */
        cold: z
          .strictObject({
            track: id,
            season: z.record(id, z.number().int().min(0)).default({}),
            weather: z.record(id, z.number().int().min(0)).default({}),
            /** 들고 있으면 추위를 덜어 주는 장비 (쓰지 않는다): 아이템 → 덜어 주는 양 */
            gear: z.record(id, z.number().int().min(0)).default({}),
            /** guests (12-121): 다른 무리 거점도 그 무리가 주인공의 무리를 이만큼 이상으로 보면 손님을 불 땐 방에 재운다 (무소속은 0으로 본다). 없으면 우리 땅만 */
            shelter: z.strictObject({ resource: id, min_days: z.number().min(0), warm: z.number().int().max(0), guests: z.number().int().min(-3).max(3).optional() }),
            worst_harm: z.number().int().min(0).default(0),
            /**
             * 기온 (12-98). 있으면 하루 단위 추위(season·weather·gear) 대신 시간대마다 기온을 재고 냉기를 쌓는다.
             * 바깥 기온 = 계절 평균 + 시간대 + 날씨 + 그날의 들쭉날쭉(±jitter). 체감 = 바깥 + 실내(구역 cover, 날씨는 indoor_weather배) + 난방 + 옷차림 + 트레잇.
             * 체감이 comfort보다 낮으면 (모자란 도 × 시간)만큼 냉기가 쌓이고 per_step마다 한 단계 오른다.
             * comfort 이상이면 시간당 mild_rate, warm 이상이면 warm_rate만큼 냉기가 빠지고 per_step마다 한 단계 풀린다
             */
            climate: z
              .strictObject({
                season: z.record(id, z.number()),
                segments: z.strictObject({ dawn: z.number(), morning: z.number(), day: z.number(), evening: z.number(), night: z.number() }),
                weather: z.record(id, z.number()).default({}),
                jitter: z.number().min(0).default(0),
                /** 오늘 새벽은 영상인데 내일 새벽이 영하면 오늘 보이는 낌새 (12-239, 플레이 테스트 13: 하룻밤에 -5°로 떨어졌는데 낌새가 없었다) */
                frost_omen: z.string().optional(),
                comfort: z.number(),
                warm: z.number(),
                per_step: z.number().positive(),
                mild_rate: z.number().min(0),
                warm_rate: z.number().min(0),
                /** 실내에서 날씨가 미치는 정도 (0 ~ 1) */
                indoor_weather: z.number().min(0).max(1).default(0.5),
                /** 바깥에서 하는 활동 (나머지는 그 구역의 실내에서) */
                outdoor: z.array(z.string()).default(["travel", "search", "guard_duty", "combat"]),
                /** 불 땐 거점 실내 (shelter 조건)의 최저 체감 */
                heated: z.number(),
                /** 피난처(location.sanctuary) 실내의 최저 체감 (12-122). 없으면 피난처도 보통 실내 */
                sanctuary: z.number().optional(),
                /** 트레잇 효과 cold 1당 체감에서 빼는 도 (추위를 탐 +1, 추위에 강함 -1) */
                trait_degrees: z.number().min(0).default(3),
                /**
                 * 모닥불: 연료 아이템 → 타는 시간. 같은 구역에 있으면 체감 +warmth, 피우면 그 구역 소음 +noise.
                 * stove: 난로(시설 effects.fire)가 있는 구역에서 피우면 이만큼 오래 탄다 (12-190: 난로도 땔감을 땐다, 실내만 따뜻하다)
                 */
                fire: z
                  .strictObject({ items: z.record(id, z.number().positive()), warmth: z.number().positive(), noise: z.number().int().min(0).default(0), stove: z.number().min(1).default(3) })
                  .optional(),
                /**
                 * 젖은 옷 (12-121, 12-186): weather 날씨에 바깥에 있었거나 이야기 효과 soak로 젖으면 마를 때까지 체감 -degrees.
                 * 시간으로는 마르지 않는다. 불 곁(모닥불·난로)에 fire_hours 있거나, 갈아입을 옷이 있는 곳에서 갈아입어야(take_action.change_clothes) 마른다.
                 * 불 곁에 있는 동안은 빼지 않는다
                 */
                wet: z.strictObject({ weather: z.array(id).default([]), degrees: z.number().positive(), fire_hours: z.number().positive() }).optional(),
              })
              .optional(),
          })
          .optional(),
        /**
         * 질병 트랙 (12-4). 걸리면 숨은 단계(잠복)부터. 하루마다 확률로 걸린다: base + 굶주림·추위·무리의 물 부족마다 더한다.
         * 능력(resist.ability, 체력)이 높을수록 덜 걸리고 잘 낫는다. 배부르고 따뜻하면 하루마다 확률로 낫고, 아니면 확률로 나빠진다
         */
        disease: z
          .strictObject({
            track: id,
            chance: z.strictObject({ base: z.number().min(0).max(1), starving: z.number().min(0).max(1), cold: z.number().min(0).max(1), thirst: z.number().min(0).max(1) }),
            /** 무리의 이 자원이 하루치보다 적으면 더러운 물을 마신다 (갈증 규칙이 있으면 갈증 suffering_from 단계로 대신한다) */
            thirst_resource: id.optional(),
            resist: z.strictObject({ ability: id, per_point: z.number().min(0).max(1) }),
            recover: z.strictObject({ chance: z.number().min(0).max(1), per_point: z.number().min(0).max(1) }),
            worsen: z.number().min(0).max(1),
            worst_harm: z.number().int().min(0).default(0),
          })
          .optional(),
        /**
         * 마음 (12-48): 크게 다치거나 곁의 사람이 죽는 것을 보면 흔들린다. 마음 다잡기(steady) 판정으로 버틴다.
         * 굶주리거나 얼지 않으면 하루마다 확률로 가라앉고, 우리 땅이나 곁에 사람이 있으면 더 잘 가라앉는다 (recover.safe). 부상은 주지 않는다 (판정 보정만)
         */
        nerves: z
          .strictObject({
            track: id,
            heavy_harm: z.number().int().min(0),
            witness_death: z.number().int().min(0),
            recover: z.strictObject({ chance: z.number().min(0).max(1), per_point: z.number().min(0).max(1), safe: z.number().min(0).max(1).default(0) }),
            /**
             * 푹 자면 가라앉는다: 끊기지 않고 min_hours 이상 자고 나면 한 단계 가라앉을 확률 (안전한 곳 safe, 아니면 unsafe, 능력 1당 recover.per_point 더).
             * 하루마다 가라앉는 것과 따로 굴린다. 굶주림·오한 이상이면 없다
             */
            sleep: z.strictObject({ min_hours: z.number().positive(), safe: z.number().min(0).max(1), unsafe: z.number().min(0).max(1) }).optional(),
          })
          .optional(),
        /**
         * 공포 (12-95): 그 자리에서 오르고 몇 시간 안에 빠지는 단기 상태. 판정 보정만 준다 (행동을 막지 않는다).
         * 계기(이야기 fright, 엑스트라 fearsome, 전투, 목격한 죽음, GM의 take_action.fright)가 주는 단계에
         * 어둠·동행·트레잇을 더하고 빼며, 마음 다잡기(steady) 판정으로 버틴다
         */
        fear: z
          .strictObject({
            track: id,
            /** GM이 고르는 take_action.fright의 단계 */
            gm: z.strictObject({ startle: z.number().int().min(0), dread: z.number().int().min(0) }),
            /** 무리 전투가 붙을 때 */
            battle: z.number().int().min(0),
            /** 곁의 사람이 눈앞에서 죽을 때 */
            witness_death: z.number().int().min(0),
            /** 이 시간대면 더한다 (어둠) */
            dark: z.strictObject({ segments: z.array(z.enum(TIME_SEGMENTS)), steps: z.number().int().min(0) }),
            /** 동행이 곁에 있으면 뺀다 */
            companion: z.number().int().min(0),
            /** 공포를 부른 것이 장면에 없으면 이 시간마다 한 단계 가라앉는다. 자고 나면 첫 단계 */
            decay_hours: z.number().positive(),
            /** 마음 트랙이 이 단계 이상이면 공포가 한 단계 더 오른다 */
            nerves_from: id.optional(),
            /** 계기 하나로 오르는 공포의 상한 (플레이 테스트 11, D7: 평온에서 한 번에 공황). 없으면 끝없이 */
            max_steps: z.number().int().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * 날씨 (12-3). 하루마다 계절별 무게로 고른다. visibility는 숨은 목격자 확률에 곱한다 (비·안개는 잘 안 보인다)
     */
    weather: z
      .strictObject({
        kinds: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              description: z.string().min(1),
              visibility: z.number().min(0).max(2),
              /** 상태 화면 아이콘 (12-66) */
              icon: iconNameSchema.optional(),
              /** 전날의 낌새 (플레이 테스트 11, E2): 내일이 이 날씨면 오늘 상태에 이 한 줄이 보인다 (한파·눈처럼 대비해야 하는 날씨만) */
              omen: z.string().min(1).optional(),
            }),
          )
          .min(1),
        /** 계절 id → 날씨 id → 무게. 계절이 없거나 빠졌으면 default */
        by_season: z.record(id, z.record(id, z.number().min(0))).default({}),
        default: z.record(id, z.number().min(0)),
      })
      .optional(),
    /**
     * 계절 (12-1). 첫 날은 start의 계절·날짜. 계절마다 하루 소모·산출에 곱하는 배수
     */
    /**
     * 상대와 상황 (12-104). 주사위는 주인공만 굴리고, 상대의 실력·지켜보는 눈·어둠을 코드가 판정 보정으로 바꾼다.
     * moves: 내 스킬 → 상대가 맞서는 스킬. crowd: 이 스킬은 장면의 눈(동행 빼고)이 at을 넘을 때마다 -1.
     * dark: 이 시간대면 value. visibility: 날씨 visibility가 below 아래면 value.
     * harm: 판정이 나빠 다칠 때 상대의 moves 중 가장 잘하는 점수가 strong 이상이면 한 단계 더, weak 이하면 한 단계 덜
     */
    opposition: z
      .strictObject({
        moves: z.record(id, id).default({}),
        /** 함께하는 말이 될 수 있는 스킬 (플레이 테스트 11): 대상(target)만 있으면 상대로 치지 않는다. 맞서는 흥정이면 GM이 check.opponent로 둔다 */
        cooperative: z.array(id).default([]),
        crowd: z.strictObject({ moves: z.array(id), at: z.array(z.number().int().positive()) }).optional(),
        dark: z.strictObject({ moves: z.array(id), segments: z.array(z.enum(TIME_SEGMENTS)), value: z.number().int() }).optional(),
        visibility: z.strictObject({ moves: z.array(id), below: z.number(), value: z.number().int() }).optional(),
        /** armed (12-121): 상대가 무거운 피해를 낼 무기(max_harm heavy, 탄약이 있으면)를 지녔으면 이만큼 더한다. 상대의 몫은 -1 ~ +1로 자른다 */
        harm: z.strictObject({ moves: z.array(id), strong: z.number().int(), weak: z.number().int(), armed: z.number().int().min(0).max(1).default(0) }).optional(),
        /** 거리 (12-121): 이 스킬은 상대와의 거리(check.distance)에 따라 보정 (숨기: 멀면 쉽고 맞붙으면 어렵다) */
        distance: z.strictObject({ moves: z.array(id), values: z.record(id, z.number().int()) }).optional(),
        /**
         * 말이 통하지 않는 상대 (엑스트라 kind: infected, 12-111).
         * refuses: 이 상대에게 쓸 수 없는 스킬 (말로 하는 것). outnumbered: 장면에 맞서는 감염체가 at을 넘을 때마다 이 스킬 -1.
         * 감염체가 상대(opponent·target)인 판정에서 다치면 감염 위험(infected_source)과 그 틀의 상처 종류가 저절로 붙는다
         */
        mindless: z
          .strictObject({
            refuses: z.array(id).default([]),
            outnumbered: z.strictObject({ moves: z.array(id), at: z.array(z.number().int().positive()) }).optional(),
          })
          .optional(),
      })
      .optional(),
    seasons: z
      .strictObject({
        start: z.strictObject({ season: id, day: z.number().int().positive() }),
        list: z
          .array(
            z.strictObject({
              id,
              label: z.string().min(1),
              days: z.number().int().positive(),
              upkeep: z.record(id, z.number().min(0)).default({}),
              yields: z.record(id, z.number().min(0)).default({}),
            }),
          )
          .min(1),
      })
      .optional(),
    /** 스토리렛 발동 간격 (기획서 10.3). 마지막 스토리렛 뒤 이만큼 지나야 다음 것이 열리고, 열린 것은 이만큼 지나면 지나간다 */
    /** 임무의 판정 조건에서 서로 바꿔 쓸 수 있는 판정 묶음 (플레이 테스트 13: 교섭 조건을 매력 낮은 사람이 넘기지 못했다. 으름장으로 끝낸 흥정도 흥정이다) */
    mission_move_groups: z.array(z.array(id).min(2)).default([]),
    /**
     * 임무 브리핑의 낌새 (content:check, 12-237): 브리핑이 이 말(정규식)을 쓰면 그 필드가 있어야 한다.
     * buddy: 짝을 말하는 브리핑 (분대장 이상만 받는 임무는 분대가 있어 뺀다), learns: 알아 오는 브리핑
     */
    /**
     * 캐릭터 설정 (RP, 4.6.4, 12-246): 칸(slots)과 목록(items). core는 칸 종류만 안다 (원칙 7).
     * rolls: 거스를 때 굴리는 칸 (이상·금기·결점). confirm: 거스를 때 GM이 먼저 묻는 확인 말. fact: 비밀의 사실 (GM만 봄).
     * requires: 성격 축 한쪽 이름 → 단계(1 가끔, 2 자주). opposites: 함께 못 고르는 설정, trait_opposites: 함께 못 고르는 트레잇.
     * roles_none: 고를 수 없는 시나리오, factions_none: 그 무리 시나리오에서 고를 수 없음, needs_faction: 무소속은 고를 수 없음, clashes_roles: 고를 수는 있지만 자주 부딪히는 시나리오.
     * backing: 지금 세계에 무언가가 있다고 말하는 설정을 엔진 상태로 뒷받침한다 (원칙 2): deserter·debt·kin_enemy 지난 일, trait, stash(우리 거점 사물함), keepsake(소중한 물건)
     */
    settings: z
      .strictObject({
        slots: z.array(z.strictObject({ id, label: z.string().min(1), max: z.number().int().min(1).max(3), rolls: z.boolean().default(false), hint: z.string().min(1) })).min(1),
        items: z.array(
          z.strictObject({
            id,
            slot: id,
            name: z.string().min(1),
            description: z.string().min(1),
            acting: z.string().min(1),
            confirm: z.string().optional(),
            fact: z.string().optional(),
            requires: z.record(z.string(), z.number().int().min(1).max(2)).default({}),
            opposites: z.array(id).default([]),
            trait_opposites: z.array(id).default([]),
            roles_none: z.array(id).default([]),
            factions_none: z.array(id).default([]),
            needs_faction: z.boolean().default(false),
            clashes_roles: z.array(id).default([]),
            backing: z
              .strictObject({
                deserter: z.boolean().optional(),
                debt: z.enum(["small", "large"]).optional(),
                kin_enemy: z.boolean().optional(),
                trait: id.optional(),
                stash: z.strictObject({ item: id, quantity: z.number().int().min(1) }).optional(),
                keepsake: id.optional(),
              })
              .optional(),
          }),
        ),
      })
      .optional(),
    /** 이 부상 단계부터는 위험 임무(작전·적 땅)를 오늘의 일감에 내지 않는다 (12-239, 플레이 테스트 13: 중상인 부하에게 보급 털기) */
    mission_unfit_from: id.optional(),
    mission_hints: z.strictObject({ buddy: z.array(z.string()).default([]), learns: z.array(z.string()).default([]) }).default({ buddy: [], learns: [] }),
    /** 공통 규칙 5 (rules/rest.ts): 최근에 나온 것이 쉬는 날수. cast 이야기 배역, mission 받은 일감, alarm 무리마다의 경보 이야기 */
    rest: z.strictObject({ cast: z.number().min(0).optional(), mission: z.number().min(0).optional(), alarm: z.number().min(0).optional() }).default({}),
    storylet_pacing: z
      .strictObject({
        min_gap_hours: z.number().min(0),
        /** 있으면 이야기 사이 간격을 min_gap_hours~이 값 사이로 정한다 (앞 이야기마다 다르게, 플레이 테스트 12: 하루 상한 대신 간격으로) */
        max_gap_hours: z.number().min(0).optional(),
        expire_hours: z.number().positive(),
        /** 캐릭터의 이야기가 시작된 뒤 첫 이야기까지 (시작하자마자 끼어들지 않게) */
        first_after_hours: z.number().min(0).default(2),
        /** 보통 이야기와 길 위의 일은 앞 이야기(급한 것 포함)와 이만큼은 떨어진다 (12-191: 하루 8개가 몰렸다). 급한 이야기는 urgent_per_day로 막는다 */
        min_any_gap_hours: z.number().min(0).default(0),
        /** 급한 이야기는 하루 이만큼까지 (0이면 끝없이). 넘친 것은 그 자리를 놓쳐 사라진다 */
        urgent_per_day: z.number().int().min(0).default(0),
        /** 주인공의 몸이 이 단계 이상이면(상태 트랙 → 단계) 급한 이야기만 연다 (위급할 때 보통 이야기·길 위의 일이 끼어들지 않게) */
        urgent_only_when: z.record(id, id).default({}),
        /**
         * 하루 상한 (플레이 테스트 11, D1~D3. 0이면 없음): 모든 이야기(급한 것 포함) per_day, 다치게 하는 이야기(공포·매복·감염체 배역) threat_per_day,
         * 길 위의 일 road_per_day. 같은 위협(공포 태그·감염체)을 가진 이야기끼리는 same_threat_gap_days 떨어진다. 임무 자리의 이야기(when.mission)는 세지 않는다
         */
        per_day: z.number().int().min(0).default(0),
        threat_per_day: z.number().int().min(0).default(0),
        road_per_day: z.number().int().min(0).default(0),
        same_threat_gap_days: z.number().min(0).default(0),
      })
      .default({ min_gap_hours: 6, expire_hours: 3, first_after_hours: 2, min_any_gap_hours: 0, urgent_per_day: 0, urgent_only_when: {}, per_day: 0, threat_per_day: 0, road_per_day: 0, same_threat_gap_days: 0 }),
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
    for (const [from, to] of Object.entries(s.renamed.abilities)) {
      if (!stats.has(to)) problem(`renamed.abilities.${from}: 알 수 없는 능력 ${to}`);
    }
    if (s.ability_array && s.ability_array.length !== s.stats.length) problem("ability_array의 길이는 능력 수와 같아야 한다");
    const moves = new Set(s.moves.map((x) => x.id));
    if (s.creation) {
      for (const key of Object.keys(s.creation.cost)) {
        const v = Number(key);
        if (v < s.ranges.ability.min || v > s.ranges.ability.max) problem(`creation.cost: 능력 범위 밖의 값 ${key}`);
      }
      if (s.creation.cost["0"] !== 0) problem("creation.cost: 0의 값은 0이어야 한다");
    }
    {
      const traitIds = new Set(s.traits.map((t) => t.id));
      for (const t of s.traits) {
        for (const o of t.opposites) if (!traitIds.has(o)) problem(`traits.${t.id}.opposites: 알 수 없는 트레잇 ${o}`);
        for (const m of Object.keys(t.effects.skills ?? {})) if (!moves.has(m)) problem(`traits.${t.id}.effects.skills: 알 수 없는 스킬 ${m}`);
        for (const m of t.effects.attraction?.moves ?? []) if (!moves.has(m)) problem(`traits.${t.id}.effects.attraction: 알 수 없는 스킬 ${m}`);
        if (t.kind === "personality" && t.cost !== 0) problem(`traits.${t.id}: 성격 트레잇의 비용은 0이다`);
      }
    }
    if (s.charm && !s.stats.some((x) => x.id === s.charm!.ability)) problem(`charm.ability: 알 수 없는 능력 ${s.charm.ability}`);
    for (const [role, move] of Object.entries(s.move_roles)) {
      if (move && !moves.has(move)) problem(`move_roles.${role}: 알 수 없는 행동 ${move}`);
    }
    for (const [track, level] of Object.entries(s.storylet_pacing.urgent_only_when)) {
      const t = s.condition_tracks.find((x) => x.id === track);
      if (!t) problem(`storylet_pacing.urgent_only_when: 알 수 없는 상태 트랙 ${track}`);
      else if (!t.levels.some((l) => l.id === level)) problem(`storylet_pacing.urgent_only_when.${track}: 알 수 없는 단계 ${level}`);
    }
    for (const [track, level] of Object.entries(s.camp?.deep_sleep ?? {})) {
      const t = s.condition_tracks.find((x) => x.id === track);
      if (!t) problem(`camp.deep_sleep: 알 수 없는 상태 트랙 ${track}`);
      else if (!t.levels.some((l) => l.id === level)) problem(`camp.deep_sleep.${track}: 알 수 없는 단계 ${level}`);
    }
    if (s.improv) {
      const t = s.condition_tracks.find((x) => x.id === s.improv!.costs.body.track);
      if (!t) problem(`improv.costs.body: 알 수 없는 상태 트랙 ${s.improv.costs.body.track}`);
      if (s.improv.costs.body.track === s.harm_track) problem("improv.costs.body: 부상 트랙은 대가로 쓸 수 없다 (원칙 3)");
      // 등급마다 모든 갈래의 물건이 있어야 한다 (GM이 고른 갈래가 비지 않게)
      for (const tier of ["small", "medium"] as const) {
        for (const kind of Object.keys(s.improv.item_kinds)) if (!s.improv.rewards[tier].items[kind]) problem(`improv.rewards.${tier}.items: 갈래 ${kind}의 물건이 없다`);
        for (const kind of Object.keys(s.improv.rewards[tier].items)) if (!s.improv.item_kinds[kind]) problem(`improv.rewards.${tier}.items: item_kinds에 없는 갈래 ${kind}`);
      }
    }
    if (s.search_lore && !moves.has(s.search_lore.skill)) problem(`search_lore: 알 수 없는 스킬 ${s.search_lore.skill}`);
    // 마음 다잡기 (12-220): 마음·공포 규칙이 있으면 있어야 하고, 능력은 그 행동이 쓰는 것이어야 한다
    if ((s.body?.nerves || s.body?.fear) && !s.body?.steady) problem("body.steady: 마음·공포 규칙에는 마음 다잡기 판정이 있어야 한다");
    if (s.body?.steady) {
      const m = s.moves.find((x) => x.id === s.body!.steady!.move);
      if (!m) problem(`body.steady: 알 수 없는 행동 ${s.body.steady.move}`);
      else if (!m.stats.includes(s.body.steady.stat)) problem(`body.steady: ${m.id}에는 ${s.body.steady.stat} 능력을 쓸 수 없다`);
    }
    for (const m of s.captivity?.flee_moves ?? []) if (!moves.has(m)) problem(`captivity.flee_moves: 알 수 없는 행동 ${m}`);
    // 잠입·뇌물·협박의 판정 행동 (12-153, 12-154)
    if (s.infiltration) {
      for (const m of [s.infiltration.move, s.infiltration.listen, ...s.infiltration.goals.map((g) => g.move)]) if (!moves.has(m)) problem(`infiltration: 알 수 없는 행동 ${m}`);
      const resources = new Set(s.resources.map((r) => r.id));
      for (const g of s.infiltration.goals) for (const r of Object.keys(g.resource)) if (!resources.has(r)) problem(`infiltration.goals.${g.id}: 알 수 없는 자원 ${r}`);
    }
    if (s.market) {
      const resources = new Set(s.resources.map((r) => r.id));
      for (const r of Object.values(s.market.kinds)) if (!resources.has(r)) problem(`market.kinds: 알 수 없는 자원 ${r}`);
      for (const [season, table] of Object.entries(s.market.seasons)) for (const r of Object.keys(table)) if (!resources.has(r)) problem(`market.seasons.${season}: 알 수 없는 자원 ${r}`);
    }
    if (s.leverage) for (const m of [s.leverage.bribe.move, s.leverage.blackmail.move]) if (!moves.has(m)) problem(`leverage: 알 수 없는 행동 ${m}`);
    for (const track of s.condition_tracks) {
      const fatal = track.levels.findIndex((l) => l.fatal);
      if (fatal !== -1 && fatal !== track.levels.length - 1) problem(`condition_tracks.${track.id}: fatal은 마지막 단계여야 한다`);
    }
    const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
    if (!harm) problem(`harm_track: 알 수 없는 상태 트랙 ${s.harm_track}`);
    else if (!harm.levels.at(-1)?.fatal) problem(`harm_track ${s.harm_track}의 마지막 단계는 fatal이어야 한다`);
    if (s.war) {
      const resources = new Set(s.resources.map((r) => r.id));
      const used = [...Object.keys(s.war.upkeep), ...s.war.vital, s.war.ammo, s.war.medicine, s.war.ration.resource];
      for (const r of used) if (!resources.has(r)) problem(`war: 알 수 없는 자원 ${r}`);
      for (const list of [s.war.ration.levels, s.war.stock_labels]) {
        if (list.some((l, i) => i > 0 && l.min_days > list[i - 1]!.min_days)) problem("war: min_days는 내림차순이어야 한다");
      }
    }
    if (s.battle) {
      const positions = new Set(s.battle.positions.map((p) => p.id));
      const preps = new Set(s.battle.preparations.map((p) => p.id));
      for (const e of s.battle.effects) {
        for (const p of e.positions) if (!positions.has(p)) problem(`battle.effects.${e.id}: 알 수 없는 위치 ${p}`);
        if (e.requires_preparation && !preps.has(e.requires_preparation)) problem(`battle.effects.${e.id}: 알 수 없는 준비물 ${e.requires_preparation}`);
      }
      const ids = s.battle.effects.map((e) => e.id);
      if (new Set(ids).size !== ids.length) problem("battle.effects에 중복된 id가 있다");
    }
    if (s.recovery) {
      const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
      const level = s.recovery.natural_max_level;
      if (harm && !harm.levels.some((l) => l.id === level)) problem(`recovery.natural_max_level: 알 수 없는 단계 ${level}`);
    }
    const trackIdSet = new Set(s.condition_tracks.map((t) => t.id));
    for (const a of s.war?.talk?.attitudes ?? []) for (const t of a.traits) if (!s.traits.some((x) => x.id === t)) problem(`war.talk.${a.id}: 알 수 없는 트레잇 ${t}`);
    if (s.wounds) {
      const w = s.wounds;
      const bleed = s.condition_tracks.find((t) => t.id === w.track);
      const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
      if (!bleed) problem(`wounds.track: 알 수 없는 상태 트랙 ${w.track}`);
      const bleedLevels = new Set(bleed?.levels.map((l) => l.id) ?? []);
      for (const [h, b] of Object.entries(w.from_harm)) {
        if (harm && !harm.levels.some((l) => l.id === h)) problem(`wounds.from_harm: 알 수 없는 부상 단계 ${h}`);
        if (!bleedLevels.has(b)) problem(`wounds.from_harm.${h}: 알 수 없는 출혈 단계 ${b}`);
      }
      for (const b of [...Object.keys(w.worsen_hours), ...Object.keys(w.clot_hours), w.blocks_recovery_from]) if (!bleedLevels.has(b)) problem(`wounds: 알 수 없는 출혈 단계 ${b}`);
      if (w.infected_default && !w.kinds.some((k) => k.id === w.infected_default)) problem(`wounds.infected_default: 알 수 없는 상처 종류 ${w.infected_default}`);
      if (!s.moves.some((m) => m.id === w.staunch_move)) problem(`wounds.staunch_move: 알 수 없는 스킬 ${w.staunch_move}`);
    }
    for (const t of Object.keys(s.body?.wear_off ?? {})) if (!s.condition_tracks.some((x) => x.id === t)) problem(`body.wear_off: 알 수 없는 상태 트랙 ${t}`);
    for (const [item, d] of Object.entries(s.body?.dependence ?? {})) {
      const t = s.traits.find((x) => x.id === d.trait);
      if (!t) problem(`body.dependence.${item}: 알 수 없는 트레잇 ${d.trait}`);
      else if (!t.effects.habit) problem(`body.dependence.${item}: ${d.trait}은(는) 버릇(habit) 트레잇이 아니다`);
    }
    for (const x of s.symptoms ?? []) for (const g of x.masks ?? []) if (!(s.symptoms ?? []).some((y) => y.group === g)) problem(`symptoms.${x.id}.masks: 알 수 없는 증상 묶음 ${g}`);
    const surgery = s.recovery?.surgery;
    if (surgery) {
      const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
      if (harm && !harm.levels.some((l) => l.id === surgery.from)) problem(`recovery.surgery.from: 알 수 없는 부상 단계 ${surgery.from}`);
      if (!s.moves.some((m) => m.id === surgery.move)) problem(`recovery.surgery.move: 알 수 없는 스킬 ${surgery.move}`);
      if (!s.stats.some((x) => x.id === surgery.stat)) problem(`recovery.surgery.stat: 알 수 없는 능력 ${surgery.stat}`);
    }
    if (s.exploration) {
      for (const m of [s.exploration.move, s.exploration.search_move]) if (!s.moves.some((x) => x.id === m)) problem(`exploration: 알 수 없는 행동 ${m}`);
      for (const r of s.exploration.ruins) if (r.loot.length !== r.depths.length) problem(`exploration.ruins.${r.id}: loot는 깊이 칸마다 하나 (${r.depths.length})`);
    }
    if (s.resolve) {
      if (!s.condition_tracks.some((t) => t.id === s.resolve!.relief_track)) problem(`resolve.relief_track: 알 수 없는 상태 트랙 ${s.resolve.relief_track}`);
      for (const [k, v] of Object.entries(s.resolve.from_history)) if (v && !s.resolve.kinds.some((x) => x.id === v)) problem(`resolve.from_history.${k}: 알 수 없는 갈래 ${v}`);
    }
    for (const k of s.disasters?.kinds ?? []) {
      for (const r of Object.keys(k.resources)) if (!s.resources.some((x) => x.id === r)) problem(`disasters.${k.id}: 알 수 없는 자원 ${r}`);
      if (k.weather && !(s.weather?.kinds ?? []).some((w) => w.id === k.weather)) problem(`disasters.${k.id}: 알 수 없는 날씨 ${k.weather}`);
      for (const x of k.seasons) if (!(s.seasons?.list ?? []).some((y) => y.id === x)) problem(`disasters.${k.id}: 알 수 없는 계절 ${x}`);
    }
    const scars = s.scars;
    if (scars) {
      const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
      if (harm && !harm.levels.some((l) => l.id === scars.at)) problem(`scars.at: 알 수 없는 부상 단계 ${scars.at}`);
      for (const x of scars.traits) {
        if (!s.traits.some((t) => t.id === x.trait)) problem(`scars.traits: 알 수 없는 트레잇 ${x.trait}`);
        for (const w of x.wounds) if (!s.wounds?.kinds.some((k) => k.id === w)) problem(`scars.traits.${x.trait}: 알 수 없는 상처 종류 ${w}`);
      }
    }
    const symptomIds = new Set((s.symptoms ?? []).map((x) => x.id));
    if (symptomIds.size !== (s.symptoms ?? []).length) problem("symptoms에 중복된 id가 있다");
    for (const [item, effects] of Object.entries(s.consumables)) {
      for (const t of Object.keys(effects)) if (!trackIdSet.has(t)) problem(`consumables.${item}: 알 수 없는 상태 트랙 ${t}`);
    }
    for (const t of Object.keys(s.recovery?.healer ?? {})) if (!trackIdSet.has(t)) problem(`recovery.healer: 알 수 없는 상태 트랙 ${t}`);
    for (const t of s.traits) if (t.effects.habit && !trackIdSet.has(t.effects.habit.track)) problem(`traits.${t.id}.habit: 알 수 없는 상태 트랙 ${t.effects.habit.track}`);
    const infection = s.body?.infection;
    if (infection) {
      for (const k of Object.keys(infection.chance)) if (!s.wounds?.kinds.some((x) => x.id === k)) problem(`body.infection.chance: 알 수 없는 상처 종류 ${k}`);
      for (const t of [...Object.keys(s.recovery?.healer ?? {}), ...Object.values(s.consumables).flatMap((e) => Object.keys(e))]) {
        if (infection.cure.length && t === infection.track) problem(`감염은 혈청(body.infection.cure)으로만 낫는다: recovery.healer·consumables에서 ${t}를 뺀다`);
      }
    }
    for (const t of [s.body?.hunger?.track, s.body?.thirst?.track, s.body?.infection?.track, s.body?.cold?.track, s.body?.disease?.track, s.body?.nerves?.track, s.body?.fear?.track]) if (t && !trackIdSet.has(t)) problem(`body: 알 수 없는 상태 트랙 ${t}`);
    if (s.persona) {
      const axes = new Set(s.persona.axes.map((x) => x.id));
      if (axes.size !== s.persona.axes.length) problem("persona.axes: 중복된 id가 있다");
      for (const t of s.traits) for (const ax of Object.keys(t.persona ?? {})) if (!axes.has(ax)) problem(`traits.${t.id}.persona: 알 수 없는 성격 축 ${ax}`);
      for (const e of s.persona.edges) for (const m of e.moves) if (!s.moves.some((x) => x.id === m)) problem(`persona.edges: 알 수 없는 스킬 ${m}`);
      const used = [s.persona.blowup?.axis, s.persona.leak?.axis, s.persona.hear?.axis, ...s.persona.edges.map((e) => e.axis), s.persona.romance?.axis, ...(s.persona.rapport?.axes ?? []), ...Object.keys(s.persona.fill ?? {})];
      for (const ax of used) if (ax && !axes.has(ax)) problem(`persona: 알 수 없는 성격 축 ${ax}`);
    } else if (s.traits.some((t) => t.persona)) problem("traits의 persona는 persona(성격 축)가 있을 때만 쓴다");
    if (s.body?.fear?.nerves_from) {
      const nerves = s.condition_tracks.find((t) => t.id === s.body?.nerves?.track);
      if (!nerves?.levels.some((l) => l.id === s.body!.fear!.nerves_from)) problem(`body.fear.nerves_from: 마음 트랙에 없는 단계 ${s.body.fear.nerves_from}`);
    }
    for (const track of s.condition_tracks) {
      if (track.levels[0]?.hidden) problem(`condition_tracks.${track.id}: 첫 단계는 숨길 수 없다`);
      for (const l of track.levels) {
        for (const sym of l.symptoms ?? []) if (!symptomIds.has(sym)) problem(`condition_tracks.${track.id}.${l.id}: 알 수 없는 증상 ${sym}`);
        if (!l.label && !l.symptoms?.length && l !== track.levels[0] && !l.hidden) problem(`condition_tracks.${track.id}.${l.id}: 이름(label)이나 증상(symptoms)이 필요하다`);
      }
    }
    if (s.seasons && !s.seasons.list.some((x) => x.id === s.seasons!.start.season)) problem(`seasons.start: 알 수 없는 계절 ${s.seasons.start.season}`);
    if (s.weather) {
      const kinds = new Set(s.weather.kinds.map((k) => k.id));
      for (const table of [s.weather.default, ...Object.values(s.weather.by_season)]) {
        for (const k of Object.keys(table)) if (!kinds.has(k)) problem(`weather: 알 수 없는 날씨 ${k}`);
      }
      for (const season of Object.keys(s.weather.by_season)) {
        if (!s.seasons?.list.some((x) => x.id === season)) problem(`weather.by_season: 알 수 없는 계절 ${season}`);
      }
    }
    if (s.war) for (const l of s.war.ration.levels) if (s.body?.hunger && l.hunger === undefined) problem(`war.ration.levels: 허기 규칙이 있으면 hunger(하루 변화)를 적는다`);
    const ranks = new Set(s.rank_ladder.map((r) => r.id));
    if (s.command) {
      const moves = new Set(s.moves.map((m) => m.id));
      const statIds = new Set(s.stats.map((x) => x.id));
      const resources = new Set(s.resources.map((r) => r.id));
      for (const t of s.command.squad_tasks) {
        if (t.kind === "work" && (!t.move || !moves.has(t.move))) problem(`command.squad_tasks.${t.id}: work는 move(스킬)가 필요하다`);
        if (t.stat && !statIds.has(t.stat)) problem(`command.squad_tasks.${t.id}: 알 수 없는 능력 ${t.stat}`);
        for (const r of Object.keys(t.rewards.resources)) if (!resources.has(r)) problem(`command.squad_tasks.${t.id}: 알 수 없는 자원 ${r}`);
      }
      if (s.command.lead_skill && !moves.has(s.command.lead_skill)) problem(`command.lead_skill: 알 수 없는 스킬 ${s.command.lead_skill}`);
      for (const m of [...s.command.council_moves, ...Object.keys(s.command.follow_bonus)]) if (!moves.has(m)) problem(`command: 알 수 없는 스킬 ${m}`);
      for (const r of s.command.council_ranks) if (!ranks.has(r)) problem(`command.council_ranks: 알 수 없는 등급 ${r}`);
      for (const p of s.command.policies) {
        if (!p.options.some((o) => o.id === p.default)) problem(`command.policies.${p.id}: default ${p.default}가 선택지에 없다`);
        for (const o of p.options) {
          for (const r of [...Object.keys(o.upkeep), ...Object.keys(o.trade?.give ?? {}), ...Object.keys(o.trade?.get ?? {})]) {
            if (!resources.has(r)) problem(`command.policies.${p.id}.${o.id}: 알 수 없는 자원 ${r}`);
          }
        }
      }
      if (s.command.policies.length && !s.command.council_moves.length) problem(`command: 방침이 있으면 council_moves(회의에서 쓰는 스킬)를 적는다`);
    }
    for (const rank of [s.promotion.from, s.promotion.to]) {
      if (!ranks.has(rank)) problem(`promotion: 알 수 없는 등급 ${rank}`);
    }
  })
  // 단계 이름·보정이 없으면 증상에서 채운다 (12-74)
  .transform((s) => {
    const byId = new Map((s.symptoms ?? []).map((x) => [x.id, x]));
    return {
      ...s,
      condition_tracks: s.condition_tracks.map((t) => ({
        ...t,
        levels: t.levels.map((l) => {
          const list = (l.symptoms ?? []).map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
          return {
            ...l,
            label: l.label ?? (list.length ? list.map((x) => x.label).join(" · ") : "이상 없음"),
            penalty: l.penalty ?? list.reduce((n, x) => n + x.penalty, 0),
          };
        }),
      })),
    };
  });
export type ScenarioFile = z.output<typeof scenarioFileSchema>;

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
  /** 세계 소개 원문 (intro 파일의 내용) */
  introText: string | null;
  /** 주인공 초상화 목록 (art/portraits.yaml, 12-139). 파일이 없는 월드는 없다 */
  portraits?: PortraitCatalog;
};

/**
 * 주인공 초상화 (12-139). art/portraits.yaml에서 게임이 쓰는 칸만 읽는다 (나머지는 그림을 만드는 도구의 설정).
 * styles: 화풍(적힌 순서가 섹션 순서), faces: 얼굴 id → 화풍과 성별. 그림은 art/portraits/<id>.png
 */
export const portraitFileSchema = z.looseObject({
  /** numbered: 고르기 화면에서 얼굴마다 번호를 보인다 (얼굴을 번호로 가리키며 다듬을 때) */
  styles: z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.looseObject({ label: z.string().min(1), numbered: z.boolean().optional() })),
  faces: z.record(
    z.string().regex(/^[a-z0-9_-]{1,40}$/, "초상화 id는 소문자·숫자·_·- (40자까지)"),
    z.looseObject({ style: z.string(), gender: z.string() }),
  ),
});

export type PortraitCatalog = {
  /** 얼굴이 있는 화풍만, 적힌 순서대로 */
  styles: { id: string; label: string; numbered: boolean }[];
  faces: { id: string; style: string; gender: string }[];
};

export type ConditionTrack = Scenario["condition_tracks"][number];

/** 시나리오 ID 목록을 zod enum으로. 타입은 string으로 다룬다 */
export function idEnum(ids: readonly string[]) {
  return z.enum(ids as unknown as [string, ...string[]]);
}
