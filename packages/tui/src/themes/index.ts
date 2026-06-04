/**
 * T-032 — Theme barrel export.
 */

export type { Theme, ThemeColors, ThemeConfig, ThemeToken } from "./types.js";
export { DARK_THEME, LIGHT_THEME, THEME_CYCLE, THEME_MAP } from "./presets.js";
export { ThemeManager } from "./manager.js";
export type { ThemeChangeCallback } from "./manager.js";