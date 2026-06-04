/**
 * T-030 tests: Diff Verification Panel
 *
 * Tests cover:
 * 1. parseUnifiedDiff — basic diff parsing
 * 2. renderDiffPanel — side-by-side rendering with +/- markers
 * 3. keybindings — y/n/q/Esc handling
 * 4. accept flow — accept → run tests → pass/fail
 * 5. reject flow — reject → panel shows rejected
 * 6. low-confidence path — blocks regardless of test result
 */

import { describe, test, expect } from "bun:test";
import {
  parseUnifiedDiff,
  renderDiffPanel,
  DiffPanel,
  createMockTestRunner,
  generateDiffFromBeforeAfter,
  type DiffPanelState,
  type Confidence,
  type TestResult,
  type DiffInput,
} from "../panels/diff.js";

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const SAMPLE_UNIFIED_DIFF = `--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,4 +1,5 @@
 import { greet } from "./lib";
 
 function main() {
-  console.log(greet("world"));
+  console.log(greet("neuralgentics"));
+  console.log("done");
 }`;

const BEFORE_CONTENT = `line1
line2
line3
`;

const AFTER_CONTENT = `line1
line2 modified
line3
line4 added
`;

// ─── 1. parseUnifiedDiff Tests ──────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  test("parses unified diff with headers and hunks", () => {
    const result = parseUnifiedDiff(SAMPLE_UNIFIED_DIFF);

    expect(result.headers).toHaveLength(2);
    expect(result.headers[0]).toBe("--- a/src/hello.ts");
    expect(result.headers[1]).toBe("+++ b/src/hello.ts");
    expect(result.hunks).toHaveLength(1);
    expect(result.additions).toBe(2); // "neuralgentics" + "done"
    expect(result.removals).toBe(1); // "world"
  });

  test("parses hunk line numbers correctly", () => {
    const result = parseUnifiedDiff(SAMPLE_UNIFIED_DIFF);
    const hunk = result.hunks[0];

    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(5);
  });

  test("classifies lines as add/remove/context", () => {
    const result = parseUnifiedDiff(SAMPLE_UNIFIED_DIFF);
    const lines = result.hunks[0].lines;

    const adds = lines.filter((l) => l.type === "add");
    const removes = lines.filter((l) => l.type === "remove");
    const contexts = lines.filter((l) => l.type === "context");

    expect(adds).toHaveLength(2);
    expect(removes).toHaveLength(1);
    expect(contexts.length).toBeGreaterThan(0);
  });

  test("handles empty diff string", () => {
    const result = parseUnifiedDiff("");

    expect(result.headers).toHaveLength(0);
    expect(result.hunks).toHaveLength(0);
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
  });

  test("handles diff with no additions", () => {
    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 hello
-world
+world
`;
    const result = parseUnifiedDiff(diff);
    // "world" appears as remove+add — that's 1 removal and 1 addition
    expect(result.removals).toBe(1);
    expect(result.additions).toBe(1);
  });
});

// ─── 2. renderDiffPanel Tests ──────────────────────────────────────────────────

describe("renderDiffPanel", () => {
  test("renders side-by-side with +/- markers from unified diff", () => {
    const result = renderDiffPanel({ diff: SAMPLE_UNIFIED_DIFF });

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.additions).toBe(2);
    expect(result.removals).toBe(1);
    expect(result.state).toBe("showing");

    // Verify +/- markers are present in the rendered lines
    const contentLines = result.lines.filter((l) => !l.startsWith("╔") && l.trim().length > 0);
    const addLines = contentLines.filter((l) => l.includes("+"));
    const removeLines = contentLines.filter((l) => l.includes("-"));
    expect(addLines.length).toBeGreaterThan(0);
    expect(removeLines.length).toBeGreaterThan(0);
  });

  test("renders from before/after content", () => {
    const result = renderDiffPanel({
      beforeAfter: { before: BEFORE_CONTENT, after: AFTER_CONTENT },
      title: "test.ts",
    });

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.additions).toBeGreaterThan(0);
    expect(result.removals).toBeGreaterThan(0);
  });

  test("shows file title in header", () => {
    const result = renderDiffPanel({ diff: SAMPLE_UNIFIED_DIFF, title: "hello.ts" });
    const headerLine = result.lines.find((l) => l.includes("hello.ts"));
    expect(headerLine).toBeDefined();
  });

  test("returns hidden state with no diff data", () => {
    const result = renderDiffPanel({});
    expect(result.state).toBe("hidden");
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(result.lines[0]).toContain("No diff data");
  });

  test("shows confidence level in status bar", () => {
    const result = renderDiffPanel({
      diff: SAMPLE_UNIFIED_DIFF,
      confidence: "high",
    });
    const statusLine = result.lines.find((l) => l.includes("Confidence"));
    expect(statusLine).toBeDefined();
    expect(statusLine!.includes("high")).toBe(true);
  });
});

// ─── 3. Keybindings Tests ──────────────────────────────────────────────────────

describe("DiffPanel keybindings", () => {
  test("'q' key hides the panel when showing", async () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });
    expect(panel.state).toBe("showing");

    const consumed = await panel.handleKey("q");
    expect(consumed).toBe(true);
    expect(panel.state).toBe("hidden");
  });

  test("'escape' key hides the panel when showing", async () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    const consumed = await panel.handleKey("escape");
    expect(consumed).toBe(true);
    expect(panel.state).toBe("hidden");
  });

  test("unknown key is consumed but does not change state", async () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    const consumed = await panel.handleKey("x");
    expect(consumed).toBe(true);
    // State stays as "showing" — key was consumed but ignored
    expect(panel.state).toBe("showing");
  });

  test("keys are not consumed when panel is hidden", async () => {
    const panel = new DiffPanel();
    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(false);
  });
});

// ─── 4. Accept Flow Tests ──────────────────────────────────────────────────────

describe("DiffPanel accept flow", () => {
  test("y key accepts change and runs tests — tests pass", async () => {
    const panel = new DiffPanel();
    panel.onAccept(createMockTestRunner({
      pass: true,
      confidence: "high",
    }));
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(true);
    expect(panel.state).toBe("accepted");
    expect(panel.statusMessage).toContain("Accepted");
    expect(panel.statusMessage).toContain("tests passed");
  });

  test("y key accepts change and runs tests — tests fail", async () => {
    const panel = new DiffPanel();
    panel.onAccept(createMockTestRunner({
      pass: false,
      error: "expected 1, got 2",
      confidence: "medium",
    }));
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    await panel.handleKey("y");
    expect(panel.state).toBe("blocked");
    expect(panel.statusMessage).toContain("Blocked");
    expect(panel.statusMessage).toContain("expected 1, got 2");
  });

  test("y key with no test runner configured", async () => {
    const panel = new DiffPanel();
    // No onAccept callback registered
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    await panel.handleKey("y");
    expect(panel.state).toBe("accepted");
    expect(panel.statusMessage).toContain("no test runner");
  });

  test("y key with test runner error", async () => {
    const panel = new DiffPanel();
    panel.onAccept(async () => {
      throw new Error("test runner crashed");
    });
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    await panel.handleKey("y");
    expect(panel.state).toBe("blocked");
    expect(panel.statusMessage).toContain("test error");
  });
});

// ─── 5. Reject Flow Tests ──────────────────────────────────────────────────────

describe("DiffPanel reject flow", () => {
  test("n key rejects the change", () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    // handleKey is async but n is synchronous
    panel.handleKey("n").then((consumed) => {
      expect(consumed).toBe(true);
    });
    expect(panel.state).toBe("rejected");
    expect(panel.statusMessage).toContain("Rejected by user");
  });

  test("n key calls the reject callback", () => {
    const panel = new DiffPanel();
    let rejectCalled = false;
    panel.onReject(() => {
      rejectCalled = true;
    });
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    panel.handleKey("n");
    expect(rejectCalled).toBe(true);
  });

  test("q key hides after rejection", async () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });
    await panel.handleKey("n");
    expect(panel.state).toBe("rejected");

    await panel.handleKey("q");
    expect(panel.state).toBe("hidden");
  });
});

// ─── 6. Low-Confidence Path Tests ──────────────────────────────────────────────

describe("DiffPanel low-confidence path", () => {
  test("low confidence forces blocked state on show", () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "low" });

    expect(panel.state).toBe("blocked");
    expect(panel.statusMessage).toContain("low confidence");
  });

  test("low confidence blocks even if tests pass on accept", async () => {
    const panel = new DiffPanel();
    // Even with pass: true, low confidence blocks
    panel.onAccept(createMockTestRunner({
      pass: true,
      confidence: "low",
    }));
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    // Override confidence in the test result
    await panel.handleKey("y");
    expect(panel.state).toBe("blocked");
    expect(panel.statusMessage).toContain("low confidence");
  });

  test("low confidence panel shows blocked status in render result", () => {
    const result = renderDiffPanel({
      diff: SAMPLE_UNIFIED_DIFF,
      confidence: "low",
    });

    expect(result.state).toBe("blocked");
    expect(result.statusMessage).toContain("low confidence");
  });

  test("medium and high confidence allow showing", () => {
    const panelMed = new DiffPanel();
    panelMed.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });
    expect(panelMed.state).toBe("showing");

    const panelHigh = new DiffPanel();
    panelHigh.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "high" });
    expect(panelHigh.state).toBe("showing");
  });

  test("default confidence is medium", () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF });
    expect(panel.state).toBe("showing");
  });
});

// ─── 7. Wrap-up Evidence Tests ─────────────────────────────────────────────────

describe("DiffPanel wrap-up evidence", () => {
  test("getWrapUpEvidence returns null when hidden", () => {
    const panel = new DiffPanel();
    expect(panel.getWrapUpEvidence()).toBeNull();
  });

  test("getWrapUpEvidence returns structured data when showing", () => {
    const panel = new DiffPanel();
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium", title: "hello.ts" });

    const evidence = panel.getWrapUpEvidence();
    expect(evidence).not.toBeNull();
    expect(evidence!.state).toBe("showing");
    expect(evidence!.confidence).toBe("medium");
    expect(evidence!.title).toBe("hello.ts");
    expect(evidence!.additions).toBe(2);
    expect(evidence!.removals).toBe(1);
    expect(evidence!.timestamp).toBeDefined();
  });

  test("getWrapUpEvidence tracks state through accept → blocked", async () => {
    const panel = new DiffPanel();
    panel.onAccept(createMockTestRunner({
      pass: false,
      error: "1 test failed",
      confidence: "medium",
    }));
    panel.show({ diff: SAMPLE_UNIFIED_DIFF, confidence: "medium" });

    await panel.handleKey("y");
    const evidence = panel.getWrapUpEvidence();
    expect(evidence!.state).toBe("blocked");
    expect(evidence!.statusMessage).toContain("Blocked");
  });
});

// ─── 8. generateDiffFromBeforeAfter Tests ───────────────────────────────────────

describe("generateDiffFromBeforeAfter", () => {
  test("generates diff from before/after content", () => {
    const diff = generateDiffFromBeforeAfter(BEFORE_CONTENT, AFTER_CONTENT, "test.ts");
    expect(diff).toContain("--- a/test.ts");
    expect(diff).toContain("+++ b/test.ts");
    // Should have at least + or - lines
    expect(diff.includes("+") || diff.includes("-")).toBe(true);
  });

  test("generates diff content that parseUnifiedDiff can process", () => {
    const diff = generateDiffFromBeforeAfter(BEFORE_CONTENT, AFTER_CONTENT, "test.ts");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.headers).toHaveLength(2);
    expect(parsed.additions + parsed.removals).toBeGreaterThan(0);
  });

  test("handles identical content (no changes)", () => {
    const content = "same\nlines\n";
    const diff = generateDiffFromBeforeAfter(content, content, "same.ts");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.additions).toBe(0);
    expect(parsed.removals).toBe(0);
  });
});