import { TIE_KINDS } from "./ties.ts";
import { z } from "zod";
import type { Rng } from "../rng.ts";
import { CHECK_OUTCOMES, difficultySchema } from "../rules/check.ts";
import { harmSeveritySchema } from "../rules/harm.ts";
import { activitySchema, dayOf, START_TIME } from "../rules/time.ts";
import { interruptSchema } from "../sim/fastForward.ts";
import type { Content, NpcContent, RoleContent } from "../content/schemas.ts";
import { idEnum, type Scenario } from "../scenario/schema.ts";
import { initialConditions, moveIds, rankIds, statIds, trackIds } from "../scenario/scenario.ts";
import { beliefSchema, beliefSourceSchema, type Belief } from "./belief.ts";
import { activeMissionOf, isRequirementMet, missionInstanceSchema, outcomeAtLeast } from "./missions.ts";
import {
  applyRelationDelta,
  deedSchema,
  NEUTRAL_RELATION,
  relationDeltaSchema,
  relationSchema,
} from "./reputation.ts";
import { createCharacterSchema, inventorySchema, type Character, type Inventory } from "./character.ts";

/**
 * 세이브 형식 버전. GameState나 GameEvent를 호환되지 않게 바꾸면 올리고,
 * 이전 세이브를 옮기는 방법을 함께 만든다.
 * 필드 추가는 기본값(.default)을 주면 이전 세이브와 호환되므로 올리지 않는다.
 * - 2: 시나리오 팩 분리. 능력치 ID 변경, injury → conditions, scenarioId
 * - 7: 인물을 아는 것을 만남(met)과 이름(known)으로 나눴다 (기획서 6.3). 엑스트라는 처음부터 이름이 있고 사라지지 않는다.
 *   extra_named·extra_gone 이벤트가 없어져 이전 세이브는 읽지 않는다
 */
export const SAVE_SCHEMA_VERSION = 19;
/** 이 버전부터의 세이브는 이벤트를 스키마 기본값으로 올려 읽는다 */
export const MIN_READABLE_SAVE_VERSION = 7;

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

/** 자유 시나리오의 역할 id (콘텐츠의 역할 id와 겹치지 않는다) */
export const CUSTOM_ROLE_ID = "custom";

/** 자유 시나리오의 역할. 코드가 검증된 고르기로 만들어 세이브에 넣는다 (game/customStart.ts) */
const customRoleSchema = z.custom<RoleContent>((v) => typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string");

/** 지금 주인공의 역할: 콘텐츠의 역할, 자유 시나리오면 세이브에 든 역할 */
export function roleOf(content: Content, state: Pick<GameState, "roleId" | "customRole">): RoleContent | undefined {
  return content.roles[state.roleId] ?? state.customRole ?? undefined;
}

const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

/** 세력의 지금 상태 (기획서 9.1). 진짜 값이므로 UI·프롬프트에는 정보 필터를 거쳐 대략만 보낸다 */
export const factionStateSchema = z.strictObject({
  population: z.number().int().min(0),
  combatants: z.number().int().min(0),
  resources: z.record(z.string(), z.number().int().min(0)),
  morale: z.number().int().min(-3).max(3),
  cohesion: z.number().int().min(-3).max(3),
  /** 다른 세력에 대한 지금 태도 (-3 ~ +3). 없으면 콘텐츠의 시작값 (이전 세이브). 이야기·클락(shift)으로 바뀐다 */
  disposition: z.record(z.string(), z.number().int().min(-3).max(3)).optional(),
  /** 무리 방침 (주제 id → 선택지 id, 기획서 9.11). 없는 주제는 시나리오의 default */
  policy: z.record(z.string(), z.string()).optional(),
});
export type FactionState = z.infer<typeof factionStateSchema>;

/** 함께 다니는 이유 (기획서 7.9) */
export const BOND_KINDS = ["animal", "buddy", "squad", "purpose", "kin"] as const;
export type BondKind = (typeof BOND_KINDS)[number];
/** 목적 동행이 끝나는 조건 (하나라도 차면 갈림길) */
export const bondUntilSchema = z.strictObject({
  flag: z.string().optional(),
  zone: z.string().optional(),
  at: z.number().int().optional(),
});
export const bondSchema = z.strictObject({
  kind: z.enum(BOND_KINDS),
  since: z.number().int(),
  /** 임무 짝: 이 임무가 끝나면 돌아간다 */
  missionId: z.string().optional(),
  until: bondUntilSchema.optional(),
  /** 목적을 이뤄 갈림길에 섰다 (lean: 남고 싶어 하는지, decideBy: 정하지 않으면 이 시각에 기울기대로) */
  crossroads: z.strictObject({ lean: z.enum(["stay", "leave"]), decideBy: z.number().int() }).optional(),
  /** 잠시 떨어져 있다: zone에서 기다리거나(until null), 볼일을 보고 until에 돌아온다(zone null) */
  apart: z.strictObject({ zone: z.string().nullable(), until: z.number().int().nullable(), since: z.number().int() }).optional(),
});
export type Bond = z.infer<typeof bondSchema>;

/** 인물 사이의 관계 한 줄: a는 b의 kind (기획서 7.10) */
export const tieRecordSchema = z.strictObject({
  a: z.string(),
  b: z.string(),
  kind: z.enum(TIE_KINDS),
  secret: z.strictObject({ reveal_when: z.string(), min_trust: z.number().int() }).nullable(),
});

/** 세력 클락: 다 차면 목표 구역을 총공격한다 */
export const clockStateSchema = z.strictObject({
  factionId: z.string(),
  label: z.string(),
  target: z.string(),
  filled: z.number().int().min(0),
  max: z.number().int().positive(),
});
export type ClockState = z.infer<typeof clockStateSchema>;

/** 하루 전쟁 틱에서 일어난 교전 */
export const clashSchema = z.strictObject({
  kind: z.enum(["raid", "skirmish", "assault", "occupy"]),
  attacker: z.string(),
  /** 빈 구역 차지(occupy)는 null */
  defender: z.string().nullable(),
  zone: z.string(),
  success: z.boolean(),
  attackerLosses: z.number().int().min(0),
  defenderLosses: z.number().int().min(0),
  /** 세력 클락이 다 차서 벌어진 총공격이면 그 클락 id */
  plan: z.string().optional(),
  /** 습격으로 빼앗은 자원 */
  loot: z.record(z.string(), z.number().int().min(0)).optional(),
});
export type Clash = z.infer<typeof clashSchema>;

/** 플레이어가 낄 교전: 그날 새벽으로 예정해 두고, 그때 그 자리에 있으면 전투 장면으로 연다 (기획서 9.5) */
export const pendingClashSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["raid", "skirmish", "assault"]),
  attacker: z.string(),
  defender: z.string(),
  zone: z.string(),
  at: z.number().int(),
  plan: z.string().optional(),
});
export type PendingClash = z.infer<typeof pendingClashSchema>;

/** 연대기: 죽은 캐릭터 한 명의 기록 (기획서 3.2). 플레이어(사람)가 보는 기록이고, 다음 캐릭터의 지식은 아니다 */
export const runRecordSchema = z.strictObject({
  characterId: z.string(),
  name: z.string(),
  factionId: z.string(),
  rank: z.string(),
  startedAt: z.number().int(),
  diedAt: z.number().int(),
  merit: z.number().int(),
  cause: z.string(),
  /** 남은 행적 (중대한 것부터) */
  deeds: z.array(z.string()),
  /** AI가 쓰는 짧은 회고·묘비명 */
  epitaph: z.string().nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** 진행 중인 전투 장면. 전세는 플레이어 편 기준 (+면 우리가 이기고 있다) */
export const battleStateSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["raid", "skirmish", "assault"]),
  attacker: z.string(),
  defender: z.string(),
  zone: z.string(),
  plan: z.string().optional(),
  /** 플레이어가 공격 쪽인지 방어 쪽인지 */
  side: z.enum(["attack", "defense"]),
  ours: z.strictObject({ faction: z.string(), committed: z.number().int().min(0), losses: z.number().int().min(0) }),
  theirs: z.strictObject({ faction: z.string(), committed: z.number().int().min(0), losses: z.number().int().min(0) }),
  momentum: z.number().int(),
  alarm: z.number().int().min(0),
  position: z.string(),
  round: z.number().int().min(0),
  /** 아직 남은 적 목표물 */
  objectives: z.array(z.string()),
  /** 플레이어 행동이 바꾼 전세의 합 (공적 계산) */
  contribution: z.number().int(),
  startedAt: z.number().int(),
});
export type BattleState = z.infer<typeof battleStateSchema>;

/**
 * 세계 상태와 이벤트 스키마. 능력치·행동·등급·상태 트랙 ID는 시나리오에서 오므로
 * 시나리오를 받아 만든다 (기획서 12.3). 세이브를 불러올 때도 이 스키마로 검증한다.
 */
