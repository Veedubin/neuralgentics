/**
 * @neuralgentics/tui — Speculative Parallel Dispatch (T-029)
 *
 * Fires up to 8 sub-agents simultaneously, merges results, no serial bottleneck.
 * Uses the stateless agent protocol: each sub-agent receives a memory_id context
 * package via NeuralgenticsClient, returns {memory_id, description}.
 *
 * Key features:
 * - Max 8 simultaneous dispatches (configurable)
 * - Promise.allSettled for failure isolation (1 fails → others continue)
 * - Topological sort for shared dependency serial enforcement
 * - Streaming progress events as each card completes
 * - Failed cards are marked "blocked" and reported
 */

import { EventEmitter } from "node:events";
import { SessionManager } from "../session/session-manager.js";
import { getModelForTask, type TaskType } from "./model-registry.js";
import type { ContextPackage } from "../session/types.js";
import type { KanbanCard, KanbanStatus } from "../kanban/types.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "../kanban/circuit-breaker.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A card ready for dispatch, wrapping a KanbanCard with dispatch context. */
export interface DispatchCard {
  /** The kanban card to dispatch (must have an id like "T-029"). */
  card: KanbanCard;
  /** The task description for the sub-agent. */
  task: string;
  /** The original user request (verbatim). */
  userRequest: string;
  /** Constraints for the sub-agent (file exclusions, style, etc). */
  constraints: string[];
  /** Relevant file paths with explanations. */
  relevantFiles: Array<{ path: string; reason: string }>;
  /** Code snippets for context. */
  codeSnippets: Array<{ file: string; snippet: string }>;
  /** Expected output format description. */
  expectedOutput: string;
  /** Agent role to route to (determines which model). */
  agentRole: TaskType | string;
  /** Card IDs this card depends on (shared deps → serial enforced). */
  dependsOn: string[];
  /** Optional model ID override (skips model-registry routing). */
  modelOverride?: string;
}

/** Result of dispatching a single card. */
export interface DispatchResult {
  /** The kanban card ID (e.g. "T-029"). */
  cardId: string;
  /** Final status: "done" on success, "blocked" on failure, "archived" if circuit breaker tripped. */
  status: "done" | "blocked" | "archived";
  /** Memory ID returned by the sub-agent (null on failure). */
  memoryId: string | null;
  /** Human-readable description of what was accomplished. */
  description: string;
  /** Error details if the card was blocked. */
  error?: string;
  /** Timestamp when this result was produced. */
  completedAt: number;
}

/** Progress event emitted during dispatch. */
export interface DispatchProgressEvent {
  /** The card ID that just completed or changed status. */
  cardId: string;
  /** Current phase of dispatch. */
  phase: "queued" | "started" | "completed" | "failed" | "blocked";
  /** The kanban status to move this card to. */
  kanbanStatus: KanbanStatus;
  /** Optional human-readable progress message. */
  message?: string;
  /** Elapsed ms since dispatch started. */
  elapsedMs: number;
}

/** Configuration for the ParallelDispatcher. */
export interface ParallelDispatcherOptions {
  /** Maximum number of concurrent sub-agent dispatches. Default: 8. */
  maxConcurrency?: number;
  /** Whether to apply trust signals on completion. Default: true. */
  trustSignalsEnabled?: boolean;
  /** Whether to store results in memory. Default: true. */
  memoryEnabled?: boolean;
  /** Circuit breaker options. If provided, a CircuitBreaker is created and
   *  wired into the dispatcher for failure tracking and auto-block/archive. */
  circuitBreaker?: CircuitBreakerOptions;
}

/** Merged results from a full dispatch run. */
export interface DispatchBatchResult {
  /** All individual results, in the order cards were provided. */
  results: DispatchResult[];
  /** Number of cards that completed successfully. */
  succeeded: number;
  /** Number of cards that were blocked or archived (failed). */
  failed: number;
  /** Number of cards that were auto-archived by circuit breaker. */
  archived: number;
  /** Number of cards that were queued but not started (beyond maxConcurrency). */
  queued: number;
  /** Total elapsed time in ms. */
  elapsedMs: number;
}

// ─── Dependency Graph ──────────────────────────────────────────────────────────

/**
 * Topological sort for dispatch ordering.
 *
 * Cards with shared dependencies are placed in the same batch (serialized).
 * Cards with no cross-dependencies can run in parallel.
 */
export class DependencyGraph {
  private adjacency = new Map<string, Set<string>>();
  private nodes = new Set<string>();

  /** Add a dependency edge: `from` depends on `on` (must complete before `from`). */
  addEdge(from: string, on: string): void {
    this.nodes.add(from);
    // Only add `on` to the graph if it was explicitly added via addNode.
    // External dependencies (not in dispatch set) should not be in nodes.
    this.adjacency.set(from, this.adjacency.get(from) ?? new Set());
    this.adjacency.get(from)!.add(on);
  }

