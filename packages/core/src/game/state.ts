import { z } from "zod";
import { CHECK_OUTCOMES, difficultySchema } from "../rules/check.ts";
import { harmSeveritySchema } from "../rules/harm.ts";
import { activitySchema, START_TIME } from "../rules/time.ts";
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
export const SAVE_SCHEMA_VERSION = 2;

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

/**
 * 세계 상태와 이벤트 스키마. 능력치·행동·등급·상태 트랙 ID는 시나리오에서 오므로
 * 시나리오를 받아 만든다 (기획서 12.3). 세이브를 불러올 때도 이 스키마로 검증한다.
 */
export function createGameSchemas(s: Scenario) {
  const character = createCharacterSchema(s);
  const move = idEnum(moveIds(s));
  const stat = idEnum(statIds(s));
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
      modifiers: z.strictObject({ stat: z.number().int(), difficulty: z.number().int(), condition: z.number().int() }),
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
};

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
export function createCharacterFromRole(s: Scenario, role: RoleContent, id = "player"): Character {
  return createCharacterSchema(s).parse({
    id,
    name: role.default_name,
    factionId: role.faction,
    rank: role.rank,
    age: role.age,
    stats: role.start_stats,
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
    conditions: initialConditions(s),
    inventory: toInventory(npc.start_inventory),
  });
}

/** 새 세계를 여는 첫 이벤트. 시작 캐릭터, 모든 NPC, 시작 지식을 담는다 */
export function createWorldEvent(content: Content, roleId: string, worldId: string): GameEvent {
  const role = content.roles[roleId];
  if (!role) throw new Error(`알 수 없는 역할: ${roleId}`);
  const player = createCharacterFromRole(content.scenario, role);
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
