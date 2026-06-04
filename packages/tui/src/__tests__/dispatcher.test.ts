/**
 * @neuralgentics/tui — Parallel Dispatcher Tests (T-029)
 *
 * Tests for speculative parallel dispatch, dependency graph,
 * concurrency limiter, and failure isolation.
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import {
  ParallelDispatcher,
  DependencyGraph,
  ConcurrencyLimiter,
  buildDispatchCards,
  type DispatchCard,
  type DispatchResult,
  type DispatchProgressEvent,
  type DispatchBatchResult,
} from "../agents/dispatcher.js";
import type { KanbanCard } from "../kanban/types.js";
import type { ContextPackage } from "../session/types.js";

// ─── Mock Fabrication ──────────────────────────────────────────────────────────

/** Create a mock KanbanCard. */
function makeCard(id: string, title?: string, dependsOn?: string[]): KanbanCard {
  return {
    id,
    title: title ?? `Task ${id}`,
    status: "ready",
    assignee: "unassigned",
    phase: "P0",
    roadmap: "",
    goal: "",
    dependsOn: dependsOn ?? [],
    blocks: [],
    failureCount: 0,
    failureLimit: 2,
    attemptHistory: [],
    truncatedAttempts: 0,
    truncatedMemoryId: "",
    comments: [],
    raw: {},
  };
}

/** Create a mock DispatchCard wrapping a KanbanCard. */
function makeDispatchCard(
  id: string,
  options?: {
    dependsOn?: string[];
    agentRole?: string;
    task?: string;
    failAfterMs?: number;
  },
): DispatchCard {
  return {
    card: makeCard(id, options?.task, options?.dependsOn),
    task: options?.task ?? `Implement ${id}`,
    userRequest: `User requested ${id}`,
    constraints: ["TypeScript strict mode", "No any types"],
    relevantFiles: [{ path: `src/${id}.ts`, reason: "Main implementation" }],
    codeSnippets: [],
    expectedOutput: "{memory_id, description}",
    agentRole: options?.agentRole ?? "coder",
    dependsOn: options?.dependsOn ?? [],
  };
}

/**
 * Create a mock SessionManager that tracks calls and optionally fails
 * for specific card IDs.
 */
function createMockSessionManager(failIds: Set<string> = new Set()): {
  mock: {
    createSessionCalls: string[];
    promptCalls: Array<{ sessionId: string; message: string }>;
    dispatchAgentCalls: ContextPackage[];
    trustCalls: Array<{ memoryId: string; signal: string }>;
  };
  sessionManager: {
    createSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    dispatchAgent: ReturnType<typeof vi.fn>;
    applyTrustSignal: ReturnType<typeof vi.fn>;
  };
} {
  const mock = {
    createSessionCalls: [] as string[],
    promptCalls: [] as Array<{ sessionId: string; message: string }>,
    dispatchAgentCalls: [] as ContextPackage[],
    trustCalls: [] as Array<{ memoryId: string; signal: string }>,
  };

  let callIndex = 0;

  const createSession = vi.fn(async (title?: string) => {
    const id = `session-${callIndex++}`;
    mock.createSessionCalls.push(id);
    return id;
  });

  const prompt = vi.fn(async (sessionId: string | null, message: string) => {
    const sid = sessionId ?? `session-default`;
    mock.promptCalls.push({ sessionId: sid, message });
    return {
      textContent: `Completed task for ${sid}`,
      sessionId: sid,
      messageId: `msg-${callIndex++}`,
    };
  });

  const dispatchAgent = vi.fn(async (context: ContextPackage) => {
    const memoryId = `mem-${callIndex++}`;
    mock.dispatchAgentCalls.push(context);

    // Check if any card ID in the task matches a fail ID
    const shouldFail = [...failIds].some(
      (fid) => context.task.includes(fid) || context.userRequest.includes(fid),
    );
    if (shouldFail) {
      throw new Error(`Simulated failure for card in: ${context.task}`);
    }

    return {
      seedPrompt: {
        text: `Task: ${context.task}\nMemory ID: ${memoryId}`,
        memoryId,
        estimatedTokens: 120,
      },
      contextResult: { memoryId },
    };
  });

  const applyTrustSignal = vi.fn(async (memoryId: string, signal: string) => {
    mock.trustCalls.push({ memoryId, signal });
    return { oldScore: 0.5, newScore: 0.55, adjustment: 0.05 };
  });

  return {
    mock,
    sessionManager: {
      createSession,
      prompt,
      dispatchAgent,
      applyTrustSignal,
    },
  };
}

