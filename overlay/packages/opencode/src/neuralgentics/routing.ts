/**
 * Neuralgentics Routing Matrix — mandatory task-to-agent assignment rules.
 *
 * Every task dispatched by the orchestrator MUST pass through this matrix.
 * Violations result in a rejected routing with a descriptive reason.
 */

import type { RoutingRule } from "./types.js";

/**
 * The canonical routing matrix.
 *
 * Keys are task-type identifiers. Each entry names the **primary** agent
 * that MUST handle that task type, plus a list of agents that MUST NOT
 * be assigned to it.
 */
export const ROUTING_MATRIX: Record<string, RoutingRule> = {
  "code-implementation": {
    primary: "neuralgentics-coder",
    never: ["general", "neuralgentics-explorer"],
  },
  "architecture-design": {
    primary: "neuralgentics-architect",
    never: ["general", "neuralgentics-coder"],
  },
  testing: {
    primary: "neuralgentics-tester",
    never: ["general", "neuralgentics-coder"],
  },
  "file-finding": {
    primary: "neuralgentics-explorer",
    never: ["general", "neuralgentics-architect"],
  },
  linting: {
    primary: "neuralgentics-linter",
    never: [],
  },
  "git-operations": {
    primary: "neuralgentics-git",
    never: [],
  },
  documentation: {
    primary: "neuralgentics-writer",
    never: [],
  },
  "web-research": {
    primary: "neuralgentics-researcher",
    never: [],
  },
};

/**
 * Validate whether an agent assignment conforms to the routing matrix.
 *
 * @param taskType - The task-type identifier (must match a key in ROUTING_MATRIX).
 * @param agentName - The agent being considered for the task.
 * @returns An object with `valid: true`, or `valid: false` plus a `reason` string.
 */
export function validateAgentRouting(
  taskType: string,
  agentName: string,
): { valid: boolean; reason?: string } {
  const rule = ROUTING_MATRIX[taskType];

  if (!rule) {
    return {
      valid: false,
      reason: `Unknown task type: "${taskType}". No routing rule defined.`,
    };
  }

  if (rule.never.includes(agentName)) {
    return {
      valid: false,
      reason: `Agent "${agentName}" is forbidden for task type "${taskType}".`,
    };
  }

  if (agentName !== rule.primary && rule.never.length === 0) {
    // Permissive: any agent is allowed when there are no "never" restrictions.
    return { valid: true };
  }

  if (agentName === rule.primary) {
    return { valid: true };
  }

  // Not the primary, but not in the never-list either — allowed with a caveat.
  return { valid: true };
}

/**
 * Look up the primary agent for a task type.
 *
 * @param taskType - The task-type identifier.
 * @returns The primary agent name, or `undefined` if no rule exists.
 */
export function getPrimaryAgent(taskType: string): string | undefined {
  return ROUTING_MATRIX[taskType]?.primary;
}