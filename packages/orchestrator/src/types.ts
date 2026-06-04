/**
 * Neuralgentics — Core Type Definitions
 *
 * All shared types for the orchestrator, routing, context building,
 * and protocol enforcement. No MCP imports — plain HTTP JSON only.
 */

// ============================================================================
// Agent & Task Types
// ============================================================================

export type TaskType =
  | 'code-implementation'
  | 'architecture-design'
  | 'file-finding'
  | 'testing'
  | 'linting'
  | 'git'
  | 'documentation'
  | 'web-scraping'
  | 'mcp-debug'
  | 'release';

export type AgentRole =
  | 'orchestrator'
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'explorer'
  | 'tester'
  | 'linter'
  | 'git'
  | 'writer'
  | 'scraper'
  | 'mcp-specialist'
  | 'release';

export interface Agent {
  name: AgentRole;
  description: string;
  model: 'primary' | 'secondary';
  skills: string[];
}

export interface Task {
  id: string;
  type: TaskType;
  description: string;
  userRequest: string;
  priority: 'low' | 'medium' | 'high';
  files?: string[];
  dependencies?: string[];
}

// ============================================================================
// Routing Types
// ============================================================================

export interface RoutingRule {
  taskType: TaskType;
  agent: AgentRole;
  forbiddenAgents: AgentRole[];
  description: string;
}

// ============================================================================
// Context Package
// ============================================================================

export interface ContextPackage {
  originalUserRequest: string;
  taskBackground: string;
  relevantFiles: string[];
  codeSnippets: string[];
  previousDecisions: string[];
  expectedOutput: string;
  scopeBoundaries: {
    inScope: string[];
    outOfScope: string[];
  };
  errorHandling: string;
  /** Injected L0 project summary (~100 tokens) */
  l0Summary?: string;
  /** Injected L1 key decisions (~2K tokens) */
  l1Summary?: string;
  /** Trust scores for relevant memories */
  trustScores?: Record<string, number>;
}

// ============================================================================
// Memory Types (HTTP JSON shapes — no MCP)
// ============================================================================

export type MemorySourceType =
  | 'session'
  | 'file'
  | 'web'
  | 'boomerang'
  | 'project'
  | 'context_package'
  | 'agent_wrap_up'
  | 'agent_partial'      // Partial result when agent hits blocker
  | 'blocker_report'     // Structured blocker report from agent
  | 'design_delta';      // Architect's response to a blocker

export interface Memory {
  id: string;
  content: string;
  sourceType: MemorySourceType;
  sourcePath?: string;
  timestamp: string;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}

export type TrustSignal = 'agent_used' | 'agent_ignored' | 'user_corrected' | 'user_confirmed';

export type RelationshipType =
  | 'SUPERSEDES'
  | 'PARTIAL_UPDATE'
  | 'RELATED_TO'
  | 'CONTRADICTS'
  | 'DERIVED_FROM'
  | 'SUPPORTS'     // One memory provides supporting context for another
  | 'BLOCKS'       // One memory blocks progress on another
  | 'RESOLVES';    // One memory resolves a blocker described by another

export interface Relationship {
  targetId: string;
  relationshipType: RelationshipType;
  confidence: number;
}

// ============================================================================
// Skill Types
// ============================================================================

export interface Skill {
  name: string;
  description: string;
  model: 'primary' | 'secondary';
  content: string;
  frontmatter: Record<string, unknown>;
}

// ============================================================================
// Protocol Types
// ============================================================================

export type ProtocolStep =
  | 'IDLE'
  | 'MEMORY_QUERY'
  | 'THOUGHT_CHAIN'
  | 'PLAN'
  | 'DELEGATE'
  | 'PENDING_BLOCKER'  // Agent hit a blocker, waiting on resolution
  | 'RESUMING'         // Blocker resolved, re-dispatching agent
  | 'GIT_CHECK'
  | 'QUALITY_GATES'
  | 'DOC_UPDATE'
  | 'MEMORY_SAVE'
  | 'COMPLETE';

