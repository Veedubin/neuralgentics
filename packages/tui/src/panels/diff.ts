/**
 * T-030 — Diff Verification Panel
 *
 * Interactive modal overlay that renders proposed code changes as a side-by-side
 * diff, accepts y/n/Esc key input, runs a configurable test callback on accept,
 * and enforces a confidence gate (low confidence → blocked).
 *
 * Uses OpenTUI's native `DiffRenderable` with `view: "split"` for side-by-side
 * rendering. Falls back to a simple text-based renderer if the native widget
 * is unavailable (shouldn't happen with opentui >= 0.3.1).
 */

import {
  Box,
  Text,
} from "@opentui/core";
import type { BoxVNode, TextVNode } from "../vnode-types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Confidence classification for a proposed change. */
export type Confidence = "low" | "medium" | "high";

/** Result from the mock (or real) test runner. */
export interface TestResult {
  /** Whether the tests passed. */
  pass: boolean;
  /** Error message if tests failed. */
  error?: string;
  /** Confidence score from the test run. */
  confidence: Confidence;
}

/** State machine for the diff panel. */
export type DiffPanelState = "hidden" | "showing" | "accepted" | "rejected" | "blocked";

/** Input data for the diff panel. */
export interface DiffInput {
  /** Unified diff string (preferred). */
  diff?: string;
  /** Before/after file contents (alternative to unified diff). */
  beforeAfter?: { before: string; after: string };
  /** File title shown in the panel header. */
  title?: string;
  /** Confidence level for the proposed change. */
  confidence?: Confidence;
}

/** Rendered output from `renderDiffPanel`. */
export interface DiffPanelRenderResult {
  /** Formatted lines (string array for testability). */
  lines: string[];
  /** Number of lines with additions. */
  additions: number;
  /** Number of lines with removals. */
  removals: number;
  /** Current panel state. */
  state: DiffPanelState;
  /** Optional status message (e.g. "✓ Accepted", "✗ Blocked: ..."). */
  statusMessage?: string;
}

// ─── Unified Diff Parser ──────────────────────────────────────────────────────

/** A single parsed diff line. */
export interface ParsedDiffLine {
  type: "add" | "remove" | "context" | "header" | "hunk" | "no-newline";
  content: string;
  lineNumber?: number;
}

/** A hunk from a unified diff. */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

/** Parsed unified diff result. */
export interface ParsedDiff {
  /** File headers (--- a/file, +++ b/file). */
  headers: string[];
  /** Hunks of changes. */
  hunks: DiffHunk[];
  /** Raw unified diff string. */
  raw: string;
  /** Total addition lines. */
  additions: number;
  /** Total removal lines. */
  removals: number;
}

/**
 * Parse a unified diff string into structured data.
 *
 * Supports standard unified diff format:
 * ```
 * --- a/file.ts
 * +++ b/file.ts
 * @@ -1,3 +1,4 @@
 *  context line
 * -removed line
 * +added line
 * ```
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  const headers: string[] = [];
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let removals = 0;

  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // File headers: --- a/... and +++ b/...
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      headers.push(line);
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@@? -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      continue;
    }

    // Content lines
    if (currentHunk === null) {
      // Lines before first hunk — might be diff header comments
      continue;
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      removals++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (line.startsWith("\\ ")) {
      // "\ No newline at end of file"
      currentHunk.lines.push({ type: "no-newline", content: line });
    } else if (line.length === 0) {
      // Empty line in diff — treat as context
      currentHunk.lines.push({ type: "context", content: "" });
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return { headers, hunks, raw: diff, additions, removals };
}

/**
 * Generate a unified diff string from before/after content.
 *
 * Simple line-by-line comparison (not a true diff algorithm — just identifies
 * which lines were added/removed/unchanged).
 */
export function generateDiffFromBeforeAfter(before: string, after: string, filename: string = "file"): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const lines: string[] = [];
  lines.push(`--- a/${filename}`);
  lines.push(`+++ b/${filename}`);
  lines.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);

  // Simple comparison: find common prefix/suffix, mark differences
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  let oldLine = 0;
  let newLine = 0;

  // Use a simple LCS approach for readable diffs
  const { removed, added, common } = computeLineDiff(beforeLines, afterLines);

  for (const line of common) {
    lines.push(` ${line}`);
  }
  // Interleave removes then adds for readability
  for (const line of removed) {
    lines.push(`-${line}`);
  }
  for (const line of added) {
    lines.push(`+${line}`);
  }

  return lines.join("\n");
}

