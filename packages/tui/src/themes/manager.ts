/**
 * T-032 — ThemeManager
 *
 * Manages theme selection, cycling (F2), custom overrides, and
 * high-contrast mode. Consumers call `applyTheme()` to get the
 * resolved color map; the actual VNode mutation happens in index.ts.
 */

import { THEME_CYCLE, THEME_MAP } from "./presets.js";
import type { Theme, ThemeColors, ThemeConfig } from "./types.js";

/** Event emitted when the theme changes. */
export type ThemeChangeCallback = (theme: Theme) => void;

export class ThemeManager {
  private _current: Theme;
  private _overrides: Partial<ThemeColors>;
  private _listeners: ThemeChangeCallback[] = [];
  private _highContrast = false;

  constructor(config?: ThemeConfig) {
    const activeName = config?.active ?? "dark";
    const preset = THEME_MAP[activeName] ?? THEME_MAP["dark"]!;
    this._overrides = config?.overrides ?? {};
    this._current = this._resolve(preset, this._overrides);
  }

  /** Current resolved theme (with overrides + high-contrast applied). */
  get current(): Theme {
    return this._current;
  }

  /** Whether high-contrast mode is active. */
  get highContrast(): boolean {
    return this._highContrast;
  }

  /** Cycle to the next theme in the preset list (F2 handler). */
  cycle(): Theme {
    const idx = THEME_CYCLE.findIndex((t) => t.name === this._current.name);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]!;
    this._current = this._resolve(next, this._overrides);
    this._emit();
    return this._current;
  }

  /** Switch to a named theme. */
  setTheme(name: string): Theme {
    const preset = THEME_MAP[name];
    if (!preset) {
      throw new Error(`Unknown theme: "${name}". Available: ${Object.keys(THEME_MAP).join(", ")}`);
    }
    this._current = this._resolve(preset, this._overrides);
    this._emit();
    return this._current;
  }

  /** Apply custom color overrides on top of the current preset. */
  setOverrides(overrides: Partial<ThemeColors>): void {
    this._overrides = overrides;
    const preset = THEME_MAP[this._current.name] ?? THEME_MAP["dark"]!;
    this._current = this._resolve(preset, this._overrides);
    this._emit();
  }

  /** Toggle high-contrast mode (F3 handler). */
  toggleHighContrast(): boolean {
    this._highContrast = !this._highContrast;
    const preset = THEME_MAP[this._current.name] ?? THEME_MAP["dark"]!;
    this._current = this._resolve(preset, this._overrides);
    this._emit();
    return this._highContrast;
  }

  /** Register a listener for theme changes. */
  onChange(cb: ThemeChangeCallback): () => void {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb);
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _resolve(preset: Theme, overrides: Partial<ThemeColors>): Theme {
    const colors: ThemeColors = { ...preset.colors, ...overrides };

    if (this._highContrast) {
      colors.textPrimary = "#ffffff";
      colors.textSecondary = "#cccccc";
      colors.textAccent = "#00ffff";
      colors.border = "#ffffff";
      colors.borderActive = "#00ffff";
    }

    return { name: preset.name, label: preset.label, colors };
  }

  private _emit(): void {
    for (const cb of this._listeners) {
      cb(this._current);
    }
  }
}