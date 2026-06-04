/**
 * Session Module — Public API (T-027)
 *
 * Re-exports the SessionManager class, types, and reseeder stub.
 */

export { SessionManager } from "./session-manager.js";
export type {
  SessionManagerStatus,
  SessionManagerOptions,
  ContextPackage,
  ContextStoreResult,
  SeedPrompt,
  RevertResult,
  PromptOptions,
  SessionManagerEvents,
} from "./types.js";
export {
  generateReseed,
  isReseedNeeded,
} from "./reseeder.js";
export type {
  ReseedPart,
  ReseedSection,
  ReseedResult,
} from "./reseeder.js";