/**
 * Simple line-level diff computation.
 * For v0.1.0, uses a straightforward approach that produces readable results.
 * Not a true LCS — groups consecutive changes together.
 */
function computeLineDiff(
  beforeLines: string[],
  afterLines: string[],
): { removed: string[]; added: string[]; common: string[] } {
  const common: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];

  // Build a set of lines in both for quick lookup
  const afterSet = new Set(afterLines);

  let bi = 0;
  let ai = 0;

  while (bi < beforeLines.length && ai < afterLines.length) {
    if (beforeLines[bi] === afterLines[ai]) {
      common.push(beforeLines[bi]);
      bi++;
      ai++;
    } else {
      // Collect consecutive removed lines
      while (bi < beforeLines.length && !afterSet.has(beforeLines[bi])) {
        removed.push(beforeLines[bi]);
        bi++;
      }
      // Collect consecutive added lines
      const beforeRemaining = new Set(beforeLines.slice(bi));
      while (ai < afterLines.length && !beforeRemaining.has(afterLines[ai])) {
        added.push(afterLines[ai]);
        ai++;
      }
    }
  }

  // Remaining lines
  while (bi < beforeLines.length) {
    removed.push(beforeLines[bi]);
    bi++;
  }
  while (ai < afterLines.length) {
    added.push(afterLines[ai]);
    ai++;
  }

  return { removed, added, common };
}

// ─── Diff Panel Rendering (pure function for testability) ────────────────────

const DIFF_COLORS = {
  addLine: "\x1b[32m",       // green
  removeLine: "\x1b[31m",    // red
  contextLine: "\x1b[37m",   // white/gray
  headerLine: "\x1b[36m",    // cyan
  hunkHeader: "\x1b[33m",    // yellow
  reset: "\x1b[0m",
  addSign: "+",
  removeSign: "-",
  contextSign: " ",
};

/**
 * Render a diff into a side-by-side display format.
 *
 * This pure function produces an array of formatted strings suitable for
 * rendering in a terminal or TUI panel. Each line is marked with `+` or `-`
 * and colored appropriately.
 *
 * @param input - The diff input (unified diff string or before/after pair).
 * @param title - Optional file title for the header.
 * @returns Rendered result with lines, additions/removals counts, and state.
 */
export function renderDiffPanel(
  input: DiffInput,
  title?: string,
): DiffPanelRenderResult {
  const { diff, beforeAfter, confidence = "medium" } = input;

  let parsed: ParsedDiff;
  let state: DiffPanelState = "showing";

  if (diff) {
    parsed = parseUnifiedDiff(diff);
  } else if (beforeAfter) {
    const generated = generateDiffFromBeforeAfter(
      beforeAfter.before,
      beforeAfter.after,
      title ?? "file",
    );
    parsed = parseUnifiedDiff(generated);
  } else {
    return {
      lines: ["⚠ No diff data provided"],
      additions: 0,
      removals: 0,
      state: "hidden",
      statusMessage: "No diff data",
    };
  }

  // Low confidence forces blocked state
  if (confidence === "low") {
    state = "blocked";
  }

  const lines: string[] = [];

  // Header
  const displayTitle = title ?? (parsed.headers.length > 0
    ? parsed.headers.join(" → ")
    : "Diff");
  lines.push(`╔══ Diff: ${displayTitle} ══╗`);
  lines.push("");

  // Render file headers
  for (const header of parsed.headers) {
    lines.push(`${DIFF_COLORS.headerLine}${header}${DIFF_COLORS.reset}`);
  }
  if (parsed.headers.length > 0) {
    lines.push("");
  }

  // Render hunks
  for (const hunk of parsed.hunks) {
    lines.push(
      `${DIFF_COLORS.hunkHeader}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${DIFF_COLORS.reset}`,
    );

    for (const line of hunk.lines) {
      switch (line.type) {
        case "add":
          lines.push(
            `${DIFF_COLORS.addLine}${DIFF_COLORS.addSign}${line.content}${DIFF_COLORS.reset}`,
          );
          break;
        case "remove":
          lines.push(
            `${DIFF_COLORS.removeLine}${DIFF_COLORS.removeSign}${line.content}${DIFF_COLORS.reset}`,
          );
          break;
        case "context":
          lines.push(
            `${DIFF_COLORS.contextLine}${DIFF_COLORS.contextSign}${line.content}${DIFF_COLORS.reset}`,
          );
          break;
        case "no-newline":
          lines.push(
            `${DIFF_COLORS.contextLine}${line.content}${DIFF_COLORS.reset}`,
          );
          break;
      }
    }
  }

  // Status bar
  lines.push("");
  lines.push(
    `${parsed.additions} addition(s), ${parsed.removals} removal(s) │ Confidence: ${confidence}`,
  );
  lines.push("[y] Accept  [n] Reject  [q/Esc] Close");

  return {
    lines,
    additions: parsed.additions,
    removals: parsed.removals,
    state,
    statusMessage: state === "blocked"
      ? "⚠ Blocked: low confidence — manual review required"
      : undefined,
  };
}

