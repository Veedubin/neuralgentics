/**
 * T-039 tests: Functional Slash Commands
 *
 * Covers all 10 commands that do real work:
 * 1. /spend — TokenCounter (T-033)
 * 2. /opportunities — OpportunityDetector (T-034)
 * 3. /memory — NeuralgenticsClient query
 * 4. /chain — NeuralgenticsClient thought chain
 * 5. /resume — CircuitBreaker.resetFailureCount
 * 6. /harness — role + skills directory scan
 * 7. /review — kanban board summary
 * 8. /scaffold — card template generation
 * 9. /board — kanban refresh (T-021)
 * 10. /diff — diff verification panel (T-030)
 *
 * Also covers: /help, /theme, /compact, unknown commands, echo.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleSlashCommand,
  isSlashCommand,
  handleMemoryCommand,
  handleChainCommand,
  type CommandDependencies,
} from "../commands.js";
import { TokenCounter } from "../observability/token-counter.js";
import { OpportunityDetector } from "../opportunity-detector/detector.js";
import { CircuitBreaker } from "../kanban/circuit-breaker.js";
import type { KanbanBoard, KanbanCard, KanbanColumn } from "../kanban/types.js";
import { KANBAN_STATUSES } from "../kanban/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────────

/** Create a TokenCounter with persistence disabled (for isolated tests). */
function createTestCounter(sessionId?: string): TokenCounter {
  return new TokenCounter({
    sessionId: sessionId ?? "test-session",
    persistToMemory: false,
  });
}

/** Create a KanbanBoard with test data. */
function createTestBoard(cardOverrides?: Partial<KanbanCard>[]): KanbanBoard {
  const cards: KanbanCard[] = (cardOverrides ?? []).map((o, i) => ({
    id: o.id ?? `T-${String(i + 1).padStart(3, "0")}`,
    title: o.title ?? `Test Card ${i + 1}`,
    status: o.status ?? "ready",
    assignee: o.assignee ?? "coder",
    phase: o.phase ?? "P1",
    roadmap: o.roadmap ?? "v0.1.0",
    goal: o.goal ?? "Test goal",
    dependsOn: o.dependsOn ?? [],
    blocks: o.blocks ?? [],
    failureCount: o.failureCount ?? 0,
    failureLimit: o.failureLimit ?? 2,
    attemptHistory: [],
    truncatedAttempts: 0,
    truncatedMemoryId: "",
    comments: [],
    raw: {},
  }));

  const columns: KanbanColumn[] = KANBAN_STATUSES.map((status) => ({
    status,
    cards: cards.filter((c) => c.status === status),
  }));

  return {
    columns,
    cardCount: cards.length,
    parsedAt: new Date().toISOString(),
  };
}

/** Create a KanbanCard with sensible defaults. */
function makeCard(overrides?: Partial<KanbanCard>): KanbanCard {
  return {
    id: "T-036",
    title: "Circuit Breaker Implementation",
    status: "ready",
    assignee: "boomerang-coder",
    phase: "P1",
    roadmap: "v0.1.0",
    goal: "Implement circuit breaker",
    dependsOn: [],
    blocks: [],
    failureCount: 0,
    failureLimit: 2,
    attemptHistory: [],
    truncatedAttempts: 0,
    truncatedMemoryId: "",
    comments: [],
    raw: {},
    ...overrides,
  };
}

// ─── 1. /spend Command ─────────────────────────────────────────────────────────────

