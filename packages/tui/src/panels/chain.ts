/**
 * T-032 — ChainPanel
 *
 * Renders thought chain progress in the right (~20%) panel.
 * Supports progressive append, branch navigation (←/→), and collapse.
 */

import { Box, Text, ScrollBox } from "@opentui/core";
import type { ThemeColors } from "../themes/types.js";
import type { TextVNode, ScrollBoxVNode, BoxVNode } from "../vnode-types.js";
import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ThoughtEntry {
  thoughtNumber: number;
  totalThoughts: number;
  content: string;
  isRevision?: boolean;
  branchId?: string;
}

export interface ChainState {
  thoughts: ThoughtEntry[];
  activeBranch: string | null;
  collapsed: Set<number>;
}

// ─── ChainPanel ──────────────────────────────────────────────────────────────────

export class ChainPanel {
  private _state: ChainState = {
    thoughts: [],
    activeBranch: null,
    collapsed: new Set(),
  };

  private _colors: ThemeColors;

  private _textRef: TextVNode | null = null;
  private _scrollRef: ScrollBoxVNode | null = null;
  private _boxRef: BoxVNode | null = null;

  constructor(colors: ThemeColors) {
    this._colors = colors;
  }

  /** Update colors when theme changes. */
  setColors(colors: ThemeColors): void {
    this._colors = colors;
  }

  /** Get current chain state (for testing). */
  get state(): ChainState {
    return this._state;
  }

  /** Add a new thought to the current chain. */
  addThought(entry: ThoughtEntry): void {
    this._state.thoughts.push(entry);
    this._render();
  }

  /** Clear all thoughts. */
  clear(): void {
    this._state = { thoughts: [], activeBranch: null, collapsed: new Set() };
    this._render();
  }

  /** Navigate to previous branch (← arrow). */
  navigateBranchPrev(): void {
    // In v0.1.0, just announce — real branch data comes from the Go backend
    this._state.activeBranch = "prev";
    this._render();
  }

  /** Navigate to next branch (→ arrow). */
  navigateBranchNext(): void {
    this._state.activeBranch = "next";
    this._render();
  }

  /** Toggle collapse on a thought. */
  collapseThought(number: number): void {
    if (this._state.collapsed.has(number)) {
      this._state.collapsed.delete(number);
    } else {
      this._state.collapsed.add(number);
    }
    this._render();
  }

  /** Build the renderable VNodes. */
  build(): { box: unknown; textRef: unknown; scrollRef: unknown } {
    this._textRef = Text({
      id: "chain-content",
      content: this._buildContent(),
      fg: this._colors.textSecondary,
    }) as unknown as TextVNode;

    this._scrollRef = ScrollBox({ scrollY: true, scrollX: false, height: "100%" }) as unknown as ScrollBoxVNode;
    this._scrollRef.add(this._textRef);

    this._boxRef = Box({
      id: "chain-panel",
      border: true,
      borderStyle: "single",
      borderColor: this._colors.border,
      title: " Chain ",
      titleAlignment: "left",
      width: "20%",
      height: "100%",
      backgroundColor: this._colors.chainBg,
      flexDirection: "column",
    }) as unknown as BoxVNode;
    (this._boxRef as unknown as { add(child: unknown): void }).add(this._scrollRef);

    return { box: this._boxRef, textRef: this._textRef, scrollRef: this._scrollRef };
  }

  /** Update panel border color based on focus. */
  setActiveBorder(isActive: boolean): void {
    if (this._boxRef) {
      this._boxRef.borderColor = isActive ? this._colors.borderActive : this._colors.border;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _render(): void {
    if (this._textRef) {
      this._textRef.content = this._buildContent();
    }
  }

  private _buildContent(): string {
    if (this._state.thoughts.length === 0) {
      return "Chain: no active thought chains";
    }

    const lines: string[] = [];
    for (const thought of this._state.thoughts) {
      const prefix = this._state.collapsed.has(thought.thoughtNumber) ? "▸" : "▽";
      const revisionTag = thought.isRevision ? " (rev)" : "";
      const branchTag = thought.branchId ? ` [${thought.branchId}]` : "";
      const line = `${prefix} #${thought.thoughtNumber}/${thought.totalThoughts}${revisionTag}${branchTag}`;

      lines.push(line);
      if (!this._state.collapsed.has(thought.thoughtNumber)) {
        // Truncate long thoughts for panel display
        const maxLen = 36;
        const content = thought.content.length > maxLen
          ? thought.content.slice(0, maxLen - 1) + "…"
          : thought.content;
        lines.push(`  ${content}`);
      }
    }

    return lines.join("\n");
  }
}

// ─── Load Chain from Memory (T-080) ────────────────────────────────────────────

/**
 * Fetch a thought chain from memory and return its state for replay on the ChainPanel.
 *
 * Used by SessionManager.resume() to restore the active thought chain after
 * a TUI restart. If the chain is not found, returns an empty default state.
 *
 * @param client - NeuralgenticsClient for memory RPC calls.
 * @param chainId - The thought chain ID to load.
 * @returns A ChainState with the loaded thoughts, or empty state if not found.
 */
export async function loadFromChain(
  client: NeuralgenticsClient,
  chainId: string,
): Promise<ChainState> {
  const emptyState: ChainState = {
    thoughts: [],
    activeBranch: null,
    collapsed: new Set(),
  };

  if (!chainId) {
    return emptyState;
  }

  try {
    const result = await client.call("memory.getThoughtChain", { chainId });
    const chain = result as Record<string, unknown>;
    const thoughts = (chain.thoughts ?? []) as Array<Record<string, unknown>>;

    if (!Array.isArray(thoughts) || thoughts.length === 0) {
      return emptyState;
    }

    const loadedThoughts: ThoughtEntry[] = thoughts.map((t) => ({
      thoughtNumber: typeof t.thoughtNumber === "number" ? t.thoughtNumber : 0,
      totalThoughts: typeof t.totalThoughts === "number" ? t.totalThoughts : 1,
      content: typeof t.thought === "string" ? t.thought : String(t.thought ?? ""),
      isRevision: t.isRevision === true,
      branchId: typeof t.branchId === "string" ? t.branchId : undefined,
    }));

    return {
      thoughts: loadedThoughts,
      activeBranch: loadedThoughts[0]?.branchId ?? null,
      collapsed: new Set(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[chain] Failed to load chain ${chainId}: ${msg}`);
    return emptyState;
  }
}