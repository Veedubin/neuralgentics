/**
 * Neuralgentics Orchestrator — main hook into OpenCode's agent lifecycle.
 *
 * The orchestrator injects identity strings into system prompts, validates
 * routing decisions against the mandatory matrix, and exposes the list of
 * available Neuralgentics agents.
 *
 * The orchestrator now communicates with the Go backend via JSON-RPC over
 * stdio (GoBackendClient), replacing the previous HTTP transport to the
 * Python memini-core server.
 */

import type { AgentDefinition, RoutingRule } from "./types.js";
import { ROUTING_MATRIX, validateAgentRouting } from "./routing.js";
import { MemoryClient } from "./memory-client.js";
import { GoBackendClient } from "./go-backend-client.js";
import { StatelessProtocol } from "./stateless.js";

/**
 * Identity string injected into every agent's system prompt.
 */
const NEURALGENTICS_IDENTITY =
  "You are Neuralgentics, powered by OpenCode. Follow the Neuralgentics Stateless Agent Protocol. All tasks MUST go through the routing matrix.";

/**
 * The canonical Neuralgentics agent roster.
 *
 * Each entry matches the routing matrix so that the orchestrator can
 * look up agent capabilities and dispatch tasks correctly.
 */
const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: "neuralgentics-coder",
    description: "Fast code generation and bug-fix agent.",
    model: "glm-5.1:cloud",
    mode: "subagent",
    steps: 50,
  },
  {
    name: "neuralgentics-architect",
    description: "Design decisions and architecture review agent.",
    model: "deepseek-v4-pro:cloud",
    mode: "subagent",
    steps: 100,
  },
  {
    name: "neuralgentics-explorer",
    description: "Codebase exploration and file-finding agent.",
    model: "devstral-2:123b-cloud",
    mode: "subagent",
    steps: 30,
  },
  {
    name: "neuralgentics-tester",
    description: "Test writing and execution agent.",
    model: "deepseek-v4-flash:cloud",
    mode: "subagent",
    steps: 50,
  },
  {
    name: "neuralgentics-linter",
    description: "Linting, formatting, and style enforcement agent.",
    model: "qwen3-coder-next:cloud",
    mode: "subagent",
    steps: 30,
  },
  {
    name: "neuralgentics-git",
    description: "Version control and git operations agent.",
    model: "minimax-m2.7:cloud",
    mode: "subagent",
    steps: 30,
  },
  {
    name: "neuralgentics-writer",
    description: "Documentation and Markdown writing agent.",
    model: "gemma4:31b-cloud",
    mode: "subagent",
    steps: 50,
  },
  {
    name: "neuralgentics-researcher",
    description: "Web research and data extraction agent.",
    model: "kimi-k2.6:cloud",
    mode: "subagent",
    steps: 50,
  },
];

/**
 * The main orchestrator class for Neuralgentics within OpenCode.
 *
 * Provides three core hooks:
 * 1. **injectSystemPrompt** — appends Neuralgentics identity to agent prompts.
 * 2. **validateRouting** — enforces the mandatory routing matrix.
 * 3. **getAgentList** — returns the full roster of Neuralgentics agents.
 */
export class NeuralgenticsOrchestrator {
  private routing: typeof ROUTING_MATRIX;
  private stateless: StatelessProtocol;
  private memoryClient: MemoryClient;

  /**
   * Create a new NeuralgenticsOrchestrator.
   *
   * @param backend - One of:
   *   - A `GoBackendClient` instance (useful for testing with a mock).
   *   - A string path to the `neuralgentics-backend` binary.
   *   - `undefined` to auto-resolve from env / $PATH.
   */
  constructor(backend?: GoBackendClient | string) {
    this.memoryClient = new MemoryClient(backend);
    this.stateless = new StatelessProtocol(this.memoryClient);
    this.routing = ROUTING_MATRIX;
  }

  /**
   * Inject the Neuralgentics identity string into an agent's system prompt.
   *
   * The identity string is appended to the existing system prompt array.
   *
   * @param system - The mutable system prompt array to modify in-place.
   * @param _agent - The agent configuration (reserved for future use).
   * @param _session - The active session object (reserved for future use).
   */
  injectSystemPrompt(
    system: string[],
    _agent: unknown,
    _session?: unknown,
  ): void {
    system.push(NEURALGENTICS_IDENTITY);
  }

  /**
   * Validate that a proposed agent assignment conforms to the routing matrix.
   *
   * @param params - Object containing the subagent type and optional parent/tasks.
   * @returns An error string if routing is violated, or `undefined` if valid.
   */
  validateRouting(params: {
    subagentType: string;
    parentAgent?: string;
    tasks?: unknown[];
  }): string | void {
    const { subagentType } = params;
    const taskType = subagentType;

    // Check against every routing rule for the "never" list.
    for (const [type, rule] of Object.entries(this.routing) as [string, RoutingRule][]) {
      if (rule.never.includes(subagentType)) {
        const result = validateAgentRouting(type, subagentType);
        if (!result.valid) {
          return result.reason;
        }
      }
    }

    // Also validate that the specific task type is known.
    const result = validateAgentRouting(taskType, subagentType);
    if (!result.valid) {
      return result.reason;
    }

    return undefined;
  }

  /**
   * Return the full list of Neuralgentics agent definitions.
   *
   * @returns An array of AgentDefinition objects.
   */
  getAgentList(): AgentDefinition[] {
    return [...AGENT_DEFINITIONS];
  }
}