/**
 * Boomerang SDK — Routing Adapter
 *
 * Wraps the Neuralgentics Routing Matrix with SDK-level convenience
 * methods for resolving agents, validating routing decisions, and
 * building parallel execution groups.
 */

import type { AgentRole, TaskType } from '@neuralgentics/orchestrator/types';
import {
  resolveAgent,
  validateRouting,
  getRoutingRule,
  ROUTING_MATRIX,
} from '@neuralgentics/orchestrator';
import type { AgentConfig, TaskPlan, PlanTask } from '../types.js';
import { generateId } from '../utils.js';

// ============================================================================
// Default Agent Configurations
// ============================================================================

/**
 * Default agent configurations matching the Neuralgentics Routing Matrix.
 * Maps AgentRole → AgentConfig with sensible defaults.
 */
const DEFAULT_AGENT_CONFIGS: Record<string, AgentConfig> = {
  'boomerang-coder': {
    id: 'boomerang-coder',
    name: 'Boomerang Coder',
    skill: 'boomerang-coder',
    model: 'glm-5.1:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_adjust_trust': 'allow',
      'memoryManager_get_trust_score': 'allow',
      'memoryManager_search_project': 'allow',
      'memoryManager_add_thought': 'allow',
      'memoryManager_get_thought_chain': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-architect': {
    id: 'boomerang-architect',
    name: 'Boomerang Architect',
    skill: 'boomerang-architect',
    model: 'deepseek-v4-pro:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_query_kg': 'allow',
      'memoryManager_extract_entities': 'allow',
      'memoryManager_add_thought': 'allow',
      'memoryManager_get_thought_chain': 'allow',
      'memoryManager_index_project': 'allow',
      'memoryManager_get_file_contents': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-explorer': {
    id: 'boomerang-explorer',
    name: 'Boomerang Explorer',
    skill: 'boomerang-explorer',
    model: 'devstral-2:123b-cloud',
    permissions: {
      'memoryManager_search_project': 'allow',
      'memoryManager_index_project': 'allow',
      'memoryManager_get_file_contents': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-tester': {
    id: 'boomerang-tester',
    name: 'Boomerang Tester',
    skill: 'boomerang-tester',
    model: 'deepseek-v4-flash:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_search_project': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-linter': {
    id: 'boomerang-linter',
    name: 'Boomerang Linter',
    skill: 'boomerang-linter',
    model: 'qwen3-coder-next:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-git': {
    id: 'boomerang-git',
    name: 'Boomerang Git',
    skill: 'boomerang-git',
    model: 'minimax-m2.7:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-writer': {
    id: 'boomerang-writer',
    name: 'Boomerang Writer',
    skill: 'boomerang-writer',
    model: 'gemma4:31b-cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_get_tier0_summary': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-scraper': {
    id: 'boomerang-scraper',
    name: 'Boomerang Scraper',
    skill: 'boomerang-scraper',
    model: 'qwen3.5:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang-release': {
    id: 'boomerang-release',
    name: 'Boomerang Release',
    skill: 'boomerang-release',
    model: 'devstral-small-2:24b-cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_adjust_trust': 'allow',
      'memoryManager_get_trust_score': 'allow',
    },
    mode: 'subagent',
  },
  'boomerang': {
    id: 'boomerang',
    name: 'Boomerang Orchestrator',
    skill: 'orchestrator',
    model: 'kimi-k2.6:cloud',
    permissions: {
      'memoryManager_query_memories': 'allow',
      'memoryManager_add_memory': 'allow',
      'memoryManager_adjust_trust': 'allow',
      'memoryManager_get_trust_score': 'allow',
      'memoryManager_search_project': 'allow',
      'memoryManager_index_project': 'allow',
      'memoryManager_get_file_contents': 'allow',
      'memoryManager_get_tier0_summary': 'allow',
      'memoryManager_get_tier1_summary': 'allow',
      'memoryManager_add_thought': 'allow',
      'memoryManager_get_thought_chain': 'allow',
      'memoryManager_query_kg': 'allow',
      'memoryManager_extract_entities': 'allow',
    },
    mode: 'primary',
  },
};

// ============================================================================
// Routing Adapter
// ============================================================================

/**
 * Resolve an AgentRole to the full AgentConfig.
 * Falls back to orchestrator defaults if role has no explicit config.
 */
export function getAgentConfig(role: AgentRole, overrides?: Partial<AgentConfig>): AgentConfig {
  const defaultConfig = DEFAULT_AGENT_CONFIGS[`boomerang-${role}`];
  if (!defaultConfig) {
    return {
      id: `boomerang-${role}`,
      name: `Boomerang ${role.charAt(0).toUpperCase() + role.slice(1)}`,
      skill: `boomerang-${role}`,
      model: 'kimi-k2.6:cloud',
      permissions: {},
      mode: 'subagent',
      ...overrides,
    };
  }
  return { ...defaultConfig, ...overrides };
}

/**
 * Validate routing and return detailed result.
 */
export function checkRouting(taskType: TaskType, agent: AgentRole): {
  valid: boolean;
  expectedAgent: AgentRole | null;
  violation?: string;
  config?: AgentConfig;
} {
  const validation = validateRouting(taskType, agent);
  const config = getAgentConfig(agent);

  return {
    ...validation,
    config,
  };
}

/**
 * Build a TaskPlan from a list of task descriptions.
 * Analyzes dependencies and parallel execution groups.
 */
export function buildTaskPlan(
  tasks: Array<{ type: TaskType; description: string; priority?: 'low' | 'medium' | 'high' }>,
  planId?: string
): TaskPlan {
  const id = planId ?? generateId('plan');

  const planTasks: PlanTask[] = tasks.map((t, i) => {
    const agent = resolveAgent(t.type) ?? 'architect';
    return {
      id: `${id}_task_${i}`,
      type: t.type,
      description: t.description,
      dependsOn: [],
      priority: t.priority ?? 'medium',
      agent,
    };
  });

  // Build dependency graph — tasks of the same type run sequentially,
  // tasks of different types with no conflicts can run in parallel
  const dependencies = new Map<string, string[]>();
  const parallelGroups: string[][] = [];

  // Group tasks by type for parallel execution
  const typeGroups = new Map<TaskType, string[]>();
  for (const task of planTasks) {
    const group = typeGroups.get(task.type) ?? [];
    group.push(task.id);
    typeGroups.set(task.type, group);
  }

  // Within same-type groups, chain dependencies (sequential)
  for (const [, taskIds] of typeGroups) {
    for (let i = 1; i < taskIds.length; i++) {
      const prev = taskIds[i - 1];
      const curr = taskIds[i];
      planTasks.find((t) => t.id === curr)!.dependsOn.push(prev);
      const deps = dependencies.get(curr) ?? [];
      deps.push(prev);
      dependencies.set(curr, deps);
    }
  }

  // Cross-type groups can run in parallel — one representative per type
  const parallelGroupIds: string[] = [];
  for (const [, taskIds] of typeGroups) {
    parallelGroupIds.push(taskIds[0]);
  }
  if (parallelGroupIds.length > 1) {
    parallelGroups.push(parallelGroupIds);
  }

  // Individual tasks form their own parallel group
  for (const task of planTasks) {
    if (!parallelGroupIds.includes(task.id)) {
      parallelGroups.push([task.id]);
    }
  }

  // Populate dependency map for all tasks
  for (const task of planTasks) {
    if (!dependencies.has(task.id)) {
      dependencies.set(task.id, task.dependsOn);
    }
  }

  return {
    id,
    tasks: planTasks,
    dependencies,
    parallelGroups,
  };
}

/**
 * Get all routing rules as agent configs.
 */
export function getAllAgentConfigs(): AgentConfig[] {
  return Object.values(DEFAULT_AGENT_CONFIGS);
}

/**
 * Get the raw routing matrix.
 */
export function getRoutingMatrix() {
  return ROUTING_MATRIX;
}

export { resolveAgent, validateRouting, getRoutingRule };