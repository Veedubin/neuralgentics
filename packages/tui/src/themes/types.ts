/**
 * T-032 — Theme type definitions.
 *
 * All color tokens used by the TUI, organized by panel/element.
 * A Theme is a flat map of token → hex color string.
 */

/** Every color token the TUI uses. */
export type ThemeToken = keyof ThemeColors;

/** Complete set of theme colors. */
export interface ThemeColors {
  // ── Panel backgrounds ──
  bg: string;
  kanbanBg: string;
  chatBg: string;
  chainBg: string;
  statusBarBg: string;
  inputBarBg: string;

  // ── Borders ──
  border: string;
  borderActive: string;

  // ── Text ──
  textPrimary: string;
  textSecondary: string;
  textAccent: string;

  // ── Spend gauge ──
  gaugeGreen: string;
  gaugeYellow: string;
  gaugeRed: string;

  // ── Diff panel ──
  diffAdd: string;
  diffRemove: string;
  diffContext: string;
  diffHeader: string;
  diffHunk: string;
}

/** A named, selectable theme. */
export interface Theme {
  name: string;
  label: string;
  colors: ThemeColors;
}

/** Config shape stored in config/default.json → `theme` key. */
export interface ThemeConfig {
  /** Active theme name. */
  active: "dark" | "light";
  /** Custom overrides applied on top of any preset. */
  overrides?: Partial<ThemeColors>;
}