export interface ProtocolState {
  currentStep: ProtocolStep;
  completedSteps: ProtocolStep[];
  violations: ProtocolViolation[];
}

export interface ProtocolViolation {
  step: ProtocolStep;
  message: string;
  severity: 'low' | 'medium' | 'high';
}

// ============================================================================
// Orchestration Result & Execution Plan
// ============================================================================

export interface OrchestrationResult {
  agent: AgentRole;
  contextPackage: ContextPackage;
  executionPlan: ExecutionPlan;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  /** Whether steps can run in parallel. Fetched from dependency graph. */
  canParallelize: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface ExecutionStep {
  agent: AgentRole;
  task: string;
  /** Step IDs that must complete before this step runs */
  dependsOn: string[];
  priority: 'low' | 'medium' | 'high';
}

// ============================================================================
// Stateless Agent Memory-Backed Context Types
// ============================================================================

/** Metadata stored alongside ContextPackage in memini-core */
export interface ContextPackageMetadata {
  taskType: TaskType;
  agentRole: AgentRole;
  taskId: string;
  /** Self-referencing — set after creation to the memory ID */
  contextMemoryId?: string;
  /** For sub-agent contexts, points to parent context. Null for top-level. */
  parentMemoryId?: string | null;
  createdAt: string;
  project: string;
  version: string;
}

/** Metadata stored alongside AgentWrapUp in memini-core */
export interface AgentWrapUpMetadata {
  taskType: TaskType;
  agentRole: AgentRole;
  taskId: string;
  /** Links back to the context_package memory the agent consumed */
  contextMemoryId: string;
  /** For sub-agent wrap-ups, points to parent's wrap-up */
  parentWrapUpId?: string | null;
  createdAt: string;
  project: string;
  durationMs?: number;
  success: boolean;
}

/** The seed prompt handed to an agent at dispatch time.
 *  Contains only a task description, memory ID, and protocol instructions. */
export interface SeedPrompt {
  /** Short task description (1-2 sentences) */
  task: string;
  /** Memory UUID pointing to the full ContextPackage in memini-core */
  memoryId: string;
  /** Complete seed prompt text (task + memory_id + protocol) */
  prompt: string;
}

/** What the agent returns after completing work (minimal reference) */
export interface StatelessTaskResult {
  /** Memory ID of the agent's wrap-up stored in memini-core */
  memory_id: string;
  /** One-line summary of what was done */
  description: string;
}

/** Agent wrap-up content stored in memini-core */
export interface AgentWrapUp {
  summary: string;
  filesModified: string[];
  filesCreated: string[];
  followUpTasks: string[];
  trustSignals: {
    contextMemoryId: string;
    signal: TrustSignal;
  };
  errors: string[];
  warnings: string[];
  subAgentResults: StatelessTaskResult[];
}

/** Result returned by stateless orchestrator dispatch */
export interface StatelessOrchestrationResult {
  agent: AgentRole;
  /** Memory ID of the context package stored in memini-core */
  contextMemoryId: string;
  /** Minimal prompt the agent receives (task + memory_id + protocol) */
  seedPrompt: SeedPrompt;
  executionPlan: ExecutionPlan;
}

// ============================================================================
// Design-to-Implementation Dependency Tracking
// ============================================================================

export interface TaskDependency {
  /** Human-readable reason for the dependency */
  reason: string;
}

/** Prevents architect + coder from being dispatched in parallel for same task. */
export const MANDATORY_SEQUENCES: Record<AgentRole, AgentRole[]> = {
  architect: ['coder', 'tester'],
  reviewer: ['tester'],
  // No mandatory dependencies for other roles
  orchestrator: [],
  coder: [],
  explorer: [],
  tester: [],
  linter: [],
  git: [],
  writer: [],
  scraper: [],
  'mcp-specialist': [],
  release: [],
};

// ============================================================================
// Fine-Grained Task Scoping Types (Design §2.1, §6)
// ============================================================================

/**
 * Task execution status for fine-grained task entries.
 * Implements the state machine from DESIGN_fine_grained_scoping_v1.md §6.
 */
export type TaskStatus =
  | 'PENDING'              // Not yet dispatched — waiting for dependencies
  | 'READY'                // All dependencies satisfied — can be dispatched
  | 'ACTIVE'               // Agent is currently executing
  | 'BLOCKED'              // Agent hit a blocker — partial result saved
  | 'RESOLVING'             // Architect is designing the missing dependency
  | 'DEPENDENCY_BUILDING'   // Coder implementing missing dependency
  | 'RESUMED'              // Dependency resolved — original agent re-dispatched
  | 'COMPLETE'              // Agent returned valid wrap-up
  | 'FAILED'                // Max retries exceeded or unrecoverable error
  | 'CANCELLED';            // Orchestrator/user cancelled the task

/**
 * A single scoped task entry in the architect's decomposition plan.
 * Each entry maps to exactly ONE agent dispatch targeting ONE file.
 */
export interface FineGrainedTaskEntry {
  /** UUID for this task entry */
  id: string;