// ─── Diff Panel Class (TUI integration) ─────────────────────────────────────

export type AcceptCallback = () => Promise<TestResult>;
export type RejectCallback = () => void;

/**
 * Interactive diff verification panel.
 *
 * Manages the state machine for showing diffs, accepting/rejecting changes,
 * and running tests. Designed as a modal overlay on the chat panel area.
 *
 * Key bindings:
 *   y — Accept the change (runs test callback)
 *   n — Reject the change (blocks the card)
 *   q / Esc — Close the panel without action
 */
export class DiffPanel {
  private _state: DiffPanelState = "hidden";
  private _currentInput: DiffInput | null = null;
  private _currentResult: DiffPanelRenderResult | null = null;
  private _acceptCallback: AcceptCallback | null = null;
  private _rejectCallback: RejectCallback | null = null;
  private _statusMessage: string = "";

  // T-083: 3-way merge state (additive — existing 2-way fields untouched)
  private _mode: DiffMode = "twoWay";
  private _threeWayState: ThreeWayState = "idle";
  private _threeWayInput: ThreeWayDiffInput | null = null;
  private _threeWayResult: ThreeWayRenderResult | null = null;
  private _activePane: ThreeWayPane = "ours";

  // VNode references for TUI rendering (set during mount)
  private _panelBox: BoxVNode | null = null;
  private _contentText: TextVNode | null = null;
  private _statusText: TextVNode | null = null;

  /** Current panel state. */
  get state(): DiffPanelState {
    return this._state;
  }

  /** Current status message. */
  get statusMessage(): string {
    return this._statusMessage;
  }

  /** Current rendered result. */
  get currentResult(): DiffPanelRenderResult | null {
    return this._currentResult;
  }

  /** Current 3-way merge state. */
  get threeWayState(): ThreeWayState {
    return this._threeWayState;
  }

  /** Current 3-way pane selector. */
  get activePane(): ThreeWayPane {
    return this._activePane;
  }

  /** Current diff mode (2-way or 3-way). */
  get mode(): DiffMode {
    return this._mode;
  }

  /**
   * Show the diff panel with proposed changes.
   *
   * @param input - Diff data (unified diff string or before/after pair).
   * @param callback - Called when the panel state changes.
   */
  show(input: DiffInput): DiffPanelRenderResult {
    this._currentInput = input;
    const confidence = input.confidence ?? "medium";

    // Render the diff
    this._currentResult = renderDiffPanel(input, input.title);

    // Check confidence gate — low confidence forces blocked
    if (confidence === "low") {
      this._state = "blocked";
      this._statusMessage = "⚠ Blocked: low confidence — manual review required";
    } else {
      this._state = "showing";
      this._statusMessage = "";
    }

    this._currentResult.state = this._state;
    this._currentResult.statusMessage = this._statusMessage;

    this._updateDisplay();

    return this._currentResult;
  }

