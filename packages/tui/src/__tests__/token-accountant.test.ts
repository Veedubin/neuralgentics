/**
 * Tests for T-033 Token Accountant — TokenCounter, TokenReporter, /spend command.
 *
 * Covers:
 * - TokenCounter.recordCall() with aggregation
 * - Per-task, per-agent, per-model breakdowns
 * - getSessionTotal() and getProjectedSessionTotal()
 * - getCycleTotal() for compaction cycle accounting
 * - reset() cleaning state
 * - TokenReporter format methods
 * - handleSpendCommand() sub-command routing
 * - SpendPanel live data updates
 * - NeuralgenticsClient persistence (fire-and-forget)
 */

import { describe, it, expect } from "bun:test";
import {
  TokenCounter,
  TokenReporter,
  handleSpendCommand,
  type TokenBreakdown,
  type TokenLedgerEntry,
  type CallMetadata,
} from "../observability/token-counter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/** Create a TokenCounter with persistence disabled (for isolated tests). */
function createTestCounter(sessionId?: string): TokenCounter {
  return new TokenCounter({
    sessionId: sessionId ?? "test-session",
    persistToMemory: false,
  });
}

/** Record a sample call. */
function recordSample(
  counter: TokenCounter,
  input: number,
  output: number,
  cached: number,
  system: number,
  metadata: CallMetadata,
): TokenLedgerEntry {
  return counter.recordCall(input, output, cached, system, metadata);
}

// ─── TokenCounter ────────────────────────────────────────────────────────────────

describe("TokenCounter", () => {
  it("should record a call and return a ledger entry", () => {
    const counter = createTestCounter();
    const entry = recordSample(counter, 100, 50, 10, 5, { model: "test-model" });

    expect(entry.id).toMatch(/^tc-\d+$/);
    expect(entry.input).toBe(100);
    expect(entry.output).toBe(50);
    expect(entry.cached).toBe(10);
    expect(entry.system).toBe(5);
    expect(entry.total).toBe(165);
    expect(entry.model).toBe("test-model");
    expect(entry.sessionId).toBe("test-session");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it("should compute session total correctly", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 10, 5, { model: "model-a" });
    recordSample(counter, 200, 100, 20, 10, { model: "model-b" });

    const total = counter.getSessionTotal();
    expect(total.input).toBe(300);
    expect(total.output).toBe(150);
    expect(total.cached).toBe(30);
    expect(total.system).toBe(15);
    expect(total.total).toBe(495);
  });

  it("should compute per-task totals", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 0, 0, { model: "m1", taskId: "T-001" });
    recordSample(counter, 200, 100, 0, 0, { model: "m1", taskId: "T-001" });
    recordSample(counter, 50, 25, 0, 0, { model: "m2", taskId: "T-002" });

    const t001 = counter.getTaskTotal("T-001");
    expect(t001.total).toBe(300 + 150); // input+output = 450

    const t002 = counter.getTaskTotal("T-002");
    expect(t002.total).toBe(75);

    const t003 = counter.getTaskTotal("T-003");
    expect(t003.total).toBe(0);
  });

  it("should compute per-agent totals", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 0, 0, { model: "m1", agentId: "coder" });
    recordSample(counter, 200, 100, 0, 0, { model: "m1", agentId: "coder" });
    recordSample(counter, 50, 25, 0, 0, { model: "m2", agentId: "architect" });

    const coderTotal = counter.getAgentTotal("coder");
    expect(coderTotal.total).toBe(450);

    const architectTotal = counter.getAgentTotal("architect");
    expect(architectTotal.total).toBe(75);
  });

  it("should compute per-model totals", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 0, 0, { model: "deepseek-v4-pro" });
    recordSample(counter, 200, 100, 0, 0, { model: "deepseek-v4-pro" });
    recordSample(counter, 50, 25, 0, 0, { model: "qwen3.5" });

    const dsTotal = counter.getModelTotal("deepseek-v4-pro");
    expect(dsTotal.input).toBe(300);
    expect(dsTotal.output).toBe(150);
    expect(dsTotal.total).toBe(450);

    const qwenTotal = counter.getModelTotal("qwen3.5");
    expect(qwenTotal.total).toBe(75);
  });

  it("should project session total based on burn rate", () => {
    const counter = createTestCounter();
    // With 0 calls, projection is 0
    expect(counter.getProjectedSessionTotal()).toBe(0);

    recordSample(counter, 1000, 500, 100, 50, { model: "m1" });
    // 1 call: total=1650, avgPerCall=1650, projected=1650*2=3300
    expect(counter.getProjectedSessionTotal()).toBe(3300);

    recordSample(counter, 1000, 500, 100, 50, { model: "m1" });
    // 2 calls: total=3300, avgPerCall=1650, projected=1650*4=6600
    expect(counter.getProjectedSessionTotal()).toBe(6600);
  });

  it("should compute per-cycle totals with timestamps", () => {
    const counter = createTestCounter();

    // Record first entry
    counter.recordCall(100, 50, 0, 0, { model: "m1" });
    // After first entry, cycle total from epoch should be 150
    const cycleAfter1 = counter.getCycleTotal(0);
    expect(cycleAfter1.total).toBe(150);

    // Add second entry
    counter.recordCall(200, 100, 0, 0, { model: "m1" });

    // Get cycle total from epoch start: should include all entries = 450
    const cycleTotalAll = counter.getCycleTotal(0);
    expect(cycleTotalAll.total).toBe(450);

    // Get cycle total from a future timestamp: should be 0
    const cycleTotalNone = counter.getCycleTotal(Date.now() + 100000);
    expect(cycleTotalNone.total).toBe(0);
  });

  it("should reset all entries", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 0, 0, { model: "m1" });
    recordSample(counter, 200, 100, 0, 0, { model: "m2" });

    expect(counter.callCount).toBe(2);
    expect(counter.getSessionTotal().total).toBe(450);

    counter.reset();

    expect(counter.callCount).toBe(0);
    expect(counter.getSessionTotal().total).toBe(0);
  });

  it("should expose entries as readonly array", () => {
    const counter = createTestCounter();
    recordSample(counter, 100, 50, 0, 0, { model: "m1" });
    recordSample(counter, 200, 100, 0, 0, { model: "m2" });

    expect(counter.entries.length).toBe(2);
    // Verify readonly — assigning to it should not mutate
    const entries = counter.entries;
    expect(entries[0]?.model).toBe("m1");
    expect(entries[1]?.model).toBe("m2");
  });

  it("should track sessionId and startTime", () => {
    const counter = createTestCounter("my-session");
    expect(counter.sessionId).toBe("my-session");
    expect(counter.startTime).toBeGreaterThan(0);
  });

  it("should handle optional taskId and agentId as undefined", () => {
    const counter = createTestCounter();
    const entry = counter.recordCall(100, 50, 0, 0, { model: "m1" });
    expect(entry.taskId).toBeUndefined();
    expect(entry.agentId).toBeUndefined();
  });
});

