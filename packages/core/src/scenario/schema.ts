import { z } from "zod";
import { TIME_SEGMENTS } from "../rules/time.ts";

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
    /** 스킬 (기본 행동). 판정은 능력 하나 + 이 스킬. stats: 쓸 수 있는 능력, default: 배우지 않았을 때의 수준 */
    moves: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          stats: z.array(id).min(1),
          description: z.string().optional(),
          default: z.number().int().default(0),
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
        xp: z.strictObject({ success: z.number().int().min(0), partial: z.number().int().min(0), miss: z.number().int().min(0), merit: z.number().int().min(0) }),
        /** 판정으로 하루에 얻을 수 있는 경험치 상한 */
        daily_check_cap: z.number().int().positive(),
      })
      .optional(),
    /** 시스템이 특정 역할로 쓰는 행동 */
    move_roles: z.strictObject({ notice: id, stealth: id }),
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
        /** 트레잇 고르기 (기획서 4.6): 종류별 최대 개수. 긍정 비용 합 ≤ 부정 보상 합 */
        traits: z
          .strictObject({ max_positive: z.number().int().min(0), max_negative: z.number().int().min(0), max_personality: z.number().int().min(0) })
          .default({ max_positive: 3, max_negative: 3, max_personality: 2 }),
        /** 대화로 만들 때(MCP) 단계별로 GM에게 주는 서술 힌트 */
        narration: z
          .strictObject({
            name: z.string().optional(),
            gender: z.string().optional(),
            abilities: z.string().optional(),
            ability: z.string().optional(),
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
              infection: z.number().min(0).optional(),
              /** 저절로 낫는 데 걸리는 날 ± */
              recovery_days: z.number().int().optional(),
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
            })
            .default({}),
        }),
      )
      .default([]),
    /** 상대를 쓰러뜨리기 (기획서 7.5): 부상이 이 단계 이상이면 무력화 (더 맞서지 못하고 소지품을 뒤질 수 있다) */
    combat: z.strictObject({ incapacitated_at: id }).optional(),
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
        /** 시작 소지품 꾸러미 */
        kits: z.array(z.strictObject({ id, label: z.string().min(1), description: z.string().default(""), items: z.array(id) })).min(1),
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
                })
                .default({ resources: {}, loot: false, merit: 0 }),
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
                    /** 무리 사람이 받는 배급 단계를 이만큼 옮긴다 (+1이면 한 단계 적게, war.ration.levels) */
                    ration_shift: z.number().int().min(-2).max(2).default(0),
                    /** 하루마다 사기 변화 */
                    morale: z.strictObject({ delta: z.number().int().min(-1).max(1), chance: z.number().min(0).max(1) }).optional(),
                    /**
                     * 교역: 하루마다 상대 무리와 자원을 바꾼다. 서로의 태도가 min_disposition 이상이고 양쪽 창고에 있을 때만.
                     * 상대가 자기 자신이면 하지 않는다
                     */
                    trade: z
                      .strictObject({
                        partner: id,
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
    /** 새 게임의 월드 고르기에 보이는 것 (기획서 12.3). 없으면 name만 */
    world: z
      .strictObject({
        /** 월드 이름 (예: 무너진 도시, 가람) */
        title: z.string().min(1),
        /** 한 줄 소개 */
        tagline: z.string().min(1),
        /** 고를 때 보여 주는 두세 문장 */
        description: z.string().min(1),
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
        /** 치료사(장면에 있는 healer NPC)에게 받으면 트랙별로 낫는 단계 수. 하루에 한 번 */
        healer: z.record(id, z.number().int().min(0)),
      })
      .optional(),
    /** 쓰면 몸 상태가 나아지는 아이템: 아이템 → 상태 트랙 → 나아지는 단계 수 (take_action.use_item) */
    consumables: z.record(id, z.record(id, z.number().int().positive())).default({}),
    /** 몸 상태 (12-1): 허기와 감염. 없으면 그 규칙을 쓰지 않는다 */
    body: z
      .strictObject({
        /** 허기 트랙. 하루마다 배급 수준(war.ration.levels[].hunger)만큼 바뀐다. 마지막 단계에서는 하루마다 부상 */
        hunger: z.strictObject({ track: id, starving_harm: z.number().int().min(0) }).optional(),
        /**
         * 감염 트랙. 감염체에게 다치면(take_action.check.infected_source) 확률로 두 번째 단계(잠복)가 된다.
         * 하루마다 한 단계씩 나빠지고, 마지막 단계에서는 하루마다 부상
         */
        infection: z
          .strictObject({
            track: id,
            chance: z.strictObject({ light: z.number().min(0).max(1), heavy: z.number().min(0).max(1) }),
            worst_harm: z.number().int().min(0),
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
            shelter: z.strictObject({ resource: id, min_days: z.number().min(0), warm: z.number().int().max(0) }),
            worst_harm: z.number().int().min(0),
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
            /** 무리의 이 자원이 하루치보다 적으면 더러운 물을 마신다 */
            thirst_resource: id.optional(),
            resist: z.strictObject({ ability: id, per_point: z.number().min(0).max(1) }),
            recover: z.strictObject({ chance: z.number().min(0).max(1), per_point: z.number().min(0).max(1) }),
            worsen: z.number().min(0).max(1),
            worst_harm: z.number().int().min(0),
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
          .array(z.strictObject({ id, label: z.string().min(1), description: z.string().min(1), visibility: z.number().min(0).max(2) }))
          .min(1),
        /** 계절 id → 날씨 id → 무게. 계절이 없거나 빠졌으면 default */
        by_season: z.record(id, z.record(id, z.number().min(0))).default({}),
        default: z.record(id, z.number().min(0)),
      })
      .optional(),
    /**
     * 계절 (12-1). 첫 날은 start의 계절·날짜. 계절마다 하루 소모·산출에 곱하는 배수
     */
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
    storylet_pacing: z
      .strictObject({
        min_gap_hours: z.number().min(0),
        expire_hours: z.number().positive(),
        /** 캐릭터의 이야기가 시작된 뒤 첫 이야기까지 (시작하자마자 끼어들지 않게) */
        first_after_hours: z.number().min(0).default(2),
      })
      .default({ min_gap_hours: 6, expire_hours: 3, first_after_hours: 2 }),
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
      if (move.default < s.ranges.skill.min || move.default > s.ranges.skill.max) problem(`moves.${move.id}: 기본값이 스킬 범위 밖이다`);
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
      if (!moves.has(move)) problem(`move_roles.${role}: 알 수 없는 행동 ${move}`);
    }
    for (const track of s.condition_tracks) {
      const fatal = track.levels.findIndex((l) => l.fatal);
      if (fatal !== -1 && fatal !== track.levels.length - 1) problem(`condition_tracks.${track.id}: fatal은 마지막 단계여야 한다`);
    }
    const harm = s.condition_tracks.find((t) => t.id === s.harm_track);
    if (!harm) problem(`harm_track: 알 수 없는 상태 트랙 ${s.harm_track}`);
    else if (!harm.levels.at(-1)?.fatal) problem(`harm_track ${s.harm_track}의 마지막 단계는 fatal이어야 한다 (사망은 부상 트랙으로만)`);
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
    for (const [item, effects] of Object.entries(s.consumables)) {
      for (const t of Object.keys(effects)) if (!trackIdSet.has(t)) problem(`consumables.${item}: 알 수 없는 상태 트랙 ${t}`);
    }
    for (const t of Object.keys(s.recovery?.healer ?? {})) if (!trackIdSet.has(t)) problem(`recovery.healer: 알 수 없는 상태 트랙 ${t}`);
    for (const t of [s.body?.hunger?.track, s.body?.infection?.track, s.body?.cold?.track, s.body?.disease?.track]) if (t && !trackIdSet.has(t)) problem(`body: 알 수 없는 상태 트랙 ${t}`);
    for (const track of s.condition_tracks) {
      if (track.levels[0]?.hidden) problem(`condition_tracks.${track.id}: 첫 단계는 숨길 수 없다`);
      if (track.id !== s.harm_track && track.levels.some((l) => l.fatal)) problem(`condition_tracks.${track.id}: 사망은 부상 트랙으로만 (fatal은 harm_track에만)`);
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
  /** 세계 소개 원문 (intro 파일의 내용) */
  introText: string | null;
};

export type ConditionTrack = Scenario["condition_tracks"][number];

/** 시나리오 ID 목록을 zod enum으로. 타입은 string으로 다룬다 */
export function idEnum(ids: readonly string[]) {
  return z.enum(ids as unknown as [string, ...string[]]);
}