  /** Add a node with no dependencies. */
  addNode(id: string): void {
    this.nodes.add(id);
    if (!this.adjacency.has(id)) {
      this.adjacency.set(id, new Set());
    }
  }

  /**
   * Return batches of card IDs where each batch can run in parallel,
   * but batches must be executed in order (sequential between batches).
   *
   * Uses Kahn's algorithm for topological sort, then groups nodes
   * by their "depth" level (nodes at the same depth can run in parallel).
   */
  topologicalBatches(): string[][] {
    if (this.nodes.size === 0) return [];

    // Kahn's algorithm: compute in-degrees
    const inDegree = new Map<string, number>();
    for (const node of this.nodes) {
      inDegree.set(node, 0);
    }
    for (const [, deps] of this.adjacency) {
      for (const dep of deps) {
        // If dep is an external node not in our graph, skip
        if (this.nodes.has(dep)) {
          // from depends on dep, so dep → from edge means from has in-degree +1
          // Actually: if A depends on B, then B must complete before A.
          // Edge direction: B → A means A has higher in-degree.
          // But our adjacency stores "from depends on on", so "from" has an edge TO "on".
          // In terms of topological sort: "on" should come before "from".
          // So we need to reverse: "on" is a prerequisite of "from".
        }
      }
    }

    // Rebuild in-degree: for each node, count how many of its dependencies are in the graph
    for (const node of this.nodes) {
      const deps = this.adjacency.get(node) ?? new Set();
      let count = 0;
      for (const dep of deps) {
        if (this.nodes.has(dep)) {
          count++;
        }
      }
      inDegree.set(node, count);
    }

    const batches: string[][] = [];
    const visited = new Set<string>();

    // Level-by-level BFS (Kahn's)
    while (visited.size < this.nodes.size) {
      // Find all nodes with in-degree 0 that haven't been visited
      const batch: string[] = [];
      for (const node of this.nodes) {
        if (!visited.has(node) && (inDegree.get(node) ?? 0) === 0) {
          batch.push(node);
        }
      }

      if (batch.length === 0) {
        // Cycle detected — shouldn't happen with proper deps, but break to avoid infinite loop
        // Put remaining nodes in the last batch
        const remaining = Array.from(this.nodes).filter((n) => !visited.has(n));
        if (remaining.length > 0) {
          batches.push(remaining);
        }
        break;
      }

      batches.push(batch);

      // Mark as visited and reduce in-degree of dependents
      for (const node of batch) {
        visited.add(node);
      }

      // Reduce in-degree for nodes that depend on completed batch nodes
      for (const node of this.nodes) {
        if (visited.has(node)) continue;
        const deps = this.adjacency.get(node) ?? new Set();
        for (const dep of deps) {
          if (batch.includes(dep)) {
            const current = inDegree.get(node) ?? 0;
            inDegree.set(node, Math.max(0, current - 1));
          }
        }
      }
    }

    return batches;
  }
}

// ─── Concurrency Limiter ──────────────────────────────────────────────────────

/**
 * Semaphore-style concurrency limiter for sub-agent dispatches.
 * Ensures no more than `maxConcurrency` promises run at the same time.
 */
export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<{ resolve: () => void }> = [];

  constructor(private readonly maxConcurrency: number) {}

  /** Acquire a slot. Resolves when a slot is available. */
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  /** Release a slot. Unblocks the next queued item. */
  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      next.resolve();
    }
  }

  /** Number of currently running tasks. */
  get active(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue. */
  get waiting(): number {
    return this.queue.length;
  }
}

// ─── Parallel Dispatcher ──────────────────────────────────────────────────────

/**
 * ParallelDispatcher — fires up to N sub-agents simultaneously with
 * failure isolation and streaming progress.
 *
 * Usage:
 * ```ts
 * const dispatcher = new ParallelDispatcher({
 *   sessionManager,
 *   maxConcurrency: 8,
 * });
 *
 * dispatcher.on("progress", (event) => {
 *   updateKanbanPanel(event.cardId, event.kanbanStatus);
 * });
 *
 * const result = await dispatcher.dispatchParallel(cards);
 * console.log(`Succeeded: ${result.succeeded}, Failed: ${result.failed}`);
 * ```
 */