export function createGameSchemas(s: Scenario) {
  const character = createCharacterSchema(s);
  const move = idEnum(moveIds(s));
  // 이름이 바뀐 능력은 새 id로 읽는다 (이전 세이브의 판정 기록)
  const stat = z.preprocess((v) => (typeof v === "string" ? (s.renamed.abilities[v] ?? v) : v), idEnum(statIds(s)));
  const rank = idEnum(rankIds(s));
  const track = idEnum(trackIds(s));

  const checkRecord = z.strictObject({
    checkId: z.string(),
    turn: z.number().int(),
    actorId: z.string(),
    /** 은밀 행동이 목격 확률을 낮춘다 */
    move: move.optional(),
    /** 판정의 상대 인물 (그 인물의 물건을 옮길 근거가 된다) */
    target: z.string().optional(),
    outcome: checkOutcomeSchema,
    /** 이 판정의 대가로 이미 피해를 적용했는지 */
    harmApplied: z.boolean(),
  });

  /** 세계의 진짜 상태 (World State). 콘텐츠(아이템 정의 등)는 넣지 않고 id로만 참조한다 */
  const state = z.strictObject({
    scenarioId: z.string(),
    worldId: z.string(),
    roleId: z.string(),
    /** 자유 시나리오로 시작했으면 그때 코드가 만든 역할 (콘텐츠에 없다, 기획서 12.5). roleId는 CUSTOM_ROLE_ID */
    customRole: customRoleSchema.nullable().default(null),
    /** 주인공과 함께 다니는 인물·동물 (기획서 7.8). 구역을 옮겨도 따라오고 장면에 남는다 */
    companions: z.array(z.string()).default([]),
    /** 동적으로 생긴 인물 사이의 관계 (세계를 만들 때, 인물이 자랄 때, 기획서 7.10). 정해진 관계는 콘텐츠에 있다 */
    dynamicTies: z.array(tieRecordSchema).default([]),
    /** 작전에 빌린 장비 (임무 id → 아이템 → 수량, 기획서 4.8). 임무가 끝나면 반납한다 */
    loans: z.record(z.string(), z.record(z.string(), z.number().int().min(1))).default({}),
    /** 구역마다 오늘의 소음 (기획서 4.8) */
    zoneNoise: z.record(z.string(), z.strictObject({ day: z.number().int(), level: z.number().int() })).default({}),
    /** 상인이 마지막으로 물건을 채운 날 */
    restockedDay: z.record(z.string(), z.number().int()).default({}),
    /** 이 세계에서 열린 해금 (여기서 얻었거나, 다른 판에서 얻어 세계를 열 때 옮겨 온 것, 기획서 9.12) */
    unlocked: z.array(z.string()).default([]),
    /** 주인공이 털어놓음을 들은 숨은 관계 (tieKey) */
    revealedTies: z.array(z.string()).default([]),
    /** 함께 다니는 이유 (NPC id → 이유, 기획서 7.9). 지금 곁에 있는 사람(companions)과 잠시 떨어져 있는 사람 모두 */
    bonds: z.record(z.string(), bondSchema).default({}),
    /** 분대원에게 맡긴 일 (NPC id → 명령, 기획서 9.11). follow는 동행으로 다루고 여기 넣지 않는다 */
    squadOrders: z
      .record(z.string(), z.strictObject({ task: z.string(), zone: z.string(), startedAt: z.number().int(), until: z.number().int() }))
      .default({}),
    /** 분대원의 마지막 보고 (NPC id → 문장). 화면 밖 일의 결과는 이것으로만 안다 */
    squadReports: z.record(z.string(), z.strictObject({ text: z.string(), at: z.number().int() })).default({}),
    /** 회의 기록 (주제 id → 마지막으로 안을 올린 날, 기각되면 다시 올릴 수 있는 시각) */
    council: z.record(z.string(), z.strictObject({ day: z.number().int(), blockedUntil: z.number().int() })).default({}),
    /** 이야기가 이름표로 기억해 둔 이름 없는 인물 (cast keep → recall) */
    keptExtras: z.record(z.string(), z.string()).default({}),
    /** 구역마다 오늘 뒤진 횟수 (수색, 기획서 4.7) */
    zoneSearches: z.record(z.string(), z.strictObject({ day: z.number().int(), count: z.number().int() })).default({}),
    turn: z.number().int().nonnegative(),
    /** 게임 시간 (1일차 00:00부터 흐른 분) */
    time: z.number().int().nonnegative(),
    playerId: z.string(),
    characters: z.record(z.string(), character),
    scene: z.strictObject({
      items: inventorySchema,
      /** 플레이어와 같은 장면에 있는 NPC id */
      present: z.array(z.string()),
    }),
    checks: z.record(z.string(), checkRecord),
    nextCheckNo: z.number().int().positive(),
    /** 치트를 쓴 적이 있는지 (슬롯에 표시) */
    cheated: z.boolean().default(false),
    /** 다음 엑스트라 번호 (ex_N) */
    nextExtraNo: z.number().int().positive().default(1),
    /** 오늘 판정으로 얻은 경험치 (하루 상한, 기획서 4.2) */
    xpToday: z.strictObject({ day: z.number().int(), amount: z.number().int() }).default({ day: 0, amount: 0 }),
    /** 캐릭터별 Belief State */
    beliefs: z.record(z.string(), z.array(beliefSchema)),
    /** 캐릭터별로 이름까지 아는 인물 id (기획서 6.3). 방향이 있다: known[A]에 B가 있으면 A가 B의 이름을 안다 */
    known: z.record(z.string(), z.array(z.string())),
    /** 캐릭터별로 만난(얼굴을 아는) 인물 id. 이름은 모를 수 있다 (이름을 알면 known에도 있다) */
    met: z.record(z.string(), z.array(z.string())).default({}),
    nextBeliefNo: z.number().int().positive(),
    missions: z.record(z.string(), missionInstanceSchema),
    /** 오늘 상관이 내놓은 임무 후보 */
    offers: z.strictObject({ day: z.number().int(), templateIds: z.array(z.string()) }).nullable(),
    nextMissionNo: z.number().int().positive(),
    /** 지금 캐릭터의 런이 시작된 시각 (복무 기간 계산) */
    runStartedAt: z.number().int(),
    /** 행적. 숨은 목격자가 들어 있으므로 UI·프롬프트로 그대로 보내지 않는다 */
    deeds: z.record(z.string(), deedSchema),
    /** NPC가 어떤 행적을 어떤 출처로 알고 있는지: npcId → deedId → source */
    deedKnowledge: z.record(z.string(), z.record(z.string(), beliefSourceSchema)),
    /** 관계: fromId → toId → 신뢰·호감·존중 */
    relations: z.record(z.string(), z.record(z.string(), relationSchema)),
    /**
     * 플레이어가 느끼는 NPC의 태도. 그 NPC와 같은 장면에 있을 때만 갱신된다.
     * 진짜 관계(relations)를 바로 보여 주면 숨은 목격자가 드러나므로 UI는 이것만 쓴다
     */
    perceived: z.record(z.string(), relationSchema),
    /** 비밀을 털어놓은 NPC */
    revealedSecrets: z.array(z.string()),
    /** 소문이 마지막으로 퍼진 날 */
    lastSpreadDay: z.number().int().nullable(),
    nextDeedNo: z.number().int().positive(),
    /** 세력 상태 (9단계). 이전 세이브는 세계를 열 때 콘텐츠의 시작값으로 채운다 */
    factions: z.record(z.string(), factionStateSchema).default({}),
    /** 구역 소유 */
    zones: z.record(z.string(), z.strictObject({ owner: z.string().nullable() })).default({}),
    clocks: z.record(z.string(), clockStateSchema).default({}),
    /** 전쟁 틱이 마지막으로 돈 날 */
    lastWarDay: z.number().int().nullable().default(null),
    /** 플레이어가 있는 전선 구역 (9-1). 이전 세이브는 세계를 열 때 정한다 */
    playerZone: z.string().nullable().default(null),
    /** 구역별 설치된 준비물 (함정 등) */
    preparations: z.record(z.string(), z.array(z.string())).default({}),
    /** 예정된 교전 (플레이어가 낄 수 있는 것) */
    pendingClashes: z.array(pendingClashSchema).default([]),
    battle: battleStateSchema.nullable().default(null),
    nextBattleNo: z.number().int().positive().default(1),
    /** 캐릭터별 시나리오 플래그 (스토리렛이 세운다. 비밀 lore의 secret:<flag>도 이것을 본다) */
    flags: z.record(z.string(), z.array(z.string())).default({}),
    /** 스토리렛 발동 기록 */
    storyletLog: z.record(z.string(), z.strictObject({ fired: z.number().int().min(0), lastFiredAt: z.number().int() })).default({}),
    /** 진행 중인 스토리렛 */
    activeStorylet: z
      .strictObject({ id: z.string(), cast: z.record(z.string(), z.string()), firedAt: z.number().int(), expiresAt: z.number().int() })
      .nullable()
      .default(null),
    lastStoryletAt: z.number().int().nullable().default(null),
    /** 회복 기준 시각: 마지막으로 다치거나 나은 때, 마지막으로 치료사에게 치료받은 날 */
    recovery: z
      .strictObject({ lastChangeAt: z.record(z.string(), z.number().int()), lastHealerDay: z.record(z.string(), z.number().int()) })
      .default({ lastChangeAt: {}, lastHealerDay: {} }),
    /** 오늘의 날씨 (12-3) */
    weather: z.strictObject({ day: z.number().int(), id: z.string() }).nullable().default(null),
    /** 최근 교전 (오래된 것부터, 최대 RECENT_CLASHES). 계승한 캐릭터가 직전 전황을 듣는 데 쓴다 */
    recentClashes: z.array(z.strictObject({ clash: clashSchema, at: z.number().int() })).default([]),
    /** 죽은 캐릭터들의 기록 (오래된 것부터) */
    chronicle: z.array(runRecordSchema).default([]),
  });

  /** 상태 변경은 반드시 이벤트로 기록한다 (append-only). 상태는 이벤트를 차례로 적용한 결과다 */
  const event = z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("world_created"),
      scenarioId: z.string().min(1),
      worldId: z.string().min(1),
      roleId: z.string().min(1),
      customRole: customRoleSchema.nullable().default(null),
      player: character,
      npcs: z.array(character),
      beliefs: z.record(z.string(), z.array(beliefSchema)),
      known: z.record(z.string(), z.array(z.string())),
    }),
    z.strictObject({ type: z.literal("npc_entered"), npcId: z.string() }),
    z.strictObject({ type: z.literal("zone_searched"), zone: z.string(), day: z.number().int() }),
    z.strictObject({ type: z.literal("extra_kept"), key: z.string(), characterId: z.string() }),
    z.strictObject({ type: z.literal("npc_captured"), npcId: z.string(), by: z.string(), zone: z.string() }),
    z.strictObject({ type: z.literal("npc_released"), npcId: z.string() }),
    /** 인물 사이의 관계가 생겼다 (세계를 만들 때 무작위로) */
    z.strictObject({ type: z.literal("ties_generated"), ties: z.array(tieRecordSchema) }),
    /** 이름 없는 인물이 자랐다 (프로필은 틀의 재료에서 코드가 골랐다) */
    z.strictObject({ type: z.literal("extra_promoted"), characterId: z.string(), profile: z.custom<NonNullable<Character["profile"]>>((v) => typeof v === "object" && v !== null), ties: z.array(tieRecordSchema).default([]) }),
    /** 무기를 들거나 방어구를 입었다 (null이면 벗었다) */
    z.strictObject({ type: z.literal("item_equipped"), characterId: z.string(), slot: z.enum(["weapon", "body", "head"]), itemId: z.string().nullable() }),
    /** 물건이 닳았다 (delta 음수면 고쳤다) */
    z.strictObject({ type: z.literal("item_worn"), characterId: z.string(), itemId: z.string(), delta: z.number().int() }),
    /** 물건이 망가졌다: 하나 줄고, 닳은 것은 처음으로, into가 있으면 그것이 남는다 */
    z.strictObject({ type: z.literal("item_broken"), characterId: z.string(), itemId: z.string(), into: z.string().nullable() }),
    /** 소리가 났다 (총소리 등): 그 구역의 오늘 소음 */
    z.strictObject({ type: z.literal("noise_made"), zone: z.string(), level: z.number().int().min(1), day: z.number().int() }),
    /** 무기고가 작전 장비를 빌려줬다 (무리 창고의 탄약 resource가 cost만큼 준다) */
    z.strictObject({ type: z.literal("armory_issued"), missionId: z.string(), factionId: z.string(), items: z.record(z.string(), z.number().int().min(1)), resource: z.string(), cost: z.number().int().min(0) }),
    /** 빌린 장비를 반납했다 (returned: 돌려준 것. 모자란 것은 잃어버린 것) */
    z.strictObject({ type: z.literal("armory_returned"), missionId: z.string(), returned: z.record(z.string(), z.number().int().min(1)) }),
    /** 상인이 물건을 다시 채웠다 */
    z.strictObject({ type: z.literal("merchant_restocked"), npcId: z.string(), day: z.number().int(), items: z.record(z.string(), z.number().int().min(1)) }),
    /** 해금을 얻었다 (inherited: 다른 판에서 얻은 것을 옮겨 왔다) */
    z.strictObject({ type: z.literal("unlock_earned"), id: z.string(), inherited: z.boolean().default(false) }),
    /** 숨은 관계를 털어놓았다 */
    z.strictObject({ type: z.literal("tie_revealed"), key: z.string() }),
    /** 함께 다니기 시작했다. kind가 없으면 이전 세이브 (코드가 틀로 정한다) */
    z.strictObject({ type: z.literal("companion_joined"), characterId: z.string(), kind: z.enum(BOND_KINDS).optional(), missionId: z.string().optional(), until: bondUntilSchema.optional() }),
    /** 헤어졌다 (함께 다니는 이유가 끝났다) */
    z.strictObject({ type: z.literal("companion_left"), characterId: z.string(), reason: z.string().optional() }),
    /** 잠시 떨어진다: zone에서 기다리거나, until에 돌아온다 */
    z.strictObject({ type: z.literal("companion_parted"), characterId: z.string(), zone: z.string().nullable(), until: z.number().int().nullable() }),
    /** 떨어져 있던 동행이 다시 곁에 왔다 */
    z.strictObject({ type: z.literal("companion_rejoined"), characterId: z.string() }),
    /** 목적을 이뤄 갈림길에 섰다 */
    z.strictObject({ type: z.literal("companion_crossroads"), characterId: z.string(), lean: z.enum(["stay", "leave"]), decideBy: z.number().int() }),
    /** 함께 다니는 이유가 바뀌었다 (목적 → 연고, 목적 연장) */
    z.strictObject({ type: z.literal("companion_bond_changed"), characterId: z.string(), kind: z.enum(BOND_KINDS), until: bondUntilSchema.optional() }),
    z.strictObject({ type: z.literal("debt_changed"), characterId: z.string(), factionId: z.string(), delta: z.number().int() }),
    /** 분대원에게 일을 맡겼다 (기획서 9.11). 시각은 코드가 정한다 */
    z.strictObject({ type: z.literal("squad_order_given"), npcId: z.string(), task: z.string(), zone: z.string(), until: z.number().int() }),
    /** 분대원이 명령을 거절했다 */
    z.strictObject({ type: z.literal("squad_order_refused"), npcId: z.string(), task: z.string() }),
    /** 맡긴 일이 끝났다 (결과는 코드가 굴렸다). report: 주인공이 듣는 보고 */
    z.strictObject({ type: z.literal("squad_order_done"), npcId: z.string(), task: z.string(), outcome: checkOutcomeSchema.nullable(), report: z.string() }),
    /** 지도부 회의에 안을 올렸다 */
    z.strictObject({ type: z.literal("council_proposed"), topic: z.string(), option: z.string(), outcome: checkOutcomeSchema, day: z.number().int(), blockedUntil: z.number().int() }),
    /** 무리 방침이 바뀌었다 */
    z.strictObject({ type: z.literal("faction_policy_set"), factionId: z.string(), topic: z.string(), option: z.string() }),
    /** NPC가 떠난다: toFaction이면 그 세력으로 넘어가고(도시에 남는다), null이면 도시를 떠난다 (기획서 10.4) */
    z.strictObject({ type: z.literal("npc_departed"), npcId: z.string(), toFaction: z.string().nullable() }),
    z.strictObject({ type: z.literal("faction_resource_changed"), factionId: z.string(), resource: z.string(), delta: z.number().int() }),
    /** 세력 사이 태도가 바뀐다 (값은 코드가 계산한 새 값) */
    z.strictObject({ type: z.literal("faction_disposition_changed"), from: z.string(), to: z.string(), value: z.number().int().min(-3).max(3) }),
    /**
     * 주인공이 무리에 들어간다 (무소속이면 가입, 무리에 있으면 옮김). 역할은 코드가 만든다 (game/customStart.ts joinRole, 기획서 12.5).
     * beliefs: 그 무리에서 처음 듣는 사정 (같은 계급 시나리오의 시작 지식)
     */
    z.strictObject({ type: z.literal("player_joined_faction"), factionId: z.string(), rank: z.string(), role: customRoleSchema, beliefs: z.array(beliefSchema).default([]) }),
    z.strictObject({ type: z.literal("npc_left"), npcId: z.string() }),
    z.strictObject({ type: z.literal("belief_added"), characterId: z.string(), belief: beliefSchema }),
    z.strictObject({ type: z.literal("missions_offered"), day: z.number().int(), templateIds: z.array(z.string()) }),
    z.strictObject({ type: z.literal("mission_assigned"), mission: missionInstanceSchema }),
    z.strictObject({
      type: z.literal("mission_reported"),
      missionId: z.string(),
      outcome: z.enum(["success", "partial", "failed"]),
      late: z.boolean(),
      merit: z.number().int(),
    }),
    /** disobedience: 무리의 규율이 이것을 불복종으로 치는지 (기획서 9.9). 이전 세이브는 true */
    z.strictObject({ type: z.literal("mission_abandoned"), missionId: z.string(), merit: z.number().int(), reason: z.string(), disobedience: z.boolean().default(true) }),
    z.strictObject({ type: z.literal("mission_expired"), missionId: z.string(), merit: z.number().int(), disobedience: z.boolean().default(true) }),
    z.strictObject({ type: z.literal("promoted"), characterId: z.string(), from: rank, to: rank }),
    z.strictObject({ type: z.literal("deed_recorded"), deed: deedSchema }),
    z.strictObject({
      type: z.literal("deed_learned"),
      deedId: z.string(),
      npcId: z.string(),
      source: beliefSourceSchema,
      /** 이 NPC의 행위자에 대한 관계 변화 (코드가 계산) */
      delta: relationDeltaSchema,
    }),
    z.strictObject({ type: z.literal("witnesses_searched"), deedId: z.string() }),
    z.strictObject({ type: z.literal("rumors_spread"), day: z.number().int() }),
    z.strictObject({
      type: z.literal("factions_initialized"),
      day: z.number().int(),
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), z.strictObject({ owner: z.string().nullable() })),
      clocks: z.record(z.string(), clockStateSchema),
    }),
    /** 하루 전쟁 틱의 결과 (코드가 계산). 세력·구역·클락의 새 값과 일어난 교전 */
    z.strictObject({
      type: z.literal("war_day_simulated"),
      day: z.number().int(),
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), z.strictObject({ owner: z.string().nullable() })),
      clocks: z.record(z.string(), z.strictObject({ filled: z.number().int().min(0) })),
      clashes: z.array(clashSchema),
      /** 플레이어가 낄 수 있어 미뤄 둔 교전 */
      scheduled: z.array(pendingClashSchema).default([]),
    }),
    z.strictObject({ type: z.literal("zone_moved"), from: z.string().nullable(), to: z.string() }),
    z.strictObject({ type: z.literal("weather_set"), day: z.number().int(), weatherId: z.string() }),
    z.strictObject({ type: z.literal("character_died"), record: runRecordSchema }),
    /**
     * 몸 상태 트랙이 바뀌었다 (12-1: 치료, 소모품, 배급에 따른 허기, 감염 진행, 굶주림·감염의 부상).
     * 판정에 묶인 피해는 harm_applied를 쓴다. by: healer | rest | daily | infection | 아이템 id
     */
    z.strictObject({
      type: z.literal("condition_changed"),
      targetId: z.string(),
      track: z.string(),
      from: z.string(),
      to: z.string(),
      fatal: z.boolean(),
      by: z.string(),
      cause: z.string(),
      day: z.number().int(),
      /** 부상 트랙이면 회복 기준 시각을 새로 잡는다 */
      harmTrack: z.boolean(),
    }),
    /** (이전 형식) 부상이 나았다. 새 기록은 condition_changed를 쓴다 */
    z.strictObject({
      type: z.literal("harm_healed"),
      targetId: z.string(),
      track: z.string(),
      from: z.string(),
      to: z.string(),
      by: z.string(),
      day: z.number().int(),
    }),
    z.strictObject({ type: z.literal("epitaph_written"), index: z.number().int().min(0), text: z.string().min(1).max(300) }),
    /** 다음 캐릭터로 이어 간다. 새로 만든 캐릭터면 character가 있다 */
    z.strictObject({
      type: z.literal("character_switched"),
      characterId: z.string(),
      /** 다른 시작 역할로 이어 갈 때 (해금된 시나리오, 기획서 9.12) */
      roleId: z.string().optional(),
      character: character.optional(),
      known: z.array(z.string()),
    }),
    z.strictObject({
      type: z.literal("storylet_fired"),
      storyletId: z.string(),
      cast: z.record(z.string(), z.string()),
      expiresAt: z.number().int(),
    }),
    z.strictObject({
      type: z.literal("storylet_resolved"),
      storyletId: z.string(),
      choiceId: z.string(),
      outcome: checkOutcomeSchema.nullable(),
    }),
    z.strictObject({ type: z.literal("storylet_expired"), storyletId: z.string() }),
    z.strictObject({ type: z.literal("flag_set"), characterId: z.string(), flag: z.string() }),
    z.strictObject({ type: z.literal("flag_cleared"), characterId: z.string(), flag: z.string() }),
    /** 스토리렛 효과 등으로 관계가 바뀌었다 (from이 to를 보는 관계) */
    z.strictObject({ type: z.literal("relation_changed"), from: z.string(), to: z.string(), delta: relationDeltaSchema, reason: z.string() }),
    z.strictObject({ type: z.literal("merit_awarded"), characterId: z.string(), delta: z.number().int(), reason: z.string() }),
    /** 경험치를 얻었다. level은 얻은 뒤의 레벨 (코드가 계산), source가 check면 하루 상한에 센다 */
    z.strictObject({
      type: z.literal("xp_gained"),
      characterId: z.string(),
      amount: z.number().int().positive(),
      source: z.enum(["check", "merit", "cheat"]),
      level: z.number().int().nonnegative(),
    }),
    /** 치트 (개발 모드, 기획서 17.2): 플레이어가 친 명령. 한 번이라도 쓰면 이 세이브는 치트를 쓴 것으로 남는다 */
    z.strictObject({ type: z.literal("cheat_used"), command: z.string() }),
    /** 치트: 캐릭터의 능력·스킬·트레잇을 바꾼다 (준 것만) */
    z.strictObject({
      type: z.literal("character_patched"),
      characterId: z.string(),
      stats: z.record(z.string(), z.number().int()).optional(),
      skills: z.record(z.string(), z.number().int()).optional(),
      traits: z.array(z.string()).optional(),
    }),
    /** 치트: 세력의 자원을 바꾼다 (준 것만) */
    z.strictObject({ type: z.literal("faction_patched"), factionId: z.string(), resources: z.record(z.string(), z.number()) }),
    /** 이름 없는 인물이 주인공과 엮여 캐릭터가 됐다 (기획서 7.5). 장면에 들어온다 */
    z.strictObject({ type: z.literal("extra_spawned"), character }),
    /** characterId가 targetId의 이름을 알게 됐다 (기획서 6.3) */
    z.strictObject({ type: z.literal("name_learned"), characterId: z.string(), targetId: z.string() }),
    /** 레벨업으로 스킬 하나를 올렸다 */
    z.strictObject({ type: z.literal("skill_learned"), characterId: z.string(), skill: z.string(), from: z.number().int(), to: z.number().int() }),
    z.strictObject({ type: z.literal("item_granted"), to: z.string(), itemId: z.string(), quantity: z.number().int().positive() }),
    z.strictObject({ type: z.literal("clock_adjusted"), clockId: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("faction_morale_changed"), factionId: z.string(), delta: z.number().int() }),
    z.strictObject({ type: z.literal("preparation_set"), zone: z.string(), preparation: z.string() }),
    z.strictObject({ type: z.literal("item_consumed"), holder: z.string(), itemId: z.string(), quantity: z.number().int().positive() }),
    /** 예정된 교전을 화면 밖에서 계산했다 (플레이어가 자리에 없었다) */
    z.strictObject({
      type: z.literal("clash_resolved"),
      pendingId: z.string(),
      clash: clashSchema,
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), z.strictObject({ owner: z.string().nullable() })),
    }),
    z.strictObject({ type: z.literal("battle_started"), pendingId: z.string(), battle: battleStateSchema }),
    z.strictObject({
      type: z.literal("battle_round"),
      effect: z.string().nullable(),
      checkId: z.string().nullable(),
      momentum: z.number().int(),
      alarm: z.number().int().min(0),
      position: z.string(),
      objectives: z.array(z.string()),
      ourLosses: z.number().int().min(0),
      theirLosses: z.number().int().min(0),
      contribution: z.number().int(),
      /** 쓴 준비물 (구역에서 빠진다) */
      preparationUsed: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("battle_ended"),
      /** 우리 편이 이겼는지 (방어는 버텼는지, 공격은 목적을 이뤘는지) */
      won: z.boolean(),
      withdrew: z.boolean(),
      clash: clashSchema,
      factions: z.record(z.string(), factionStateSchema),
      zones: z.record(z.string(), z.strictObject({ owner: z.string().nullable() })),
      merit: z.number().int().min(0),
    }),
    z.strictObject({ type: z.literal("secret_revealed"), npcId: z.string() }),
    z.strictObject({ type: z.literal("turn_started"), turn: z.number().int().positive(), input: z.string() }),
    z.strictObject({
      type: z.literal("check_rolled"),
      checkId: z.string(),
      turn: z.number().int(),
      actorId: z.string(),
      move,
      stat,
      difficulty: difficultySchema,
      intent: z.string(),
      dice: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]),
      /** condition: 상태 트랙(부상 등)에서 오는 보정 */
      /** stat: 능력, skill: 스킬 (능력 + 스킬은 상한까지), condition: 몸 상태 */
      modifiers: z.strictObject({
        stat: z.number().int(),
        skill: z.number().int().default(0),
        difficulty: z.number().int(),
        condition: z.number().int(),
        /** 트레잇의 상황 보정 (끌림 등) */
        trait: z.number().int().default(0),
        /** 물건의 불리함 (입은 방어구, 무거운 짐, 기획서 4.8) */
        gear: z.number().int().default(0),
      }),
      total: z.number().int(),
      outcome: checkOutcomeSchema,
      /** 상대 인물 id */
      target: z.string().optional(),
      /** 이 판정이 수행 중인 임무를 위한 것이면 그 임무 id (임무 진행으로 집계) */
      forMission: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("harm_applied"),
      targetId: z.string(),
      checkId: z.string(),
      track,
      severity: harmSeveritySchema,
      steps: z.number().int().positive(),
      from: z.string(),
      to: z.string(),
      /** to가 치명 단계(사망)인지. 코드가 시나리오 트랙으로 계산한다 */
      fatal: z.boolean(),
      cause: z.string(),
    }),
    z.strictObject({
      type: z.literal("time_advanced"),
      activity: activitySchema,
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      /** 빨리감기가 중간에 멈췄다면 그 이유 */
      interrupt: interruptSchema.optional(),
      /** 이 활동이 수행 중인 임무를 위한 것이면 그 임무 id (임무 진행으로 집계) */
      forMission: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal("item_transferred"),
      from: z.string(),
      to: z.string(),
      itemId: z.string(),
      quantity: z.number().int().positive(),
    }),
  ]);

  return { character, checkRecord, state, event };
}