  /** Workspace-relative file path this task owns */
  targetFile: string;

  /** Whether this task creates or modifies the target file */
  type: 'new_file' | 'modify_file';

  /** Agent role dispatched for this task */
  agent: AgentRole;

  /** Precise scope boundary */
  scope: {
    inScope: string[];
    outOfScope: string[];
  };

  /** Task IDs that MUST complete before this task can start */
  dependsOn: string[];

  /** Current execution status */
  status: TaskStatus;

  /** Priority within its dependency group */
  priority: 'low' | 'medium' | 'high';

  /** Estimated token cost for dispatching this task */
  estimatedTokens: number;

  /** How many times dispatched (retry tracking) */
  dispatchCount: number;

  /** Max retries before FAILED */
  maxDispatches: number;

  /** True if spawned from a blocker (design delta) */
  isDeltaTask: boolean;

  /** If isDeltaTask, the parent taskId that was blocked */
  parentTaskId?: string;

  /** If isDeltaTask, which blocker this resolves */
  resolvedBlockerId?: string;

  /** Memory ID of the design doc for this task */
  designDocId?: string;

  /** Memory ID of the agent's wrap-up */
  resultMemoryId?: string;
}

/**
 * Structured report from a coder agent when it hits a missing dependency.
 * Stored in memini-core as sourceType="blocker_report".
 */
export interface BlockerReport {
  /** Task that is blocked */
  originalTaskId: string;

  /** The task this is blocked on (the missing dependency) */
  blockerTaskId: string;

  /** What file/type/config is missing */
  missingDependency: string;

  /** Human-readable explanation of the blocker */
  description: string;

  /** How severe the blocker is */
  severity: 'low' | 'medium' | 'high';
}

/**
 * The architect's design for resolving a blocker.
 * Contains new task entries for the missing dependency.
 */
export interface DesignDelta {
  /** Memory ID of the original design doc that needed updating */
  parentDesignId: string;

  /** New tasks created to resolve the blocker */
  newTasks: FineGrainedTaskEntry[];

  /** Why the architect made these changes */
  reasoning: string;
}

/**
 * The full task list produced by the architect's decomposition.
 */
export interface FineGrainedTaskList {
  featureId: string;
  featureDescription: string;
  tasks: FineGrainedTaskEntry[];
  createdAt: string;
  totalEstimatedTokens: number;
  maxTopologicalDepth: number;
}

/**
 * In-memory file lock tracking for conflict prevention.
 */
export interface FileLock {
  taskId: string;
  status: TaskStatus;
  acquiredAt: number;
}

/**
 * Agent partial result stored when an agent hits a blocker.
 */
export interface AgentPartialResult {
  taskId: string;
  targetFile: string;
  completedWork: string[];
  remainingWork: string[];
  dependsOn: string[];
  filesTouched: string[];
  contextMemoryId: string;
  blockedAt: string;
}