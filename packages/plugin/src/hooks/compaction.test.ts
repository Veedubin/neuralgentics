/**
 * Neuralgentics — Compaction Hook Tests
 *
 * Verifies that runEvolutionGate is called BEFORE the CRITICAL_FILES
 * backup loop in handleCompaction, and that gate failures do not
 * block compaction.
 *
 * Uses bun:test — the project's test framework.
 * Uses a stub MemoryAdapter that records call order.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { handleCompaction, runEvolutionGate } from "./compaction.js";
import type { Memory } from "../adapters/memory.js";

// ============================================================================
// Call-Recording Stub
// ============================================================================

/**
 * A stub MemoryAdapter that records every call in order.
 *
 * Each call increments a counter keyed by method name so we can
 * assert the order of operations.
 */
class CallRecordingStub {
  public callOrder: string[] = [];
  public callCounts: Map<string, number> = new Map();
  public failQueryMemories: boolean = false;

  private record(name: string): void {
    this.callOrder.push(name);
    this.callCounts.set(name, (this.callCounts.get(name) ?? 0) + 1);
  }

  async queryMemories(
    _query: string,
    _limit?: number,
  ): Promise<Memory[]> {
    this.record("queryMemories");
    if (this.failQueryMemories) {
      throw new Error("Simulated queryMemories failure");
    }
    return [];
  }

  async addMemory(
    _content: string,
    _metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.record("addMemory");
    return `mem-${this.callCounts.get("addMemory") ?? 0}`;
  }

  async adjustTrust(
    _id: string,
    _signal: string,
  ): Promise<void> {
    this.record("adjustTrust");
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("handleCompaction wiring", () => {
  it("should run evolution gate before backup", async () => {
    const stub = new CallRecordingStub();
    const workspaceRoot = "/tmp/nonexistent-workspace";

    // handleCompaction will:
    //   1. runEvolutionGate → queryMemories, addMemory
    //   2. backupFileToMemory (AGENTS.md) → addMemory, adjustTrust
    //   3. backupFileToMemory (TASKS.md) → addMemory, adjustTrust
    //   4. addMemory (compaction event)
    //   5. adjustTrust (compaction event)
    const result = await handleCompaction(
      stub as any,
      workspaceRoot,
    );

    // Verify the gate ran before backup
    const gateQueryIdx = stub.callOrder.indexOf("queryMemories");
    const firstBackupAddIdx = stub.callOrder.indexOf("addMemory");

    // The first addMemory should be from the gate (queryMemories comes first)
    expect(gateQueryIdx).toBeGreaterThanOrEqual(0);
    expect(firstBackupAddIdx).toBeGreaterThan(gateQueryIdx);

    // Verify the result shape
    expect(result.success).toBe(false); // files don't exist in /tmp
    expect(result.backedUp).toEqual([]);
    expect(result.failed).toContain("AGENTS.md");
    expect(result.failed).toContain("TASKS.md");
  });

  it("should not block compaction when evolution gate fails", async () => {
    const stub = new CallRecordingStub();
    stub.failQueryMemories = true;
    const workspaceRoot = "/tmp/nonexistent-workspace";

    // Even though queryMemories throws, handleCompaction should continue
    const result = await handleCompaction(
      stub as any,
      workspaceRoot,
    );

    // The backup loop should still have run
    expect(result.backedUp).toEqual([]);
    expect(result.failed.length).toBeGreaterThanOrEqual(2);

    // The gate failure should not prevent the compaction event from being recorded
    const addMemoryCount = stub.callCounts.get("addMemory") ?? 0;
    expect(addMemoryCount).toBeGreaterThanOrEqual(1); // at least the compaction event
  });
});

describe("runEvolutionGate", () => {
  it("should return zeros on error", async () => {
    const stub = new CallRecordingStub();
    stub.failQueryMemories = true;

    const result = await runEvolutionGate(
      stub as any,
      "/tmp/nonexistent",
    );

    expect(result).toEqual({
      evaluated: 0,
      qualified: 0,
      created: 0,
    });
  });
});