type GameSchemas = ReturnType<typeof createGameSchemas>;
export type CheckRecord = z.infer<GameSchemas["checkRecord"]>;
export type GameState = z.infer<GameSchemas["state"]>;
export type GameEvent = z.infer<GameSchemas["event"]>;

/** 세계가 만들어지기 전의 빈 상태. 첫 이벤트는 반드시 world_created다 */
export const EMPTY_STATE: GameState = {
  scenarioId: "",
  worldId: "",
  roleId: "",
  customRole: null,
  zoneSearches: {},
  keptExtras: {},
  companions: [],
  bonds: {},
  dynamicTies: [],
  revealedTies: [],
  unlocked: [],
  zoneNoise: {},
  loans: {},
  restockedDay: {},
  squadOrders: {},
  squadReports: {},
  council: {},
  turn: 0,
  time: START_TIME,
  playerId: "",
  characters: {},
  scene: { items: {}, present: [] },
  checks: {},
  nextCheckNo: 1,
  nextExtraNo: 1,
  cheated: false,
  xpToday: { day: 0, amount: 0 },
  beliefs: {},
  known: {},
  met: {},
  nextBeliefNo: 1,
  missions: {},
  offers: null,
  nextMissionNo: 1,
  runStartedAt: START_TIME,
  deeds: {},
  deedKnowledge: {},
  relations: {},
  perceived: {},
  revealedSecrets: [],
  lastSpreadDay: null,
  nextDeedNo: 1,
  factions: {},
  zones: {},
  clocks: {},
  lastWarDay: null,
  playerZone: null,
  preparations: {},
  pendingClashes: [],
  battle: null,
  nextBattleNo: 1,
  flags: {},
  storyletLog: {},
  activeStorylet: null,
  lastStoryletAt: null,
  recovery: { lastChangeAt: {}, lastHealerDay: {} },
  weather: null,
  recentClashes: [],
  chronicle: [],
};

