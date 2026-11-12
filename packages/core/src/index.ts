export { createSeededRng, rollDie, type Rng } from "./rng.ts";

export * from "./rules/stats.ts";
export * from "./rules/moves.ts";
export * from "./rules/injury.ts";
export * from "./rules/check.ts";

export { characterSchema, inventorySchema, type Character, type Inventory } from "./game/character.ts";
export { TEMP_ITEMS, itemDefSchema, type ItemDef } from "./game/items.ts";
export {
  applyEvent,
  createInitialState,
  createStartingPlayer,
  SCENE_HOLDER,
  type CheckRecord,
  type GameEvent,
  type GameState,
} from "./game/state.ts";
export { InMemoryGameStore, type GameStore } from "./game/store.ts";

export { GM_SYSTEM_PROMPT } from "./gm/prompt.ts";
export { OPENING_SCENE } from "./gm/scene.ts";
export { describePlayerState, buildPlayerPrompt } from "./gm/context.ts";
export { executeTool, GM_TOOL_SPECS, harmSteps, type ToolDisplayEvent, type ToolOutcome } from "./gm/tools.ts";
export {
  runTurn,
  buildHistoryMessages,
  normalizePlayerInput,
  isPlayerDead,
  InvalidPlayerInputError,
  MAX_INPUT_LENGTH,
  MAX_HISTORY_TURNS,
  MAX_TOOL_ROUNDS,
  type TranscriptEntry,
  type TurnEvent,
  type TurnStopReason,
  type RunTurnOptions,
} from "./gm/turn.ts";
export type {
  LanguageModel,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ToolSpec,
} from "./gm/model.ts";
export { createClaudeModel, DEFAULT_GM_MODEL, ModelError, type ClaudeModelOptions } from "./gm/claude.ts";
