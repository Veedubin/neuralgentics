/**
 * T-083 tests: 3-Way Merge Viewer
 *
 * Tests cover:
 * 1. renderThreeWay — 3-pane layout rendering
 * 2. cycleActivePane — Tab cycles ours→theirs→base→ours
 * 3. jumpToPane — 1/2/3 direct pane jumps
 * 4. acceptActive — y accepts based on active pane
 * 5. rejectTheirs — n rejects theirs
 * 6. DiffPanel showThreeWay / handleKey in 3-way mode
 * 7. Base pane is read-only (y in base-active is a no-op)
 * 8. 2-way regression — existing DiffPanel still works
 * 9. Narrow terminal graceful degradation
 * 10. All keys consumed in active 3-way state (modal)
 */

import { describe, test, expect } from "bun:test";
import {
  renderThreeWay,
  cycleActivePane,
  jumpToPane,
  acceptActive,
  rejectTheirs,
  calculatePaneWidths,
  DiffPanel,
  renderDiffPanel,
  type ThreeWayPane,
  type ThreeWayState,
  type ThreeWayDiffInput,
} from "../panels/diff.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────────

const BASE_CONTENT = `function greet(name) {
  return "Hello, " + name;
}
`;

const OURS_CONTENT = `function greet(name) {
  return "Hello, " + name + "!";
}
`;

const THEIRS_CONTENT = `function greet(name) {
  console.log("Hello, " + name);
  return "Hello, " + name;
}
`;

const SAMPLE_THREE_WAY: ThreeWayDiffInput = {
  base: BASE_CONTENT,
  ours: OURS_CONTENT,
  theirs: THEIRS_CONTENT,
};

// ─── 1. renderThreeWay Tests ────────────────────────────────────────────────────

describe("renderThreeWay", () => {
  test("renders 3-pane layout with base, ours, theirs", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "ours", 120);

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.state).toBe("ours-active");
    expect(result.activePane).toBe("ours");
    expect(result.paneData).toHaveLength(3);
    expect(result.paneData[0].label).toBe("base");
    expect(result.paneData[1].label).toBe("ours");
    expect(result.paneData[2].label).toBe("theirs");
  });

  test("renders with theirs as active pane", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "theirs", 120);

    expect(result.state).toBe("theirs-active");
    expect(result.activePane).toBe("theirs");
    expect(result.paneData[2].isActive).toBe(true);
  });

  test("renders with base as active pane", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "base", 100);

    expect(result.state).toBe("base-active");
    expect(result.activePane).toBe("base");
    expect(result.paneData[0].isActive).toBe(true);
  });

  test("shows error for narrow terminal", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "ours", 40);

    expect(result.state).toBe("error");
    expect(result.lines[0]).toContain("too narrow");
    expect(result.statusMessage).toContain("60");
  });

  test("base pane is always marked read-only", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "ours", 120);

    expect(result.paneData[0].isReadOnly).toBe(true);
    expect(result.paneData[1].isReadOnly).toBe(false);
    expect(result.paneData[2].isReadOnly).toBe(false);
  });

  test("keybinding bar is present in output", () => {
    const result = renderThreeWay(SAMPLE_THREE_WAY, "ours", 120);
    const keyBarLine = result.lines.find((l) => l.includes("[Tab]") && l.includes("[y]"));
    expect(keyBarLine).toBeDefined();
  });
});

// ─── 2. cycleActivePane Tests ──────────────────────────────────────────────────

describe("cycleActivePane", () => {
  test("Tab cycles ours → theirs", () => {
    expect(cycleActivePane("ours")).toBe("theirs");
  });

  test("Tab cycles theirs → base", () => {
    expect(cycleActivePane("theirs")).toBe("base");
  });

  test("Tab cycles base → ours", () => {
    expect(cycleActivePane("base")).toBe("ours");
  });

  test("Tab cycles back to ours after full loop", () => {
    let pane: ThreeWayPane = "ours";
    pane = cycleActivePane(pane); // ours → theirs
    pane = cycleActivePane(pane); // theirs → base
    pane = cycleActivePane(pane); // base → ours
    expect(pane).toBe("ours");
  });
});