/** 최근 교전 기록에 남길 수 */
export const RECENT_CLASHES = 12;

function rememberClashes(next: GameState, clashes: readonly Clash[], at: number) {
  next.recentClashes.push(...clashes.map((clash) => ({ clash: structuredClone(clash), at })));
  next.recentClashes = next.recentClashes.slice(-RECENT_CLASHES);
}

export function applyEvent(state: GameState, event: GameEvent): GameState {
  if (event.type !== "world_created" && !state.worldId) {
    throw new Error(`세계가 만들어지기 전에 ${event.type} 이벤트를 적용할 수 없습니다.`);
  }
  const next = structuredClone(state);
  switch (event.type) {
    case "world_created": {
      if (state.worldId) throw new Error("세계가 이미 만들어졌습니다.");
      const characters: Record<string, Character> = { [event.player.id]: structuredClone(event.player) };
      for (const npc of event.npcs) {
        if (characters[npc.id]) throw new Error(`캐릭터 id 중복: ${npc.id}`);
        characters[npc.id] = structuredClone(npc);
      }
      const beliefCount = Object.values(event.beliefs).reduce((n, list) => n + list.length, 0);
      const created: GameState = {
        ...EMPTY_STATE,
        scenarioId: event.scenarioId,
        worldId: event.worldId,
        roleId: event.roleId,
        customRole: event.customRole ? structuredClone(event.customRole) : null,
        playerId: event.player.id,
        characters,
        beliefs: structuredClone(event.beliefs),
        known: structuredClone(event.known),
        met: structuredClone(event.known),
        nextBeliefNo: beliefCount + 1,
      };
      // 처음부터 아는 사람들(같은 무리 동료)은 주인공도 이름까지 안다
      for (const id of event.known[event.player.id] ?? []) acquaint(created, id, event.player.id, true);
      return created;
    }
    case "npc_departed": {
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      if (event.toFaction !== null) npc.factionId = event.toFaction;
      else npc.away = true;
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "player_joined_faction": {
      const player = mustGet(next.characters, next.playerId, "캐릭터");
      if (player.factionId === event.factionId) throw new Error("이미 그 무리에 속해 있습니다.");
      player.factionId = event.factionId;
      player.rank = event.rank;
      next.roleId = event.role.id;
      next.customRole = structuredClone(event.role);
      // 옛 분대·회의는 옛 무리의 것이다
      next.squadOrders = {};
      next.squadReports = {};
      next.council = {};
      // 무리 사람들과 서로 이름을 안다 (같은 무리 동료, 기획서 6.3)
      for (const id of event.role.known_npcs) {
        acquaint(next, next.playerId, id, true);
        acquaint(next, id, next.playerId, true);
      }
      next.beliefs[next.playerId] = [...(next.beliefs[next.playerId] ?? []), ...structuredClone(event.beliefs)];
      next.nextBeliefNo += event.beliefs.length;
      return next;
    }
    case "faction_disposition_changed": {
      const f = next.factions[event.from];
      if (!f) return next;
      f.disposition = { ...(f.disposition ?? {}), [event.to]: event.value };
      return next;
    }
    case "faction_resource_changed": {
      const f = next.factions[event.factionId];
      if (!f) return next;
      f.resources[event.resource] = Math.max(0, (f.resources[event.resource] ?? 0) + event.delta);
      return next;
    }
    case "npc_captured": {
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      npc.captive = { by: event.by, zone: event.zone };
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "ties_generated":
      next.dynamicTies = [...next.dynamicTies, ...structuredClone(event.ties)];
      return next;
    case "extra_promoted": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.profile = structuredClone(event.profile);
      next.dynamicTies = [...next.dynamicTies, ...structuredClone(event.ties)];
      return next;
    }
    case "item_equipped": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.equipped = { ...c.equipped, [event.slot]: event.itemId };
      return next;
    }
    case "item_worn": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      const now = Math.max(0, (c.wear[event.itemId] ?? 0) + event.delta);
      if (now === 0) delete c.wear[event.itemId];
      else c.wear[event.itemId] = now;
      return next;
    }
    case "item_broken": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      const have = c.inventory[event.itemId] ?? 0;
      if (have <= 1) delete c.inventory[event.itemId];
      else c.inventory[event.itemId] = have - 1;
      delete c.wear[event.itemId];
      if (event.into) c.inventory[event.into] = (c.inventory[event.into] ?? 0) + 1;
      for (const slot of ["weapon", "body", "head"] as const) if (c.equipped[slot] === event.itemId && !c.inventory[event.itemId]) c.equipped = { ...c.equipped, [slot]: null };
      return next;
    }
    case "noise_made": {
      const prev = next.zoneNoise[event.zone];
      next.zoneNoise[event.zone] = { day: event.day, level: (prev && prev.day === event.day ? prev.level : 0) + event.level };
      return next;
    }
    case "armory_issued": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      for (const [item, qty] of Object.entries(event.items)) me.inventory[item] = (me.inventory[item] ?? 0) + qty;
      next.loans[event.missionId] = { ...event.items };
      const f = next.factions[event.factionId];
      if (f && event.cost > 0) f.resources[event.resource] = Math.max(0, (f.resources[event.resource] ?? 0) - event.cost);
      return next;
    }
    case "armory_returned": {
      const me = mustGet(next.characters, next.playerId, "캐릭터");
      for (const [item, qty] of Object.entries(event.returned)) {
        const left = (me.inventory[item] ?? 0) - qty;
        if (left > 0) me.inventory[item] = left;
        else delete me.inventory[item];
      }
      delete next.loans[event.missionId];
      return next;
    }
    case "merchant_restocked": {
      const c = mustGet(next.characters, event.npcId, "캐릭터");
      for (const [item, qty] of Object.entries(event.items)) c.inventory[item] = (c.inventory[item] ?? 0) + qty;
      next.restockedDay[event.npcId] = event.day;
      return next;
    }
    case "unlock_earned":
      if (!next.unlocked.includes(event.id)) next.unlocked = [...next.unlocked, event.id];
      return next;
    case "tie_revealed":
      if (!next.revealedTies.includes(event.key)) next.revealedTies = [...next.revealedTies, event.key];
      return next;
    case "companion_joined": {
      if (!next.companions.includes(event.characterId)) next.companions.push(event.characterId);
      if (!next.scene.present.includes(event.characterId)) next.scene.present.push(event.characterId);
      if (event.kind) {
        next.bonds[event.characterId] = {
          kind: event.kind,
          since: state.time,
          ...(event.missionId ? { missionId: event.missionId } : {}),
          ...(event.until ? { until: event.until } : {}),
        };
      }
      return next;
    }
    case "companion_left": {
      next.companions = next.companions.filter((id) => id !== event.characterId);
      delete next.bonds[event.characterId];
      return next;
    }
    case "companion_parted": {
      next.companions = next.companions.filter((id) => id !== event.characterId);
      next.scene.present = next.scene.present.filter((id) => id !== event.characterId);
      const bond = next.bonds[event.characterId];
      if (bond) bond.apart = { zone: event.zone, until: event.until, since: state.time };
      return next;
    }
    case "companion_rejoined": {
      if (!next.companions.includes(event.characterId)) next.companions.push(event.characterId);
      if (!next.scene.present.includes(event.characterId)) next.scene.present.push(event.characterId);
      const bond = next.bonds[event.characterId];
      if (bond) delete bond.apart;
      return next;
    }
    case "companion_crossroads": {
      const bond = next.bonds[event.characterId];
      if (bond) bond.crossroads = { lean: event.lean, decideBy: event.decideBy };
      return next;
    }
    case "companion_bond_changed": {
      const bond = next.bonds[event.characterId];
      if (!bond) return next;
      bond.kind = event.kind;
      delete bond.crossroads;
      if (event.until) bond.until = event.until;
      else delete bond.until;
      return next;
    }
    case "squad_order_given": {
      next.squadOrders[event.npcId] = { task: event.task, zone: event.zone, startedAt: state.time, until: event.until };
      next.companions = next.companions.filter((id) => id !== event.npcId);
      delete next.bonds[event.npcId];
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "squad_order_refused":
      return next;
    case "squad_order_done": {
      delete next.squadOrders[event.npcId];
      next.squadReports[event.npcId] = { text: event.report, at: state.time };
      return next;
    }
    case "council_proposed": {
      next.council[event.topic] = { day: event.day, blockedUntil: event.blockedUntil };
      return next;
    }
    case "faction_policy_set": {
      const f = next.factions[event.factionId];
      if (!f) return next;
      f.policy = { ...(f.policy ?? {}), [event.topic]: event.option };
      return next;
    }
    case "debt_changed": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      const now = Math.max(0, (c.debts[event.factionId] ?? 0) + event.delta);
      if (now === 0) delete c.debts[event.factionId];
      else c.debts[event.factionId] = now;
      return next;
    }
    case "npc_released": {
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      npc.captive = null;
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      return next;
    }
    case "extra_kept": {
      next.keptExtras[event.key] = event.characterId;
      return next;
    }
    case "zone_searched": {
      const prev = next.zoneSearches[event.zone];
      next.zoneSearches[event.zone] = { day: event.day, count: prev && prev.day === event.day ? prev.count + 1 : 1 };
      return next;
    }
    case "npc_entered": {
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      if (npc.id === state.playerId) throw new Error("플레이어는 NPC로 등장할 수 없습니다.");
      if (npc.dead) throw new Error(`사망한 인물: ${npc.id}`);
      if (next.scene.present.includes(npc.id)) throw new Error(`이미 장면에 있음: ${npc.id}`);
      next.scene.present.push(npc.id);
      perceive(next, npc.id);
      if (npc.extra) npc.extra.lastSeenAt = state.time;
      // 만나면 서로 얼굴을 안다. 이름은 밝히거나 불려야 안다 (name_learned)
      acquaint(next, state.playerId, npc.id, false);
      acquaint(next, npc.id, state.playerId, false);
      break;
    }
    case "npc_left":
      if (!next.scene.present.includes(event.npcId)) throw new Error(`장면에 없음: ${event.npcId}`);
      perceive(next, event.npcId);
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
      {
        const c = next.characters[event.npcId];
        if (c?.extra) c.extra.lastSeenAt = state.time;
      }
      break;
    case "belief_added":
      mustGet(next.characters, event.characterId, "캐릭터");
      (next.beliefs[event.characterId] ??= []).push(structuredClone(event.belief));
      next.nextBeliefNo += 1;
      break;
    case "turn_started":
      next.turn = event.turn;
      break;
    case "check_rolled": {
      // 임무를 위한 판정만 임무 진행으로 센다 (거점 안의 사적인 행동이 정찰 조건을 채우지 않게)
      const mission = activeMissionOf(next.missions, event.actorId);
      if (mission && mission.id === event.forMission) mission.requirements.forEach((r, i) => {
        if ("check" in r && r.check === event.move && outcomeAtLeast(event.outcome, r.min_outcome)) {
          mission.progress[i] = 1;
        }
      });
      next.checks[event.checkId] = {
        checkId: event.checkId,
        turn: event.turn,
        actorId: event.actorId,
        move: event.move,
        ...(event.target ? { target: event.target } : {}),
        outcome: event.outcome,
        harmApplied: false,
      };
      next.nextCheckNo += 1;
      break;
    }
    case "harm_applied": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      target.conditions[event.track] = event.to;
      if (event.fatal) target.dead = true;
      next.recovery.lastChangeAt[event.targetId] = state.time;
      mustGet(next.checks, event.checkId, "판정").harmApplied = true;
      break;
    }
    case "time_advanced":
      if (event.from !== state.time) throw new Error(`시간이 어긋납니다: 현재 ${state.time}, 이벤트 ${event.from}`);
      if (event.to <= event.from) throw new Error("시간은 앞으로만 흐릅니다.");
      next.time = event.to;
      {
        const mission = activeMissionOf(next.missions, state.playerId);
        if (mission && mission.id === event.forMission) mission.requirements.forEach((r, i) => {
          if ("activity" in r && r.activity === event.activity && !isRequirementMet(r, mission.progress[i] ?? 0)) {
            mission.progress[i] = (mission.progress[i] ?? 0) + (event.to - event.from);
          }
        });
      }
      break;
    case "missions_offered":
      next.offers = { day: event.day, templateIds: [...event.templateIds] };
      break;
    case "mission_assigned": {
      const m = event.mission;
      mustGet(next.characters, m.assigneeId, "캐릭터");
      if (next.missions[m.id]) throw new Error(`임무 id 중복: ${m.id}`);
      if (activeMissionOf(next.missions, m.assigneeId)) throw new Error("이미 수행 중인 임무가 있습니다.");
      next.missions[m.id] = structuredClone(m);
      next.nextMissionNo += 1;
      // 받은 임무는 그날 후보에서 빠진다 (같은 임무를 하루에 여러 번 받지 않게)
      if (next.offers) next.offers.templateIds = next.offers.templateIds.filter((id) => id !== m.templateId);
      break;
    }
    case "mission_reported":
    case "mission_abandoned":
    case "mission_expired": {
      const mission = mustGet(next.missions, event.missionId, "임무");
      if (mission.status !== "active") throw new Error(`이미 끝난 임무: ${mission.id}`);
      const assignee = mustGet(next.characters, mission.assigneeId, "캐릭터");
      assignee.merit += event.merit;
      if (event.type === "mission_reported") {
        mission.status = event.outcome === "success" ? "completed" : event.outcome;
      } else {
        mission.status = event.type === "mission_abandoned" ? "abandoned" : "expired";
        if (event.disobedience) assignee.disobedience += 1;
      }
      break;
    }
    case "deed_recorded": {
      const deed = event.deed;
      mustGet(next.characters, deed.actorId, "캐릭터");
      if (next.deeds[deed.id]) throw new Error(`행적 id 중복: ${deed.id}`);
      next.deeds[deed.id] = structuredClone(deed);
      next.nextDeedNo += 1;
      break;
    }
    case "deed_learned": {
      const deed = mustGet(next.deeds, event.deedId, "행적");
      mustGet(next.characters, event.npcId, "캐릭터");
      const known = (next.deedKnowledge[event.npcId] ??= {});
      if (known[deed.id]) throw new Error(`이미 아는 행적: ${event.npcId} ${deed.id}`);
      known[deed.id] = event.source;
      const toward = (next.relations[event.npcId] ??= {});
      toward[deed.actorId] = applyRelationDelta(toward[deed.actorId] ?? NEUTRAL_RELATION, event.delta);
      if (next.scene.present.includes(event.npcId)) perceive(next, event.npcId);
      break;
    }
    case "witnesses_searched":
      mustGet(next.deeds, event.deedId, "행적").searched = true;
      break;
    case "rumors_spread":
      next.lastSpreadDay = event.day;
      break;
    case "factions_initialized":
      if (Object.keys(state.factions).length) throw new Error("세력이 이미 정해졌습니다.");
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      next.clocks = structuredClone(event.clocks);
      next.lastWarDay = event.day;
      break;
    case "war_day_simulated":
      if (state.lastWarDay !== null && event.day <= state.lastWarDay) throw new Error(`이미 지난 날: ${event.day}일차`);
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      for (const [id, clock] of Object.entries(event.clocks)) mustGet(next.clocks, id, "세력 클락").filled = clock.filled;
      next.lastWarDay = event.day;
      next.pendingClashes.push(...structuredClone(event.scheduled));
      rememberClashes(next, event.clashes, state.time);
      next.nextBattleNo += event.scheduled.length;
      break;
    case "weather_set":
      next.weather = { day: event.day, id: event.weatherId };
      break;
    case "zone_moved":
      if (state.battle) throw new Error("전투 중에는 구역을 옮길 수 없습니다.");
      // 장면의 인물은 따라오지 않는다 (같이 가려면 도착한 뒤 다시 등장시킨다). 처음 자리를 정할 때(from 없음)는 그대로
      if (event.from !== null) {
        for (const id of next.scene.present) {
          perceive(next, id);
          const c = next.characters[id];
          if (c?.extra) c.extra.lastSeenAt = state.time;
        }
        // 동행은 따라온다 (살아 있고 붙잡히지 않았을 때)
        next.scene.present = next.companions.filter((id) => {
          const c = next.characters[id];
          return c && !c.dead && !c.away && !c.captive;
        });
      }
      next.playerZone = event.to;
      break;
    case "condition_changed": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      if (target.dead) throw new Error("사망한 캐릭터의 상태는 바뀌지 않습니다.");
      target.conditions[event.track] = event.to;
      if (event.fatal) target.dead = true;
      if (event.harmTrack) next.recovery.lastChangeAt[event.targetId] = state.time;
      if (event.by === "healer") next.recovery.lastHealerDay[event.targetId] = event.day;
      break;
    }
    case "harm_healed": {
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      if (target.dead) throw new Error("사망한 캐릭터는 낫지 않습니다.");
      target.conditions[event.track] = event.to;
      next.recovery.lastChangeAt[event.targetId] = state.time;
      if (event.by === "healer") next.recovery.lastHealerDay[event.targetId] = event.day;
      break;
    }
    case "character_died":
      if (event.record.characterId !== state.playerId) throw new Error("현재 캐릭터의 기록이 아닙니다.");
      if (!state.characters[state.playerId]?.dead) throw new Error("캐릭터가 아직 살아 있습니다.");
      next.chronicle.push(structuredClone(event.record));
      break;
    case "epitaph_written": {
      const record = next.chronicle[event.index];
      if (!record) throw new Error(`없는 연대기: ${event.index}`);
      record.epitaph = event.text;
      break;
    }
    case "character_switched": {
      if (!state.characters[state.playerId]?.dead) throw new Error("살아 있는 캐릭터는 바꿀 수 없습니다.");
      if (event.character) {
        if (next.characters[event.character.id]) throw new Error(`캐릭터 id 중복: ${event.character.id}`);
        next.characters[event.character.id] = structuredClone(event.character);
      }
      const successor = mustGet(next.characters, event.characterId, "캐릭터");
      if (successor.dead) throw new Error(`사망한 인물: ${successor.id}`);
      next.playerId = successor.id;
      next.runStartedAt = state.time;
      if (event.roleId) {
        next.roleId = event.roleId;
        next.customRole = null;
      }
      // 이어받는 인물이 원래 알던 사람은 그대로 알고, 같은 무리 동료와는 서로 이름을 안다
      for (const id of event.known) {
        acquaint(next, successor.id, id, true);
        acquaint(next, id, successor.id, true);
      }
      // 장면과 플레이어 기준 상태를 새로 시작한다 (새 캐릭터는 다른 곳에서 하루를 시작한다)
      next.scene.present = [];
      next.perceived = {};
      // 동행은 죽은 사람을 따라다녔다. 다음 캐릭터는 새로 사귄다 (기획서 7.8)
      next.companions = [];
      next.bonds = {};
      next.squadOrders = {};
      next.squadReports = {};
      next.council = {};
      next.offers = null;
      next.playerZone = null;
      next.battle = null;
      next.activeStorylet = null;
      break;
    }
    case "storylet_fired": {
      if (state.activeStorylet) throw new Error("이미 진행 중인 스토리렛이 있습니다.");
      next.activeStorylet = { id: event.storyletId, cast: { ...event.cast }, firedAt: state.time, expiresAt: event.expiresAt };
      const log = (next.storyletLog[event.storyletId] ??= { fired: 0, lastFiredAt: state.time });
      log.fired += 1;
      log.lastFiredAt = state.time;
      next.lastStoryletAt = state.time;
      break;
    }
    case "storylet_resolved":
    case "storylet_expired":
      if (state.activeStorylet?.id !== event.storyletId) throw new Error(`진행 중인 스토리렛이 아닙니다: ${event.storyletId}`);
      next.activeStorylet = null;
      break;
    case "flag_set": {
      const flags = (next.flags[event.characterId] ??= []);
      if (!flags.includes(event.flag)) flags.push(event.flag);
      break;
    }
    case "flag_cleared":
      next.flags[event.characterId] = (next.flags[event.characterId] ?? []).filter((f) => f !== event.flag);
      break;
    case "relation_changed": {
      mustGet(next.characters, event.from, "캐릭터");
      const toward = (next.relations[event.from] ??= {});
      toward[event.to] = applyRelationDelta(toward[event.to] ?? NEUTRAL_RELATION, event.delta);
      if (event.to === state.playerId && next.scene.present.includes(event.from)) perceive(next, event.from);
      break;
    }
    case "merit_awarded":
      mustGet(next.characters, event.characterId, "캐릭터").merit += event.delta;
      break;
    case "xp_gained": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      c.xp += event.amount;
      if (event.level > c.level) {
        c.skillPoints += event.level - c.level;
        c.level = event.level;
      }
      if (event.source === "check") {
        const day = dayOf(state.time);
        next.xpToday = { day, amount: (state.xpToday.day === day ? state.xpToday.amount : 0) + event.amount };
      }
      break;
    }
    case "cheat_used":
      next.cheated = true;
      break;
    case "character_patched": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (event.stats) Object.assign(c.stats, event.stats);
      if (event.skills) Object.assign(c.skills, event.skills);
      if (event.traits) c.traits = [...event.traits];
      break;
    }
    case "faction_patched": {
      const f = mustGet(next.factions, event.factionId, "세력");
      Object.assign(f.resources, event.resources);
      break;
    }
    case "extra_spawned": {
      const c = event.character;
      if (next.characters[c.id]) throw new Error(`캐릭터 id 중복: ${c.id}`);
      if (!c.extra) throw new Error("엑스트라 정보가 없습니다.");
      next.characters[c.id] = structuredClone(c);
      next.nextExtraNo += 1;
      next.scene.present.push(c.id);
      perceive(next, c.id);
      acquaint(next, state.playerId, c.id, false);
      acquaint(next, c.id, state.playerId, false);
      break;
    }
    case "name_learned": {
      mustGet(next.characters, event.characterId, "캐릭터");
      mustGet(next.characters, event.targetId, "캐릭터");
      if (event.characterId === event.targetId) throw new Error("자기 이름은 이미 안다.");
      if (next.known[event.characterId]?.includes(event.targetId)) throw new Error(`이미 이름을 안다: ${event.characterId} → ${event.targetId}`);
      acquaint(next, event.characterId, event.targetId, true);
      break;
    }
    case "skill_learned": {
      const c = mustGet(next.characters, event.characterId, "캐릭터");
      if (c.skillPoints < 1) throw new Error("올릴 수 있는 레벨업이 없습니다.");
      if ((c.skills[event.skill] ?? event.from) !== event.from) throw new Error(`스킬 값이 어긋납니다: ${event.skill}`);
      c.skillPoints -= 1;
      c.skills[event.skill] = event.to;
      break;
    }
    case "item_granted": {
      const inv = holderInventory(next, event.to);
      inv[event.itemId] = (inv[event.itemId] ?? 0) + event.quantity;
      break;
    }
    case "clock_adjusted": {
      const clock = mustGet(next.clocks, event.clockId, "세력 클락");
      // 다 차서 이미 일어난 일(태도가 바뀐 shift 클락)은 되돌리지 않는다
      if (clock.filled >= clock.max) break;
      clock.filled = Math.max(0, Math.min(clock.max - 1, clock.filled + event.delta));
      break;
    }
    case "faction_morale_changed": {
      const f = mustGet(next.factions, event.factionId, "세력");
      f.morale = Math.max(-3, Math.min(3, f.morale + event.delta));
      break;
    }
    case "preparation_set":
      (next.preparations[event.zone] ??= []).push(event.preparation);
      break;
    case "item_consumed": {
      const inv = holderInventory(next, event.holder);
      const left = (inv[event.itemId] ?? 0) - event.quantity;
      if (left < 0) throw new Error(`수량 부족: ${event.holder}의 ${event.itemId}`);
      if (left === 0) delete inv[event.itemId];
      else inv[event.itemId] = left;
      break;
    }
    case "clash_resolved":
      next.pendingClashes = next.pendingClashes.filter((p) => p.id !== event.pendingId);
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      rememberClashes(next, [event.clash], state.time);
      break;
    case "battle_started":
      if (state.battle) throw new Error("이미 전투 중입니다.");
      next.pendingClashes = next.pendingClashes.filter((p) => p.id !== event.pendingId);
      next.battle = structuredClone(event.battle);
      break;
    case "battle_round": {
      const b = next.battle;
      if (!b) throw new Error("진행 중인 전투가 없습니다.");
      b.round += 1;
      b.momentum = event.momentum;
      b.alarm = event.alarm;
      b.position = event.position;
      b.objectives = [...event.objectives];
      b.ours.losses = event.ourLosses;
      b.theirs.losses = event.theirLosses;
      b.contribution = event.contribution;
      if (event.preparationUsed) {
        const list = next.preparations[b.zone] ?? [];
        const i = list.indexOf(event.preparationUsed);
        if (i < 0) throw new Error(`설치된 준비물이 없습니다: ${event.preparationUsed}`);
        list.splice(i, 1);
      }
      break;
    }
    case "battle_ended": {
      if (!state.battle) throw new Error("진행 중인 전투가 없습니다.");
      next.battle = null;
      next.factions = structuredClone(event.factions);
      next.zones = structuredClone(event.zones);
      mustGet(next.characters, state.playerId, "캐릭터").merit += event.merit;
      rememberClashes(next, [event.clash], state.time);
      break;
    }
    case "secret_revealed":
      mustGet(next.characters, event.npcId, "캐릭터");
      if (next.revealedSecrets.includes(event.npcId)) throw new Error(`이미 공개된 비밀: ${event.npcId}`);
      next.revealedSecrets.push(event.npcId);
      break;
    case "promoted": {
      const character = mustGet(next.characters, event.characterId, "캐릭터");
      if (character.rank !== event.from) throw new Error(`등급이 어긋납니다: ${character.rank} ≠ ${event.from}`);
      character.rank = event.to;
      break;
    }
    case "item_transferred": {
      const from = holderInventory(next, event.from);
      const to = holderInventory(next, event.to);
      const remaining = (from[event.itemId] ?? 0) - event.quantity;
      if (remaining < 0) throw new Error(`수량 부족: ${event.from}의 ${event.itemId}`);
      if (remaining === 0) delete from[event.itemId];
      else from[event.itemId] = remaining;
      to[event.itemId] = (to[event.itemId] ?? 0) + event.quantity;
      break;
    }
  }
  return next;
}

