/**
 * Neuralgentics — Main Orchestrator
 *
 * Routes tasks to agents, enforces the 8-step protocol,
 * and builds ContextPackages via the memory adapter.
 */

import type {
  AgentRole,
  AgentWrapUp,
  ContextPackage,
  ExecutionPlan,
  ExecutionStep,
  OrchestrationResult,
  ProtocolStep,
  ProtocolState,
  ProtocolViolation,
  SeedPrompt,
  StatelessOrchestrationResult,
  StatelessTaskResult,
  Task,
  TaskType,
} from './types.js';
import {
  validateRouting,
  resolveAgent,
  getRoutingRule,
  ROUTING_MATRIX,
} from './routing.js';
import {
  buildContextPackage,
  buildSeedPrompt,
  fetchAgentWrapUp,
  storeContextPackage,
} from './context.js';
import type { MemoryAdapter } from './context.js';
import { formatSeedPrompt } from './stateless-protocol.js';
import { MANDATORY_SEQUENCES } from './types.js';

// ============================================================================
// Protocol Steps (ordered)
// ============================================================================

const PROTOCOL_STEPS: ProtocolStep[] = [
  'MEMORY_QUERY',
  'THOUGHT_CHAIN',
  'PLAN',
  'DELEGATE',
  'GIT_CHECK',
  'QUALITY_GATES',
  'DOC_UPDATE',
  'MEMORY_SAVE',
];

const WAIVER_PHRASES: Record<string, ProtocolStep> = {
  'skip planning': 'PLAN',
  'just do it': 'PLAN',
  'no plan needed': 'PLAN',
  'skip tests': 'QUALITY_GATES',
  'skip gates': 'QUALITY_GATES',
  'git is fine': 'GIT_CHECK',
  'no docs needed': 'DOC_UPDATE',
};

// ============================================================================
// Orchestrator
// ============================================================================

export interface OrchestratorConfig {
  /** Path to skills directory */
  skillsDir: string;
  /** Memory adapter instance */
  memory: MemoryAdapter;
  /** Protocol strictness: 'lenient' | 'standard' | 'strict' */
  strictness?: 'lenient' | 'standard' | 'strict';
  /**
   * Enable stateless agent mode. When true, handleTask() delegates
   * to handleTaskStateless() which stores context in memini-core
   * and returns a SeedPrompt instead of an inline ContextPackage.
   * Default: false (backward compatible).
   */
  useStatelessAgents?: boolean;
}

export class NeuralgenticsOrchestrator {
  private memory: MemoryAdapter;
  private skillsDir: string;
  private strictness: 'lenient' | 'standard' | 'strict';
  private useStatelessAgents: boolean;
  private protocolStates: Map<string, ProtocolState> = new Map();

  constructor(config: OrchestratorConfig) {
    this.memory = config.memory;
    this.skillsDir = config.skillsDir;
    this.strictness = config.strictness ?? 'standard';
    this.useStatelessAgents = config.useStatelessAgents ?? false;
  }

  /**
   * Handle a task: route to the correct agent, build context, return plan.
   *
   * When useStatelessAgents is true, delegates to handleTaskStateless()
   * which stores context in memini-core and returns a SeedPrompt.
   * Otherwise, returns the full inline ContextPackage (backward compatible).
   */
  async handleTask(task: Task): Promise<OrchestrationResult | StatelessOrchestrationResult> {
    if (this.useStatelessAgents) {
      return this.handleTaskStateless(task);
    }
    return this.handleTaskInline(task);
  }

