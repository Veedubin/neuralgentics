/**
 * T-032 — StatusBar (live data)
 *
 * Rewrites the hardcoded status bar to pull from real state:
 * session ID, token gauge, agent roster, compaction count.
 * Uses ThemeManager for colors.
 */

import { Box, Text } from "@opentui/core";
import type { ThemeColors } from "../themes/types.js";
import type { OpenCodeStatus } from "../opencode-client/index.js";
import type { SessionManagerStatus } from "../session/index.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface StatusBarData {
  sessionId: string;
  tokenUsed: number;
  tokenLimit: number;
  agentRoster: Map<string, string>;
  compactionCount: number;
  opencodeStatus: OpenCodeStatus;
  sessionStatus: SessionManagerStatus;
}

// ─── StatusBar ──────────────────────────────────────────────────────────────────

export class StatusBar {
  private _data: StatusBarData;
  private _colors: ThemeColors;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private _textRef: any = null;
  private _boxRef: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(data: StatusBarData, colors: ThemeColors) {
    this._data = data;
    this._colors = colors;
  }

  /** Update colors when theme changes. */
  setColors(colors: ThemeColors): void {
    this._colors = colors;
    this._render();
  }

  /** Get current data (for testing). */
  get data(): StatusBarData {
    return this._data;
  }

  /** Update individual fields and re-render. */
  update(partial: Partial<StatusBarData>): void {
    this._data = { ...this._data, ...partial };
    this._render();
  }

  /** Build the renderable VNodes. */
  build(): { box: unknown; textRef: unknown } {
    this._textRef = Text({
      id: "status-content",
      content: this._buildContent(),
      fg: this._colors.textAccent,
    });

    this._boxRef = Box({
      id: "status-bar",
      height: 1,
      backgroundColor: this._colors.statusBarBg,
      flexDirection: "row",
      padding: 0,
    });
    this._boxRef.add(this._textRef);

    return { box: this._boxRef, textRef: this._textRef };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _render(): void {
    if (this._textRef) {
      this._textRef.content = this._buildContent();
    }
    if (this._boxRef) {
      this._boxRef.backgroundColor = this._colors.statusBarBg;
    }
  }

  private _buildContent(): string {
    const { sessionId, tokenUsed, tokenLimit, agentRoster, compactionCount, opencodeStatus, sessionStatus } = this._data;

    const tokenPct = tokenLimit === 0 ? "0" : ((tokenUsed / tokenLimit) * 100).toFixed(1);
    const tokenStr = `${tokenUsed.toLocaleString()} / ${tokenLimit.toLocaleString()} (${tokenPct}%)`;

    const roster = Array.from(agentRoster.entries())
      .map(([agent, status]) => `${agent}: ${status}`)
      .join(", ");

    const ocStatus = opencodeStatus === "ready"
      ? "LLM:online"
      : opencodeStatus === "degraded"
        ? "LLM:offline"
        : `LLM:${opencodeStatus}`;

    const sessStatus = sessionStatus === "active"
      ? "active"
      : sessionStatus === "streaming"
        ? "streaming"
        : sessionStatus;

    return ` Session: ${sessionId} │ ${ocStatus} │ Sess:${sessStatus} │ Tokens: ${tokenStr} │ Agents: ${roster} │ Compactions: ${compactionCount}`;
  }
}