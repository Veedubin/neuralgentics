/**
 * @neuralgentics/tui — Attempts History Tests (T-038)
 *
 * Tests for attempt history management: auto-append on failure,
 * truncation to max 5 visible attempts, truncation line formatting
 * and parsing, and integration with formatAttempt/formatAttemptBlock.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  AttemptsHistory,
  formatTruncationLine,
  parseTruncationLine,
  truncateAttempts,
} from "../kanban/attempts.js";
import { formatAttempt, formatAttemptBlock } from "../kanban/circuit-breaker.js";
import type { KanbanCard, AttemptEntry } from "../kanban/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock KanbanCard with sensible defaults. */
function makeCard(overrides?: Partial<KanbanCard>): KanbanCard {
  return {
    id: "T-038",
    title: "Attempts History",
    status: "ready",
    assignee: "boomerang-coder",
    phase: "P1",
    roadmap: "v0.1.0",
    goal: "Implement attempts history",
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

/** Create a mock AttemptEntry. */
function makeAttempt(overrides?: Partial<AttemptEntry>): AttemptEntry {
  return {
    attemptNumber: 1,
    worker: "boomerang-coder",
    timestamp: "2026-06-04T15:30:00Z",
    result: "failure",
    tokensSpent: 5400,
    memoryId: "mem-abc123",
    summary: "Test failure",
    ...overrides,
  };
}

/** Generate N failure attempts starting from number 1. */
function generateAttempts(count: number, startNumber: number = 1): AttemptEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeAttempt({
      attemptNumber: startNumber + i,
      worker: "boomerang-coder",
      timestamp: `2026-06-04T${String(15 + i).padStart(2, "0")}:30:00Z`,
      result: "failure",
      tokensSpent: 1000 * (i + 1),
      memoryId: `mem-attempt-${startNumber + i}`,
      summary: `Attempt ${startNumber + i} failed`,
    }),
  );
}

// ─── AttemptsHistory Class Tests ────────────────────────────────────────────────

