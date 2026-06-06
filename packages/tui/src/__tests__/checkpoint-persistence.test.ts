/**
 * Checkpoint Persistence Tests (T-079)
 *
 * Tests the compaction checkpoint persistence feature:
 * - writeCheckpoint: serializes and stores a checkpoint
 * - loadLastCheckpoint: retrieves the most recent checkpoint
 * - Round-trip: write then read back preserves all fields
 * - Missing checkpoint: returns null gracefully
 * - Corrupted JSON: returns null with warning (graceful degradation)
 * - restoreFromCheckpoint: repopulates session state
 * - Invalid JSON in loadLastCheckpoint: handles gracefully
 * - Empty confidenceScores and extractedMemoryIds
 * - Concurrent checkpoint writes
 * - Checkpoint does NOT duplicate facts (references by ID)
 * - Most recent checkpoint returned when multiple exist
 * - Checkpoint with all primitive field types round-trips correctly
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { writeCheckpoint, loadLastCheckpoint } from "../compaction/writer.js";
import type { CompactionCheckpoint, CompactionDependencies } from "../compaction/types.js";
import { SessionManager } from "../session/session-manager.js";
import type { CompactionResult } from "../compaction/types.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockDeps(overrides?: Partial<CompactionDependencies>): CompactionDependencies {
  let memAddCounter = 0;
  return {
    neuralgentics: {
      call: mock(async (method: string, _params: Record<string, unknown>) => {
        if (method === "memory.add") {
          return { id: `mem-cp-${String(++memAddCounter).padStart(3, "0")}` };
        }
        if (method === "memory.queryBySourceType") {
          return [];
        }
        return {};
      }),
    },
    session: {
      revert: mock(async () => ({ sessionId: "sess-test", messagesRemoved: 10 })),
      messages: mock(async () => []),
      sessionId: "sess-test",
      status: "active",
    },
    reseed: mock(async () => ({ totalTokens: 1200 })),
    getTokenCount: () => ({ used: 75000, limit: 100000 }),
    isModelAvailable: mock(async () => true),
    callExtractionModel: mock(async () => JSON.stringify({ facts: [] })),
    ...overrides,
  };
}

function createCheckpointData(
  overrides?: Partial<Omit<CompactionCheckpoint, "checkpointId">>,
): Omit<CompactionCheckpoint, "checkpointId"> {
  return {
    sessionId: "sess-abc123",
    timestamp: "2026-06-06T12:00:00.000Z",
    factsExtracted: 5,
    tokensBefore: 75000,
    tokensAfter: 5000,
    savingsRatio: 15.0,
    reverted: true,
    reseeded: true,
    confidenceScores: {
      "mem-001": 0.95,
      "mem-002": 0.88,
      "mem-003": 0.72,
      "mem-004": 0.91,
      "mem-005": 0.65,
    },
    extractedMemoryIds: ["mem-001", "mem-002", "mem-003", "mem-004", "mem-005"],
    ...overrides,
  };
}

// ─── writeCheckpoint Tests ────────────────────────────────────────────────────

describe("writeCheckpoint", () => {
  test("writes checkpoint with correct sourceType and metadata", async () => {
    const deps = createMockDeps();
    const checkpointData = createCheckpointData();

    const id = await writeCheckpoint(checkpointData, deps);

    expect(id).toBe("mem-cp-001");

    const callArgs = (deps.neuralgentics.call as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[0]).toBe("memory.add");

    const params = callArgs[1] as Record<string, unknown>;
    expect(params.sourceType).toBe("compaction_checkpoint");

    const metadata = params.metadata as Record<string, unknown>;
    expect(metadata.type).toBe("compaction_checkpoint");
    expect(metadata.sessionId).toBe("sess-abc123");
    expect(metadata.factsExtracted).toBe(5);
    expect(metadata.tokensBefore).toBe(75000);
    expect(metadata.tokensAfter).toBe(5000);
    expect(metadata.savingsRatio).toBe(15.0);
    expect(metadata.reverted).toBe(true);
    expect(metadata.reseeded).toBe(true);
  });

  test("stores checkpoint content as JSON with all fields", async () => {
    const deps = createMockDeps();
    const checkpointData = createCheckpointData();

    await writeCheckpoint(checkpointData, deps);

    const callArgs = (deps.neuralgentics.call as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const content = params.content as string;

    const parsed = JSON.parse(content);
    expect(parsed.sessionId).toBe("sess-abc123");
    expect(parsed.factsExtracted).toBe(5);
    expect(parsed.confidenceScores).toEqual({
      "mem-001": 0.95,
      "mem-002": 0.88,
      "mem-003": 0.72,
      "mem-004": 0.91,
      "mem-005": 0.65,
    });
    expect(parsed.extractedMemoryIds).toEqual([
      "mem-001", "mem-002", "mem-003", "mem-004", "mem-005",
    ]);
  });

  test("checkpoint references fact IDs, not duplicating content", async () => {
    const deps = createMockDeps();
    const checkpointData = createCheckpointData();

    await writeCheckpoint(checkpointData, deps);

    const callArgs = (deps.neuralgentics.call as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const content = params.content as string;
    const parsed = JSON.parse(content);

    // The checkpoint should contain IDs, not fact text
    expect(parsed.extractedMemoryIds).toEqual(["mem-001", "mem-002", "mem-003", "mem-004", "mem-005"]);
    // The content field should NOT contain the actual fact text
    expect(content).not.toContain("Authentication uses JWT");
  });
});

// ─── loadLastCheckpoint Tests ────────────────────────────────────────────────

describe("loadLastCheckpoint", () => {
  test("returns null when no checkpoint exists", async () => {
    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async () => []),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).toBeNull();
  });

  test("returns the most recent checkpoint when multiple exist", async () => {
    const checkpointData = createCheckpointData();

    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, _params: Record<string, unknown>) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-newest",
                content: JSON.stringify({
                  ...checkpointData,
                  timestamp: "2026-06-06T14:00:00.000Z",
                }),
                metadata: { type: "compaction_checkpoint" },
              },
              {
                id: "mem-older",
                content: JSON.stringify({
                  ...checkpointData,
                  timestamp: "2026-06-05T10:00:00.000Z",
                }),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).not.toBeNull();
    expect(result!.checkpointId).toBe("mem-newest");
  });

  test("returns null for corrupted checkpoint JSON", async () => {
    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, _params: Record<string, unknown>) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-bad",
                content: "THIS IS NOT VALID JSON {{{{",
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).toBeNull();
  });

  test("returns null gracefully when queryBySourceType fails", async () => {
    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async () => {
          throw new Error("backend connection failed");
        }),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).toBeNull();
  });

  test("returns null for checkpoint with missing required fields", async () => {
    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, _params: Record<string, unknown>) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-incomplete",
                content: JSON.stringify({
                  // Missing sessionId and factsExtracted
                  timestamp: "2026-06-06T12:00:00.000Z",
                }),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).toBeNull();
  });

  test("round-trips all fields correctly", async () => {
    const checkpointData = createCheckpointData();
    let storedContent = "";

    const writeDeps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.add") {
            storedContent = params.content as string;
            return { id: "mem-rt-001" };
          }
          return {};
        }),
      },
    });

    await writeCheckpoint(checkpointData, writeDeps);

    const loadDeps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-rt-001",
                content: storedContent,
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(loadDeps);
    expect(result).not.toBeNull();
    expect(result!.checkpointId).toBe("mem-rt-001");
    expect(result!.sessionId).toBe("sess-abc123");
    expect(result!.timestamp).toBe("2026-06-06T12:00:00.000Z");
    expect(result!.factsExtracted).toBe(5);
    expect(result!.tokensBefore).toBe(75000);
    expect(result!.tokensAfter).toBe(5000);
    expect(result!.savingsRatio).toBe(15.0);
    expect(result!.reverted).toBe(true);
    expect(result!.reseeded).toBe(true);
    expect(result!.confidenceScores).toEqual({
      "mem-001": 0.95,
      "mem-002": 0.88,
      "mem-003": 0.72,
      "mem-004": 0.91,
      "mem-005": 0.65,
    });
    expect(result!.extractedMemoryIds).toEqual([
      "mem-001", "mem-002", "mem-003", "mem-004", "mem-005",
    ]);
  });
});

// ─── CompactionResult checkpointId Tests ───────────────────────────────────────

describe("CompactionResult checkpointId", () => {
  test("CompactionResult includes checkpointId field", () => {
    const result: CompactionResult = {
      factsExtracted: 5,
      memoryIds: ["mem-001", "mem-002"],
      tokensBefore: 10000,
      tokensAfter: 2000,
      savingsRatio: 10.0,
      reverted: true,
      reseeded: true,
      messagesFiltered: 8,
      durationMs: 500,
      checkpointId: "mem-cp-123",
    };

    expect(result.checkpointId).toBe("mem-cp-123");
  });

  test("CompactionResult allows null checkpointId for write failures", () => {
    const result: CompactionResult = {
      factsExtracted: 3,
      memoryIds: ["mem-010"],
      tokensBefore: 8000,
      tokensAfter: 1500,
      savingsRatio: 5.0,
      reverted: false,
      reseeded: true,
      messagesFiltered: 5,
      durationMs: 300,
      checkpointId: null,
    };

    expect(result.checkpointId).toBeNull();
  });
});

// ─── SessionManager loadLastCheckpoint / restoreFromCheckpoint Tests ──────────

describe("SessionManager checkpoint methods", () => {
  test("loadLastCheckpoint returns null when no checkpoint exists", async () => {
    const { SessionManager } = await import("../session/session-manager.js");
    const mockOpenCode = {
      createSession: mock(async () => "sess-1"),
      prompt: mock(async () => ({ textContent: "hi", sessionId: "sess-1", messageId: "msg-1" })),
      messages: mock(async () => []),
      revert: mock(async () => "sess-1"),
      on: mock(function(this: unknown) { return this; }),
      start: mock(async () => {}),
      shutdown: mock(async () => {}),
      isReady: true,
      sessionId: null,
      status: "ready" as const,
    };

    const mockNeuralgentics = {
      call: mock(async () => []),
    };

    const sm = new SessionManager({
      opencode: mockOpenCode as unknown as import("../opencode-client/client.js").OpenCodeClient,
      neuralgentics: mockNeuralgentics as unknown as import("../neuralgentics-client/client.js").NeuralgenticsClient,
      memoryEnabled: true,
    });

    const result = await sm.loadLastCheckpoint();
    expect(result).toBeNull();
  });

  test("restoreFromCheckpoint sets sessionId and status", async () => {
    const { SessionManager } = await import("../session/session-manager.js");
    const mockOpenCode = {
      createSession: mock(async () => "sess-1"),
      prompt: mock(async () => ({ textContent: "hi", sessionId: "sess-1", messageId: "msg-1" })),
      messages: mock(async () => []),
      revert: mock(async () => "sess-1"),
      on: mock(function(this: unknown) { return this; }),
      start: mock(async () => {}),
      shutdown: mock(async () => {}),
      isReady: true,
      sessionId: null,
      status: "ready" as const,
    };

    const mockNeuralgentics = {
      call: mock(async () => []),
    };

    const sm = new SessionManager({
      opencode: mockOpenCode as unknown as import("../opencode-client/client.js").OpenCodeClient,
      neuralgentics: mockNeuralgentics as unknown as import("../neuralgentics-client/client.js").NeuralgenticsClient,
      memoryEnabled: true,
    });

    const checkpoint: CompactionCheckpoint = {
      checkpointId: "mem-cp-001",
      sessionId: "sess-restored",
      timestamp: "2026-06-06T12:00:00.000Z",
      factsExtracted: 5,
      tokensBefore: 75000,
      tokensAfter: 5000,
      savingsRatio: 15.0,
      reverted: true,
      reseeded: true,
      confidenceScores: { "mem-001": 0.95 },
      extractedMemoryIds: ["mem-001"],
    };

    await sm.restoreFromCheckpoint(checkpoint);

    expect(sm.sessionId).toBe("sess-restored");
    expect(sm.status).toBe("active");
  });
});

// ─── Empty Checkpoint Edge Cases ───────────────────────────────────────────────

describe("checkpoint edge cases", () => {
  test("handles checkpoint with empty confidenceScores and extractedMemoryIds", async () => {
    const checkpointData = createCheckpointData({
      confidenceScores: {},
      extractedMemoryIds: [],
    });

    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.add") {
            return { id: "mem-cp-empty" };
          }
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-cp-empty",
                content: params.content ?? JSON.stringify(checkpointData),
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const id = await writeCheckpoint(checkpointData, deps);
    expect(id).toBe("mem-cp-empty");

    const callArgs = (deps.neuralgentics.call as ReturnType<typeof mock>).mock.calls[0];
    const params = callArgs[1] as Record<string, unknown>;
    const parsed = JSON.parse(params.content as string);
    expect(parsed.confidenceScores).toEqual({});
    expect(parsed.extractedMemoryIds).toEqual([]);
  });

  test("handles concurrent checkpoint writes (each gets unique ID)", async () => {
    let idCounter = 0;
    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, _params: Record<string, unknown>) => {
          if (method === "memory.add") {
            return { id: `mem-cp-concurrent-${++idCounter}` };
          }
          return {};
        }),
      },
    });

    const checkpoint1 = createCheckpointData({ sessionId: "sess-1" });
    const checkpoint2 = createCheckpointData({ sessionId: "sess-2" });

    const [id1, id2] = await Promise.all([
      writeCheckpoint(checkpoint1, deps),
      writeCheckpoint(checkpoint2, deps),
    ]);

    expect(id1).toBe("mem-cp-concurrent-1");
    expect(id2).toBe("mem-cp-concurrent-2");
    expect(id1).not.toBe(id2);
  });

  test("restores numeric fields with correct types from JSON", async () => {
    // JSON round-trip can convert int-like floats to integers, ensure types are correct
    const checkpointData = createCheckpointData({
      savingsRatio: 10.5,
      factsExtracted: 0,
      tokensBefore: 0,
      tokensAfter: 0,
    });

    let storedContent = "";
    const writeDeps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.add") {
            storedContent = params.content as string;
            return { id: "mem-types-001" };
          }
          return {};
        }),
      },
    });

    await writeCheckpoint(checkpointData, writeDeps);

    const loadDeps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-types-001",
                content: storedContent,
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(loadDeps);
    expect(result).not.toBeNull();
    expect(result!.factsExtracted).toBe(0);
    expect(result!.tokensBefore).toBe(0);
    expect(result!.tokensAfter).toBe(0);
    expect(result!.savingsRatio).toBe(10.5);
  });

  test("defaults missing optional fields in loadLastCheckpoint", async () => {
    // Server returns a checkpoint missing some optional fields
    const partialContent = JSON.stringify({
      sessionId: "sess-partial",
      timestamp: "2026-06-06T12:00:00.000Z",
      factsExtracted: 3,
      // tokensBefore, tokensAfter, savingsRatio, etc. are missing
    });

    const deps = createMockDeps({
      neuralgentics: {
        call: mock(async (method: string) => {
          if (method === "memory.queryBySourceType") {
            return [
              {
                id: "mem-partial",
                content: partialContent,
                metadata: { type: "compaction_checkpoint" },
              },
            ];
          }
          return {};
        }),
      },
    });

    const result = await loadLastCheckpoint(deps);
    expect(result).not.toBeNull();
    expect(result!.checkpointId).toBe("mem-partial");
    expect(result!.sessionId).toBe("sess-partial");
    expect(result!.factsExtracted).toBe(3);
    // Missing fields should default
    expect(result!.tokensBefore).toBe(0);
    expect(result!.tokensAfter).toBe(0);
    expect(result!.savingsRatio).toBe(0);
    expect(result!.reverted).toBe(false);
    expect(result!.reseeded).toBe(false);
    expect(result!.confidenceScores).toEqual({});
    expect(result!.extractedMemoryIds).toEqual([]);
  });
});