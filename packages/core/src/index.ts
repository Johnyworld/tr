export { createSeededRng, rollDie, type Rng } from "./rng.ts";

export * from "./rules/stats.ts";
export * from "./rules/moves.ts";
export * from "./rules/injury.ts";
export * from "./rules/check.ts";
export * from "./rules/time.ts";
export {
  fastForward,
  disturbanceCheck,
  DEFAULT_INTERRUPT_CHECKS,
  DISTURBANCE_CHANCE_PER_HOUR,
  type Interrupt,
  type InterruptCheck,
  type FastForwardResult,
} from "./sim/fastForward.ts";

export { characterSchema, inventorySchema, type Character, type Inventory } from "./game/character.ts";
export * from "./game/belief.ts";
export * from "./rules/ranks.ts";
export {
  applyEvent,
  createCharacterFromRole,
  createCharacterFromNpc,
  createWorldEvent,
  EMPTY_STATE,
  gameEventSchema,
  gameStateSchema,
  SAVE_SCHEMA_VERSION,
  SCENE_HOLDER,
  type CheckRecord,
  type GameEvent,
  type GameState,
} from "./game/state.ts";
export { InMemoryGameStore, type GameStore } from "./game/store.ts";
export * from "./game/missions.ts";
export * from "./game/reputation.ts";
export { describeRequirement, describeMission } from "./gm/missionTools.ts";

export * from "./content/schemas.ts";
export { loadContent, ContentError } from "./content/loader.ts";

export { InMemoryRepository, type GameRepository } from "./persistence/repository.ts";
export { SqliteRepository, SaveFormatError, archiveSave } from "./persistence/sqlite.ts";

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