describe("/spend command (T-033)", () => {
  test("/spend without TokenCounter shows unavailable", () => {
    const result = handleSlashCommand("/spend");
    expect(result.command).toBe("spend");
    expect(result.message).toContain("not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/spend with TokenCounter shows session total", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1" });
    const result = handleSlashCommand("/spend", { tokenCounter: counter });
    expect(result.command).toBe("spend");
    expect(result.message).toContain("Session total");
    expect(result.message).toContain("150");
  });

  test("/spend by-card shows per-task breakdown", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1", taskId: "T-001" });
    const result = handleSlashCommand("/spend by-card", { tokenCounter: counter });
    expect(result.message).toContain("Per-task breakdown");
    expect(result.message).toContain("T-001");
  });

  test("/spend by-model shows per-model breakdown", () => {
    const counter = createTestCounter();
    counter.recordCall(24500, 8200, 0, 0, { model: "deepseek-v4-pro" });
    const result = handleSlashCommand("/spend by-model", { tokenCounter: counter });
    expect(result.message).toContain("deepseek-v4-pro");
  });

  test("/spend projected shows burn rate", () => {
    const counter = createTestCounter();
    counter.recordCall(2450, 1000, 0, 0, { model: "m1" });
    const result = handleSlashCommand("/spend projected", { tokenCounter: counter });
    expect(result.message).toContain("Projected");
    expect(result.message).toContain("burn rate");
  });

  test("/spend report shows full wrap-up", () => {
    const counter = createTestCounter();
    counter.recordCall(100, 50, 0, 0, { model: "m1" });
    const result = handleSlashCommand("/spend report", { tokenCounter: counter });
    expect(result.message).toContain("Token Spend Report");
  });

  test("/spend unknown sub-command shows error", () => {
    const counter = createTestCounter();
    const result = handleSlashCommand("/spend xyz", { tokenCounter: counter });
    expect(result.message).toContain("Unknown /spend sub-command");
  });
});

// ─── 2. /opportunities Command ─────────────────────────────────────────────────────

describe("/opportunities command (T-034)", () => {
  test("/opportunities without detector shows unavailable", () => {
    const result = handleSlashCommand("/opportunities");
    expect(result.command).toBe("opportunities");
    expect(result.message).toContain("not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/opportunities with detector scans and returns results", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });
    const result = handleSlashCommand("/opportunities", { opportunityDetector: detector });
    expect(result.command).toBe("opportunities");
    // With no tool calls, should show "No new opportunities" or candidate list
    expect(result.refreshKanban).toBe(false);
  });
});

// ─── 5. /resume Command ────────────────────────────────────────────────────────────

describe("/resume command", () => {
  test("/resume without card ID shows usage", () => {
    const result = handleSlashCommand("/resume");
    expect(result.command).toBe("resume");
    expect(result.message).toContain("specify a card ID");
    expect(result.message).toContain("T-036");
    expect(result.refreshKanban).toBe(false);
  });

  test("/resume without circuit breaker shows unavailable", () => {
    const result = handleSlashCommand("/resume T-036");
    expect(result.command).toBe("resume");
    expect(result.message).toContain("circuit breaker not available");
    expect(result.refreshKanban).toBe(false);
  });

  test("/resume with circuit breaker resets failure count", () => {
    const breaker = new CircuitBreaker({ failureLimit: 2 });
    const card = makeCard({ id: "T-036", status: "running" });
    breaker.registerCard(card);
    breaker.recordFailure(card, "coder", "Build failed", 5400, "mem-fail1");

    // Card should have 1 failure
    expect(breaker.getFailureCount("T-036")).toBe(1);

    // Resume should reset the count
    const result = handleSlashCommand("/resume T-036", { circuitBreaker: breaker });
    expect(result.command).toBe("resume");
    expect(result.message).toContain("resumed");
    expect(result.message).toContain("T-036");
    expect(result.refreshKanban).toBe(true);

    // Failure count should be 0
    expect(breaker.getFailureCount("T-036")).toBe(0);
  });

  test("/resume with unknown card ID returns not found", () => {
    const breaker = new CircuitBreaker({ failureLimit: 2 });
    const result = handleSlashCommand("/resume T-NONEXISTENT", { circuitBreaker: breaker });
    expect(result.command).toBe("resume");
    expect(result.message).toContain("not found");
    expect(result.refreshKanban).toBe(false);
  });
});

// ─── 6. /harness Command ────────────────────────────────────────────────────────────

describe("/harness command", () => {
  test("/harness shows agent harness header", () => {
    const result = handleSlashCommand("/harness");
    expect(result.command).toBe("harness");
    expect(result.message).toContain("Agent Harness");
    expect(result.message).toContain("Skills directory");
    expect(result.refreshKanban).toBe(false);
  });

  test("/harness with nonexistent project root still works", () => {
    const result = handleSlashCommand("/harness", { projectRoot: "/nonexistent" });
    expect(result.command).toBe("harness");
    expect(result.message).toContain("Agent Harness");
    expect(result.message).toContain("No skills found");
  });
});

