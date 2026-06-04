/**
 * Neuralgentics Memory Client — thin wrapper over GoBackendClient.
 *
 * Routes all memory and thought-chain operations through the Go backend
 * via JSON-RPC over stdio (child process).  This replaces the previous
 * HTTP transport to the Python memini-core server, achieving sub-millisecond
 * latency on the same machine with zero port management.
 *
 * The underlying `GoBackendClient` spawns the `neuralgentics-backend` binary
 * and communicates via newline-delimited JSON-RPC 2.0.
 */

import type { MemoryRecord } from "./types.js";
import { GoBackendClient } from "./go-backend-client.js";

/** Resolve the Go backend binary path from env var or fallback. */
function resolveBinaryPath(): string {
  if (process.env.NEURALGENTICS_BACKEND_PATH) {
    return process.env.NEURALGENTICS_BACKEND_PATH;
  }
  return "neuralgentics-backend";
}

/**
 * High-level client for Neuralgentics memory operations.
 *
 * Delegates to a `GoBackendClient` instance that talks to the Go backend
 * over stdio.  Consumers can supply their own `GoBackendClient` instance
 * (useful for testing with a mock) or let this class create one
 * automatically.
 */
export class MemoryClient {
  private backend: GoBackendClient;

  /**
   * Create a new MemoryClient.
   *
   * @param backendOrPath - One of:
   *   - A `GoBackendClient` instance (typically a mock in tests).
   *   - A string path to the `neuralgentics-backend` binary.
   *   - `undefined` to auto-resolve from `NEURALGENTICS_BACKEND_PATH` env
   *     or fall back to `"neuralgentics-backend"` (looked up on $PATH).
   */
  constructor(backendOrPath?: GoBackendClient | string) {
    if (backendOrPath instanceof GoBackendClient) {
      this.backend = backendOrPath;
    } else {
      const path = backendOrPath ?? resolveBinaryPath();
      this.backend = new GoBackendClient(path);
    }
  }

  // ---------------------------------------------------------------
  // Memory operations
  // ---------------------------------------------------------------

  /**
   * Store a new memory entry via the Go backend.
   *
   * @param content - The memory text to store.
   * @param metadata - Optional key-value metadata attached to the memory.
   * @returns The ID of the newly created memory record.
   */
  async addMemory(
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.backend.call("memory.add", {
      content,
      metadata,
    })) as { id: string };
    return result.id;
  }

  /**
   * Query memories via semantic search through the Go backend.
   *
   * @param query - Natural-language search string.
   * @param limit - Maximum number of results to return (default 10).
   * @returns An array of matching memory records.
   */
  async queryMemories(
    query: string,
    limit: number = 10,
  ): Promise<MemoryRecord[]> {
    return this.backend.call("memory.query", { query, limit }) as Promise<
      MemoryRecord[]
    >;
  }

  // ---------------------------------------------------------------
  // Thought-chain operations
  // ---------------------------------------------------------------

  /**
   * Add a thought to an existing (or new) thought chain.
   *
   * @param thought - The thought text.
   * @param thoughtNumber - 1-based index of this thought within the chain.
   * @param totalThoughts - Expected total number of thoughts.
   * @param nextThoughtNeeded - Whether more thoughts follow after this one.
   * @param chainId - Existing chain UUID to continue, or undefined to auto-create.
   * @returns The chain ID (useful when auto-creating).
   */
  async addThought(
    thought: string,
    thoughtNumber: number,
    totalThoughts: number,
    nextThoughtNeeded: boolean,
    chainId?: string,
  ): Promise<string> {
    const params: Record<string, unknown> = {
      thought,
      thoughtNumber,
      totalThoughts,
      nextThoughtNeeded,
    };
    if (chainId !== undefined) {
      params.chainId = chainId;
    }

    const result = (await this.backend.call(
      "thought.add",
      params,
    )) as { chainId: string };
    return result.chainId;
  }

  /**
   * Start a new thought chain and return its UUID.
   *
   * @returns The UUID of the newly created thought chain.
   */
  async startThoughtChain(): Promise<string> {
    const result = (await this.backend.call("thought.startChain", {})) as {
      chainId: string;
    };
    return result.chainId;
  }
}