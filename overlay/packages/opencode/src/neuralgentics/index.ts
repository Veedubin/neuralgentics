/**
 * Neuralgentics overlay — public API surface.
 *
 * Re-exports every module so consumers can import from a single entry point:
 *
 * ```ts
 * import { NeuralgenticsOrchestrator, GoBackendClient, ROUTING_MATRIX } from "./neuralgentics";
 * ```
 */

export { NeuralgenticsOrchestrator } from "./orchestrator.js";
export { MemoryClient } from "./memory-client.js";
export { GoBackendClient } from "./go-backend-client.js";
export { ROUTING_MATRIX, validateAgentRouting, getPrimaryAgent } from "./routing.js";
export { StatelessProtocol } from "./stateless.js";
export { NeuralgenticsUpdater } from "./updater.js";
export { mergePersonalizations, stripYamlFrontmatter } from "./personalizations.js";
export type { MergeResult } from "./personalizations.js";
export * from "./config.js";
export * from "./model-picker.js";
export * from "./remodel.js";
export type {
  AgentDefinition,
  RoutingRule,
  ContextPackage,
  MemoryRecord,
  ServerCatalogEntry,
  ToolMatch,
} from "./types.js";