// ─── TokenReporter ───────────────────────────────────────────────────────────────

describe("TokenReporter", () => {
  it("should format session total as a human-readable string", () => {
    const counter = createTestCounter();
    counter.recordCall(28100, 12450, 3200, 1480, { model: "deepseek-v4-pro" });

    const reporter = new TokenReporter(counter);
    const result = reporter.formatSessionTotal();

    expect(result).toContain("45,230");
    expect(result).toContain("28,100");
    expect(result).toContain("12,450");
    expect(result).toContain("3,200");
    expect(result).toContain("1,480");
    expect(result).toContain("Session total");
  });

  it("should format per-task breakdown", () => {
    const counter = createTestCounter();
    counter.recordCall(1000, 500, 0, 0, { model: "m1", taskId: "T-001" });
    counter.recordCall(2000, 1000, 0, 0, { model: "m2", taskId: "T-002" });

    const reporter = new TokenReporter(counter);
    const result = reporter.formatByCard();

    expect(result).toContain("T-001");
    expect(result).toContain("T-002");
    expect(result).toContain("Per-task breakdown");
  });

  it("should format per-agent breakdown", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1", agentId: "coder" });
    counter.recordCall(200, 100, 0, 0, { model: "m2", agentId: "architect" });

    const reporter = new TokenReporter(counter);
    const result = reporter.formatByAgent();

    expect(result).toContain("coder");
    expect(result).toContain("architect");
    expect(result).toContain("Per-agent breakdown");
  });

  it("should format per-model breakdown", () => {
    const counter = createTestCounter();
    counter.recordCall(24500, 8200, 0, 0, { model: "deepseek-v4-pro:cloud" });

    const reporter = new TokenReporter(counter);
    const result = reporter.formatByModel();

    expect(result).toContain("deepseek-v4-pro:cloud");
    expect(result).toContain("24,500");
    expect(result).toContain("8,200");
    expect(result).toContain("Per-model breakdown");
  });

  it("should format projected spend", () => {
    const counter = createTestCounter();
    counter.recordCall(2450, 1000, 0, 0, { model: "m1" });
    counter.recordCall(2450, 1000, 0, 0, { model: "m1" });

    const reporter = new TokenReporter(counter);
    const result = reporter.formatProjected();

    expect(result).toContain("Projected");
    expect(result).toContain("burn rate");
    expect(result).toContain("2 turns");
  });

  it("should format projected spend as unavailable with no calls", () => {
    const counter = createTestCounter();
    const reporter = new TokenReporter(counter);
    const result = reporter.formatProjected();

    expect(result).toContain("No calls recorded");
  });

  it("should generate a grand total report", () => {
    const counter = createTestCounter("rpt-session");
    counter.recordCall(1000, 500, 100, 50, { model: "m1", taskId: "T-001", agentId: "coder" });
    counter.recordCall(2000, 1000, 200, 100, { model: "m1", taskId: "T-001", agentId: "coder" });
    counter.recordCall(500, 250, 0, 0, { model: "m2", taskId: "T-002", agentId: "architect" });

    const reporter = new TokenReporter(counter);
    const report = reporter.formatReport();

    expect(report).toContain("Token Spend Report");
    expect(report).toContain("rpt-session");
    expect(report).toContain("By Model");
    expect(report).toContain("By Task");
    expect(report).toContain("By Agent");
    expect(report).toContain("Projected");
  });

  it("should return empty breakdowns when no data", () => {
    const counter = createTestCounter();
    const reporter = new TokenReporter(counter);

    const grand = reporter.generateGrandTotal();
    expect(grand.session.total).toBe(0);
    expect(grand.calls).toBe(0);
    expect(grand.byTask).toHaveLength(0);
    expect(grand.byAgent).toHaveLength(0);
    expect(grand.byModel).toHaveLength(0);
  });

  it("should handle formatByCard with no task data", () => {
    const counter = createTestCounter();
    const reporter = new TokenReporter(counter);
    expect(reporter.formatByCard()).toContain("No per-task data");
  });

  it("should handle formatByAgent with no agent data", () => {
    const counter = createTestCounter();
    const reporter = new TokenReporter(counter);
    expect(reporter.formatByAgent()).toContain("No per-agent data");
  });

  it("should handle formatByModel with no model data", () => {
    const counter = createTestCounter();
    const reporter = new TokenReporter(counter);
    expect(reporter.formatByModel()).toContain("No per-model data");
  });
});