  /**
   * Original inline context behavior — builds ContextPackage and returns
   * it directly in the OrchestrationResult.
   */
  private async handleTaskInline(task: Task): Promise<OrchestrationResult> {
    // Initialize protocol tracking
    const state = this.initProtocolState(task.id);

    // Step 1: MEMORY_QUERY (mandatory)
    this.advanceProtocol(task.id, 'MEMORY_QUERY');

    // Step 2: THOUGHT_CHAIN — mark complete (actual thinking is done by the agent)
    this.advanceProtocol(task.id, 'THOUGHT_CHAIN');

    // Step 3: PLAN — mark complete (we're building the plan now)
    this.advanceProtocol(task.id, 'PLAN');

    // Step 4: DELEGATE — resolve agent
    const agent = this.resolveTaskAgent(task.type);

    // Validate routing
    const routeCheck = validateRouting(task.type, agent);
    if (!routeCheck.valid && routeCheck.violation) {
      const violation: ProtocolViolation = {
        step: 'DELEGATE',
        message: routeCheck.violation,
        severity: 'high',
      };
      state.violations.push(violation);

      if (this.strictness === 'strict') {
        throw new Error(`ROUTING BLOCKED: ${routeCheck.violation}`);
      }
      console.warn(`[Orchestrator] ${routeCheck.violation}`);
    }

    this.advanceProtocol(task.id, 'DELEGATE');

    // Build context package
    const contextPackage = await buildContextPackage(task, agent, this.memory);

    // Build execution plan
    const executionPlan = this.buildExecutionPlan(task, agent);

    return { agent, contextPackage, executionPlan };
  }

  /**
   * Stateless agent mode — stores context in memini-core and returns
   * a SeedPrompt with memory ID instead of the full ContextPackage inline.
   */
  async handleTaskStateless(task: Task): Promise<StatelessOrchestrationResult> {
    // Initialize protocol tracking
    const state = this.initProtocolState(task.id);

    // Step 1: MEMORY_QUERY (mandatory)
    this.advanceProtocol(task.id, 'MEMORY_QUERY');

    // Step 2: THOUGHT_CHAIN — mark complete
    this.advanceProtocol(task.id, 'THOUGHT_CHAIN');

    // Step 3: PLAN — mark complete
    this.advanceProtocol(task.id, 'PLAN');

    // Step 4: DELEGATE — resolve agent
    const agent = this.resolveTaskAgent(task.type);

    // Validate routing
    const routeCheck = validateRouting(task.type, agent);
    if (!routeCheck.valid && routeCheck.violation) {
      const violation: ProtocolViolation = {
        step: 'DELEGATE',
        message: routeCheck.violation,
        severity: 'high',
      };
      state.violations.push(violation);

      if (this.strictness === 'strict') {
        throw new Error(`ROUTING BLOCKED: ${routeCheck.violation}`);
      }
      console.warn(`[Orchestrator] ${routeCheck.violation}`);
    }

    this.advanceProtocol(task.id, 'DELEGATE');

    // Build context package (same assembly as inline mode)
    const contextPackage = await buildContextPackage(task, agent, this.memory);

    // Store context package in memini-core and get seed prompt
    const { seedPrompt, contextMemoryId } = await buildSeedPrompt(
      this.memory,
      task,
      contextPackage,
      agent
    );

    // Build execution plan
    const executionPlan = this.buildExecutionPlan(task, agent);

    return { agent, contextMemoryId, seedPrompt, executionPlan };
  }

  /**
   * Complete the task cycle after an agent returns.
   *
   * 1. Fetches the wrap-up from memini-core via memory ID
   * 2. Adjusts trust on the context memory (+0.05 agent_used)
   * 3. Returns the full AgentWrapUp for presentation
   */
  async completeTaskCycle(
    taskId: string,
    result: StatelessTaskResult,
    contextMemoryId: string
  ): Promise<AgentWrapUp> {
    // Step 1: Fetch the wrap-up from memini-core
    const wrapUp = await fetchAgentWrapUp(this.memory, result.memory_id);

    // Step 2: Adjust trust on the context memory (agent_used signal = +0.05)
    try {
      await this.memory.adjustTrust(contextMemoryId, 'agent_used');
    } catch (err) {
      // Trust adjustment is best-effort; log but don't fail
      console.warn(
        `[Orchestrator] Failed to adjust trust on context memory ${contextMemoryId}: ${err}`
      );
    }

    // Step 3: Complete remaining protocol steps
    this.advanceProtocol(taskId, 'MEMORY_SAVE');
    this.advanceProtocol(taskId, 'COMPLETE');

    return wrapUp;
  }

  /**
   * Build a seed prompt string from a task and memory ID.
   *
   * This is useful when you already have a contextMemoryId and
   * just need the formatted prompt string.
   */
  buildSeedPrompt(task: Task, contextMemoryId: string): string {
    return formatSeedPrompt(task.description, contextMemoryId);
  }

