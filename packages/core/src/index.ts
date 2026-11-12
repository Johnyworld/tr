export type {
  ChatTurn,
  NarrationEvent,
  NarrationModel,
  NarrationRequest,
  NarrationStopReason,
} from "./gm/types.ts";
export { GM_SYSTEM_PROMPT } from "./gm/prompt.ts";
export { OPENING_SCENE } from "./gm/scene.ts";
export {
  narrate,
  buildNarrationRequest,
  normalizePlayerInput,
  InvalidPlayerInputError,
  MAX_INPUT_LENGTH,
  MAX_HISTORY_TURNS,
} from "./gm/narrate.ts";
export { createClaudeNarrationModel, DEFAULT_GM_MODEL } from "./gm/claude.ts";
export type { ClaudeNarrationOptions } from "./gm/claude.ts";
