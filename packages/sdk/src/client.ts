/**
 * Boomerang SDK — Client Wrapper
 *
 * Main entry point for the SDK. Wraps OpenCode SDK with boomerang-specific
 * error handling, retry logic, and typed configuration. Provides convenience
 * methods for common operations like memory queries, routing validation,
 * and task planning.
 *
 * If @opencode-ai/sdk is not installed (optional peer dependency),
 * the client falls back to direct HTTP operations via the MemoryAdapter.
 */

import type {
  BoomerangClientConfig,
  MemoryConfig,
  RetryConfig,
  AgentConfig,
  AgentRole,
  TaskPlan,
  ContextPackage,
  TaskType,
  SdkResult,
  HookDefinitions,
} from './types.js';
import { MemoryAdapter } from './adapters/memory.js';
import { HooksAdapter } from './adapters/hooks.js';
import {
  resolveAgent,
  validateRouting,
  getRoutingRule,
} from './adapters/routing.js';
import { buildTaskPlan, getAgentConfig, checkRouting } from './adapters/routing.js';
import { withRetry, tryOperation, DEFAULT_RETRY_CONFIG } from './utils.js';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  baseUrl: process.env.NEURALGENTICS_MEMORY_URL ?? 'http://localhost:8900',
  timeoutMs: 10000,
};

// ============================================================================
// Client
// ============================================================================

/**
 * BoomerangClient — the main SDK entry point.
 *
 * Wraps OpenCode SDK with boomerang-specific abstractions:
 * - Memory adapter with retry logic (connects to memini-core on port 8900)
 * - Routing validation against the Routing Matrix
 * - Task planning with dependency/parallel group detection
 * - OpenCode plugin hooks adapter
 */
export class BoomerangClient {
  readonly memory: MemoryAdapter;
  private _hooks: HooksAdapter;
  /** Current hooks adapter (replaceable via configureHooks) */
  get hooks(): HooksAdapter { return this._hooks; }
  private config: BoomerangClientConfig;
  private initialized: boolean = false;

  constructor(config?: Partial<BoomerangClientConfig>) {
    const memoryConfig: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      ...config?.memory,
    };

    this.config = {
      memory: memoryConfig,
      retry: config?.retry,
      agentOverrides: config?.agentOverrides,
      strictness: config?.strictness ?? 'standard',
    };

    this.memory = new MemoryAdapter(memoryConfig, config?.retry);
    this._hooks = new HooksAdapter({ memory: this.memory });
    this.initialized = true;
  }

  /**
   * Check if the memory server is healthy.
   */
  async isReady(): Promise<boolean> {
    return this.memory.isHealthy();
  }

  // ---------------------------------------------------------------------------
  // Memory Operations
  // ---------------------------------------------------------------------------

  /**
   * Query memories with typed result.
   */
  async queryMemories(query: string, limit?: number): Promise<SdkResult<import('./adapters/memory.js').Memory[]>> {
    return tryOperation(() => this.memory.queryMemories(query, limit));
  }

  /**
   * Add a memory entry.
   */
  async addMemory(content: string, metadata?: Record<string, unknown>): Promise<SdkResult<string>> {
    return this.memory.addMemory(content, metadata);
  }

  /**
   * Get L0 project summary (~100 tokens).
   */
  async getProjectSummary(): Promise<string | null> {
    return this.memory.getTier0Summary();
  }

  /**
   * Get L1 key decisions summary (~2K tokens).
   */
  async getKeyDecisions(): Promise<string | null> {
    return this.memory.getTier1Summary();
  }

  // ---------------------------------------------------------------------------
  // Routing Operations
  // ---------------------------------------------------------------------------

  /**
   * Resolve the correct agent for a task type.
   */
  resolveAgent(taskType: TaskType): AgentRole | null {
    return resolveAgent(taskType);
  }

  /**
   * Validate a routing decision.
   */
  validateRouting(taskType: TaskType, agent: AgentRole) {
    return checkRouting(taskType, agent);
  }

  /**
   * Get the full agent configuration for a role.
   */
  getAgentConfig(role: AgentRole): AgentConfig {
    const overrides = this.config.agentOverrides?.[role];
    return getAgentConfig(role, overrides);
  }

  // ---------------------------------------------------------------------------
  // Task Planning
  // ---------------------------------------------------------------------------

  /**
   * Build a task plan from a list of tasks.
   */
  planTasks(
    tasks: Array<{ type: TaskType; description: string; priority?: 'low' | 'medium' | 'high' }>,
    planId?: string
  ): TaskPlan {
    return buildTaskPlan(tasks, planId);
  }

  // ---------------------------------------------------------------------------
  // Hooks Configuration
  // ---------------------------------------------------------------------------

  /**
   * Update hooks adapter with custom handlers and AGENTS.md content.
   */
  configureHooks(handlers: HookDefinitions, agentsMdContent?: string): void {
    this._hooks = new HooksAdapter(
      { memory: this.memory, agentsMdContent },
      handlers
    );
  }

  /**
   * Get all MCP tool definitions from the hooks adapter.
   */
  getHookTools(): Record<string, import('./adapters/hooks.js').ToolDefinition> {
    return this.hooks.getTools();
  }

  // ---------------------------------------------------------------------------
  // Client Info
  // ---------------------------------------------------------------------------

  /**
   * Get the current client configuration (without sensitive data).
   */
  getConfig(): Readonly<BoomerangClientConfig> {
    return { ...this.config };
  }

  /**
   * Get the protocol strictness level.
   */
  getStrictness(): 'lenient' | 'standard' | 'strict' {
    return this.config.strictness ?? 'standard';
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a BoomerangClient with the given configuration.
 */
export function createClient(config?: Partial<BoomerangClientConfig>): BoomerangClient {
  return new BoomerangClient(config);
}