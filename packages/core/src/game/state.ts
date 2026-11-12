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
 */
export const SAVE_SCHEMA_VERSION = 5;
/** 이 버전부터의 세이브는 이벤트를 스키마 기본값으로 올려 읽는다 (1은 시나리오 팩 분리 전이라 읽지 않는다) */
export const MIN_READABLE_SAVE_VERSION = 2;

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

/** 세력의 지금 상태 (기획서 9.1). 진짜 값이므로 UI·프롬프트에는 정보 필터를 거쳐 대략만 보낸다 */
export const factionStateSchema = z.strictObject({
  population: z.number().int().min(0),
  combatants: z.number().int().min(0),
  resources: z.record(z.string(), z.number().int().min(0)),
  morale: z.number().int().min(-3).max(3),
  cohesion: z.number().int().min(-3).max(3),
});
export type FactionState = z.infer<typeof factionStateSchema>;

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
    /** 오늘 판정으로 얻은 경험치 (하루 상한, 기획서 4.2) */
    xpToday: z.strictObject({ day: z.number().int(), amount: z.number().int() }).default({ day: 0, amount: 0 }),
    /** 캐릭터별 Belief State */
    beliefs: z.record(z.string(), z.array(beliefSchema)),
    /** 캐릭터별로 알고 있는 인물 id */
    known: z.record(z.string(), z.array(z.string())),
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
      player: character,
      npcs: z.array(character),
      beliefs: z.record(z.string(), z.array(beliefSchema)),
      known: z.record(z.string(), z.array(z.string())),
    }),
    z.strictObject({ type: z.literal("npc_entered"), npcId: z.string() }),
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
    z.strictObject({ type: z.literal("mission_abandoned"), missionId: z.string(), merit: z.number().int(), reason: z.string() }),
    z.strictObject({ type: z.literal("mission_expired"), missionId: z.string(), merit: z.number().int() }),
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
      source: z.enum(["check", "merit"]),
      level: z.number().int().nonnegative(),
    }),
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
  turn: 0,
  time: START_TIME,
  playerId: "",
  characters: {},
  scene: { items: {}, present: [] },
  checks: {},
  nextCheckNo: 1,
  xpToday: { day: 0, amount: 0 },
  beliefs: {},
  known: {},
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
      return {
        ...EMPTY_STATE,
        scenarioId: event.scenarioId,
        worldId: event.worldId,
        roleId: event.roleId,
        playerId: event.player.id,
        characters,
        beliefs: structuredClone(event.beliefs),
        known: structuredClone(event.known),
        nextBeliefNo: beliefCount + 1,
      };
    }
    case "npc_entered": {
      const npc = mustGet(next.characters, event.npcId, "캐릭터");
      if (npc.id === state.playerId) throw new Error("플레이어는 NPC로 등장할 수 없습니다.");
      if (npc.dead) throw new Error(`사망한 인물: ${npc.id}`);
      if (next.scene.present.includes(npc.id)) throw new Error(`이미 장면에 있음: ${npc.id}`);
      next.scene.present.push(npc.id);
      perceive(next, npc.id);
      // 만난 인물은 알게 된다
      const known = (next.known[state.playerId] ??= []);
      if (!known.includes(npc.id)) known.push(npc.id);
      break;
    }
    case "npc_left":
      if (!next.scene.present.includes(event.npcId)) throw new Error(`장면에 없음: ${event.npcId}`);
      perceive(next, event.npcId);
      next.scene.present = next.scene.present.filter((id) => id !== event.npcId);
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
        assignee.disobedience += 1;
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
        for (const id of next.scene.present) perceive(next, id);
        next.scene.present = [];
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
      next.known[successor.id] = [...event.known];
      // 장면과 플레이어 기준 상태를 새로 시작한다 (새 캐릭터는 다른 곳에서 하루를 시작한다)
      next.scene.present = [];
      next.perceived = {};
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
  });
}

/** NPC 프로필로 캐릭터를 만든다. 플레이어와 같은 스키마다 (CLAUDE.md 원칙 6) */
export function createCharacterFromNpc(s: Scenario, npc: NpcContent): Character {
  return createCharacterSchema(s).parse({
    id: npc.id,
    name: npc.name,
    factionId: npc.faction,
    rank: npc.rank,
    age: npc.age,
    stats: npc.stats,
    skills: npc.skills,
    gender: npc.gender ?? null,
    traits: npc.traits,
    conditions: initialConditions(s),
    inventory: toInventory(npc.start_inventory),
  });
}

/** 새 세계를 여는 첫 이벤트. 시작 캐릭터, 모든 NPC, 시작 지식을 담는다 */
export function createWorldEvent(content: Content, roleId: string, worldId: string, rng?: Rng, choice?: CharacterChoice): GameEvent {
  const role = content.roles[roleId];
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
  for (const npc of Object.values(content.npcs)) {
    beliefs[npc.id] = npc.knows.map((fact) => belief(fact, "seen", "exact"));
  }

  return {
    type: "world_created",
    scenarioId: content.scenario.id,
    worldId,
    roleId,
    player,
    npcs,
    beliefs,
    known: { [player.id]: [...role.known_npcs] },
  };
}