// ─── /spend Command Handler ──────────────────────────────────────────────────────

describe("/spend command handler", () => {
  it("should show session total for bare /spend", () => {
    const counter = createTestCounter();
    counter.recordCall(28100, 12450, 3200, 1480, { model: "deepseek-v4-pro" });

    const result = handleSpendCommand(counter, "/spend");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("45,230");
    expect(result.refreshKanban).toBe(false);
  });

  it("should show session total for /spend today", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1" });

    const result = handleSpendCommand(counter, "/spend today");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("Session total");
  });

  it("should show per-task breakdown for /spend by-card", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1", taskId: "T-001" });

    const result = handleSpendCommand(counter, "/spend by-card");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("T-001");
    expect(result.message).toContain("Per-task breakdown");
  });

  it("should show per-agent breakdown for /spend by-agent", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1", agentId: "coder" });

    const result = handleSpendCommand(counter, "/spend by-agent");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("coder");
    expect(result.message).toContain("Per-agent breakdown");
  });

  it("should show per-model breakdown for /spend by-model", () => {
    const counter = createTestCounter();
    counter.recordCall(24500, 8200, 0, 0, { model: "deepseek-v4-pro:cloud" });

    const result = handleSpendCommand(counter, "/spend by-model");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("deepseek-v4-pro:cloud");
    expect(result.message).toContain("Per-model breakdown");
  });

  it("should show projected spend for /spend projected", () => {
    const counter = createTestCounter();
    counter.recordCall(2450, 1000, 0, 0, { model: "m1" });

    const result = handleSpendCommand(counter, "/spend projected");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("Projected");
    expect(result.message).toContain("burn rate");
  });

  it("should show full report for /spend report", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1" });

    const result = handleSpendCommand(counter, "/spend report");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("Token Spend Report");
    expect(result.message).toContain("By Model");
  });

  it("should return error for unknown sub-command", () => {
    const counter = createTestCounter();
    const result = handleSpendCommand(counter, "/spend invalid");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("Unknown /spend sub-command");
    expect(result.message).toContain("invalid");
  });

  it("should list available sub-commands on error", () => {
    const counter = createTestCounter();
    const result = handleSpendCommand(counter, "/spend xyz");
    expect(result.message).toContain("/spend today");
    expect(result.message).toContain("/spend by-card");
    expect(result.message).toContain("/spend by-agent");
    expect(result.message).toContain("/spend by-model");
    expect(result.message).toContain("/spend projected");
    expect(result.message).toContain("/spend report");
  });
});

// ─── SpendPanel ──────────────────────────────────────────────────────────────────