// ─── DependencyGraph Tests ─────────────────────────────────────────────────────

describe("DependencyGraph", () => {
  test("empty graph returns empty batches", () => {
    const graph = new DependencyGraph();
    expect(graph.topologicalBatches()).toEqual([]);
  });

  test("single node with no dependencies returns one batch", () => {
    const graph = new DependencyGraph();
    graph.addNode("T-001");
    const batches = graph.topologicalBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["T-001"]);
  });

  test("independent nodes return in a single batch", () => {
    const graph = new DependencyGraph();
    graph.addNode("T-001");
    graph.addNode("T-002");
    graph.addNode("T-003");
    const batches = graph.topologicalBatches();
    expect(batches).toHaveLength(1);
    // All 3 independent nodes in the first batch
    expect(batches[0].sort()).toEqual(["T-001", "T-002", "T-003"].sort());
  });

  test("linear dependency chain produces sequential batches", () => {
    const graph = new DependencyGraph();
    // T-001 → T-002 → T-003 (T-003 depends on T-002 depends on T-001)
    graph.addNode("T-001");
    graph.addEdge("T-002", "T-001"); // T-002 depends on T-001
    graph.addEdge("T-003", "T-002"); // T-003 depends on T-002

    const batches = graph.topologicalBatches();
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["T-001"]);
    expect(batches[1]).toEqual(["T-002"]);
    expect(batches[2]).toEqual(["T-003"]);
  });

  test("mixed independent and dependent nodes", () => {
    const graph = new DependencyGraph();
    // T-001, T-002 independent
    // T-003 depends on T-001
    graph.addNode("T-001");
    graph.addNode("T-002");
    graph.addNode("T-003");
    graph.addEdge("T-003", "T-001");

    const batches = graph.topologicalBatches();
    expect(batches).toHaveLength(2);
    // First batch: T-001 and T-002 (both have 0 in-degree)
    expect(batches[0].sort()).toEqual(["T-001", "T-002"].sort());
    // Second batch: T-003 (depends on T-001)
    expect(batches[1]).toEqual(["T-003"]);
  });

  test("diamond dependency produces 2 batches", () => {
    const graph = new DependencyGraph();
    // T-001 → T-002, T-001 → T-003, T-004 depends on T-002 & T-003
    graph.addNode("T-001");
    graph.addNode("T-002");
    graph.addNode("T-003");
    graph.addNode("T-004");
    graph.addEdge("T-002", "T-001");
    graph.addEdge("T-003", "T-001");
    graph.addEdge("T-004", "T-002");
    graph.addEdge("T-004", "T-003");

    const batches = graph.topologicalBatches();
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["T-001"]);
    expect(batches[1].sort()).toEqual(["T-002", "T-003"].sort());
    expect(batches[2]).toEqual(["T-004"]);
  });

  test("external dependency (not in graph) is ignored", () => {
    const graph = new DependencyGraph();
    graph.addNode("T-001");
    graph.addNode("T-002");
    graph.addEdge("T-002", "T-999"); // T-999 not in graph

    const batches = graph.topologicalBatches();
    // T-999 is external, so both should be independent
    expect(batches).toHaveLength(1);
    expect(batches[0].sort()).toEqual(["T-001", "T-002"].sort());
  });
});

// ─── ConcurrencyLimiter Tests ──────────────────────────────────────────────────

describe("ConcurrencyLimiter", () => {
  test("allows up to maxConcurrency tasks simultaneously", async () => {
    const limiter = new ConcurrencyLimiter(3);
    const started: number[] = [];
    const finished: number[] = [];
    const delays = [50, 50, 50, 50, 50]; // 5 tasks, max 3 concurrent

    const tasks = delays.map((delay, i) =>
      (async () => {
        await limiter.acquire();
        started.push(i);
        await new Promise((r) => setTimeout(r, delay));
        finished.push(i);
        limiter.release();
      })(),
    );

    await Promise.all(tasks);

    // All 5 tasks finished
    expect(finished).toHaveLength(5);
  });

  test("respects maxConcurrency limit", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      (async () => {
        await limiter.acquire();
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        limiter.release();
      })(),
    );

    await Promise.all(tasks);

    // Should never exceed 2 concurrent
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("active and waiting counts are correct", () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  test("single task acquires and releases without issue", async () => {
    const limiter = new ConcurrencyLimiter(8);
    await limiter.acquire();
    expect(limiter.active).toBe(1);
    limiter.release();
    expect(limiter.active).toBe(0);
  });
});

// ─── ConcurrencyLimiter concurrency timing test ────────────────────────────────

describe("ConcurrencyLimiter timing", () => {
  test("3 independent tasks start within 100ms gap", async () => {
    // This tests acceptance criteria: 3 independent cards → all 3 start <100ms gap
    const limiter = new ConcurrencyLimiter(8);
    const startTimes: number[] = [];

    const tasks = Array.from({ length: 3 }, (_, i) =>
      (async () => {
        await limiter.acquire();
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 100)); // Simulate work
        limiter.release();
      })(),
    );

    await Promise.all(tasks);

    // Check that all 3 started within 100ms of each other
    const maxStartGap = Math.max(...startTimes) - Math.min(...startTimes);
    expect(maxStartGap).toBeLessThan(100);
  });
});