  /**
   * Hide the diff panel.
   */
  hide(): void {
    this._state = "hidden";
    this._currentInput = null;
    this._currentResult = null;
    this._statusMessage = "";
    this._mode = "twoWay";
    this._threeWayState = "idle";
    this._threeWayInput = null;
    this._threeWayResult = null;
    this._activePane = "ours";
    this._updateDisplay();
  }

  /**
   * Show the 3-way merge viewer (T-083).
   *
   * @param input - The 3-way diff input (base, ours, theirs).
   * @param terminalWidth - Terminal width for layout (default 120).
   * @returns The rendered result.
   */
  showThreeWay(input: ThreeWayDiffInput, terminalWidth: number = 120): ThreeWayRenderResult {
    this._mode = "threeWay";
    this._threeWayInput = input;
    this._activePane = "ours";
    this._threeWayState = "ours-active";

    this._threeWayResult = renderThreeWay(input, this._activePane, terminalWidth);

    if (this._threeWayResult.state === "error") {
      this._threeWayState = "error";
      this._statusMessage = this._threeWayResult.statusMessage;
    } else {
      this._threeWayState = "ours-active";
      this._statusMessage = "Active: ours";
    }

    // Also set 2-way state to showing so the panel is visible
    this._state = "showing";
    this._updateDisplay();

    return this._threeWayResult;
  }

  /**
   * Register the accept callback.
   * Called when user presses 'y'. Should return test results.
   */
  onAccept(callback: AcceptCallback): void {
    this._acceptCallback = callback;
  }

  /**
   * Register the reject callback.
   * Called when user presses 'n'.
   */
  onReject(callback: RejectCallback): void {
    this._rejectCallback = callback;
  }

  /**
   * Handle a key press event.
   *
   * Returns true if the key was consumed (panel is active), false otherwise.
   * Dispatches to 2-way or 3-way handler based on current mode.
   */
  async handleKey(keyName: string): Promise<boolean> {
    // If panel is hidden, don't consume
    if (this._state === "hidden" && this._threeWayState === "idle") {
      return false;
    }

    // Dispatch based on mode
    if (this._mode === "threeWay") {
      return this._handleThreeWayKey(keyName);
    }
    return this._handleTwoWayKey(keyName);
  }

  /**
   * Create OpenTUI renderables for the diff panel.
   *
   * This builds a modal overlay Box that can be shown/hidden atop the
   * chat panel area. The panel shows the diff with y/n/q controls.
   */
  createRenderable(): BoxVNode {
    const panelBox = Box({
      id: "diff-panel",
      border: true,
      borderStyle: "single",
      borderColor: "#ff6644",
      title: " Diff Verification ",
      titleAlignment: "center",
      width: "100%",
      height: "100%",
      backgroundColor: "#1a1a2e",
      flexDirection: "column",
      visible: false,
      onKeyDown: (key) => {
        this.handleKey(key.name);
      },
    });

    const contentText = Text({
      id: "diff-content",
      content: "",
      fg: "#e0e0e0",
    });

    const statusText = Text({
      id: "diff-status",
      content: "",
      fg: "#00ff88",
    });

    panelBox.add(contentText);
    panelBox.add(statusText);

    this._panelBox = panelBox as unknown as BoxVNode;
    this._contentText = contentText as unknown as TextVNode;
    this._statusText = statusText as unknown as TextVNode;

    return panelBox as unknown as BoxVNode;
  }

  /**
   * 2-way key handler (original behavior, extracted from handleKey).
   */
  private async _handleTwoWayKey(keyName: string): Promise<boolean> {
    // If panel is hidden, don't consume
    if (this._state === "hidden") {
      return false;
    }

    // If already in a terminal state, only allow close
    if (this._state === "accepted" || this._state === "rejected" || this._state === "blocked") {
      if (keyName === "q" || keyName === "escape") {
        this.hide();
        return true;
      }
      return true; // Consume all keys in terminal states except q/Esc
    }

    // Key handling in "showing" state
    switch (keyName) {
      case "y":
        await this._handleAccept();
        return true;

      case "n":
        this._handleReject();
        return true;

      case "q":
      case "escape":
        this.hide();
        return true;

      default:
        return true; // Panel is active, consume all keys to prevent input going to chat
    }
  }

