import type { CheckOutcome, Difficulty } from "../rules/check.ts";
import type { HarmSeverity, InjuryLevel } from "../rules/injury.ts";
import type { Move } from "../rules/moves.ts";
import type { Stat } from "../rules/stats.ts";
import { characterSchema, type Character, type Inventory } from "./character.ts";
import { TEMP_ITEMS, type ItemDef } from "./items.ts";

/** 장면의 물건 보관 위치. 캐릭터 id 또는 "scene"(현재 장면 바닥) */
export const SCENE_HOLDER = "scene";

export type CheckRecord = {
  checkId: string;
  turn: number;
  actorId: string;
  outcome: CheckOutcome;
  /** 이 판정의 대가로 이미 피해를 적용했는지 */
  harmApplied: boolean;
};

export type GameState = {
  turn: number;
  playerId: string;
  characters: Record<string, Character>;
  items: Record<string, ItemDef>;
  scene: { items: Inventory };
  checks: Record<string, CheckRecord>;
  nextCheckNo: number;
};

/**
 * 상태 변경은 반드시 이벤트로 기록한다 (append-only).
 * 상태는 이벤트를 차례로 적용한 결과다.
 */
export type GameEvent =
  | { type: "turn_started"; turn: number; input: string }
  | {
      type: "check_rolled";
      checkId: string;
      turn: number;
      actorId: string;
      move: Move;
      stat: Stat;
      difficulty: Difficulty;
      intent: string;
      dice: [number, number];
      modifiers: { stat: number; difficulty: number; injury: number };
      total: number;
      outcome: CheckOutcome;
    }
  | {
      type: "harm_applied";
      targetId: string;
      checkId: string;
      severity: HarmSeverity;
      steps: number;
      from: InjuryLevel;
      to: InjuryLevel;
      cause: string;
    }
  | { type: "item_transferred"; from: string; to: string; itemId: string; quantity: number };

export function applyEvent(state: GameState, event: GameEvent): GameState {
  const next = structuredClone(state);
  switch (event.type) {
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
      const target = mustGet(next.characters, event.targetId, "캐릭터");
      target.injury = event.to;
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

/**
 * 임시 시작 캐릭터 (기획서 3.4 role_a_grunt 기준).
 * 능력치 분배는 임시값이다 (기획서 18장 미정). 4단계에서 역할 YAML로 옮긴다.
 */
export function createStartingPlayer(): Character {
  return characterSchema.parse({
    id: "player",
    name: "신병",
    factionId: "faction_a",
    rank: "grunt",
    stats: { strength: 1, agility: 2, cool: 0, sense: 1, persuasion: -1 },
    injury: "none",
    inventory: { kitchen_knife: 1, water_bottle: 1 },
  });
}

export function createInitialState(): GameState {
  const player = createStartingPlayer();
  return {
    turn: 0,
    playerId: player.id,
    characters: { [player.id]: player },
    items: Object.fromEntries(TEMP_ITEMS.map((item) => [item.id, item])),
    scene: { items: {} },
    checks: {},
    nextCheckNo: 1,
  };
}
