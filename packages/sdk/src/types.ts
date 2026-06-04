/**
 * Boomerang SDK — Core Type Definitions
 *
 * Extended types for the Neuralgentics SDK wrapper. These types
 * build on @neuralgentics/orchestrator types with SDK-specific
 * abstractions for agent configuration, task planning, permissions,
 * and client configuration.
 */

import type {
  TaskType,
  AgentRole,
  ContextPackage as OrchestratorContextPackage,
  Task as OrchestratorTask,
  ProtocolStep,
  TrustSignal,
  MemorySourceType,
  RelationshipType,
} from '@neuralgentics/orchestrator/types';

// ============================================================================
// Re-exported orchestrator types for convenience
// ============================================================================

export type {
  TaskType,
  AgentRole,
  Task as Task,
  ContextPackage as OrchestratorContextPackage,
  ProtocolStep,
  TrustSignal,
  MemorySourceType,
  RelationshipType,
} from '@neuralgentics/orchestrator/types';

// ============================================================================
// Agent Configuration
// ============================================================================

/** Permission map: tool pattern → allow/deny */
export interface PermissionMap {
  [toolPattern: string]: 'allow' | 'deny';
}

/** Agent execution mode */
export type AgentMode = 'subagent' | 'primary';

/**
 * Full agent configuration as used by the Routing Matrix.
 * Extends the basic AgentRole with model, permissions, and mode info.
 */
export interface AgentConfig {
  /** Unique agent identifier (e.g., "boomerang-coder") */
  id: string;
  /** Display name (e.g., "Boomerang Coder") */
  name: string;
  /** Skill name for the agent */
  skill: string;
  /** Ollama model identifier (e.g., "glm-5.1:cloud") */
  model: string;
  /** Tool-level permissions */
  permissions: PermissionMap;
  /** Execution mode — primary agents run standalone, subagents are delegated */
  mode: AgentMode;
}

// ============================================================================
// Task Planning
// ============================================================================

/** A single task within a plan */
export interface PlanTask {
  id: string;
  type: TaskType;
  description: string;
  /** IDs of tasks that must complete before this one starts */
  dependsOn: string[];
  priority: 'low' | 'medium' | 'high';
  /** Assigned agent role */
  agent: AgentRole;
}

/**
 * Task plan with dependencies and parallel group detection.
 * The SDK client can produce these from raw user requests.
 */
export interface TaskPlan {
  id: string;
  tasks: PlanTask[];
  /** Task dependency graph: taskId → list of taskIds it depends on */
  dependencies: Map<string, string[]>;
  /** Groups of task IDs that can run in parallel */
  parallelGroups: string[][];
}

// ============================================================================
// SDK Context Package
// ============================================================================

/** Scope boundaries for a task */
export interface ScopeBoundaries {
  inScope: string[];
  outOfScope: string[];
}

/**
 * Extended ContextPackage with SDK-level fields.
 * Wraps the orchestrator's ContextPackage with convenience fields
 * for SDK consumers.
 */
export interface ContextPackage {
  /** Original user request verbatim */
  originalRequest: string;
  /** Task background and context */
  background: string;
  /** Files relevant to the task */
  relevantFiles: string[];
  /** Extracted code snippets */
  codeSnippets: string[];
  /** Previous architectural/logical decisions */
  decisions: string[];
  /** Expected output format description */
  outputFormat: string;
  /** Scope boundaries */
  scope: ScopeBoundaries;
  /** Nested orchestrator context package for deep access */
  orchestratorContext?: OrchestratorContextPackage;
}

// ============================================================================
// Client Configuration
// ============================================================================

/** Retry configuration for SDK operations */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay cap in ms (default: 10000) */
  maxDelayMs: number;
  /** Which error types are retryable (default: network, timeout, 5xx) */
  retryableErrors: RetryableErrorType[];
}

export type RetryableErrorType = 'network' | 'timeout' | 'server' | 'rate-limit';

/** Memory adapter configuration */
export interface MemoryConfig {
  /** Base URL of the memini-core HTTP server */
  baseUrl: string;
  /** Request timeout in ms */
  timeoutMs: number;
}

/** Full SDK client configuration */
export interface BoomerangClientConfig {
  /** Memory server configuration */
  memory: MemoryConfig;
  /** Retry configuration for resilient operations */
  retry?: Partial<RetryConfig>;
  /** Custom agent overrides (replace default routing) */
  agentOverrides?: Partial<Record<AgentRole, AgentConfig>>;
  /** Protocol strictness level */
  strictness?: 'lenient' | 'standard' | 'strict';
}

// ============================================================================
// Hook Types
// ============================================================================

/** Compaction hook event payload */
export interface CompactionEvent {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
}

/** Session lifecycle event types */
export type SessionEventType = 'session.created' | 'session.idle' | 'session.compacting' | 'session.destroyed';

/** Hook handler function signature */
export type HookHandler<T = unknown> = (payload: T) => Promise<void>;

/** SDK-level hook definitions for OpenCode integration */
export interface HookDefinitions {
  /** Called before tool execution to validate routing */
  onBeforeToolExecute?: HookHandler<{ toolName: string; agent: AgentRole }>;
  /** Called after tool execution to save context */
  onAfterToolExecute?: HookHandler<{ toolName: string; result: string; durationMs: number }>;
  /** Called when session is about to be compacted */
  onCompaction?: HookHandler<CompactionEvent>;
  /** Called to inject context into system prompt */
  onSystemTransform?: HookHandler<{ prompt: string }>;
}

// ============================================================================
// SDK Result Types
// ============================================================================

/** Successful SDK operation result */
export interface SdkSuccess<T> {
  ok: true;
  value: T;
}

/** Failed SDK operation result */
export interface SdkFailure {
  ok: false;
  error: string;
  retryable: boolean;
}

/** Union type for SDK operation results */
export type SdkResult<T> = SdkSuccess<T> | SdkFailure;