// ─── 3. jumpToPane Tests ────────────────────────────────────────────────────────

describe("jumpToPane", () => {
  test("1 jumps to base pane", () => {
    expect(jumpToPane(1)).toBe("base");
  });

  test("2 jumps to ours pane", () => {
    expect(jumpToPane(2)).toBe("ours");
  });

  test("3 jumps to theirs pane", () => {
    expect(jumpToPane(3)).toBe("theirs");
  });
});

// ─── 4. acceptActive Tests ──────────────────────────────────────────────────────

describe("acceptActive", () => {
  test("y in ours-active state accepts ours", () => {
    const result = acceptActive("ours-active");
    expect(result.newState).toBe("accepted");
    expect(result.message).toContain("ours");
  });

  test("y in theirs-active state accepts theirs", () => {
    const result = acceptActive("theirs-active");
    expect(result.newState).toBe("accepted");
    expect(result.message).toContain("theirs");
  });

  test("y in base-active state is a no-op (read-only)", () => {
    const result = acceptActive("base-active");
    expect(result.newState).toBe("base-active");
    expect(result.message).toContain("read-only");
  });

  test("y in accepted state is a no-op", () => {
    const result = acceptActive("accepted");
    expect(result.newState).toBe("accepted");
    expect(result.message).toBe("");
  });

  test("y in rejected state is a no-op", () => {
    const result = acceptActive("rejected");
    expect(result.newState).toBe("rejected");
    expect(result.message).toBe("");
  });
});

// ─── 5. rejectTheirs Tests ──────────────────────────────────────────────────────

describe("rejectTheirs", () => {
  test("n rejects theirs and keeps ours", () => {
    const result = rejectTheirs();
    expect(result.newState).toBe("rejected");
    expect(result.message).toContain("rejected");
    expect(result.message).toContain("ours");
  });
});

// ─── 6. DiffPanel 3-way Integration Tests ───────────────────────────────────────

describe("DiffPanel 3-way mode", () => {
  test("showThreeWay sets mode to threeWay and state to ours-active", () => {
    const panel = new DiffPanel();
    const result = panel.showThreeWay(SAMPLE_THREE_WAY, 120);

    expect(panel.mode).toBe("threeWay");
    expect(panel.threeWayState).toBe("ours-active");
    expect(panel.activePane).toBe("ours");
    expect(result.lines.length).toBeGreaterThan(0);
  });

  test("Tab key cycles active pane in 3-way mode", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    expect(panel.activePane).toBe("ours");

    // Tab → theirs
    let consumed = await panel.handleKey("tab");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("theirs");

    // Tab → base
    consumed = await panel.handleKey("tab");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("base");

    // Tab → ours (full cycle)
    consumed = await panel.handleKey("tab");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("ours");
  });

  test("1/2/3 keys jump to specific panes", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    expect(panel.activePane).toBe("ours");

    // Press 1 → base
    let consumed = await panel.handleKey("1");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("base");

    // Press 3 → theirs
    consumed = await panel.handleKey("3");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("theirs");

    // Press 2 → ours
    consumed = await panel.handleKey("2");
    expect(consumed).toBe(true);
    expect(panel.activePane).toBe("ours");
  });

  test("y accepts ours when ours is active in 3-way mode", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    // Default active pane is ours
    expect(panel.activePane).toBe("ours");

    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("accepted");
    expect(panel.statusMessage).toContain("ours");
  });

  test("y accepts theirs when theirs is active in 3-way mode", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    // Tab to theirs
    await panel.handleKey("tab");
    expect(panel.activePane).toBe("theirs");

    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("accepted");
    expect(panel.statusMessage).toContain("theirs");
  });

  test("y in base-active is a no-op (read-only)", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    // Jump to base
    await panel.handleKey("1");
    expect(panel.activePane).toBe("base");

    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("base-active");
    expect(panel.statusMessage).toContain("read-only");
  });

  test("n rejects theirs from any active pane in 3-way mode", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);

    const consumed = await panel.handleKey("n");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("rejected");
    expect(panel.statusMessage).toContain("rejected");
  });

  test("q hides the 3-way panel", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    expect(panel.mode).toBe("threeWay");

    const consumed = await panel.handleKey("q");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("idle");
    expect(panel.mode).toBe("twoWay"); // hide() resets mode
  });

  test("unknown keys are consumed in 3-way mode (modal)", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);

    const consumed = await panel.handleKey("x");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("ours-active"); // state unchanged
  });

  test("keys are not consumed when 3-way panel is idle", async () => {
    const panel = new DiffPanel();
    // Panel starts in idle/hidden state
    const consumed = await panel.handleKey("y");
    expect(consumed).toBe(false);
  });

  test("Escape hides the 3-way panel", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);

    const consumed = await panel.handleKey("escape");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("idle");
  });

  test("accepted state only allows q/Esc", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    await panel.handleKey("y"); // Accept — state is "accepted"
    expect(panel.threeWayState).toBe("accepted");

    // Other keys are consumed but don't change state
    let consumed = await panel.handleKey("tab");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("accepted");

    // q/Escape closes
    consumed = await panel.handleKey("q");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("idle");
  });

  test("rejected state only allows q/Esc", async () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);
    await panel.handleKey("n"); // Reject — state is "rejected"
    expect(panel.threeWayState).toBe("rejected");

    // Other keys are consumed but don't change state
    let consumed = await panel.handleKey("2");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("rejected");

    // Escape closes
    consumed = await panel.handleKey("escape");
    expect(consumed).toBe(true);
    expect(panel.threeWayState).toBe("idle");
  });
});

