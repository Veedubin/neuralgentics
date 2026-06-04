/**
 * T-032 — Accessibility tests (P1-a)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  FocusManager,
  PANEL_ORDER,
  PANEL_LABELS,
  setAriaLabel,
  getAriaLabel,
  clearAriaLabels,
  initPanelAriaLabels,
  announceToScreenReader,
  toggleHighContrast,
  type PanelName,
} from "../a11y/index.js";
import { ThemeManager } from "../themes/index.js";

describe("FocusManager", () => {
  test("defaults to input panel (index 3)", () => {
    const fm = new FocusManager();
    expect(fm.focused).toBe("input");
  });

  test("next() cycles through panels", () => {
    const fm = new FocusManager();
    expect(fm.next()).toBe("kanban");
    expect(fm.next()).toBe("chat");
    expect(fm.next()).toBe("chain");
    expect(fm.next()).toBe("input");
    expect(fm.next()).toBe("kanban"); // wraps
  });

  test("previous() cycles backward", () => {
    const fm = new FocusManager(); // starts at input
    expect(fm.previous()).toBe("chain");
    expect(fm.previous()).toBe("chat");
    expect(fm.previous()).toBe("kanban");
    expect(fm.previous()).toBe("input");
  });

  test("focusPanel() jumps to a specific panel", () => {
    const fm = new FocusManager();
    fm.focusPanel("chat");
    expect(fm.focused).toBe("chat");
    fm.focusPanel("kanban");
    expect(fm.focused).toBe("kanban");
  });

  test("focusPanel() ignores unknown panel names", () => {
    const fm = new FocusManager();
    const before = fm.focusedIndex;
    fm.focusPanel("nonexistent" as PanelName);
    expect(fm.focusedIndex).toBe(before);
  });

  test("arrowLeft() moves to previous panel", () => {
    const fm = new FocusManager();
    expect(fm.arrowLeft()).toBe("chain");
  });

  test("arrowRight() moves to next panel", () => {
    const fm = new FocusManager();
    expect(fm.arrowRight()).toBe("kanban");
  });

  test("onChange fires on focus changes", () => {
    const fm = new FocusManager();
    const panels: string[] = [];
    fm.onChange((panel) => panels.push(panel));
    fm.next();
    fm.next();
    expect(panels).toEqual(["kanban", "chat"]);
  });

  test("onChange unsubscribe works", () => {
    const fm = new FocusManager();
    const panels: string[] = [];
    const unsub = fm.onChange((panel) => panels.push(panel));
    unsub();
    fm.next();
    expect(panels).toHaveLength(0);
  });

  test("PANEL_ORDER has 4 entries", () => {
    expect(PANEL_ORDER).toHaveLength(4);
    expect(PANEL_ORDER).toEqual(["kanban", "chat", "chain", "input"]);
  });
});

describe("ARIA Labels", () => {
  beforeEach(() => {
    clearAriaLabels();
  });

  test("setAriaLabel and getAriaLabel work", () => {
    setAriaLabel("kanban", "Kanban board");
    expect(getAriaLabel("kanban")).toBe("Kanban board");
  });

  test("getAriaLabel returns undefined for unknown id", () => {
    expect(getAriaLabel("nonexistent")).toBeUndefined();
  });

  test("setAriaLabel overwrites previous label", () => {
    setAriaLabel("chat", "Chat panel");
    setAriaLabel("chat", "Chat panel — conversation and agent responses");
    expect(getAriaLabel("chat")).toBe("Chat panel — conversation and agent responses");
  });

  test("clearAriaLabels removes all labels", () => {
    setAriaLabel("kanban", "test");
    setAriaLabel("chat", "test2");
    clearAriaLabels();
    expect(getAriaLabel("kanban")).toBeUndefined();
    expect(getAriaLabel("chat")).toBeUndefined();
  });

  test("initPanelAriaLabels sets labels for all 4 panels", () => {
    initPanelAriaLabels();
    expect(getAriaLabel("kanban")).toBeDefined();
    expect(getAriaLabel("chat")).toBeDefined();
    expect(getAriaLabel("chain")).toBeDefined();
    expect(getAriaLabel("input")).toBeDefined();
  });

  test("initPanelAriaLabels sets labels for commands", () => {
    initPanelAriaLabels();
    expect(getAriaLabel("command-theme")).toBe("Cycle theme (F2)");
    expect(getAriaLabel("command-high-contrast")).toBe("Toggle high contrast (F3)");
    expect(getAriaLabel("command-tab")).toBe("Next panel (Tab)");
    expect(getAriaLabel("command-shift-tab")).toBe("Previous panel (Shift+Tab)");
  });
});

describe("PANEL_LABELS", () => {
  test("all panels have descriptive labels", () => {
    for (const [panel, label] of Object.entries(PANEL_LABELS)) {
      expect(label.length).toBeGreaterThan(5);
      expect(label).toContain(panel === "kanban" ? "Kanban" : panel === "chat" ? "Chat" : panel === "chain" ? "Chain" : "Input");
    }
  });
});

describe("announceToScreenReader", () => {
  test("does not throw", () => {
    // This writes to stderr — just verify it doesn't crash
    expect(() => announceToScreenReader("Test announcement")).not.toThrow();
  });
});

describe("toggleHighContrast", () => {
  test("toggles high contrast on the ThemeManager", () => {
    const mgr = new ThemeManager();
    expect(mgr.highContrast).toBe(false);
    const result = toggleHighContrast(mgr);
    expect(result).toBe(true);
    expect(mgr.highContrast).toBe(true);
    const result2 = toggleHighContrast(mgr);
    expect(result2).toBe(false);
    expect(mgr.highContrast).toBe(false);
  });
});

describe("Keyboard Navigation Integration", () => {
  test("Tab cycle visits all 4 panels", () => {
    const fm = new FocusManager();
    const visited: PanelName[] = [];
    const unsub = fm.onChange((panel) => visited.push(panel));

    // Starting at input, Tab 4 times should visit all panels
    fm.next(); // kanban
    fm.next(); // chat
    fm.next(); // chain
    fm.next(); // input (back to start)

    expect(visited).toEqual(["kanban", "chat", "chain", "input"]);
    unsub();
  });

  test("Shift+Tab reverse cycle visits all 4 panels", () => {
    const fm = new FocusManager();
    const visited: PanelName[] = [];
    const unsub = fm.onChange((panel) => visited.push(panel));

    fm.previous(); // chain
    fm.previous(); // chat
    fm.previous(); // kanban
    fm.previous(); // input (wrap)

    expect(visited).toEqual(["chain", "chat", "kanban", "input"]);
    unsub();
  });

  test("focusPanel correctly sets index for all panels", () => {
    const fm = new FocusManager();
    fm.focusPanel("kanban");
    expect(fm.focusedIndex).toBe(0);
    fm.focusPanel("chat");
    expect(fm.focusedIndex).toBe(1);
    fm.focusPanel("chain");
    expect(fm.focusedIndex).toBe(2);
    fm.focusPanel("input");
    expect(fm.focusedIndex).toBe(3);
  });
});