export class ParallelDispatcher extends EventEmitter {
  private readonly sessionManager: SessionManager;
  private readonly maxConcurrency: number;
  private readonly trustSignalsEnabled: boolean;
  private readonly memoryEnabled: boolean;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(
    options: {
      sessionManager: SessionManager;
    } & ParallelDispatcherOptions,
  ) {
    super();
    this.sessionManager = options.sessionManager;
    this.maxConcurrency = options.maxConcurrency ?? 8;
    this.trustSignalsEnabled = options.trustSignalsEnabled ?? true;
    this.memoryEnabled = options.memoryEnabled ?? true;
    this.circuitBreaker = new CircuitBreaker(options.circuitBreaker);
  }

  /**
   * Dispatch multiple cards in parallel with dependency ordering.
   *
   * 1. Build a dependency graph from each card's `dependsOn` field.
   * 2. Topologically sort into batches (same-batch = parallel, inter-batch = serial).
   * 3. Within each batch, fire all sub-agents simultaneously (up to maxConcurrency).
   * 4. Use Promise.allSettled for failure isolation.
   * 5. Emit progress events as each card completes.
   * 6. Return merged results.
   */
  async dispatchParallel(cards: DispatchCard[]): Promise<DispatchBatchResult> {
    const startTime = Date.now();
    const results = new Map<string, DispatchResult>();

    if (cards.length === 0) {
      return {
        results: [],
        succeeded: 0,
        failed: 0,
        archived: 0,
        queued: 0,
        elapsedMs: 0,
      };
    }

    // ── Step 1: Build dependency graph ────────────────────────────────────
    const graph = new DependencyGraph();
    const cardMap = new Map<string, DispatchCard>();

    for (const card of cards) {
      cardMap.set(card.card.id, card);
      graph.addNode(card.card.id);
      for (const dep of card.dependsOn) {
        // If the dependency is also in our dispatch set, add an edge
        if (cards.some((c) => c.card.id === dep)) {
          graph.addEdge(card.card.id, dep);
        }
        // External deps are ignored — they're assumed already done
      }
    }

    // ── Step 2: Get topological batches ───────────────────────────────────
    const batches = graph.topologicalBatches();

    // ── Step 3: Execute batches sequentially, cards within batch in parallel ──
    for (const batch of batches) {
      const batchCards = batch
        .map((id) => cardMap.get(id))
        .filter((c): c is DispatchCard => c !== undefined);

      const batchResults = await this.dispatchBatch(batchCards);
      for (const result of batchResults) {
        results.set(result.cardId, result);
      }
    }

    // ── Step 4: Assemble final result ─────────────────────────────────────
    const orderedResults = cards.map((card) => {
      const result = results.get(card.card.id);
      if (!result) {
        // Card was never dispatched (e.g., dependency failed upstream)
        return {
          cardId: card.card.id,
          status: "blocked" as const,
          memoryId: null,
          description: "Card not dispatched — dependency chain broken",
          completedAt: Date.now(),
        };
      }
      return result;
    });

    const succeeded = orderedResults.filter((r) => r.status === "done").length;
    const failed = orderedResults.filter((r) => r.status === "blocked" || r.status === "archived").length;
    const archived = orderedResults.filter((r) => r.status === "archived").length;
    const queued = orderedResults.filter((r) => r.status === "blocked" && r.error?.includes("not dispatched")).length;

    return {
      results: orderedResults,
      succeeded,
      failed,
      archived,
      queued,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Dispatch a batch of independent cards in parallel.
   * Uses Promise.allSettled for failure isolation.
   * Respects maxConcurrency via ConcurrencyLimiter.
   */
  private async dispatchBatch(cards: DispatchCard[]): Promise<DispatchResult[]> {
    const limiter = new ConcurrencyLimiter(this.maxConcurrency);

    const dispatchPromises = cards.map((card) =>
      this.dispatchSingleCard(card, limiter),
    );

    const settled = await Promise.allSettled(dispatchPromises);

    return settled.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // Promise.allSettled rejected — this shouldn't happen with our try/catch,
      // but handle it defensively
      const card = cards[index];
      return {
        cardId: card.card.id,
        status: "blocked" as const,
        memoryId: null,
        description: `Unexpected failure: ${result.reason?.message ?? String(result.reason)}`,
        error: result.reason?.message ?? String(result.reason),
        completedAt: Date.now(),
      };
    });
  }