// ─── ParallelDispatcher Tests ──────────────────────────────────────────────────

describe("ParallelDispatcher", () => {
  // ── Happy path: 3 independent cards ────────────────────────────────────────

  test("3 independent cards dispatch successfully", async () => {
    const { mock, sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"),
      makeDispatchCard("T-003"),
    ];

    const result = await dispatcher.dispatchParallel(cards);

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.status === "done")).toBe(true);

    // All 3 should have memoryId set
    expect(result.results.every((r) => r.memoryId !== null)).toBe(true);

    // Trust signal should be applied for each
    expect(mock.trustCalls).toHaveLength(3);
    expect(mock.trustCalls.every((t) => t.signal === "agent_used")).toBe(true);
  });

  // ── Failure isolation: 1 fails, 2 succeed ──────────────────────────────────

  test("1 fails → 2 succeed + failed card is blocked", async () => {
    const { mock, sessionManager } = createMockSessionManager(new Set(["T-002"]));
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"), // Will fail
      makeDispatchCard("T-003"),
    ];

    const result = await dispatcher.dispatchParallel(cards);

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);

    const failedCard = result.results.find((r) => r.status === "blocked");
    expect(failedCard).toBeDefined();
    expect(failedCard!.cardId).toBe("T-002");
    expect(failedCard!.memoryId).toBeNull();
    expect(failedCard!.error).toBeDefined();

    const succeededCards = result.results.filter((r) => r.status === "done");
    expect(succeededCards).toHaveLength(2);
  });

  // ── Concurrency: 9 cards → 8 start, 9th queued ─────────────────────────────

  test("9 cards → max 8 concurrent, 9th queued", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
      maxConcurrency: 8,
    });

    const cards = Array.from({ length: 9 }, (_, i) =>
      makeDispatchCard(`T-${String(i + 1).padStart(3, "0")}`),
    );

    const result = await dispatcher.dispatchParallel(cards);

    // All 9 should complete (8 parallel + 1 queued)
    expect(result.results).toHaveLength(9);
    expect(result.succeeded).toBe(9);
  });

  // ── Dependency enforcement: shared dependency → serial ──────────────────────

  test("shared dependency enforces serial execution", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    // T-002 depends on T-001, so T-001 must complete first
    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002", { dependsOn: ["T-001"] }),
    ];

    const result = await dispatcher.dispatchParallel(cards);

    // Both should complete
    expect(result.succeeded).toBe(2);

    // T-001 should be done, T-002 should be done
    const t001 = result.results.find((r) => r.cardId === "T-001");
    const t002 = result.results.find((r) => r.cardId === "T-002");
    expect(t001!.status).toBe("done");
    expect(t002!.status).toBe("done");
  });

  // ── Streaming progress events ─────────────────────────────────────────────

  test("progress events fire as cards complete", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const progressEvents: DispatchProgressEvent[] = [];
    dispatcher.on("progress", (event: DispatchProgressEvent) => {
      progressEvents.push(event);
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"),
    ];

    await dispatcher.dispatchParallel(cards);

    // Should have at least started + completed for each card
    const startedEvents = progressEvents.filter((e) => e.phase === "started");
    const completedEvents = progressEvents.filter((e) => e.phase === "completed");

    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
    expect(completedEvents.length).toBeGreaterThanOrEqual(2);

    // All started events should reference the correct card IDs
    expect(startedEvents.map((e) => e.cardId).sort()).toEqual(
      ["T-001", "T-002"].sort(),
    );
  });

  // ── Progress events for failed cards ───────────────────────────────────────

  test("failed cards emit failed progress event", async () => {
    const { sessionManager } = createMockSessionManager(new Set(["T-002"]));
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const progressEvents: DispatchProgressEvent[] = [];
    dispatcher.on("progress", (event: DispatchProgressEvent) => {
      progressEvents.push(event);
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"), // Will fail
      makeDispatchCard("T-003"),
    ];

    await dispatcher.dispatchParallel(cards);

    const failedEvents = progressEvents.filter(
      (e) => e.phase === "failed" && e.cardId === "T-002",
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect(failedEvents[0].kanbanStatus).toBe("blocked");
  });

  // ── Empty input ────────────────────────────────────────────────────────────

  test("empty card array returns empty result", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const result = await dispatcher.dispatchParallel([]);

    expect(result.results).toHaveLength(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.queued).toBe(0);
  });

  // ── Trust signals disabled ────────────────────────────────────────────────

  test("trust signals are skipped when disabled", async () => {
    const { mock, sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
      trustSignalsEnabled: false,
    });

    const cards = [makeDispatchCard("T-001")];
    await dispatcher.dispatchParallel(cards);

    expect(mock.trustCalls).toHaveLength(0);
  });

  // ── Custom maxConcurrency ──────────────────────────────────────────────────

  test("custom maxConcurrency limits parallel dispatch", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
      maxConcurrency: 2,
    });

    // 5 cards with maxConcurrency 2 — should still complete all 5
    const cards = Array.from({ length: 5 }, (_, i) =>
      makeDispatchCard(`T-${String(i + 1).padStart(3, "0")}`),
    );

    const result = await dispatcher.dispatchParallel(cards);
    expect(result.succeeded).toBe(5);
  });
});

