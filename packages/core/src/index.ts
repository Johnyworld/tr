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
export { describeRequirement, describeMission } from "./engine/missionTools.ts";

export * from "./content/schemas.ts";
export { loadContent, ContentError } from "./content/loader.ts";

export { InMemoryRepository, type GameRepository } from "./persistence/repository.ts";
export { SqliteRepository, SaveFormatError, archiveSave } from "./persistence/sqlite.ts";
export { acquireLock, readLock, isProcessAlive, WorldLockedError, type LockInfo } from "./persistence/lock.ts";

export { buildGmGuide } from "./engine/prompt.ts";
export { describePlayerState, buildPlayerPrompt } from "./engine/context.ts";
export {
  executeTool,
  gmToolSpecs,
  gmTools,
  STRICT_UNSUPPORTED_KEYS,
  type ToolContext,
  type ToolDisplayEvent,
  type ToolOutcome,
  type ToolSpec,
} from "./engine/tools.ts";
export {
  takeAction,
  advanceTime,
  harmSteps,
  createTakeActionSchema,
  type TakeActionInput,
  type TakeActionResult,
} from "./engine/action.ts";
export { runAfterTimeAdvance } from "./engine/turnStart.ts";
export { normalizePlayerInput, InvalidPlayerInputError, MAX_INPUT_LENGTH } from "./engine/input.ts";
export type { TranscriptEntry, TurnSummary, SummaryKind, PlayMode } from "./engine/log.ts";

export { GameWorld, RECAP_TURNS } from "./world/world.ts";
export { WorldManager, type WorldInfo } from "./world/manager.ts";
export {
  buildPlayerView,
  buildTranscriptView,
  type PlayerView,
  type TranscriptView,
} from "./views/player.ts";

export {
  COMMANDS,
  COMMAND_PREFIX,
  JOURNAL_RECENT,
  isCommand,
  runCommand,
  type CommandContext,
  type CommandDef,
} from "./commands/commands.ts";
export { gauge, gaugeLine, GAUGE_EMPTY, GAUGE_FULL } from "./commands/format.ts";