describe("AttemptsHistory", () => {
  let history: AttemptsHistory;

  beforeEach(() => {
    history = new AttemptsHistory(5);
  });

  // ── appendFailure ───────────────────────────────────────────────────────────

  describe("appendFailure", () => {
    test("appends a failure attempt to empty card", () => {
      const card = makeCard({ failureCount: 0, attemptHistory: [] });
      const result = history.appendFailure(card, "boomerang-coder", "Build failed", 450, "mem-fail1");

      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]!.result).toBe("failure");
      expect(result.attempts[0]!.worker).toBe("boomerang-coder");
      expect(result.attempts[0]!.summary).toBe("Build failed");
      expect(result.attempts[0]!.tokensSpent).toBe(450);
      expect(result.attempts[0]!.memoryId).toBe("mem-fail1");
      expect(result.failureCount).toBe(1);
      expect(result.truncation).toBeNull();
    });

    test("appends a failure attempt to card with existing history", () => {
      const card = makeCard({
        failureCount: 1,
        attemptHistory: [
          makeAttempt({ attemptNumber: 1, memoryId: "mem-1" }),
        ],
      });

      const result = history.appendFailure(card, "boomerang-coder", "Second fail", 520, "mem-fail2");

      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[1]!.attemptNumber).toBe(2);
      expect(result.attempts[1]!.summary).toBe("Second fail");
      expect(result.failureCount).toBe(2);
    });

    test("truncates when exceeding max visible attempts", () => {
      const existingAttempts = generateAttempts(5);
      const card = makeCard({ failureCount: 5, attemptHistory: existingAttempts });

      const result = history.appendFailure(card, "boomerang-coder", "6th fail", 600, "mem-6th");

      // Should keep max 5 visible, truncate 1
      expect(result.attempts).toHaveLength(5);
      expect(result.truncation).not.toBeNull();
      expect(result.truncation!.truncatedCount).toBe(1);
      expect(result.truncation!.truncatedMemoryId).toBe("mem-attempt-1");
      expect(result.failureCount).toBe(6);
    });

    test("truncates many older attempts correctly", () => {
      const existingAttempts = generateAttempts(8);
      const card = makeCard({ failureCount: 8, attemptHistory: existingAttempts });

      const result = history.appendFailure(card, "boomerang-coder", "9th fail", 900, "mem-9th");

      expect(result.attempts).toHaveLength(5);
      expect(result.truncation!.truncatedCount).toBe(4);
      // Oldest truncated attempt's memoryId is the link
      expect(result.truncation!.truncatedMemoryId).toBe("mem-attempt-1");
    });
  });

  // ── appendSuccess ──────────────────────────────────────────────────────────

  describe("appendSuccess", () => {
    test("appends a success attempt and resets failure count", () => {
      const card = makeCard({
        failureCount: 2,
        attemptHistory: generateAttempts(2),
      });

      const result = history.appendSuccess(card, "boomerang-coder", 500, "mem-success");

      expect(result.attempts).toHaveLength(3);
      expect(result.attempts[2]!.result).toBe("success");
      expect(result.attempts[2]!.summary).toContain("Completed by boomerang-coder");
      expect(result.failureCount).toBe(0);
    });

    test("success after failures resets failure count to 0", () => {
      const card = makeCard({
        failureCount: 1,
        attemptHistory: [makeAttempt({ attemptNumber: 1, result: "failure" })],
      });

      const result = history.appendSuccess(card, "coder", 300, "mem-ok");

      expect(result.failureCount).toBe(0);
      expect(result.truncation).toBeNull();
    });
  });

  // ── truncate ──────────────────────────────────────────────────────────────

  describe("truncate", () => {
    test("no truncation when within limit", () => {
      const attempts = generateAttempts(3);
      const result = history.truncate(attempts);

      expect(result.visible).toHaveLength(3);
      expect(result.truncatedCount).toBe(0);
      expect(result.truncatedMemoryId).toBe("");
    });

    test("no truncation when exactly at limit", () => {
      const attempts = generateAttempts(5);
      const result = history.truncate(attempts);

      expect(result.visible).toHaveLength(5);
      expect(result.truncatedCount).toBe(0);
    });

    test("truncation keeps most recent attempts", () => {
      const attempts = generateAttempts(7);
      const result = history.truncate(attempts);

      expect(result.visible).toHaveLength(5);
      expect(result.truncatedCount).toBe(2);
      // Should keep attempts 3-7 (the most recent)
      expect(result.visible[0]!.attemptNumber).toBe(3);
      expect(result.visible[4]!.attemptNumber).toBe(7);
    });

    test("truncation uses oldest attempt's memory ID as link", () => {
      const attempts = generateAttempts(6);
      const result = history.truncate(attempts);

      expect(result.truncatedMemoryId).toBe("mem-attempt-1");
    });

    test("empty list returns empty result", () => {
      const result = history.truncate([]);
      expect(result.visible).toHaveLength(0);
      expect(result.truncatedCount).toBe(0);
    });

    test("custom maxVisible limit", () => {
      const smallHistory = new AttemptsHistory(3);
      const attempts = generateAttempts(5);
      const result = smallHistory.truncate(attempts);

      expect(result.visible).toHaveLength(3);
      expect(result.truncatedCount).toBe(2);
    });

    test("single attempt no truncation", () => {
      const attempts = [makeAttempt()];
      const result = history.truncate(attempts);

      expect(result.visible).toHaveLength(1);
      expect(result.truncatedCount).toBe(0);
    });
  });

  // ── formatForTasksMd ──────────────────────────────────────────────────────

  describe("formatForTasksMd", () => {
    test("formats empty attempt list as empty string", () => {
      const result = history.formatForTasksMd([]);
      expect(result).toBe("");
    });

    test("formats attempts without truncation", () => {
      const attempts = generateAttempts(2);
      const result = history.formatForTasksMd(attempts);

      expect(result).toContain("## Previous Attempts");
      expect(result).toContain("### Attempt 1");
      expect(result).toContain("### Attempt 2");
      expect(result).not.toContain("... and");
    });

    test("formats attempts with truncation line", () => {
      const attempts = generateAttempts(5);
      // Simulate truncation: 7 total, 5 visible, 2 hidden
      const truncation = {
        visible: attempts,
        truncatedCount: 2,
        truncatedMemoryId: "mem-old-ref",
      };

      const result = history.formatForTasksMd(attempts, truncation);

      expect(result).toContain("## Previous Attempts");
      expect(result).toContain("... and 2 more in memini-core (memory_id: mem-old-ref)");
    });

    test("formats with null truncation (no truncation info)", () => {
      const attempts = generateAttempts(3);
      const result = history.formatForTasksMd(attempts, null);

      expect(result).toContain("## Previous Attempts");
      expect(result).not.toContain("... and");
    });
  });

  // ── parseTruncationLine ──────────────────────────────────────────────────

  describe("parseTruncationLine", () => {
    test("parses valid truncation line", () => {
      const result = history.parseTruncationLine(
        "... and 3 more in memini-core (memory_id: mem-abc-123)",
      );

      expect(result).not.toBeNull();
      expect(result!.count).toBe(3);
      expect(result!.memoryId).toBe("mem-abc-123");
    });

    test("parses truncation line with different count", () => {
      const result = history.parseTruncationLine(
        "... and 10 more in memini-core (memory_id: some-long-id)",
      );

      expect(result).not.toBeNull();
      expect(result!.count).toBe(10);
      expect(result!.memoryId).toBe("some-long-id");
    });

    test("returns null for non-truncation line", () => {
      expect(history.parseTruncationLine("### Attempt 1 (coder, ts, failure, 100 tokens)")).toBeNull();
      expect(history.parseTruncationLine("> Some summary")).toBeNull();
      expect(history.parseTruncationLine("Memory: `mem-1`")).toBeNull();
      expect(history.parseTruncationLine("Random text")).toBeNull();
      expect(history.parseTruncationLine("")).toBeNull();
    });

    test("parses truncation line with UUID memory ID", () => {
      const result = history.parseTruncationLine(
        "... and 5 more in memini-core (memory_id: 5fc66e7e-f993-479b-a77a-b4aaf7373376)",
      );

      expect(result).not.toBeNull();
      expect(result!.count).toBe(5);
      expect(result!.memoryId).toBe("5fc66e7e-f993-479b-a77a-b4aaf7373376");
    });
  });
});

