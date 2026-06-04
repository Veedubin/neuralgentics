/**
 * Kanban board data types for T-021.
 *
 * These types represent the parsed structure of a TASKS.md kanban board.
 * The kanban section starts at `## Kanban Board (Boomerang Cycle v3)` and
 * contains 7 status columns. Each card starts with `#### T-NNN · Title`
 * and has YAML-like field lines prefixed with `- **Field:** value`.
 */

/** The 7 kanban statuses, in canonical order. */
export const KANBAN_STATUSES = [
  "triage",
  "todo",
  "ready",
  "running",
  "blocked",
  "done",
  "archived",
] as const;

export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

/** A single attempt entry for a kanban card (T-036). */
export interface AttemptEntry {
  /** 1-based attempt number (incremented per failure or success). */
  attemptNumber: number;
  /** Worker/agent role that performed the attempt. */
  worker: string;
  /** ISO timestamp of when the attempt started. */
  timestamp: string;
  /** Result of the attempt. */
  result: "success" | "failure";
  /** Number of tokens spent on this attempt. */
  tokensSpent: number;
  /** Memory ID link to the wrap-up or failure details. */
  memoryId: string;
  /** Short summary of what happened. */
  summary: string;
}

/** A single kanban card. */
export interface KanbanCard {
  id: string;       // e.g. "T-021"
  title: string;    // e.g. "TUI App Scaffold + Panel Layout (P0-a)"
  status: KanbanStatus;
  assignee: string;
  phase: string;
  roadmap: string;
  goal: string;
  dependsOn: string[];
  blocks: string[];
  /** Number of consecutive failures. Resets on success or /resume. */
  failureCount: number;
  /** Maximum failures before circuit breaker trips. Default: 2. */
  failureLimit: number;
  /** History of all attempts on this card. */
  attemptHistory: AttemptEntry[];
  /** Number of truncated attempts hidden from view. */
  truncatedAttempts: number;
  /** Memory ID linking to truncated attempts in memini-core. */
  truncatedMemoryId: string;
  /** Inter-agent comments on this card. */
  comments: Comment[];
  /** All parsed fields as a flat map. */
  raw: Record<string, string>;
}

/** A comment on a kanban card. */
export interface Comment {
  /** Unique comment ID. */
  id: string;
  /** Author of the comment (agent role or user). */
  author: string;
  /** ISO timestamp of when the comment was posted. */
  timestamp: string;
  /** Comment body text. */
  body: string;
}

/** A kanban column: one status bucket containing its cards. */
export interface KanbanColumn {
  status: KanbanStatus;
  cards: KanbanCard[];
}

/** The full kanban board. */
export interface KanbanBoard {
  columns: KanbanColumn[];
  cardCount: number;
  parsedAt: string; // ISO timestamp of when parsing happened
}