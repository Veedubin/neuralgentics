/**
 * Boomerang SDK — Main Exports
 *
 * Public API surface for @neuralgentics/sdk.
 */

// Client
export { BoomerangClient, createClient } from './client.js';

// Types
export type {
  AgentConfig,
  AgentMode,
  PermissionMap,
  PlanTask,
  TaskPlan,
  ContextPackage,
  ScopeBoundaries,
  RetryConfig,
  RetryableErrorType,
  MemoryConfig,
  BoomerangClientConfig,
  CompactionEvent,
  SessionEventType,
  HookDefinitions,
  HookHandler,
  SdkResult,
  SdkSuccess,
  SdkFailure,
  // Re-exported orchestrator types
  TaskType,
  AgentRole,
  Task as Task,
  ContextPackage as OrchestratorContextPackage,
  ProtocolStep,
  TrustSignal,
  MemorySourceType,
  RelationshipType,
} from './types.js';

// Adapters
export { MemoryAdapter } from './adapters/memory.js';
export type { Memory, Relationship } from './adapters/memory.js';
export {
  getAgentConfig,
  checkRouting,
  buildTaskPlan,
  getAllAgentConfigs,
  getRoutingMatrix,
  resolveAgent,
  validateRouting,
  getRoutingRule,
} from './adapters/routing.js';
export { HooksAdapter } from './adapters/hooks.js';
export type { ToolDefinition, HooksAdapterConfig } from './adapters/hooks.js';

// Utilities
export {
  withRetry,
  sleep,
  classifyError,
  isRetryable,
  calculateBackoff,
  generateId,
  ok,
  fail,
  tryOperation,
  mapToRecord,
  recordToMap,
  DEFAULT_RETRY_CONFIG,
} from './utils.js';