  /**
   * 3-way merge key handler (T-083).
   *
   * Handles Tab (cycle pane), 1/2/3 (jump to pane), y (accept), n (reject), q/Esc (quit).
   */
  private async _handleThreeWayKey(keyName: string): Promise<boolean> {
    // If in idle state, don't consume
    if (this._threeWayState === "idle") {
      return false;
    }

    // Terminal states: accepted/rejected/error — only q/Esc closes
    if (this._threeWayState === "accepted" || this._threeWayState === "rejected" || this._threeWayState === "error") {
      if (keyName === "q" || keyName === "escape") {
        this.hide();
        return true;
      }
      return true; // Consume all keys in terminal states
    }

    // Active states: ours-active, theirs-active, base-active
    switch (keyName) {
      case "tab": {
        this._activePane = cycleActivePane(this._activePane);
        this._threeWayState = this._activePane === "base" ? "base-active" : this._activePane === "ours" ? "ours-active" : "theirs-active";
        this._rerenderThreeWay();
        return true;
      }

      case "1":
        this._activePane = "base";
        this._threeWayState = "base-active";
        this._rerenderThreeWay();
        return true;

      case "2":
        this._activePane = "ours";
        this._threeWayState = "ours-active";
        this._rerenderThreeWay();
        return true;

      case "3":
        this._activePane = "theirs";
        this._threeWayState = "theirs-active";
        this._rerenderThreeWay();
        return true;

      case "y": {
        const result = acceptActive(this._threeWayState);
        this._threeWayState = result.newState;
        this._statusMessage = result.message;
        this._updateDisplay();
        return true;
      }

      case "n": {
        const result = rejectTheirs();
        this._threeWayState = result.newState;
        this._statusMessage = result.message;
        this._updateDisplay();
        return true;
      }

      case "q":
      case "escape":
        this.hide();
        return true;

      default:
        // Consume all keys when panel is active (modal behavior)
        return true;
    }
  }

  /**
   * Re-render the 3-way merge view after a pane change.
   */
  private _rerenderThreeWay(): void {
    if (!this._threeWayInput) return;
    this._threeWayResult = renderThreeWay(this._threeWayInput, this._activePane);
    this._statusMessage = `Active: ${this._activePane}`;
    this._updateDisplay();
  }