// ─── 7. /review Command ────────────────────────────────────────────────────────────

describe("/review command", () => {
  test("/review without kanban board shows error and requests /board", () => {
    const result = handleSlashCommand("/review");
    expect(result.command).toBe("review");
    expect(result.message).toContain("kanban board not loaded");
    expect(result.refreshKanban).toBe(true);
  });

  test("/review with empty board shows all zeros", () => {
    const board = createTestBoard([]);
    const result = handleSlashCommand("/review", { kanbanBoard: board });
    expect(result.command).toBe("review");
    expect(result.message).toContain("Kanban Review");
    expect(result.message).toContain("Total cards: 0");
    expect(result.refreshKanban).toBe(false);
  });

  test("/review with cards shows counts per status", () => {
    const board = createTestBoard([
      { id: "T-001", title: "Card 1", status: "ready", assignee: "coder" },
      { id: "T-002", title: "Card 2", status: "ready", assignee: "tester" },
      { id: "T-003", title: "Card 3", status: "blocked", assignee: "architect" },
      { id: "T-004", title: "Card 4", status: "done", assignee: "coder" },
    ]);
    const result = handleSlashCommand("/review", { kanbanBoard: board });
    expect(result.message).toContain("Kanban Review");
    expect(result.message).toContain("Total cards: 4");
    expect(result.message).toContain("Ready: 2");
    expect(result.message).toContain("Blocked: 1");
    expect(result.message).toContain("Done: 1");
  });

  test("/review highlights blocked cards", () => {
    const board = createTestBoard([
      { id: "T-099", title: "Blocked Card", status: "blocked", assignee: "coder" },
    ]);
    const result = handleSlashCommand("/review", { kanbanBoard: board });
    expect(result.message).toContain("Blocked cards");
    expect(result.message).toContain("T-099");
  });
});

// ─── 8. /scaffold Command ───────────────────────────────────────────────────────────

describe("/scaffold command", () => {
  test("/scaffold without title shows usage", () => {
    const result = handleSlashCommand("/scaffold");
    expect(result.command).toBe("scaffold");
    expect(result.message).toContain("specify a card title");
    expect(result.refreshKanban).toBe(false);
  });

  test("/scaffold with title generates template", () => {
    const result = handleSlashCommand("/scaffold Implement WebSocket transport");
    expect(result.command).toBe("scaffold");
    expect(result.message).toContain("WebSocket transport");
    expect(result.message).toContain("T-???");
    expect(result.message).toContain("**Status:** ready");
    expect(result.message).toContain("**Assignee:** boomerang-coder");
    expect(result.clipboardContent).toBeDefined();
    expect(result.clipboardContent).toContain("Implement WebSocket transport");
    expect(result.refreshKanban).toBe(false);
  });

  test("/scaffold card template has proper structure", () => {
    const result = handleSlashCommand("/scaffold Add auth middleware");
    const clipboard = result.clipboardContent!;
    expect(clipboard).toContain("#### T-??? · Add auth middleware (P1)");
    expect(clipboard).toContain("**Status:** ready");
    expect(clipboard).toContain("**Assignee:** boomerang-coder");
    expect(clipboard).toContain("**Failure limit:** 2");
    expect(clipboard).toContain("### Acceptance");
    expect(clipboard).toContain("Auto-scaffolded by /scaffold");
  });

  test("/scaffold with multi-word title works", () => {
    const result = handleSlashCommand("/scaffold Build the thing");
    expect(result.message).toContain("Build the thing");
    expect(result.clipboardContent).toContain("Build the thing (P1)");
  });
});

// ─── 9. /board Command ─────────────────────────────────────────────────────────────

describe("/board command (T-021)", () => {
  test("/board triggers kanban refresh", () => {
    const result = handleSlashCommand("/board");
    expect(result.command).toBe("board");
    expect(result.message).toContain("Refreshing");
    expect(result.refreshKanban).toBe(true);
  });
});

