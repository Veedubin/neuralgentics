/**
 * Typed VNode reference interfaces for OpenTUI ProxiedVNode refs.
 *
 * OpenTUI factory functions (Text, Box, Input, ScrollBox) return
 * ProxiedVNode<TCtor>, a mapped type that delegates property access
 * to the underlying Renderable. However, ProxiedVNode only captures
 * getter return types, not setter parameter types, making it unusable
 * for writing properties like `vnode.content = "string"`.
 *
 * These interfaces capture the write facets of the VNode refs that the
 * TUI actually uses. The factory return values are assigned via
 * type assertion (`as TextVNode`) at the single assignment site in
 * buildLayout().
 */

// ─── Text VNode ────────────────────────────────────────────────────────────────

/** Properties on the Text VNode (factory: Text()). */
export interface TextVNode {
  /** Text content — read returns StyledText, write accepts StyledText | string. */
  content: string;
  /** Foreground color. */
  fg: string;
}

// ─── Box VNode ─────────────────────────────────────────────────────────────────

/** Properties on the Box VNode (factory: Box()). */
export interface BoxVNode {
  /** Background color. */
  backgroundColor: string;
  /** Border color. */
  borderColor: string;
  /** Visibility toggle. */
  visible: boolean;
}

// ─── Input VNode ───────────────────────────────────────────────────────────────

/** Properties on the Input VNode (factory: Input()). */
export interface InputVNode {
  /** Current input value. */
  value: string;
  /** Text (foreground) color. */
  textColor: string;
  /** Background color. */
  backgroundColor: string;
  /** Focus the input element. */
  focus(): void;
}

// ─── ScrollBox VNode ───────────────────────────────────────────────────────────

/** Interface for the ScrollBox VNode (factory: ScrollBox()). */
export interface ScrollBoxVNode {
  /** Add a child renderable. */
  add(child: unknown): number;
}