/**
 * Neuralgentics — Routing Matrix
 *
 * Hardcoded mapping from TaskType → Agent with forbidden agents.
 * CODE-LEVEL ENFORCED: the orchestrator MUST delegate based on these rules.
 */

import type { AgentRole, RoutingRule, TaskType } from './types.js';

export const ROUTING_MATRIX: RoutingRule[] = [
  {
    taskType: 'code-implementation',
    agent: 'coder',
    forbiddenAgents: ['explorer'],
    description: 'Writing/editing code, tests, config',
  },
  {
    taskType: 'architecture-design',
    agent: 'architect',
    forbiddenAgents: ['coder', 'explorer'],
    description: 'System design, trade-offs, research',
  },
  {
    taskType: 'file-finding',
    agent: 'explorer',
    forbiddenAgents: ['architect', 'coder', 'tester', 'writer', 'linter', 'git', 'scraper', 'mcp-specialist', 'release'],
    description: 'ONLY glob/find operations — no analysis',
  },
  {
    taskType: 'testing',
    agent: 'tester',
    forbiddenAgents: ['coder'],
    description: 'Test writing and test execution',
  },
  {
    taskType: 'linting',
    agent: 'linter',
    forbiddenAgents: ['coder', 'architect', 'tester'],
    description: 'Code style enforcement',
  },
  {
    taskType: 'git',
    agent: 'git',
    forbiddenAgents: ['coder', 'architect', 'tester', 'linter'],
    description: 'Commits, branches, tags',
  },
  {
    taskType: 'documentation',
    agent: 'writer',
    forbiddenAgents: ['explorer'],
    description: 'Markdown, README, docs',
  },
  {
    taskType: 'web-scraping',
    agent: 'scraper',
    forbiddenAgents: ['explorer'],
    description: 'URL fetching, data extraction',
  },
  {
    taskType: 'mcp-debug',
    agent: 'mcp-specialist',
    forbiddenAgents: ['explorer'],
    description: 'MCP protocol, server issues',
  },
  {
    taskType: 'release',
    agent: 'release',
    forbiddenAgents: ['coder', 'architect', 'tester', 'linter', 'explorer', 'scraper', 'writer', 'git', 'mcp-specialist'],
    description: 'Version bumps, changelogs',
  },
];

/** Lookup table for fast access: TaskType → RoutingRule */
const routingByType = new Map<TaskType, RoutingRule>(
  ROUTING_MATRIX.map((rule) => [rule.taskType, rule])
);

/**
 * Resolve a TaskType to the correct agent.
 * Returns null if no routing rule exists for the task type.
 */
export function resolveAgent(taskType: TaskType): AgentRole | null {
  const rule = routingByType.get(taskType);
  return rule?.agent ?? null;
}

/**
 * Check whether a given agent is forbidden for a task type.
 */
export function isForbiddenAgent(taskType: TaskType, agent: AgentRole): boolean {
  const rule = routingByType.get(taskType);
  if (!rule) return false;
  return rule.forbiddenAgents.includes(agent);
}

/**
 * Get the full routing rule for a task type.
 */
export function getRoutingRule(taskType: TaskType): RoutingRule | undefined {
  return routingByType.get(taskType);
}

/**
 * Validate that a task type → agent assignment is correct.
 * Returns { valid, violation? } object.
 */
export function validateRouting(taskType: TaskType, agent: AgentRole): {
  valid: boolean;
  expectedAgent: AgentRole | null;
  violation?: string;
} {
  const rule = routingByType.get(taskType);
  if (!rule) {
    return { valid: true, expectedAgent: null };
  }
  if (rule.agent !== agent) {
    return {
      valid: false,
      expectedAgent: rule.agent,
      violation: `ROUTING VIOLATION: ${taskType} should use ${rule.agent}, not ${agent}`,
    };
  }
  if (rule.forbiddenAgents.includes(agent)) {
    return {
      valid: false,
      expectedAgent: rule.agent,
      violation: `ROUTING VIOLATION: ${agent} is forbidden for ${taskType}`,
    };
  }
  return { valid: true, expectedAgent: rule.agent };
}