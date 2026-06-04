/**
 * Kanban module — public API.
 *
 * Re-exports types, parser, circuit breaker, comments, and attempts history
 * for use by the TUI panels.
 */

export { parseKanbanBoard, formatKanbanForPanel } from "./parser.js";
export { CircuitBreaker, formatAttempt, formatAttemptBlock } from "./circuit-breaker.js";
export {
  AttemptsHistory,
  formatTruncationLine,
  parseTruncationLine,
  truncateAttempts,
} from "./attempts.js";
export {
  CommentManager,
  formatComment,
  formatCommentBlock,
  collapseComments,
  renderMarkdown,
  stripMarkdown,
  parseCommentLine,
  parseCommentsFromSection,
} from "./comments.js";
export { KANBAN_STATUSES } from "./types.js";
export type { KanbanBoard, KanbanCard, KanbanColumn, KanbanStatus, AttemptEntry, Comment } from "./types.js";
export type { CircuitBreakerResult, CircuitBreakerState, CircuitBreakerOptions } from "./circuit-breaker.js";
export type { TruncationResult, AppendResult } from "./attempts.js";