  /**
   * Enforce 8-step protocol compliance for a task.
   * Returns the current protocol state with any violations.
   */
  enforceProtocol(taskId: string): ProtocolState {
    const state = this.protocolStates.get(taskId);
    if (!state) {
      return {
        currentStep: 'IDLE',
        completedSteps: [],
        violations: [],
      };
    }
    return { ...state };
  }

  /**
   * Check whether a waiver phrase can skip a protocol step.
   */
  canWaiverStep(phrase: string, step: ProtocolStep): boolean {
    const waivedStep = WAIVER_PHRASES[phrase.toLowerCase()];
    if (!waivedStep) return false;
    return waivedStep === step;
  }

  /**
   * Complete the remaining protocol steps after agent execution.
   */
  completeProtocol(taskId: string): ProtocolState {
    const remaining: ProtocolStep[] = ['GIT_CHECK', 'QUALITY_GATES', 'DOC_UPDATE', 'MEMORY_SAVE'];
    for (const step of remaining) {
      this.advanceProtocol(taskId, step);
    }
    this.advanceProtocol(taskId, 'COMPLETE');
    return this.enforceProtocol(taskId);
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private resolveTaskAgent(taskType: TaskType): AgentRole {
    const agent = resolveAgent(taskType);
    if (!agent) {
      // Default to architect for unknown task types (research-oriented)
      console.warn(`[Orchestrator] No routing rule for task type: ${taskType}, defaulting to architect`);
      return 'architect';
    }
    return agent;
  }

  /**
   * Build execution plan with dependency-aware step ordering.
   *
   * Enforces:
   * 1. Design-before-implementation: architect must complete before coder/tester.
   * 2. Review-before-test: reviewer must complete before tester.
   *
   * NOTE: The orchestrator itself does not dispatch agents — OpenCode does.
   * Dependency enforcement happens in the dispatch layer by checking
   * `this._pendingTaskAgents` before launching parallel agents.
   */
  private buildExecutionPlan(task: Task, agent: AgentRole): ExecutionPlan {
    const steps: ExecutionStep[] = [];

    // Main step for the resolved agent
    steps.push({
      agent,
      task: task.description,
      dependsOn: [],
      priority: task.priority,
    });

    // If the task has dependencies, add prerequisites
    if (task.dependencies && task.dependencies.length > 0) {
      for (const dep of task.dependencies) {
        steps.push({
          agent: 'orchestrator' as AgentRole,
          task: `Resolve dependency: ${dep}`,
          dependsOn: [],
          priority: 'high',
        });
      }
    }

    const canParallelize = steps.length <= 1 || steps.every((s) => s.dependsOn.length === 0);
    const estimatedComplexity = this.estimateComplexity(task);

    return { steps, canParallelize, estimatedComplexity };
  }

  private estimateComplexity(task: Task): 'low' | 'medium' | 'high' {
    if (task.priority === 'high') return 'high';
    if (task.files && task.files.length > 3) return 'high';
    if (task.dependencies && task.dependencies.length > 0) return 'medium';
    return task.priority === 'medium' ? 'medium' : 'low';
  }

  private initProtocolState(taskId: string): ProtocolState {
    const state: ProtocolState = {
      currentStep: 'IDLE',
      completedSteps: [],
      violations: [],
    };
    this.protocolStates.set(taskId, state);
    return state;
  }

  private advanceProtocol(taskId: string, step: ProtocolStep): void {
    const state = this.protocolStates.get(taskId);
    if (!state) return;

    state.currentStep = step;
    if (step !== 'IDLE' && !state.completedSteps.includes(step)) {
      state.completedSteps.push(step);
    }
  }
}

/**
 * Factory function to create an orchestrator instance.
 */
export function createOrchestrator(config: OrchestratorConfig): NeuralgenticsOrchestrator {
  return new NeuralgenticsOrchestrator(config);
}

// Re-export for convenience
export { validateRouting, resolveAgent, getRoutingRule, ROUTING_MATRIX } from './routing.js';
export { loadSkills, getSkill } from './skills.js';
export { buildContextPackage, storeContextPackage, fetchContextPackage, storeAgentWrapUp, fetchAgentWrapUp, HttpMemoryAdapter } from './context.js';
export type { MemoryAdapter } from './context.js';
export { SEED_PROMPT_TEMPLATE, isStatelessDispatch, isStatelessTaskResult, formatSeedPrompt, buildSeedPromptObject } from './stateless-protocol.js';