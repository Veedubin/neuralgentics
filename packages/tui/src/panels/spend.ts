/**
 * T-032 → T-033 — SpendPanel
 *
 * Token usage gauge displayed in the status bar area.
 * Shows a color-coded progress bar with percentage.
 * T-033: Wired to TokenCounter.getSessionTotal() for live data.
 */

import { Box, Text } from "@opentui/core";
import type { ThemeColors } from "../themes/types.js";
import type { TokenCounter } from "../observability/token-counter.js";
import type { TextVNode, BoxVNode } from "../vnode-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SpendData {
  tokensUsed: number;
  tokenLimit: number;
}

// ─── SpendPanel ─────────────────────────────────────────────────────────────────

export class SpendPanel {
  private _data: SpendData = { tokensUsed: 0, tokenLimit: 100000 };
  private _colors: ThemeColors;
  private _counter: TokenCounter | null = null;

  private _textRef: TextVNode | null = null;
  private _boxRef: BoxVNode | null = null;

  constructor(colors: ThemeColors, counter?: TokenCounter) {
    this._colors = colors;
    if (counter) {
      this._counter = counter;
    }
  }

  /** Update colors when theme changes. */
  setColors(colors: ThemeColors): void {
    this._colors = colors;
  }

  /** Get current spend data (for testing). */
  get data(): SpendData {
    return this._data;
  }

  /**
   * Wire a TokenCounter for live data.
   * When set, updateSpend() reads from the counter instead of manual values.
   */
  setCounter(counter: TokenCounter): void {
    this._counter = counter;
  }

  /**
   * Update from a TokenCounter (preferred) or manual values.
   * If a counter is set, uses its session total and ignores manual args.
   */
  updateSpend(tokensUsed?: number, tokenLimit?: number): void {
    if (this._counter) {
      const total = this._counter.getSessionTotal();
      this._data = { tokensUsed: total.total, tokenLimit: tokenLimit ?? this._data.tokenLimit };
    } else {
      this._data = {
        tokensUsed: tokensUsed ?? this._data.tokensUsed,
        tokenLimit: tokenLimit ?? this._data.tokenLimit,
      };
    }
    this._render();
  }

  /** Build the renderable VNodes. */
  build(): { box: unknown; textRef: unknown } {
    this._textRef = Text({
      id: "spend-gauge",
      content: this._buildContent(),
      fg: this._colors.textAccent,
    }) as unknown as TextVNode;

    this._boxRef = Box({
      id: "spend-panel",
      height: 1,
      backgroundColor: this._colors.statusBarBg,
      flexDirection: "row",
    }) as unknown as BoxVNode;
    (this._boxRef as unknown as { add(child: unknown): void }).add(this._textRef);

    return { box: this._boxRef, textRef: this._textRef };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _render(): void {
    if (this._textRef) {
      this._textRef.content = this._buildContent();
      this._textRef.fg = this._gaugeColor();
    }
  }

  private _buildContent(): string {
    const { tokensUsed, tokenLimit } = this._data;
    if (tokenLimit === 0) return " Tokens: N/A";

    const pct = (tokensUsed / tokenLimit) * 100;
    const barWidth = 20;
    const filled = Math.min(Math.round((pct / 100) * barWidth), barWidth);
    const empty = barWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);

    return ` Tokens: ${bar} ${pct.toFixed(1)}%`;
  }

  private _gaugeColor(): string {
    const pct = this._data.tokenLimit === 0 ? 0 : (this._data.tokensUsed / this._data.tokenLimit) * 100;
    if (pct < 50) return this._colors.gaugeGreen;
    if (pct < 75) return this._colors.gaugeYellow;
    return this._colors.gaugeRed;
  }
}