// ─── Standalone Function Tests ───────────────────────────────────────────────

describe("formatTruncationLine", () => {
  test("formats truncation line correctly", () => {
    const line = formatTruncationLine(3, "mem-abc-123");
    expect(line).toBe("... and 3 more in memini-core (memory_id: mem-abc-123)");
  });

  test("formats with large count", () => {
    const line = formatTruncationLine(99, "mem-long-id-here");
    expect(line).toBe("... and 99 more in memini-core (memory_id: mem-long-id-here)");
  });

  test("formats with UUID memory ID", () => {
    const line = formatTruncationLine(7, "5fc66e7e-f993-479b-a77a-b4aaf7373376");
    expect(line).toBe("... and 7 more in memini-core (memory_id: 5fc66e7e-f993-479b-a77a-b4aaf7373376)");
  });
});

describe("parseTruncationLine (standalone)", () => {
  test("parses truncation line", () => {
    const result = parseTruncationLine("... and 4 more in memini-core (memory_id: mem-xyz)");
    expect(result).toEqual({ count: 4, memoryId: "mem-xyz" });
  });

  test("returns null for non-matching line", () => {
    expect(parseTruncationLine("not a truncation line")).toBeNull();
  });
});

describe("truncateAttempts (convenience)", () => {
  test("delegates to AttemptsHistory.truncate", () => {
    const attempts = generateAttempts(7);
    const result = truncateAttempts(attempts);

    expect(result.visible).toHaveLength(5);
    expect(result.truncatedCount).toBe(2);
  });

  test("supports custom maxVisible", () => {
    const attempts = generateAttempts(10);
    const result = truncateAttempts(attempts, 3);

    expect(result.visible).toHaveLength(3);
    expect(result.truncatedCount).toBe(7);
  });
});

// ─── Integration: formatAttempt/formatAttemptBlock with truncation ─────────────

describe("Attempt history integration with formatAttemptBlock", () => {
  test("formatAttemptBlock + truncation line produces valid TASKS.md output", () => {
    const attempts = generateAttempts(7);
    const history = new AttemptsHistory(5);
    const truncation = history.truncate(attempts);

    const block = history.formatForTasksMd(truncation.visible, truncation);

    expect(block).toContain("## Previous Attempts");
    expect(block).toContain("### Attempt 3");
    expect(block).toContain("### Attempt 7");
    expect(block).toContain("... and 2 more in memini-core (memory_id: mem-attempt-1)");
    // Should NOT contain attempts 1 and 2 (they're truncated)
    expect(block).not.toContain("### Attempt 1");
    expect(block).not.toContain("### Attempt 2");
  });

  test("full workflow: append failures, truncate, format", () => {
    const history = new AttemptsHistory(5);

    // Build a full list of 6 attempts (not using appendFailure which truncates)
    const allAttempts = generateAttempts(6);
    const truncation = history.truncate(allAttempts);
    const formatted = history.formatForTasksMd(truncation.visible, truncation);

    expect(formatted).toContain("## Previous Attempts");
    expect(formatted).toContain("### Attempt 2"); // Starts from attempt 2 (oldest kept)
    expect(formatted).toContain("### Attempt 6"); // Newest
    expect(formatted).toContain("... and 1 more in memini-core (memory_id: mem-attempt-1)");
    // Should NOT contain attempt 1 (truncated)
    expect(formatted).not.toContain("### Attempt 1");
  });
});

// ─── Parser integration: truncation line parsing ────────────────────────────

describe("Parser truncation line integration", () => {
  test("parseTruncationLine handles the exact TASKS.md format", () => {
    // Exact format from the task spec
    const line = "... and 3 more in memini-core (memory_id: mem-abc-123)";
    const result = parseTruncationLine(line);

    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.memoryId).toBe("mem-abc-123");
  });

  test("parseTruncationLine handles whitespace variations", () => {
    const result = parseTruncationLine(
      "   ... and 5 more in memini-core (memory_id: uuid-here)",
    );
    // Our regex doesn't allow leading whitespace, so we trim in the parser
    // But standalone function doesn't trim
    expect(result).toBeNull(); // Leading spaces break the regex
  });

  test("parseTruncationLine with trimmed whitespace", () => {
    const result = parseTruncationLine(
      "... and 5 more in memini-core (memory_id: uuid-here)",
    );
    expect(result).not.toBeNull();
    expect(result!.count).toBe(5);
  });
});