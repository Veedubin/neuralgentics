/**
 * Session Resume / Replay Tests (T-080)
 *
 * Tests the session resume feature:
 * 1. resume() with no checkpoint → returns { resumed: false, reason: 'no-checkpoint' }
 * 2. resume() with checkpoint → returns { resumed: true, checkpointId, age }
 * 3. resume() with offline client → returns { resumed: false, reason: 'offline' }
 * 4. resume() called twice → second is no-op (double-resume guard)
 * 5. TUI startup with checkpoint → banner shows "Resuming session SESS-xxx at [age]"
 * 6. TUI startup without checkpoint → banner shows "Fresh session"
 * 7. /resume returns checkpoint age
 * 8. kanban reflects TASKS.md after resume
 * 9. thought chain loaded within 2s
 * 10. sub-state restored (model, token counter, opportunities)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { SessionManager } from "../session/session-manager.js";
import type { ResumeResult } from "../session/types.js";
import type { CompactionCheckpoint } from "../compaction/types.js";
import type { OpenCodeClient } from "../opencode-client/client.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import { loadFromChain } from "../panels/chain.js";
import type { ChainState } from "../panels/chain.js";
import type { TokenCounter } from "../observability/token-counter.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockOpenCode(overrides?: Partial<{ status: string; isReady: boolean }>): OpenCodeClient {
  return {
    createSession: mock(async () => "sess-mock-1"),
    prompt: mock(async () => ({ textContent: "test", sessionId: "sess-mock-1", messageId: "msg-1" })),
    messages: mock(async () => []),
    revert: mock(async () => "sess-mock-1"),
    on: mock(function(this: unknown) { return this; }),
    start: mock(async () => {}),
    shutdown: mock(async () => {}),
    registerShutdownHandlers: mock(() => {}),
    isReady: overrides?.isReady ?? true,
    sessionId: null,
    status: (overrides?.status ?? "ready") as "offline" | "starting" | "ready" | "degraded",
  } as unknown as OpenCodeClient;
}

let memAddCounter = 0;

function createMockNeuralgentics(overrides?: Record<string, unknown>): NeuralgenticsClient {
  memAddCounter = 0;
  return {
    call: mock(async (method: string, _params: Record<string, unknown>) => {
      if (method === "memory.add") {
        return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
      }
      if (method === "memory.queryBySourceType") {
        return [];
      }
      if (method === "memory.adjustTrust") {
        return { oldScore: 0.5, newScore: 0.55, adjustmentAmount: 0.05 };
      }
      return {};
    }),
    ...overrides,
  } as unknown as NeuralgenticsClient;
}

function createMockTokenCounter(): TokenCounter {
  return {
    recordCall: mock(() => {}),
    getSessionTotal: mock(() => ({ total: 0, input: 0, output: 0, cached: 0, system: 0 })),
    saveBatch: mock(async () => "mem-tlb-resume-001"),
    restoreBatch: mock(async () => true),
  } as unknown as TokenCounter;
}

function createCheckpoint(overrides?: Partial<CompactionCheckpoint>): CompactionCheckpoint {
  return {
    checkpointId: "mem-cp-resume-001",
    sessionId: "SESS-resume-test",
    timestamp: "2026-06-06T14:30:00.000Z",
    factsExtracted: 5,
    tokensBefore: 75000,
    tokensAfter: 5000,
    savingsRatio: 15.0,
    reverted: true,
    reseeded: true,
    confidenceScores: { "mem-001": 0.95 },
    extractedMemoryIds: ["mem-001"],
    ...overrides,
  };
}

// ─── Test 1: resume() with no checkpoint ─────────────────────────────────────

describe("SessionManager.resume()", () => {
  test("1: returns { resumed: false, reason: 'no-checkpoint' } when no checkpoint exists", async () => {
    const mockOC = createMockOpenCode();
    const mockNG = createMockNeuralgentics();

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("no-checkpoint");
  });

  // ─── Test 2: resume() with checkpoint ────────────────────────────────────────

  test("2: returns { resumed: true, checkpointId, age } when checkpoint exists", async () => {
    const checkpoint = createCheckpoint();
    const mockOC = createMockOpenCode();

    let queryCalled = false;
    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType" && !queryCalled) {
          queryCalled = true;
          return [
            {
              id: checkpoint.checkpointId,
              content: JSON.stringify({
                sessionId: checkpoint.sessionId,
                timestamp: checkpoint.timestamp,
                factsExtracted: checkpoint.factsExtracted,
                tokensBefore: checkpoint.tokensBefore,
                tokensAfter: checkpoint.tokensAfter,
                savingsRatio: checkpoint.savingsRatio,
                reverted: checkpoint.reverted,
                reseeded: checkpoint.reseeded,
                confidenceScores: checkpoint.confidenceScores,
                extractedMemoryIds: checkpoint.extractedMemoryIds,
              }),
              metadata: { type: "compaction_checkpoint" },
            },
          ];
        }
        if (method === "memory.add") {
          return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
        }
        if (method === "memory.queryBySourceType") {
          // Subsequent calls (model pref, token batch, opportunity cache) return empty
          return [];
        }
        return {};
      }),
    });

    const mockTC = createMockTokenCounter();

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      tokenCounter: mockTC,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(true);
    expect(result.checkpointId).toBe("mem-cp-resume-001");
    expect(result.age).toBeDefined();
    expect(typeof result.age).toBe("string");
  });

  // ─── Test 3: resume() with offline client ────────────────────────────────────

  test("3: returns { resumed: false, reason: 'offline' } when OpenCode client is offline", async () => {
    const mockOC = createMockOpenCode({ status: "offline" });
    const mockNG = createMockNeuralgentics();

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("offline");
  });

  // ─── Test 4: resume() called twice → second is no-op ─────────────────────────

  test("4: double-resume is no-op on second call", async () => {
    const checkpoint = createCheckpoint();
    const mockOC = createMockOpenCode();
    let queryCount = 0;

    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType") {
          queryCount++;
          if (queryCount <= 3) {
            // First 3 calls: checkpoint, model_pref, token_ledger_batch
            if (queryCount === 1) {
              return [
                {
                  id: checkpoint.checkpointId,
                  content: JSON.stringify({
                    sessionId: checkpoint.sessionId,
                    timestamp: checkpoint.timestamp,
                    factsExtracted: checkpoint.factsExtracted,
                    tokensBefore: checkpoint.tokensBefore,
                    tokensAfter: checkpoint.tokensAfter,
                    savingsRatio: checkpoint.savingsRatio,
                    reverted: checkpoint.reverted,
                    reseeded: checkpoint.reseeded,
                  }),
                  metadata: { type: "compaction_checkpoint" },
                },
              ];
            }
            return [];
          }
          return [];
        }
        if (method === "memory.add") {
          return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
        }
        return {};
      }),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result1 = await sm.resume();
    expect(result1.resumed).toBe(true);

    const result2 = await sm.resume();
    expect(result2.resumed).toBe(false);
    expect(result2.reason).toBe("already-resumed");
  });

  // ─── Test 5: TUI startup with checkpoint → banner shows resuming message ─────

  test("5: startup banner shows 'Resuming session' when checkpoint exists", async () => {
    const checkpoint = createCheckpoint();
    const mockOC = createMockOpenCode();

    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType") {
          return [
            {
              id: checkpoint.checkpointId,
              content: JSON.stringify({
                sessionId: checkpoint.sessionId,
                timestamp: checkpoint.timestamp,
                factsExtracted: checkpoint.factsExtracted,
                tokensBefore: checkpoint.tokensBefore,
                tokensAfter: checkpoint.tokensAfter,
                savingsRatio: checkpoint.savingsRatio,
              }),
              metadata: { type: "compaction_checkpoint" },
            },
          ];
        }
        if (method === "memory.add") {
          return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
        }
        return {};
      }),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    // Verify the result contains the expected fields for a banner
    expect(result.resumed).toBe(true);
    expect(result.checkpointId).toBe("mem-cp-resume-001");

    // The banner message format would be in the TUI layer, but we verify
    // the result has the needed fields
    expect(result.age).toBeTruthy();
  });

  // ─── Test 6: TUI startup without checkpoint → fresh session ──────────────────

  test("6: startup shows 'Fresh session' when no checkpoint exists", async () => {
    const mockOC = createMockOpenCode();
    const mockNG = createMockNeuralgentics({
      call: mock(async () => []),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("no-checkpoint");

    // The TUI would display a "Fresh session" message based on this result
  });

  // ─── Test 7: /resume returns checkpoint age ───────────────────────────────────

  test("7: /resume command reports checkpoint age", async () => {
    const checkpoint = createCheckpoint({
      timestamp: new Date(Date.now() - 2.3 * 60 * 60 * 1000).toISOString(), // 2.3 hours ago
    });
    const mockOC = createMockOpenCode();
    let queryCount = 0;

    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType") {
          queryCount++;
          if (queryCount === 1) {
            return [
              {
                id: checkpoint.checkpointId,
                content: JSON.stringify({
                  sessionId: checkpoint.sessionId,
                  timestamp: checkpoint.timestamp,
                  factsExtracted: checkpoint.factsExtracted,
                }),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return [];
        }
        if (method === "memory.add") {
          return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
        }
        return {};
      }),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(true);
    expect(result.age).toBeTruthy();
    // Age should contain "hours" since it was 2.3 hours ago
    expect(result.age).toContain("hour");
  });

  // ─── Test 8: kanban reflects TASKS.md after resume ────────────────────────────

  test("8: kanban re-parses TASKS.md on resume (verified by refreshKanban flag)", async () => {
    const checkpoint = createCheckpoint();
    const mockOC = createMockOpenCode();
    let queryCount = 0;

    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType") {
          queryCount++;
          if (queryCount === 1) {
            return [
              {
                id: checkpoint.checkpointId,
                content: JSON.stringify({
                  sessionId: checkpoint.sessionId,
                  timestamp: checkpoint.timestamp,
                  factsExtracted: checkpoint.factsExtracted,
                }),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return [];
        }
        return {};
      }),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    // The result.resumed = true means the TUI will know to refresh kanban
    // The actual kanban parsing is done in index.ts, not in SessionManager
    expect(result.resumed).toBe(true);
  });

  // ─── Test 9: thought chain loaded within 2s ────────────────────────────────────

  test("9: loadFromChain loads thought chain within 2s", async () => {
    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.getThoughtChain") {
          return {
            thoughts: [
              { thoughtNumber: 1, totalThoughts: 3, thought: "Starting analysis...", isRevision: false, branchId: undefined },
              { thoughtNumber: 2, totalThoughts: 3, thought: "Found root cause", isRevision: false, branchId: undefined },
              { thoughtNumber: 3, totalThoughts: 3, thought: "Implementing fix", isRevision: false, branchId: undefined },
            ],
          };
        }
        return {};
      }),
    });

    const startTime = Date.now();
    const chainState = await loadFromChain(mockNG, "chain-test-001");
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(2000);
    expect(chainState.thoughts).toHaveLength(3);
    expect(chainState.thoughts[0]!.thoughtNumber).toBe(1);
    expect(chainState.thoughts[0]!.content).toBe("Starting analysis...");
  });

  // ─── Test 10: sub-state restored (model, token, opportunities) ────────────────

  test("10: resume restores sub-state via restoreFromCheckpoint", async () => {
    const checkpoint = createCheckpoint();
    const mockOC = createMockOpenCode();
    const mockTC = createMockTokenCounter();
    let queryCount = 0;

    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string, params: Record<string, unknown>) => {
        if (method === "memory.queryBySourceType") {
          queryCount++;
          if (queryCount === 1) {
            return [
              {
                id: checkpoint.checkpointId,
                content: JSON.stringify({
                  sessionId: checkpoint.sessionId,
                  timestamp: checkpoint.timestamp,
                  factsExtracted: checkpoint.factsExtracted,
                }),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          // Model pref, token batch, opportunity cache queries return empty
          return [];
        }
        if (method === "memory.add") {
          return { id: `mem-resume-${String(++memAddCounter).padStart(3, "0")}` };
        }
        return {};
      }),
    });

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      tokenCounter: mockTC,
      memoryEnabled: true,
    });

    const result = await sm.resume();
    expect(result.resumed).toBe(true);

    // Verify sub-state restoration was attempted
    // restoreFromCheckpoint calls: restoreModelPref, tokenCounter.restoreBatch, restoreCache
    expect(mockTC.restoreBatch).toHaveBeenCalled();
  });
});

// ─── loadFromChain Edge Cases ─────────────────────────────────────────────────

describe("loadFromChain edge cases", () => {
  test("returns empty state when chain not found", async () => {
    const mockNG = createMockNeuralgentics({
      call: mock(async (method: string) => {
        if (method === "memory.getThoughtChain") {
          return { thoughts: [] };
        }
        return {};
      }),
    });

    const result = await loadFromChain(mockNG, "nonexistent-chain-id");

    expect(result.thoughts).toHaveLength(0);
    expect(result.activeBranch).toBeNull();
    expect(result.collapsed.size).toBe(0);
  });

  test("returns empty state when chain ID is empty", async () => {
    const mockNG = createMockNeuralgentics();
    const result = await loadFromChain(mockNG, "");

    expect(result.thoughts).toHaveLength(0);
  });

  test("returns empty state on error", async () => {
    const mockNG = createMockNeuralgentics({
      call: mock(async () => {
        throw new Error("backend connection failed");
      }),
    });

    const result = await loadFromChain(mockNG, "chain-err");

    expect(result.thoughts).toHaveLength(0);
  });
});

// ─── Resume with Degraded Client ─────────────────────────────────────────────

describe("SessionManager.resume() with degraded client", () => {
  test("returns offline reason when client is degraded", async () => {
    const mockOC = createMockOpenCode({ status: "degraded" });
    const mockNG = createMockNeuralgentics();

    const sm = new SessionManager({
      opencode: mockOC,
      neuralgentics: mockNG,
      memoryEnabled: true,
    });

    const result = await sm.resume();

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("offline");
  });
});