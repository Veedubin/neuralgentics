/**
 * T-032 — Theme system tests (P1-a)
 */

import { describe, test, expect } from "bun:test";
import {
  ThemeManager,
  DARK_THEME,
  LIGHT_THEME,
  THEME_CYCLE,
  THEME_MAP,
} from "../themes/index.js";
import type { ThemeColors } from "../themes/types.js";

describe("Theme Presets", () => {
  test("DARK_THEME has correct name and label", () => {
    expect(DARK_THEME.name).toBe("dark");
    expect(DARK_THEME.label).toBe("Dark");
  });

  test("LIGHT_THEME has correct name and label", () => {
    expect(LIGHT_THEME.name).toBe("light");
    expect(LIGHT_THEME.label).toBe("Light");
  });

  test("DARK_THEME colors match the original hardcoded COLORS", () => {
    expect(DARK_THEME.colors.bg).toBe("#1a1a2e");
    expect(DARK_THEME.colors.kanbanBg).toBe("#16213e");
    expect(DARK_THEME.colors.chatBg).toBe("#0f3460");
    expect(DARK_THEME.colors.chainBg).toBe("#1a1a2e");
    expect(DARK_THEME.colors.statusBarBg).toBe("#0a0a1a");
    expect(DARK_THEME.colors.inputBarBg).toBe("#16213e");
    expect(DARK_THEME.colors.border).toBe("#333366");
    expect(DARK_THEME.colors.textPrimary).toBe("#e0e0e0");
    expect(DARK_THEME.colors.textSecondary).toBe("#8888aa");
    expect(DARK_THEME.colors.textAccent).toBe("#00ff88");
  });

  test("LIGHT_THEME has all required color keys", () => {
    const requiredKeys: (keyof ThemeColors)[] = [
      "bg", "kanbanBg", "chatBg", "chainBg", "statusBarBg", "inputBarBg",
      "border", "borderActive", "textPrimary", "textSecondary", "textAccent",
      "gaugeGreen", "gaugeYellow", "gaugeRed",
      "diffAdd", "diffRemove", "diffContext", "diffHeader", "diffHunk",
    ];
    for (const key of requiredKeys) {
      expect(LIGHT_THEME.colors[key]).toBeDefined();
      expect(typeof LIGHT_THEME.colors[key]).toBe("string");
    }
  });

  test("LIGHT_THEME has light backgrounds", () => {
    // Light theme should have light backgrounds
    expect(LIGHT_THEME.colors.bg).not.toBe(DARK_THEME.colors.bg);
    expect(LIGHT_THEME.colors.textPrimary).not.toBe(DARK_THEME.colors.textPrimary);
  });

  test("THEME_CYCLE has 2 entries (dark, light)", () => {
    expect(THEME_CYCLE).toHaveLength(2);
    expect(THEME_CYCLE[0]!.name).toBe("dark");
    expect(THEME_CYCLE[1]!.name).toBe("light");
  });

  test("THEME_MAP has dark and light keys", () => {
    expect(Object.keys(THEME_MAP)).toHaveLength(2);
    expect(THEME_MAP["dark"]).toBe(DARK_THEME);
    expect(THEME_MAP["light"]).toBe(LIGHT_THEME);
  });
});