// ─── 7. calculatePaneWidths Tests ────────────────────────────────────────────────

describe("calculatePaneWidths", () => {
  test("returns null for terminal width < 60", () => {
    expect(calculatePaneWidths(59)).toBeNull();
    expect(calculatePaneWidths(30)).toBeNull();
  });

  test("returns valid widths for terminal width >= 60", () => {
    const widths = calculatePaneWidths(80);
    expect(widths).not.toBeNull();
    expect(widths!.baseW).toBeGreaterThanOrEqual(15);
    expect(widths!.oursW).toBeGreaterThan(0);
    expect(widths!.theirsW).toBeGreaterThan(0);
  });

  test("base width is approximately 25% of content width", () => {
    const widths = calculatePaneWidths(100);
    // content = 100 - 4 (borders/separators) = 96
    // base = max(15, floor(96 * 0.25)) = 24
    expect(widths!.baseW).toBe(24);
  });

  test("all pane widths sum to content width", () => {
    const terminalWidth = 120;
    const widths = calculatePaneWidths(terminalWidth)!;
    const contentW = terminalWidth - 4; // 2 outer border + 2 separators
    expect(widths.baseW + widths.oursW + widths.theirsW).toBe(contentW);
  });
});

// ─── 8. 2-Way Regression Tests ──────────────────────────────────────────────────

describe("2-way diff regression", () => {
  test("DiffPanel 2-way show still works after 3-way additions", () => {
    const panel = new DiffPanel();
    const result = panel.show({
      diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
      confidence: "high",
    });

    expect(result.state).toBe("showing");
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(1);
    expect(panel.mode).toBe("twoWay");
  });

  test("DiffPanel 2-way handleKey still works after 3-way additions", async () => {
    const panel = new DiffPanel();
    panel.show({
      diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
      confidence: "high",
    });

    const consumed = await panel.handleKey("q");
    expect(consumed).toBe(true);
    expect(panel.state).toBe("hidden");
  });

  test("renderDiffPanel (pure function) still works", () => {
    const result = renderDiffPanel({
      diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new",
    });
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(1);
    expect(result.state).toBe("showing");
  });

  test("getWrapUpEvidence returns null in 3-way mode", () => {
    const panel = new DiffPanel();
    panel.showThreeWay(SAMPLE_THREE_WAY, 120);

    // 3-way mode should return null from getWrapUpEvidence
    const evidence = panel.getWrapUpEvidence();
    expect(evidence).toBeNull();
  });
});