/** 플레이어가 지금 이 NPC의 태도를 느낀다 (같은 장면에 있을 때) */
/** a가 b를 만났다(얼굴을 안다). withName이면 이름까지 안다 (기획서 6.3) */
function acquaint(state: GameState, a: string, b: string, withName: boolean) {
  if (a === b) return;
  const met = (state.met[a] ??= []);
  if (!met.includes(b)) met.push(b);
  if (!withName) return;
  const known = (state.known[a] ??= []);
  if (!known.includes(b)) known.push(b);
}

function perceive(state: GameState, npcId: string) {
  state.perceived[npcId] = { ...(state.relations[npcId]?.[state.playerId] ?? NEUTRAL_RELATION) };
}

/** 보관 위치의 인벤토리. 없으면 undefined */
export function findHolderInventory(state: GameState, holder: string): Inventory | undefined {
  if (holder === SCENE_HOLDER) return state.scene.items;
  return state.characters[holder]?.inventory;
}

function holderInventory(state: GameState, holder: string): Inventory {
  const inventory = findHolderInventory(state, holder);
  if (!inventory) throw new Error(`알 수 없는 보관 위치: ${holder}`);
  return inventory;
}

function mustGet<T>(record: Record<string, T>, key: string, label: string): T {
  const value = record[key];
  if (!value) throw new Error(`알 수 없는 ${label}: ${key}`);
  return value;
}

