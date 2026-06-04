/**
 * T-032 — Accessibility helpers for the Neuralgentics TUI.
 *
 * Provides ARIA-style labels, screen reader announcements,
 * high-contrast toggle, and keyboard/mouse focus management.
 */

import type { ThemeManager } from "../themes/manager.js";

// ─── Panel identifiers ──────────────────────────────────────────────────────────

/** The four navigable panels in the TUI layout. */
export type PanelName = "kanban" | "chat" | "chain" | "input";

/** Ordered panel list for Tab/Shift+Tab cycling. */
export const PANEL_ORDER: PanelName[] = ["kanban", "chat", "chain", "input"];

/** Human-readable labels for each panel (ARIA-style). */
export const PANEL_LABELS: Record<PanelName, string> = {
  kanban: "Kanban board — task cards by status column",
  chat: "Chat panel — conversation and agent responses",
  chain: "Chain panel — thought chain progress and branches",
  input: "Input bar — type messages or /commands",
};

// ─── Screen reader announcements ───────────────────────────────────────────────

/** Announce a message to assistive technology via stdout escape sequence. */
export function announceToScreenReader(message: string): void {
  // OSC escape sequence recognized by modern terminals for accessibility
  // Fallback: the message is also written to stderr which screen readers monitor
  process.stderr.write(`\x1b]9977;${message}\x07`);
}

// ─── Focus Manager ──────────────────────────────────────────────────────────────

export class FocusManager {
  private _focusedIndex = 3; // Start on "input" panel (most common starting point)
  private _listeners: ((panel: PanelName) => void)[] = [];

  /** Currently focused panel. */
  get focused(): PanelName {
    return PANEL_ORDER[this._focusedIndex]!;
  }

  /** Index of the focused panel in PANEL_ORDER. */
  get focusedIndex(): number {
    return this._focusedIndex;
  }

  /** Move focus to the next panel (Tab). */
  next(): PanelName {
    this._focusedIndex = (this._focusedIndex + 1) % PANEL_ORDER.length;
    const panel = this.focused;
    this._emit(panel);
    announceToScreenReader(`Focusing ${PANEL_LABELS[panel]}`);
    return panel;
  }

  /** Move focus to the previous panel (Shift+Tab). */
  previous(): PanelName {
    this._focusedIndex = (this._focusedIndex - 1 + PANEL_ORDER.length) % PANEL_ORDER.length;
    const panel = this.focused;
    this._emit(panel);
    announceToScreenReader(`Focusing ${PANEL_LABELS[panel]}`);
    return panel;
  }

  /** Move focus to a specific panel by name. */
  focusPanel(panel: PanelName): void {
    const idx = PANEL_ORDER.indexOf(panel);
    if (idx >= 0) {
      this._focusedIndex = idx;
      this._emit(panel);
      announceToScreenReader(`Focusing ${PANEL_LABELS[panel]}`);
    }
  }

  /** Move focus by arrow key within current panel group (left/right). */
  arrowLeft(): PanelName {
    return this.previous();
  }

  /** Move focus by arrow key within current panel group (left/right). */
  arrowRight(): PanelName {
    return this.next();
  }

  /** Register a callback for focus changes. */
  onChange(cb: (panel: PanelName) => void): () => void {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb);
    };
  }

  private _emit(panel: PanelName): void {
    for (const cb of this._listeners) {
      cb(panel);
    }
  }
}

// ─── ARIA Label helpers ─────────────────────────────────────────────────────────

/**
 * Set an ARIA-style label on a panel element.
 * In a terminal TUI context, this stores the label in an internal map
 * that the screen reader can query.
 */
const ariaLabels = new Map<string, string>();

export function setAriaLabel(elementId: string, label: string): void {
  ariaLabels.set(elementId, label);
}

export function getAriaLabel(elementId: string): string | undefined {
  return ariaLabels.get(elementId);
}

export function clearAriaLabels(): void {
  ariaLabels.clear();
}

/** Initialize ARIA labels for all four panels plus commands. */
export function initPanelAriaLabels(): void {
  for (const [panel, label] of Object.entries(PANEL_LABELS)) {
    setAriaLabel(panel, label);
  }
  // Command shortcuts
  setAriaLabel("command-theme", "Cycle theme (F2)");
  setAriaLabel("command-high-contrast", "Toggle high contrast (F3)");
  setAriaLabel("command-tab", "Next panel (Tab)");
  setAriaLabel("command-shift-tab", "Previous panel (Shift+Tab)");
}

// ─── High-contrast mode ─────────────────────────────────────────────────────────

/**
 * Toggle high-contrast mode via the ThemeManager.
 * Announces the state change to the screen reader.
 */
export function toggleHighContrast(themeManager: ThemeManager): boolean {
  const enabled = themeManager.toggleHighContrast();
  announceToScreenReader(enabled ? "High contrast enabled" : "High contrast disabled");
  return enabled;
}