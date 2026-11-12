import { z } from "zod";
import { CHECK_OUTCOMES, difficultySchema } from "../rules/check.ts";
import { harmSeveritySchema, injuryLevelSchema } from "../rules/injury.ts";
import { moveSchema } from "../rules/moves.ts";
import { statSchema } from "../rules/stats.ts";
import type { RoleContent } from "../content/schemas.ts";
import { characterSchema, inventorySchema, type Character, type Inventory } from "./character.ts";

/**
 * 세이브 형식 버전. GameState나 GameEvent의 형태를 바꾸면 올리고,
 * 이전 세이브를 옮기는 방법을 함께 만든다.
 */
export const SAVE_SCHEMA_VERSION = 1;

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

const checkOutcomeSchema = z.enum(CHECK_OUTCOMES);

export const checkRecordSchema = z.strictObject({
  checkId: z.string(),
  turn: z.number().int(),
  actorId: z.string(),
  outcome: checkOutcomeSchema,
  /** 이 판정의 대가로 이미 피해를 적용했는지 */
  harmApplied: z.boolean(),
});
export type CheckRecord = z.infer<typeof checkRecordSchema>;

/**
 * 세계의 진짜 상태 (World State). 콘텐츠(아이템 정의 등)는 넣지 않고 id로만 참조한다.
 */
export const gameStateSchema = z.strictObject({
  worldId: z.string(),
  roleId: z.string(),
  turn: z.number().int().nonnegative(),
  playerId: z.string(),
  characters: z.record(z.string(), characterSchema),
  scene: z.strictObject({ items: inventorySchema }),
  checks: z.record(z.string(), checkRecordSchema),
  nextCheckNo: z.number().int().positive(),
});
export type GameState = z.infer<typeof gameStateSchema>;

/** 세계가 만들어지기 전의 빈 상태. 첫 이벤트는 반드시 world_created다 */
export const EMPTY_STATE: GameState = {
  worldId: "",
  roleId: "",
  turn: 0,
  playerId: "",
  characters: {},
  scene: { items: {} },
  checks: {},
  nextCheckNo: 1,
};

/**
 * 상태 변경은 반드시 이벤트로 기록한다 (append-only).
 * 상태는 이벤트를 차례로 적용한 결과다. 세이브에서 읽을 때도 이 스키마로 검증한다.
 */
export const gameEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("world_created"),
    worldId: z.string().min(1),
    roleId: z.string().min(1),
    player: characterSchema,
  }),
  z.strictObject({ type: z.literal("turn_started"), turn: z.number().int().positive(), input: z.string() }),
  z.strictObject({
    type: z.literal("check_rolled"),
    checkId: z.string(),
    turn: z.number().int(),
    actorId: z.string(),
    move: moveSchema,
    stat: statSchema,
    difficulty: difficultySchema,
    intent: z.string(),
    dice: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]),
    modifiers: z.strictObject({ stat: z.number().int(), difficulty: z.number().int(), injury: z.number().int() }),
    total: z.number().int(),
    outcome: checkOutcomeSchema,
  }),
  z.strictObject({
    type: z.literal("harm_applied"),
    targetId: z.string(),
    checkId: z.string(),
    severity: harmSeveritySchema,
    steps: z.number().int().positive(),
    from: injuryLevelSchema,
    to: injuryLevelSchema,
    cause: z.string(),
  }),
  z.strictObject({
    type: z.literal("item_transferred"),
    from: z.string(),
    to: z.string(),
    itemId: z.string(),
    quantity: z.number().int().positive(),
  }),
]);
export type GameEvent = z.infer<typeof gameEventSchema>;

export function applyEvent(state: GameState, event: GameEvent): GameState {
  if (event.type !== "world_created" && !state.worldId) {
    throw new Error(`세계가 만들어지기 전에 ${event.type} 이벤트를 적용할 수 없습니다.`);
  }
  const next = structuredClone(state);
  switch (event.type) {
    case "world_created":
      if (state.worldId) throw new Error("세계가 이미 만들어졌습니다.");
      return {
        ...EMPTY_STATE,
        worldId: event.worldId,
        roleId: event.roleId,
        playerId: event.player.id,
        characters: { [event.player.id]: structuredClone(event.player) },
      };
    case "turn_started":
      next.turn = event.turn;
      break;
    case "check_rolled":
      next.checks[event.checkId] = {
        checkId: event.checkId,
        turn: event.turn,
        actorId: event.actorId,
        outcome: event.outcome,
        harmApplied: false,
      };
      next.nextCheckNo += 1;
      break;
    case "harm_applied": {
      mustGet(next.characters, event.targetId, "캐릭터").injury = event.to;
      mustGet(next.checks, event.checkId, "판정").harmApplied = true;
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

/** 역할 콘텐츠로 시작 캐릭터를 만든다 (기획서 3.4: 역할 = 초기값 묶음) */
export function createCharacterFromRole(role: RoleContent, id = "player"): Character {
  const inventory: Inventory = {};
  for (const itemId of role.start_inventory) inventory[itemId] = (inventory[itemId] ?? 0) + 1;
  return characterSchema.parse({
    id,
    name: role.default_name,
    factionId: role.faction,
    rank: role.rank,
    stats: role.start_stats,
    injury: "none",
    inventory,
  });
}

/** 새 세계를 여는 첫 이벤트 */
export function createWorldEvent(role: RoleContent, worldId: string): GameEvent {
  return { type: "world_created", worldId, roleId: role.id, player: createCharacterFromRole(role) };
}