function toInventory(itemIds: readonly string[]): Inventory {
  const inventory: Inventory = {};
  for (const itemId of itemIds) inventory[itemId] = (inventory[itemId] ?? 0) + 1;
  return inventory;
}

/** 역할 콘텐츠로 시작 캐릭터를 만든다 (기획서 3.4: 역할 = 초기값 묶음) */
/**
 * 새 캐릭터의 능력: 역할에 정해져 있으면 그것, 아니면 시나리오의 능력 배열을 섞어서 (능력은 계급과 무관, 기획서 4.2).
 * rng가 없으면 섞지 않는다 (테스트·결정적 생성)
 */
export function rollAbilities(s: Scenario, rng?: Rng): Record<string, number> {
  const array = [...(s.ability_array ?? s.stats.map(() => 0))];
  if (rng) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
  }
  return Object.fromEntries(s.stats.map((x, i) => [x.id, array[i] ?? 0]));
}

/** 플레이어가 캐릭터 생성에서 고른 것 (검증은 creation.ts의 checkCharacterChoice) */
export type CharacterChoice = {
  name: string;
  gender: string | null;
  abilities: Record<string, number> | null;
  portrait: string | null;
  /** 트레잇 id. null이면 무작위 (MCP의 "알아서"), 없으면 빈 목록 */
  traits?: string[] | null;
};