  /**
   * Dispatch a single card through the stateless agent protocol.
   *
   * 1. Store the context package in Neuralgentics memory
   * 2. Generate a seed prompt referencing the memory_id
   * 3. Create a session via SessionManager
   * 4. Send the seed prompt to the session
   * 5. Apply trust signal on success
   * 6. Return {memoryId, description}
   */
  private async dispatchSingleCard(
    card: DispatchCard,
    limiter: ConcurrencyLimiter,
  ): Promise<DispatchResult> {
    const startTime = Date.now();

    await limiter.acquire();

    // Emit "started" progress event
    this.emit("progress", {
      cardId: card.card.id,
      phase: "started" as const,
      kanbanStatus: "running" as KanbanStatus,
      message: `Dispatching ${card.card.id}: ${card.task.slice(0, 60)}...`,
      elapsedMs: Date.now() - startTime,
    });

    try {
      // ── Build context package ─────────────────────────────────────────
      const contextPackage: ContextPackage = {
        task: card.task,
        userRequest: card.userRequest,
        constraints: card.constraints,
        relevantFiles: card.relevantFiles,
        codeSnippets: card.codeSnippets,
        expectedOutput: card.expectedOutput,
        targetAgent: card.agentRole,
        createdAt: Date.now(),
      };

      // ── Determine model routing ───────────────────────────────────────
      const modelResolution = getModelForTask(card.agentRole, card.modelOverride);

      // ── Store context in Neuralgentics memory ──────────────────────────
      const { seedPrompt, contextResult } = await this.sessionManager.dispatchAgent(
        contextPackage,
      );

      // ── Create session and dispatch prompt ─────────────────────────────
      const sessionId = await this.sessionManager.createSession(
        `Neuralgentics ${card.card.id}: ${card.task.slice(0, 50)}`,
      );

      const promptResult = await this.sessionManager.prompt(
        sessionId,
        seedPrompt.text,
        {
          sessionTitle: `${card.card.id}: ${card.agentRole}`,
          storeInMemory: this.memoryEnabled,
        },
      );

      // ── Apply trust signal on success ──────────────────────────────────
      if (this.trustSignalsEnabled) {
        await this.sessionManager.applyTrustSignal(
          contextResult.memoryId,
          "agent_used",
        );
      }

      // ── Record success via circuit breaker ───────────────────────────────
      const cbResult = this.circuitBreaker.recordSuccess(
        card.card,
        card.agentRole,
        0, // Token count will be filled in by token accountant (P1-b)
        contextResult.memoryId,
      );

      // ── Emit completion progress ──────────────────────────────────────
      this.emit("progress", {
        cardId: card.card.id,
        phase: "completed" as const,
        kanbanStatus: "done" as KanbanStatus,
        message: `Completed ${card.card.id} via ${modelResolution.modelId}`,
        elapsedMs: Date.now() - startTime,
      });

      return {
        cardId: card.card.id,
        status: "done" as const,
        memoryId: contextResult.memoryId,
        description: promptResult.textContent.slice(0, 500),
        completedAt: Date.now(),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // ── Record failure via circuit breaker ───────────────────────────────
      const cbResult = this.circuitBreaker.recordFailure(
        card.card,
        card.agentRole,
        errorMsg,
        0, // Token count will be filled in by token accountant (P1-b)
        "", // No memory ID on failure — the wrap-up may or may not have been stored
      );

      // ── Emit failure progress ──────────────────────────────────────────
      this.emit("progress", {
        cardId: card.card.id,
        phase: "failed" as const,
        kanbanStatus: cbResult.newStatus,
        message: `Failed ${card.card.id}: ${errorMsg} (${cbResult.reason})`,
        elapsedMs: Date.now() - startTime,
      });

      return {
        cardId: card.card.id,
        status: cbResult.newStatus as "blocked" | "archived",
        memoryId: null,
        description: `Failed: ${errorMsg}`,
        error: `${errorMsg} — ${cbResult.reason}`,
        completedAt: Date.now(),
      };
    } finally {
      limiter.release();
    }
  }
}

// ─── Utility: Build DispatchCards from KanbanBoard ─────────────────────────────

/**
 * Convert kanban cards ready for dispatch into DispatchCard objects.
 *
 * This is a convenience function that maps kanban cards to their
 * dispatch-ready form. The caller must still fill in agentRole and
 * other dispatch-specific fields.
 *
 * @param cards - Kanban cards in "ready" status
 * @param overrides - Per-card overrides (task, agentRole, etc.)
 * @returns DispatchCard objects ready for dispatchParallel
 */
export function buildDispatchCards(
  cards: KanbanCard[],
  overrides: Map<string, Partial<Omit<DispatchCard, "card">>>,
): DispatchCard[] {
  return cards.map((card) => {
    const override = overrides.get(card.id) ?? {};
    return {
      card,
      task: override.task ?? card.title,
      userRequest: override.userRequest ?? card.title,
      constraints: override.constraints ?? [],
      relevantFiles: override.relevantFiles ?? [],
      codeSnippets: override.codeSnippets ?? [],
      expectedOutput: override.expectedOutput ?? "Return {memory_id, description}",
      agentRole: override.agentRole ?? "coder",
      dependsOn: override.dependsOn ?? card.dependsOn,
      modelOverride: override.modelOverride,
    };
  });
}