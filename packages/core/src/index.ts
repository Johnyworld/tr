export { createSeededRng, rollDie, type Rng } from "./rng.ts";

export * from "./rules/harm.ts";
export * from "./rules/check.ts";
export * from "./rules/time.ts";
export {
  fastForward,
  createDisturbanceCheck,
  createInterruptChecks,
  type Interrupt,
  type InterruptCheck,
  type FastForwardResult,
} from "./sim/fastForward.ts";

export {
  createCharacterSchema,
  createStatsSchema,
  inventorySchema,
  STAT_MAX,
  STAT_MIN,
  type Character,
  type Inventory,
} from "./game/character.ts";
export * from "./scenario/schema.ts";
export * from "./scenario/scenario.ts";
export * from "./game/belief.ts";
export {
  applyEvent,
  createCharacterFromRole,
  createCharacterFromNpc,
  createWorldEvent,
  EMPTY_STATE,
  createGameSchemas,
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

export { GM_RULES, buildSystemPrompt } from "./gm/prompt.ts";
export { describePlayerState, buildPlayerPrompt } from "./gm/context.ts";
export { executeTool, gmToolSpecs, gmTools, harmSteps, type ToolDisplayEvent, type ToolOutcome } from "./gm/tools.ts";
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