export function createCharacterFromRole(s: Scenario, role: RoleContent, id = "player", rng?: Rng, choice?: CharacterChoice): Character {
  return createCharacterSchema(s).parse({
    id,
    name: choice?.name.trim() || role.default_name,
    gender: choice?.gender ?? null,
    traits: choice?.traits ?? [],
    portrait: choice?.portrait ?? null,
    factionId: role.faction,
    rank: role.rank,
    age: role.age,
    stats: choice?.abilities ?? role.start_stats ?? rollAbilities(s, rng),
    skills: role.start_skills,
    conditions: initialConditions(s),
    inventory: toInventory(role.start_inventory),
    debts: { ...(role.start_debt ?? {}) },
  });
}

/** NPC 프로필로 캐릭터를 만든다. 플레이어와 같은 스키마다 (CLAUDE.md 원칙 6) */
export function createCharacterFromNpc(s: Scenario, npc: NpcContent): Character {
  return createCharacterSchema(s).parse({
    id: npc.id,
    name: npc.name,
    factionId: npc.faction ?? "",
    rank: npc.rank,
    age: npc.age,
    stats: npc.stats,
    skills: npc.skills,
    gender: npc.gender ?? null,
    traits: npc.traits,
    conditions: initialConditions(s),
    inventory: toInventory(npc.start_inventory),
    captive: npc.start_captive ?? null,
  });
}

