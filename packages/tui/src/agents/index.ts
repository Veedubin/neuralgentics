/**
 * @neuralgentics/tui — Agents Module (Public API)
 *
 * Re-exports model registry and parallel dispatcher for use by the TUI.
 */

export {
  getModelForTask,
  loadConfig,
  resetConfig,
  getRegisteredModels,
  validateRegistryModels,
  getModelRegistry,
  getRoutingTable,
  type TaskType,
  type ModelCategory,
  type ModelResolution,
  type ModelEntry,
  type ModelRegistryConfig,
} from "./model-registry.js";

export {
  ParallelDispatcher,
  DependencyGraph,
  ConcurrencyLimiter,
  buildDispatchCards,
  type DispatchCard,
  type DispatchResult,
  type DispatchProgressEvent,
  type DispatchBatchResult,
  type ParallelDispatcherOptions,
} from "./dispatcher.js";