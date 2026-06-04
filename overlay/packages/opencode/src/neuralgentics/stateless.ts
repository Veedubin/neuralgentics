/**
 * Neuralgentics Stateless Agent Protocol.
 *
 * Each agent invocation is fully self-contained. The protocol prepares
 * a context package (storing it in memini-core) and returns a thin
 * reference that the agent can use to pull full context at runtime.
 * After execution, the agent stores a wrap-up record for audit/training.
 */

import type { ContextPackage } from "./types.js";
import { MemoryClient } from "./memory-client.js";

/**
 * Implements the Neuralgentics Stateless Agent Protocol.
 *
 * The protocol has two phases:
 * 1. **Prepare** — stores task context in memini-core and returns a
 *    `ContextPackage` referencing the stored memory.
 * 2. **Wrapup** — stores the agent's result alongside the original
 *    memory ID for later review, training, or trust scoring.
 */
export class StatelessProtocol {
  private memoryClient: MemoryClient;

  /**
   * Create a new StatelessProtocol.
   *
   * @param memoryClient - The MemoryClient used to interact with memini-core.
   */
  constructor(memoryClient: MemoryClient) {
    this.memoryClient = memoryClient;
  }

  /**
   * Prepare a context package for a stateless agent invocation.
   *
   * The method stores the task context as a memory record and returns
   * a `ContextPackage` containing the memory ID, a seed prompt that
   * instructs the agent to fetch context from memini-core, and the
   * task and agent metadata.
   *
   * @param task - Short description of the task to execute.
   * @param agent - Name of the agent that will receive this package.
   * @param previousMemoryId - Optional memory ID from a prior step to link contexts.
   * @returns A fully populated ContextPackage ready for injection.
   */
  async prepareContextPackage(
    task: string,
    agent: string,
    previousMemoryId?: string,
  ): Promise<ContextPackage> {
    const content = previousMemoryId
      ? `Task: ${task}\nPrevious context: ${previousMemoryId}`
      : `Task: ${task}`;

    const metadata: Record<string, unknown> = {
      agent,
      protocol: "stateless",
      timestamp: new Date().toISOString(),
    };

    if (previousMemoryId) {
      metadata.previousMemoryId = previousMemoryId;
    }

    const memoryId = await this.memoryClient.addMemory(content, metadata);

    const seedPrompt =
      `Task: ${task}\nMemory ID: ${memoryId}\n` +
      "Action: Fetch context from memini-core using the provided memory ID, then execute the task.";

    return {
      memoryId,
      seedPrompt,
      task,
      agent,
    };
  }

  /**
   * Store the result of a completed agent invocation.
   *
   * Links the result back to the original context memory for traceability.
   *
   * @param memoryId - The memory ID from the original ContextPackage.
   * @param result - The agent's output text.
   * @param metadata - Optional metadata (e.g. trust signal, duration).
   */
  async storeWrapup(
    memoryId: string,
    result: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const content = `Wrapup for memory ${memoryId}:\n${result}`;

    const wrapupMetadata: Record<string, unknown> = {
      ...(metadata ?? {}),
      protocol: "stateless-wrapup",
      sourceMemoryId: memoryId,
      timestamp: new Date().toISOString(),
    };

    await this.memoryClient.addMemory(content, wrapupMetadata);
  }
}