/**
 * 새 세계를 여는 첫 이벤트. 시작 캐릭터, 모든 NPC, 시작 지식을 담는다.
 * customRole을 주면 콘텐츠의 역할 대신 그것으로 시작한다 (자유 시나리오, roleId는 CUSTOM_ROLE_ID)
 */
export function createWorldEvent(content: Content, roleId: string, worldId: string, rng?: Rng, choice?: CharacterChoice, customRole?: RoleContent, background?: string[]): GameEvent {
  const role = customRole ?? content.roles[roleId];
  if (!role) throw new Error(`알 수 없는 역할: ${roleId}`);
  const player = createCharacterFromRole(content.scenario, role, "player", rng, choice);
  const npcs = Object.values(content.npcs).map((npc) => createCharacterFromNpc(content.scenario, npc));

  let no = 0;
  const belief = (fact: string, source: Belief["source"], accuracy: Belief["accuracy"]): Belief => ({
    id: `b_${++no}`,
    fact,
    source,
    accuracy,
    learnedAt: START_TIME,
  });
  const beliefs: Record<string, Belief[]> = {};
  const preset = role.beliefs_preset ? content.beliefs[role.beliefs_preset] : undefined;
  beliefs[player.id] = (preset?.beliefs ?? []).map((b) => belief(b.fact, b.source, b.accuracy));
  // 자유 시나리오에서 플레이어가 쓴 지난 삶: 캐릭터 자신의 기억이다 (세계의 사실로 확정되지 않는다)
  for (const fact of background ?? []) beliefs[player.id]!.push(belief(fact, "seen", "approximate"));
  for (const npc of Object.values(content.npcs)) {
    beliefs[npc.id] = npc.knows.map((fact) => belief(fact, "seen", "exact"));
  }

  return {
    type: "world_created",
    scenarioId: content.scenario.id,
    worldId,
    roleId: customRole ? CUSTOM_ROLE_ID : roleId,
    customRole: customRole ?? null,
    player,
    npcs,
    beliefs,
    known: { [player.id]: [...role.known_npcs] },
  };
}