// ─── 10. /diff Command ─────────────────────────────────────────────────────────────

describe("/diff command (T-030)", () => {
  test("/diff shows diff verification panel", () => {
    const result = handleSlashCommand("/diff");
    expect(result.command).toBe("diff");
    expect(result.showDiffPanel).toBe(true);
    expect(result.message).toContain("diff verification panel");
    expect(result.refreshKanban).toBe(false);
  });
});

// ─── /memory Command (Async) ──────────────────────────────────────────────────────

describe("/memory command", () => {
  test("/memory without args shows help (sync path)", () => {
    // Without NeuralgenticsClient, synchronous path returns handler redirect
    const result = handleSlashCommand("/memory");
    expect(result.command).toBe("memory");
    expect(result.message).toContain("async handler");
  });

  test("/memory get shows async handler note (sync)", () => {
    const result = handleSlashCommand("/memory get abc-123");
    expect(result.command).toBe("memory");
    expect(result.message).toContain("async handler");
  });
});

// ─── /chain Command (Async) ────────────────────────────────────────────────────────

describe("/chain command", () => {
  test("/chain without args shows handler redirect (sync)", () => {
    const result = handleSlashCommand("/chain");
    expect(result.command).toBe("chain");
    expect(result.message).toContain("async handler");
  });

  test("/chain with ID shows handler redirect (sync)", () => {
    const result = handleSlashCommand("/chain abc-123");
    expect(result.command).toBe("chain");
    expect(result.message).toContain("async handler");
  });
});

// ─── /compact Command ──────────────────────────────────────────────────────────────

describe("/compact command (T-026)", () => {
  test("/compact returns _compact_ signal", () => {
    const result = handleSlashCommand("/compact");
    expect(result.command).toBe("compact");
    expect(result.message).toBe("_compact_");
    expect(result.refreshKanban).toBe(false);
  });
});

// ─── /theme Command ─────────────────────────────────────────────────────────────────

describe("/theme command (T-032)", () => {
  test("/theme dark switches to dark theme", () => {
    const result = handleSlashCommand("/theme dark");
    expect(result.command).toBe("theme");
    expect(result.switchTheme).toBe("dark");
    expect(result.message).toContain("dark");
  });

  test("/theme light switches to light theme", () => {
    const result = handleSlashCommand("/theme light");
    expect(result.command).toBe("theme");
    expect(result.switchTheme).toBe("light");
    expect(result.message).toContain("light");
  });

  test("/theme without arg shows usage", () => {
    const result = handleSlashCommand("/theme");
    expect(result.command).toBe("theme");
    expect(result.switchTheme).toBeUndefined();
    expect(result.message).toContain("[dark|light]");
  });
});

// ─── /help Command ─────────────────────────────────────────────────────────────────

describe("/help command", () => {
  test("/help lists all available commands", () => {
    const result = handleSlashCommand("/help");
    expect(result.command).toBe("help");
    expect(result.message).toContain("/spend");
    expect(result.message).toContain("/memory");
    expect(result.message).toContain("/board");
    expect(result.message).toContain("/chain");
    expect(result.message).toContain("/harness");
    expect(result.message).toContain("/resume");
    expect(result.message).toContain("/review");
    expect(result.message).toContain("/scaffold");
    expect(result.message).toContain("/opportunities");
    expect(result.message).toContain("/diff");
    expect(result.message).toContain("/compact");
    expect(result.message).toContain("/theme");
  });
});

// ─── Unknown and Echo ──────────────────────────────────────────────────────────────

describe("unknown commands and echo", () => {
  test("unknown command returns error", () => {
    const result = handleSlashCommand("/xyz");
    expect(result.command).toBe("unknown");
    expect(result.message).toContain("Unknown command");
  });

  test("isSlashCommand detects slash prefix", () => {
    expect(isSlashCommand("/help")).toBe(true);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("  /help  ")).toBe(true);
  });

  test("non-slash input echoes back", () => {
    const result = handleSlashCommand("hello world");
    expect(result.command).toBe("echo");
    expect(result.message).toBe("hello world");
  });
});