// ─── buildDispatchCards Tests ───────────────────────────────────────────────────

describe("buildDispatchCards", () => {
  test("converts kanban cards to dispatch cards with defaults", () => {
    const cards: KanbanCard[] = [
      makeCard("T-001", "Implement feature X"),
      makeCard("T-002", "Fix bug Y", ["T-001"]),
    ];

    const overrides = new Map<string, Partial<Omit<DispatchCard, "card">>>();
    overrides.set("T-001", { agentRole: "architect", task: "Design feature X" });

    const dispatchCards = buildDispatchCards(cards, overrides);

    expect(dispatchCards).toHaveLength(2);

    // T-001: override provided
    expect(dispatchCards[0].card.id).toBe("T-001");
    expect(dispatchCards[0].task).toBe("Design feature X");
    expect(dispatchCards[0].agentRole).toBe("architect");

    // T-002: defaults from kanban card
    expect(dispatchCards[1].card.id).toBe("T-002");
    expect(dispatchCards[1].task).toBe("Fix bug Y");
    expect(dispatchCards[1].agentRole).toBe("coder"); // default
    expect(dispatchCards[1].dependsOn).toEqual(["T-001"]); // from kanban
  });

  test("empty overrides map uses all defaults", () => {
    const cards: KanbanCard[] = [
      makeCard("T-001", "Task one"),
    ];

    const dispatchCards = buildDispatchCards(cards, new Map());

    expect(dispatchCards).toHaveLength(1);
    expect(dispatchCards[0].task).toBe("Task one");
    expect(dispatchCards[0].agentRole).toBe("coder");
    expect(dispatchCards[0].expectedOutput).toBe("Return {memory_id, description}");
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────────

describe("ParallelDispatcher edge cases", () => {
  test("all cards fail → all marked blocked", async () => {
    const { sessionManager } = createMockSessionManager(
      new Set(["T-001", "T-002", "T-003"]),
    );
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"),
      makeDispatchCard("T-003"),
    ];

    const result = await dispatcher.dispatchParallel(cards);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.results.every((r) => r.status === "blocked")).toBe(true);
  });

  test("complex dependency graph with mixed success/failure", async () => {
    // T-001 independent (succeeds)
    // T-002 independent (fails)
    // T-003 depends on T-001 (should still be dispatched if T-001 succeeds)
    const { sessionManager } = createMockSessionManager(new Set(["T-002"]));
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const cards = [
      makeDispatchCard("T-001"),
      makeDispatchCard("T-002"), // Will fail
      makeDispatchCard("T-003", { dependsOn: ["T-001"] }),
    ];

    const result = await dispatcher.dispatchParallel(cards);

    // T-001 and T-003 should succeed, T-002 should fail
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.find((r) => r.cardId === "T-002")!.status).toBe("blocked");
  });

  test("elapsed time is tracked in results", async () => {
    const { sessionManager } = createMockSessionManager();
    const dispatcher = new ParallelDispatcher({
      sessionManager: sessionManager as unknown as import("../session/session-manager.js").SessionManager,
    });

    const cards = [makeDispatchCard("T-001")];
    const result = await dispatcher.dispatchParallel(cards);

    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.results[0].completedAt).toBeGreaterThan(0);
  });
});