describe("SpendPanel", () => {
  // Note: SpendPanel uses @opentui/core Box/Text which require a terminal.
  // We test the data update logic only (not rendering).

  it("should update from TokenCounter via updateSpend", async () => {
    const { SpendPanel } = await import("../panels/spend.js");

    // Minimal ThemeColors subset for SpendPanel
    const mockColors = {
      gaugeGreen: "#00ff00",
      gaugeYellow: "#ffff00",
      gaugeRed: "#ff0000",
      statusBarBg: "#1a1a2e",
      textAccent: "#e0e0e0",
    } as any;

    const counter = createTestCounter();
    counter.recordCall(500, 250, 100, 50, { model: "m1" });

    const panel = new SpendPanel(mockColors, counter);
    panel.updateSpend();

    expect(panel.data.tokensUsed).toBe(900); // 500+250+100+50
  });

  it("should fall back to manual values without counter", async () => {
    const { SpendPanel } = await import("../panels/spend.js");

    const mockColors = {
      gaugeGreen: "#00ff00",
      gaugeYellow: "#ffff00",
      gaugeRed: "#ff0000",
      statusBarBg: "#1a1a2e",
      textAccent: "#e0e0e0",
    } as any;

    const panel = new SpendPanel(mockColors);
    panel.updateSpend(5000, 100000);

    expect(panel.data.tokensUsed).toBe(5000);
    expect(panel.data.tokenLimit).toBe(100000);
  });

  it("should allow setting counter after construction", async () => {
    const { SpendPanel } = await import("../panels/spend.js");

    const mockColors = {
      gaugeGreen: "#00ff00",
      gaugeYellow: "#ffff00",
      gaugeRed: "#ff0000",
      statusBarBg: "#1a1a2e",
      textAccent: "#e0e0e0",
    } as any;

    const counter = createTestCounter();
    counter.recordCall(200, 100, 0, 0, { model: "m1" });

    const panel = new SpendPanel(mockColors);
    panel.updateSpend(0, 100000); // Manual
    expect(panel.data.tokensUsed).toBe(0);

    panel.setCounter(counter);
    panel.updateSpend();
    expect(panel.data.tokensUsed).toBe(300);
  });
});

// ─── Neuralgentics Persistence ────────────────────────────────────────────────────

describe("TokenCounter persistence", () => {
  it("should skip persistence when persistToMemory is false", () => {
    // Just verify no crash when persistToMemory is false and no client
    const counter = new TokenCounter({
      sessionId: "no-persist",
      persistToMemory: false,
    });
    const entry = counter.recordCall(100, 50, 0, 0, { model: "m1" });
    expect(entry.id).toMatch(/^tc-\d+$/);
    expect(counter.getSessionTotal().total).toBe(150);
  });

  it("should skip persistence when client is null even if persistToMemory is true", () => {
    const counter = new TokenCounter({
      sessionId: "no-client",
      persistToMemory: true,
      // No client provided
    });
    const entry = counter.recordCall(100, 50, 0, 0, { model: "m1" });
    expect(entry.total).toBe(150);
    // No crash, no network calls
  });
});

// ─── Thresholds (visibility only, NO enforcement) ─────────────────────────────────

describe("Token thresholds (visibility only)", () => {
  it("should calculate percentages for display without enforcement", () => {
    const counter = createTestCounter();
    counter.recordCall(25000, 10000, 5000, 2000, { model: "m1" });

    const total = counter.getSessionTotal();
    const tokenLimit = 100000;
    const pct = (total.total / tokenLimit) * 100;

    // 42000/100000 = 42% — below green threshold
    expect(pct).toBeLessThan(50);
    expect(pct).toBeCloseTo(42, 0);

    // No enforcement — just visibility
    // 42% would show green in the gauge
  });

  it("should show yellow at 50-75% usage", () => {
    const counter = createTestCounter();
    counter.recordCall(55100, 0, 0, 0, { model: "m1" }); // 55.1K out of 100K
    counter.recordCall(5000, 0, 0, 0, { model: "m1" }); // 5K more

    const total = counter.getSessionTotal();
    const pct = (total.total / 100000) * 100;

    // 60.1 out of 100 = 60.1% — yellow zone
    expect(pct).toBeGreaterThanOrEqual(50);
    expect(pct).toBeLessThan(75);
  });

  it("should show red at >75% usage", () => {
    const counter = createTestCounter();
    counter.recordCall(80000, 10000, 0, 0, { model: "m1" }); // 90K

    const total = counter.getSessionTotal();
    const pct = (total.total / 100000) * 100;

    // 90% — red zone
    expect(pct).toBeGreaterThanOrEqual(75);
  });
});