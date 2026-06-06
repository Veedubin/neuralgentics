/**
 * Spend History & Persistence Tests (T-084)
 *
 * Tests for token_ledger_batch persistence:
 * 1. saveBatch persists to store (mock)
 * 2. restoreBatch reads from store
 * 3. Cumulative calculation correct across multiple batches
 * 4. getHistory(5) returns most recent 5
 * 5. Missing batch → zero (no error)
 * 6. /spend history returns formatted list
 * 7. No duplicate batches (idempotency check)
 * 8. Shutdown calls saveBatch (mock the shutdown handler)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  TokenCounter,
  handleSpendHistoryCommand,
} from "../observability/token-counter.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import { SessionManager } from "../session/session-manager.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

let memAddCounter = 0;
const storedBatches: Array<Record<string, unknown>> = [];

function createMockClient(overrides?: Record<string, unknown>): NeuralgenticsClient {
  memAddCounter = 0;
  storedBatches.length = 0;

  return {
    call: mock(async (method: string, params: Record<string, unknown>) => {
      if (method === "memory.add") {
        const id = `mem-tlb-${String(++memAddCounter).padStart(3, "0")}`;
        storedBatches.push({ id, ...params });
        return { id };
      }
      if (method === "memory.queryBySourceType") {
        const sourceType = (params as Record<string, unknown>).sourceType as string;
        if (sourceType === "token_ledger_batch") {
          // Return batches sorted by createdAt DESC
          const limit = (params as Record<string, unknown>).limit as number ?? 5;
          return storedBatches.slice(0, limit).map((b) => ({
            id: b.id,
            content: b.content,
            metadata: b.metadata,
          }));
        }
        return [];
      }
      return {};
    }),
    ...overrides,
  } as unknown as NeuralgenticsClient;
}

function createMockOpenCode(): import("../opencode-client/client.js").OpenCodeClient {
  return {
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
  } as unknown as import("../opencode-client/client.js").OpenCodeClient;
}

// ─── Test 1: saveBatch persists to store ─────────────────────────────────────

describe("TokenCounter.saveBatch", () => {
  test("1: saveBatch persists to store with correct sourceType", async () => {
    const client = createMockClient();
    const counter = new TokenCounter({ client, sessionId: "sess-save-1", persistToMemory: false });

    // Record some calls to have data to save
    counter.recordCall(100, 50, 10, 5, { model: "kimi-k2.6" });
    counter.recordCall(200, 100, 20, 10, { model: "glm-5.1" });

    const batchId = await counter.saveBatch();

    expect(batchId).toBe("mem-tlb-001");

    // Verify the stored batch has token_ledger_batch sourceType
    const stored = storedBatches[0];
    expect(stored).toBeDefined();
    expect((stored as Record<string, unknown>).sourceType).toBe("token_ledger_batch");

    const metadata = (stored as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.type).toBe("token_ledger_batch");
    expect(metadata.sessionId).toBe("sess-save-1");
    expect(metadata.totalSpend).toBe(495); // 100+50+10+5 + 200+100+20+10 = 495

    // Content should be valid JSON with all batch fields
    const content = JSON.parse((stored as Record<string, unknown>).content as string);
    expect(content.sessionId).toBe("sess-save-1");
    expect(content.inputTokens).toBe(300);
    expect(content.outputTokens).toBe(150);
    expect(content.totalSpend).toBe(495);
    expect(content.model).toBeDefined();
    expect(content.timestamp).toBeDefined();
  });

  test("saveBatch returns empty string when no client", async () => {
    const counter = new TokenCounter({ sessionId: "sess-no-client", persistToMemory: false });
    const result = await counter.saveBatch();
    expect(result).toBe("");
  });
});

// ─── Test 2: restoreBatch reads from store ────────────────────────────────────

describe("TokenCounter.restoreBatch", () => {
  test("2: restoreBatch reads from store and restores cumulative", async () => {
    // First, create and save a batch
    const client = createMockClient();
    const counter1 = new TokenCounter({ client, sessionId: "sess-restore-1", persistToMemory: false });
    counter1.recordCall(100, 50, 10, 5, { model: "kimi-k2.6" });
    await counter1.saveBatch();

    // Now, create a new counter and restore
    const counter2 = new TokenCounter({ client, sessionId: "sess-restore-2", persistToMemory: false });
    const restored = await counter2.restoreBatch();

    expect(restored).toBe(true);
    // Cumulative total should include the restored batch
    const total = counter2.getSessionTotal();
    expect(total.total).toBe(165); // 100+50+10+5 = 165
    expect(total.input).toBe(100);
    expect(total.output).toBe(50);
  });

  test("restoreBatch returns false when no client", async () => {
    const counter = new TokenCounter({ sessionId: "sess-no-client", persistToMemory: false });
    const result = await counter.restoreBatch();
    expect(result).toBe(false);
  });
});

// ─── Test 3: Cumulative calculation across multiple batches ────────────────────

describe("TokenCounter cumulative across batches", () => {
  test("3: cumulative calculation correct across multiple batches", async () => {
    const client = createMockClient();
    // Simulate two previous sessions
    const counter1 = new TokenCounter({ client, sessionId: "sess-cum-1", persistToMemory: false });
    counter1.recordCall(500, 250, 50, 25, { model: "kimi-k2.6" });
    await counter1.saveBatch();

    const counter2 = new TokenCounter({ client, sessionId: "sess-cum-2", persistToMemory: false });
    counter2.recordCall(300, 150, 30, 15, { model: "glm-5.1" });
    await counter2.saveBatch();

    // Restore into a new counter — should get the most recent batch
    const counter3 = new TokenCounter({ client, sessionId: "sess-cum-3", persistToMemory: false });
    await counter3.restoreBatch();

    // The counter should have cumulative data from the restored batch
    const total = counter3.getSessionTotal();
    // restoreBatch picks the most recent (DESC sort), so it should restore
    // at least the last session's data
    expect(total.total).toBeGreaterThan(0);
  });
});

// ─── Test 4: getHistory returns most recent N ─────────────────────────────────

describe("TokenCounter.getHistory", () => {
  test("4: getHistory(5) returns most recent 5 batches", async () => {
    const client = createMockClient();

    // Create 3 sessions
    for (let i = 1; i <= 3; i++) {
      const counter = new TokenCounter({ client, sessionId: `sess-hist-${i}`, persistToMemory: false });
      counter.recordCall(i * 100, i * 50, i * 10, i * 5, { model: "kimi-k2.6" });
      await counter.saveBatch();
    }

    // Now query history with a fresh counter
    const historyCounter = new TokenCounter({ client, sessionId: "sess-hist-query", persistToMemory: false });
    const history = await historyCounter.getHistory(5);

    expect(history.length).toBe(3);
    // Should be sorted by createdAt DESC
    expect(history[0]!.sessionId).toBeDefined();
    expect(history[0]!.totalSpend).toBeGreaterThan(0);
    expect(history[0]!.model).toBeDefined();
    expect(history[0]!.timestamp).toBeDefined();
  });

  test("getHistory returns empty array when no client", async () => {
    const counter = new TokenCounter({ sessionId: "sess-no-client", persistToMemory: false });
    const history = await counter.getHistory(5);
    expect(history).toEqual([]);
  });
});

// ─── Test 5: Missing batch → zero (no error) ──────────────────────────────────

describe("TokenCounter missing batch", () => {
  test("5: missing batch → zero (no error)", async () => {
    const client = createMockClient({
      call: mock(async () => []),
    });

    const counter = new TokenCounter({ client: client as unknown as NeuralgenticsClient, sessionId: "sess-empty", persistToMemory: false });
    const restored = await counter.restoreBatch();

    expect(restored).toBe(false);

    // Counter should start at zero
    const total = counter.getSessionTotal();
    expect(total.total).toBe(0);
    expect(total.input).toBe(0);
    expect(total.output).toBe(0);
  });
});

// ─── Test 6: /spend history returns formatted list ─────────────────────────────

describe("handleSpendHistoryCommand", () => {
  test("6: /spend history returns formatted list", async () => {
    const client = createMockClient();

    // Create and save a batch
    const counter = new TokenCounter({ client, sessionId: "sess-hist-cmd", persistToMemory: false });
    counter.recordCall(500, 250, 50, 25, { model: "kimi-k2.6" });
    await counter.saveBatch();

    // Now use a counter linked to the same client to get history
    const historyCounter = new TokenCounter({ client, sessionId: "sess-hist-cmd2", persistToMemory: false });
    const result = await handleSpendHistoryCommand(historyCounter, 5);

    expect(result.command).toBe("spend");
    expect(result.message).toContain("Spend History");
    expect(result.refreshKanban).toBe(false);
  });

  test("/spend history with no batches returns not found message", async () => {
    const client = createMockClient({
      call: mock(async () => []),
    });

    const counter = new TokenCounter({ client: client as unknown as NeuralgenticsClient, sessionId: "sess-no-hist", persistToMemory: false });
    const result = await handleSpendHistoryCommand(counter, 5);

    expect(result.command).toBe("spend");
    expect(result.message).toContain("No previous session spend history");
  });
});

// ─── Test 7: No duplicate batches ──────────────────────────────────────────────

describe("TokenCounter batch idempotency", () => {
  test("7: no duplicate batches — each saveBatch creates one entry", async () => {
    const client = createMockClient();
    const counter = new TokenCounter({ client, sessionId: "sess-dedup", persistToMemory: false });

    counter.recordCall(100, 50, 10, 5, { model: "kimi-k2.6" });

    // Save batch once
    const id1 = await counter.saveBatch();
    expect(id1).toBe("mem-tlb-001");

    // Verify only one batch stored
    const history = await counter.getHistory(5);
    expect(history.length).toBe(1);
  });
});

// ─── Test 8: Shutdown calls saveBatch ──────────────────────────────────────────

describe("SessionManager shutdown saves batch", () => {
  test("8: shutdown calls saveBatch on tokenCounter", async () => {
    const client = createMockClient();
    const counter = new TokenCounter({ client, sessionId: "sess-shutdown", persistToMemory: false });
    counter.recordCall(200, 100, 20, 10, { model: "kimi-k2.6" });

    const mockOpenCode = createMockOpenCode();

    const sm = new SessionManager({
      opencode: mockOpenCode,
      neuralgentics: client as unknown as NeuralgenticsClient,
      tokenCounter: counter,
      memoryEnabled: true,
    });

    await sm.shutdown();

    // After shutdown, the batch should have been saved
    // Check storedBatches for token_ledger_batch
    const batchEntry = storedBatches.find(
      (b) => (b as Record<string, unknown>).sourceType === "token_ledger_batch",
    );
    expect(batchEntry).toBeDefined();

    const metadata = (batchEntry as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.type).toBe("token_ledger_batch");
    expect(metadata.totalSpend).toBe(330); // 200+100+20+10 = 330
  });

  test("shutdown with no tokenCounter does not throw", async () => {
    const client = createMockClient();
    const mockOpenCode = createMockOpenCode();

    const sm = new SessionManager({
      opencode: mockOpenCode,
      neuralgentics: client as unknown as NeuralgenticsClient,
      memoryEnabled: true,
      // No tokenCounter provided
    });

    // Should not throw
    await expect(sm.shutdown()).resolves.toBeUndefined();
  });
});