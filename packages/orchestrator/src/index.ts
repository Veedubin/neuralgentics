/**
 * Neuralgentics — Main Orchestrator
 *
 * Routes tasks to agents, enforces the 8-step protocol,
 * and builds ContextPackages via the memory adapter.
 */

import type {
  AgentRole,
  ContextPackage,
  ExecutionPlan,
  ExecutionStep,
  OrchestrationResult,
  ProtocolStep,
  ProtocolState,
  ProtocolViolation,
  Task,
  TaskType,
} from './types.js';
import { validateRouting, resolveAgent } from './routing.js';
import { buildContextPackage } from './context.js';
import type { MemoryAdapter } from './context.js';

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
}

export class NeuralgenticsOrchestrator {
  private memory: MemoryAdapter;
  private skillsDir: string;
  private strictness: 'lenient' | 'standard' | 'strict';
  private protocolStates: Map<string, ProtocolState> = new Map();

  constructor(config: OrchestratorConfig) {
    this.memory = config.memory;
    this.skillsDir = config.skillsDir;
    this.strictness = config.strictness ?? 'standard';
  }

  /**
   * Handle a task: route to the correct agent, build context, return plan.
   *
   * This is the main entry point. It does NOT execute agents —
   * it returns the routing decision + context + execution plan
   * for the caller (OpenCode) to handle.
   */
  async handleTask(task: Task): Promise<OrchestrationResult> {
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
export { validateRouting, resolveAgent } from './routing.js';
export { loadSkills, getSkill } from './skills.js';
export { buildContextPackage } from './context.js';
export type { MemoryAdapter } from './context.js';