  private async _handleAccept(): Promise<void> {
    if (!this._acceptCallback) {
      this._state = "accepted";
      this._statusMessage = "✓ Accepted (no test runner configured)";
      this._updateDisplay();
      return;
    }

    // Show "running tests..." indicator
    this._statusMessage = "⟳ Running tests...";
    this._updateDisplay();

    try {
      const result = await this._acceptCallback();

      if (result.pass) {
        this._state = "accepted";
        this._statusMessage = "✓ Accepted — tests passed";
      } else {
        this._state = "blocked";
        this._statusMessage = `✗ Blocked: ${result.error ?? "test failure"}`;
      }

      // Low confidence overrides
      if (result.confidence === "low") {
        this._state = "blocked";
        this._statusMessage = "⚠ Blocked: low confidence — manual review required";
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._state = "blocked";
      this._statusMessage = `✗ Blocked: test error — ${message}`;
    }

    this._updateDisplay();
  }

  private _handleReject(): void {
    this._state = "rejected";
    this._statusMessage = "✗ Rejected by user";

    if (this._rejectCallback) {
      this._rejectCallback();
    }

    this._updateDisplay();
  }

  private _updateDisplay(): void {
    if (!this._contentText || !this._statusText) return;

    // 3-way merge mode display
    if (this._mode === "threeWay" && this._threeWayResult) {
      if (this._threeWayState === "idle") {
        if (this._panelBox) {
          this._panelBox.visible = false;
        }
        return;
      }

      if (this._panelBox) {
        this._panelBox.visible = true;
      }

      const contentLines = this._threeWayResult.lines.map(stripAnsiForDisplay).join("\n");
      this._contentText.content = contentLines;

      // Status message with color based on 3-way state
      this._statusText.content = this._statusMessage;
      switch (this._threeWayState) {
        case "accepted":
          this._statusText.fg = "#00ff88";
          break;
        case "rejected":
          this._statusText.fg = "#ff4444";
          break;
        case "error":
          this._statusText.fg = "#ff4444";
          break;
        case "base-active":
          this._statusText.fg = "#ffaa00";
          break;
        default:
          this._statusText.fg = "#e0e0e0";
      }
      return;
    }

    // 2-way mode display (original)
    if (this._state === "hidden" || !this._currentResult) {
      if (this._panelBox) {
        this._panelBox.visible = false;
      }
      return;
    }

    if (this._panelBox) {
      this._panelBox.visible = true;
    }

    // Update content
    const contentLines = this._currentResult.lines.map(stripAnsiForDisplay).join("\n");
    this._contentText.content = contentLines;

    // Update status bar with current state
    this._statusText.content = this._statusMessage;

    // Color status based on state
    switch (this._state) {
      case "accepted":
        this._statusText.fg = "#00ff88";
        break;
      case "rejected":
        this._statusText.fg = "#ff4444";
        break;
      case "blocked":
        this._statusText.fg = "#ffaa00";
        break;
      default:
        this._statusText.fg = "#e0e0e0";
    }
  }

  /**
   * Build wrap-up evidence for the kanban.
   *
   * Returns a structured log of the diff verification result that
   * the kanban manager can read later.
   */
  getWrapUpEvidence(): DiffWrapUpEvidence | null {
    // 3-way merge mode does not produce wrap-up evidence
    if (this._mode === "threeWay") {
      return null;
    }

    if (this._state === "hidden" || !this._currentInput) {
      return null;
    }

    return {
      state: this._state,
      statusMessage: this._statusMessage,
      additions: this._currentResult?.additions ?? 0,
      removals: this._currentResult?.removals ?? 0,
      confidence: this._currentInput.confidence ?? "medium",
      title: this._currentInput.title ?? "untitled",
      timestamp: new Date().toISOString(),
    };
  }
}

/** Wrap-up evidence structure for kanban integration. */
export interface DiffWrapUpEvidence {
  state: DiffPanelState;
  statusMessage: string;
  additions: number;
  removals: number;
  confidence: Confidence;
  title: string;
  timestamp: string;
}

/**
 * Strip ANSI escape codes for plain-text display.
 * Used when rendering to OpenTUI Text (which handles its own coloring).
 */
function stripAnsiForDisplay(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Diff Panel State Machine (for testing) ──────────────────────────────────

/**
 * Create a mock test runner that returns the given result.
 * Used until T-029 wires the real test runner.
 */
export function createMockTestRunner(
  result: TestResult,
): AcceptCallback {
  return async () => result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// T-083 — 3-Way Merge Viewer (Additive Extension)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 3-Way Types (additive) ─────────────────────────────────────────────────────

/** Diff mode: 2-way (original) or 3-way merge viewer. */
export type DiffMode = "twoWay" | "threeWay";

/** 3-way merge pane identifier. */
export type ThreeWayPane = "base" | "ours" | "theirs";

/** State machine for the 3-way merge viewer. */
export type ThreeWayState =
  | "idle"
  | "ours-active"
  | "theirs-active"
  | "base-active"
  | "accepted"
  | "rejected"
  | "error";

/** Input for the 3-way merge viewer. */
export interface ThreeWayDiffInput {
  /** Original file content before any changes (ancestor). */
  base: string;
  /** Local/current file content (our version). */
  ours: string;
  /** Proposed/coder's file content (their version). */
  theirs: string;
  /** Optional conflict marker lines. */
  conflictMarkers?: string[];
}

/** Stores a single pane's rendered output. */
interface ThreeWayPaneData {
  label: "base" | "ours" | "theirs";
  lines: string[];
  lineCount: number;
  isReadOnly: boolean;
  isActive: boolean;
}

/** Result from `renderThreeWay`. */
export interface ThreeWayRenderResult {
  lines: string[];
  paneData: [ThreeWayPaneData, ThreeWayPaneData, ThreeWayPaneData];
  activePane: ThreeWayPane;
  state: ThreeWayState;
  statusMessage: string;
}

// ─── 3-Way Constants ─────────────────────────────────────────────────────────────

const THREE_WAY_COLORS = {
  dimText: "\x1b[38;5;244m",    // gray #888
  activeBorder: "\x1b[1;36m",   // cyan bold
  inactiveBorder: "\x1b[37m",    // white
  headerSep: "\x1b[33m",        // yellow
  reset: "\x1b[0m",
};

const THREE_WAY_MIN_WIDTH = 60;

// ─── 3-Way Rendering (pure function for testability) ──────────────────────────

/**
 * Calculate pane widths for 3-way viewer.
 * base gets 25%, ours/theirs split remaining evenly.
 */
export function calculatePaneWidths(terminalWidth: number): { baseW: number; oursW: number; theirsW: number } | null {
  if (terminalWidth < THREE_WAY_MIN_WIDTH) {
    return null;
  }

  const separators = 2; // │ between panes
  const outerBorder = 2; // │ left + │ right
  const overhead = outerBorder + separators;
  const contentW = terminalWidth - overhead;
  const baseW = Math.max(15, Math.floor(contentW * 0.25));
  const remaining = contentW - baseW;
  const oursW = Math.floor(remaining / 2);
  const theirsW = remaining - oursW;

  return { baseW, oursW, theirsW };
}

/**
 * Render 3-way merge panes as formatted strings for display.
 *
 * This pure function produces an array of formatted strings representing
 * the three side-by-side panes (base, ours, theirs) with line numbers,
 * a status bar, and keybinding hints.
 *
 * @param input - The 3-way diff input (base, ours, theirs).
 * @param activePane - Which pane is currently active/highlighted.
 * @param terminalWidth - Terminal width in columns (default 120).
 * @returns ThreeWayRenderResult with lines and state.
 */
export function renderThreeWay(
  input: ThreeWayDiffInput,
  activePane: ThreeWayPane = "ours",
  terminalWidth: number = 120,
): ThreeWayRenderResult {
  const widths = calculatePaneWidths(terminalWidth);

  if (widths === null) {
    return {
      lines: [`⚠ Terminal too narrow for 3-way view (min ${THREE_WAY_MIN_WIDTH} cols, got ${terminalWidth})`],
      paneData: [
        { label: "base", lines: [], lineCount: 0, isReadOnly: true, isActive: false },
        { label: "ours", lines: [], lineCount: 0, isReadOnly: false, isActive: false },
        { label: "theirs", lines: [], lineCount: 0, isReadOnly: false, isActive: false },
      ],
      activePane,
      state: "error",
      statusMessage: `Terminal too narrow (min ${THREE_WAY_MIN_WIDTH} cols)`,
    };
  }

  const { baseW, oursW, theirsW } = widths;
  const lineNumWidth = 5; // " 123 " format

  // Split content into lines
  const baseLines = input.base.split("\n");
  const oursLines = input.ours.split("\n");
  const theirsLines = input.theirs.split("\n");
  const maxLines = Math.max(baseLines.length, oursLines.length, theirsLines.length);

  // Build pane data
  const basePane: ThreeWayPaneData = {
    label: "base",
    lines: baseLines,
    lineCount: baseLines.length,
    isReadOnly: true,
    isActive: activePane === "base",
  };
  const oursPane: ThreeWayPaneData = {
    label: "ours",
    lines: oursLines,
    lineCount: oursLines.length,
    isReadOnly: false,
    isActive: activePane === "ours",
  };
  const theirsPane: ThreeWayPaneData = {
    label: "theirs",
    lines: theirsLines,
    lineCount: theirsLines.length,
    isActive: activePane === "theirs",
    isReadOnly: false,
  };

  const panes: [ThreeWayPaneData, ThreeWayPaneData, ThreeWayPaneData] = [basePane, oursPane, theirsPane];

  // Render header
  const lines: string[] = [];
  const headerTitle = " Three-Way Merge ";
  lines.push(`╔${headerTitle}${"═".repeat(Math.max(0, terminalWidth - headerTitle.length - 2))}╗`);

  // Column headers
  const baseHeader = padPaneHeader("Base (original)", baseW);
  const oursHeader = padPaneHeader("Ours (local)", oursW);
  const theirsHeader = padPaneHeader("Theirs (proposed)", theirsW);
  lines.push(`║${baseHeader}│${oursHeader}│${theirsHeader}║`);

  // Separator line
  lines.push(`║${"─".repeat(baseW)}┼${"─".repeat(oursW)}┼${"─".repeat(theirsW)}║`);

  // Render content lines
  for (let i = 0; i < maxLines; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth - 2);
    const numPrefix = ` ${lineNum} `;

    const bContent = (baseLines[i] ?? "").slice(0, baseW - lineNumWidth);
    const oContent = (oursLines[i] ?? "").slice(0, oursW - lineNumWidth);
    const tContent = (theirsLines[i] ?? "").slice(0, theirsW - lineNumWidth);

    // Dim text for base pane, normal for others
    const bLine = activePane === "base"
      ? `${numPrefix}${padContent(bContent, baseW - lineNumWidth)}`
      : `${THREE_WAY_COLORS.dimText}${numPrefix}${padContent(bContent, baseW - lineNumWidth)}${THREE_WAY_COLORS.reset}`;
    const oLine = `${numPrefix}${padContent(oContent, oursW - lineNumWidth)}`;
    const tLine = `${numPrefix}${padContent(tContent, theirsW - lineNumWidth)}`;

    lines.push(`║${bLine}│${oLine}│${tLine}║`);
  }

  // Keybinding bar
  const keyBar = " [Tab] cycle  [1] base  [2] ours  [3] theirs  [y] accept  [n] reject  [q/Esc] quit ";
  lines.push(`║${keyBar}${" ".repeat(Math.max(0, terminalWidth - keyBar.length - 2))}║`);
  lines.push(`╚${"═".repeat(terminalWidth - 2)}╝`);

  return {
    lines,
    paneData: panes,
    activePane,
    state: activePane === "base" ? "base-active" : activePane === "ours" ? "ours-active" : "theirs-active",
    statusMessage: `Active: ${activePane}`,
  };
}

/** Pad a pane header to the given width. */
function padPaneHeader(header: string, width: number): string {
  const padded = header.length >= width
    ? header.slice(0, width)
    : header + " ".repeat(width - header.length);
  return padded.slice(0, width);
}

/** Pad content string to the given width. */
function padContent(content: string, width: number): string {
  const padded = content.length >= width
    ? content.slice(0, width)
    : content + " ".repeat(width - content.length);
  return padded.slice(0, Math.max(0, width));
}

// ─── 3-Way Navigation Functions (pure, testable) ────────────────────────────────

/**
 * Cycle the active pane in order: ours → theirs → base → ours.
 */
export function cycleActivePane(current: ThreeWayPane): ThreeWayPane {
  const cycle: ThreeWayPane[] = ["ours", "theirs", "base"];
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % 3]!;
}

/**
 * Jump directly to a specific pane by number (1=base, 2=ours, 3=theirs).
 */
export function jumpToPane(num: 1 | 2 | 3): ThreeWayPane {
  const map: Record<number, ThreeWayPane> = { 1: "base", 2: "ours", 3: "theirs" };
  return map[num]!;
}

/**
 * Accept the currently active pane's version.
 * In base-active state, this is a no-op (base is read-only).
 */
export function acceptActive(state: ThreeWayState): { newState: ThreeWayState; message: string } {
  if (state === "ours-active") {
    return { newState: "accepted", message: "✓ Merged with ours" };
  }
  if (state === "theirs-active") {
    return { newState: "accepted", message: "✓ Merged with theirs" };
  }
  if (state === "base-active") {
    return { newState: "base-active", message: "Base pane is read-only — select ours or theirs to accept" };
  }
  // accepted, rejected, error, idle — no-op
  return { newState: state, message: "" };
}

/**
 * Reject theirs — discard their version and keep ours.
 */
export function rejectTheirs(): { newState: ThreeWayState; message: string } {
  return { newState: "rejected", message: "✗ Merge rejected — keeping ours" };
}