describe("ThemeManager", () => {
  test("defaults to dark theme", () => {
    const mgr = new ThemeManager();
    expect(mgr.current.name).toBe("dark");
    expect(mgr.current.label).toBe("Dark");
  });

  test("can be initialized with light theme", () => {
    const mgr = new ThemeManager({ active: "light" });
    expect(mgr.current.name).toBe("light");
  });

  test("cycle goes dark → light → dark", () => {
    const mgr = new ThemeManager(); // starts at dark
    const t1 = mgr.cycle();
    expect(t1.name).toBe("light");
    const t2 = mgr.cycle();
    expect(t2.name).toBe("dark");
    const t3 = mgr.cycle();
    expect(t3.name).toBe("light");
  });

  test("setTheme switches to specific theme", () => {
    const mgr = new ThemeManager();
    const light = mgr.setTheme("light");
    expect(light.name).toBe("light");
    expect(mgr.current.name).toBe("light");
  });

  test("setTheme throws for unknown theme", () => {
    const mgr = new ThemeManager();
    expect(() => mgr.setTheme("neon")).toThrow(/Unknown theme/);
  });

  test("setOverrides applies custom colors on top of preset", () => {
    const mgr = new ThemeManager();
    mgr.setOverrides({ textPrimary: "#ff0000" });
    expect(mgr.current.colors.textPrimary).toBe("#ff0000");
    // Other colors should stay as dark preset
    expect(mgr.current.colors.bg).toBe("#1a1a2e");
  });

  test("high-contrast mode overrides text colors", () => {
    const mgr = new ThemeManager();
    expect(mgr.highContrast).toBe(false);
    const enabled = mgr.toggleHighContrast();
    expect(enabled).toBe(true);
    expect(mgr.highContrast).toBe(true);
    expect(mgr.current.colors.textPrimary).toBe("#ffffff");
    expect(mgr.current.colors.textSecondary).toBe("#cccccc");
    expect(mgr.current.colors.textAccent).toBe("#00ffff");
    expect(mgr.current.colors.border).toBe("#ffffff");
    expect(mgr.current.colors.borderActive).toBe("#00ffff");
  });

  test("toggling high-contrast off restores original colors", () => {
    const mgr = new ThemeManager();
    mgr.toggleHighContrast(); // on
    mgr.toggleHighContrast(); // off
    expect(mgr.highContrast).toBe(false);
    expect(mgr.current.colors.textPrimary).toBe("#e0e0e0"); // dark default
    expect(mgr.current.colors.textAccent).toBe("#00ff88");
  });

  test("onChange callback fires on cycle", () => {
    const mgr = new ThemeManager();
    const themes: string[] = [];
    mgr.onChange((t) => themes.push(t.name));
    mgr.cycle();
    mgr.cycle();
    expect(themes).toEqual(["light", "dark"]);
  });

  test("onChange callback fires on setTheme", () => {
    const mgr = new ThemeManager();
    const themes: string[] = [];
    mgr.onChange((t) => themes.push(t.name));
    mgr.setTheme("light");
    expect(themes).toEqual(["light"]);
  });

  test("onChange callback fires on toggleHighContrast", () => {
    const mgr = new ThemeManager();
    const themes: string[] = [];
    mgr.onChange((t) => themes.push(t.name));
    mgr.toggleHighContrast();
    expect(themes).toHaveLength(1);
  });

  test("onChange unsubscribe works", () => {
    const mgr = new ThemeManager();
    const themes: string[] = [];
    const unsub = mgr.onChange((t) => themes.push(t.name));
    unsub(); // unsubscribe
    mgr.cycle();
    expect(themes).toHaveLength(0);
  });

  test("high-contrast persists across theme cycle", () => {
    const mgr = new ThemeManager();
    mgr.toggleHighContrast(); // enable
    expect(mgr.current.colors.textPrimary).toBe("#ffffff");
    mgr.cycle(); // switch to light with high-contrast
    expect(mgr.current.name).toBe("light");
    expect(mgr.current.colors.textPrimary).toBe("#ffffff"); // still high-contrast
    mgr.toggleHighContrast(); // disable — should restore light theme normal
    expect(mgr.current.colors.textPrimary).toBe("#1e293b"); // light default
  });

  test("overrides persist across theme cycle", () => {
    const mgr = new ThemeManager();
    mgr.setOverrides({ bg: "#000000" });
    expect(mgr.current.colors.bg).toBe("#000000");
    mgr.cycle(); // to light
    // Override should still apply on top of light theme
    expect(mgr.current.colors.bg).toBe("#000000");
  });

  test("DARK_THEME has borderActive field", () => {
    expect(DARK_THEME.colors.borderActive).toBe("#00ff88");
  });

  test("LIGHT_THEME has borderActive field", () => {
    expect(LIGHT_THEME.colors.borderActive).toBe("#2563eb");
  });
});