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

export type MemorySourceType = 'session' | 'file' | 'web' | 'boomerang' | 'project';

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

export type RelationshipType = 'SUPERSEDES' | 'RELATED_TO' | 'CONTRADICTS' | 'DERIVED_FROM';

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
// Orchestration Result
// ============================================================================

export interface OrchestrationResult {
  agent: AgentRole;
  contextPackage: ContextPackage;
  executionPlan: ExecutionPlan;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  canParallelize: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface ExecutionStep {
  agent: AgentRole;
  task: string;
  dependsOn: string[];
  priority: 'low' | 'medium' | 'high';
}