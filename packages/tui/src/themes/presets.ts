/**
 * T-032 — Built-in theme presets (dark + light).
 *
 * The "dark" preset matches the COLORS constant that was previously
 * hardcoded in index.ts, ensuring zero visual regression.
 */

import type { Theme, ThemeColors } from "./types.js";

// ─── Dark theme (current default) ─────────────────────────────────────────────

const DARK_COLORS: ThemeColors = {
  bg: "#1a1a2e",
  kanbanBg: "#16213e",
  chatBg: "#0f3460",
  chainBg: "#1a1a2e",
  statusBarBg: "#0a0a1a",
  inputBarBg: "#16213e",

  border: "#333366",
  borderActive: "#00ff88",

  textPrimary: "#e0e0e0",
  textSecondary: "#8888aa",
  textAccent: "#00ff88",

  gaugeGreen: "#00ff88",
  gaugeYellow: "#ffcc00",
  gaugeRed: "#ff4444",

  diffAdd: "#22c55e",
  diffRemove: "#ef4444",
  diffContext: "#9ca3af",
  diffHeader: "#06b6d4",
  diffHunk: "#eab308",
};

// ─── Light theme ───────────────────────────────────────────────────────────────

const LIGHT_COLORS: ThemeColors = {
  bg: "#f5f5f5",
  kanbanBg: "#e8edf3",
  chatBg: "#ffffff",
  chainBg: "#eef0f4",
  statusBarBg: "#d1d5db",
  inputBarBg: "#e8edf3",

  border: "#94a3b8",
  borderActive: "#2563eb",

  textPrimary: "#1e293b",
  textSecondary: "#64748b",
  textAccent: "#2563eb",

  gaugeGreen: "#16a34a",
  gaugeYellow: "#ca8a04",
  gaugeRed: "#dc2626",

  diffAdd: "#16a34a",
  diffRemove: "#dc2626",
  diffContext: "#6b7280",
  diffHeader: "#0891b2",
  diffHunk: "#a16207",
};

// ─── Preset registry ───────────────────────────────────────────────────────────

export const DARK_THEME: Theme = {
  name: "dark",
  label: "Dark",
  colors: DARK_COLORS,
};

export const LIGHT_THEME: Theme = {
  name: "light",
  label: "Light",
  colors: LIGHT_COLORS,
};

/** Ordered list for F2 cycling. */
export const THEME_CYCLE: Theme[] = [DARK_THEME, LIGHT_THEME];

/** Lookup by name. */
export const THEME_MAP: Record<string, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
};