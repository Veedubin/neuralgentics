/**
 * OpenCode SDK Client — public API (T-023).
 *
 * Re-exports the client class, error types, and TypeScript interfaces.
 */

export { OpenCodeClient } from "./client.js";
export type { ClientStatus } from "./client.js";
export type {
  OpenCodeStatus,
  ChatMessage,
  StreamingCallbacks,
  OpenCodeClientEvents,
  OpenCodeClientOptions,
  PromptResult,
} from "./types.js";
export { PortConflictError, OpenCodeStartError } from "./types.js";