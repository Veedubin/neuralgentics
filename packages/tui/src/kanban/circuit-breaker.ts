/**
 * @neuralgentics/tui — Kanban Circuit Breaker (T-036)
 *
 * Implements per-card failure tracking with configurable limits.
 * After `failureLimit` consecutive failures, the card is auto-archived.
 * After 1 failure, the card is moved to `blocked` status (still visible).
 * `/resume` resets the failure counter, allowing a fresh start.
 *
 * Hermes default: failure_limit = 2 (overrides v4-FINAL's recommended 3).
 * User can override per-card via the `failure_limit` field in TASKS.md.
 */

import type { KanbanCard, KanbanStatus, AttemptEntry } from "./types.js";
import { KANBAN_STATUSES } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of a circuit breaker evaluation. */
export interface CircuitBreakerResult {
  /** The new status the card should transition to. */
  newStatus: KanbanStatus;
  /** Whether the circuit breaker has tripped (card should be archived). */
  tripped: boolean;
  /** Human-readable reason for the status change. */
  reason: string;
  /** Updated failure count after evaluation. */
  failureCount: number;
}

/** State snapshot of the circuit breaker across all cards. */
export interface CircuitBreakerState {
  /** Number of cards currently blocked due to circuit breaker. */
  blockedToday: number;
  /** Total number of failures recorded today. */
  failuresToday: number;
  /** Number of cards that have been auto-archived by circuit breaker. */
  archivedToday: number;
}

/** Options for creating a CircuitBreaker instance. */
export interface CircuitBreakerOptions {
  /** Maximum consecutive failures before auto-archive. Default: 2. */
  failureLimit?: number;
  /** Callback invoked when a card transitions status. */
  onStatusChange?: (cardId: string, from: KanbanStatus, to: KanbanStatus, reason: string) => void;
}

// ─── Valid Transitions ─────────────────────────────────────────────────────────

/**
 * Legal status transitions for kanban cards.
 *
 * Each key is a "from" status, and the value is the set of "to" statuses
 * that are allowed. Any transition not in this map is rejected.
 */
const VALID_TRANSITIONS: Record<KanbanStatus, Set<KanbanStatus>> = {
  triage: new Set(["todo", "ready", "archived"]),
  todo: new Set(["ready", "archived"]),
  ready: new Set(["running", "archived"]),
  running: new Set(["done", "blocked", "archived"]),
  blocked: new Set(["ready", "running", "archived"]),
  done: new Set(["archived"]),
  archived: new Set(["ready"]), // Only via /resume
};

// ─── CircuitBreaker Class ─────────────────────────────────────────────────────

/**
 * CircuitBreaker — tracks per-card failure counts and enforces limits.
 *
 * Life cycle:
 *   1. Card starts with failureCount=0 and failureLimit (default 2).
 *   2. On dispatch failure: `recordFailure()` bumps failureCount.
 *      - If failureCount < failureLimit → card moves to `blocked`.
 *      - If failureCount >= failureLimit → card auto-archives.
 *   3. On dispatch success: `recordSuccess()` resets failureCount to 0.
 *   4. On `/resume`: `resetFailureCount()` resets to 0 and unblocks.
 */
export class CircuitBreaker {
  private readonly defaultFailureLimit: number;
  private readonly onStatusChange?: (cardId: string, from: KanbanStatus, to: KanbanStatus, reason: string) => void;
  private readonly cardStates = new Map<string, { failureCount: number; failureLimit: number; lastFailureTimestamp: string }>();
  private blockedToday = 0;
  private failuresToday = 0;
  private archivedToday = 0;

  constructor(options?: CircuitBreakerOptions) {
    this.defaultFailureLimit = options?.failureLimit ?? 2;
    this.onStatusChange = options?.onStatusChange;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Record a dispatch failure for a card.
   *
   * Increments the card's failure count and returns the new target status:
   * - 1st failure → `blocked` (card stays visible)
   * - failure_limit reached → `archived` (card removed from active board)
   *
   * @param card - The card that failed.
   * @param worker - Worker/agent role that attempted the card.
   * @param error - Error message describing the failure.
   * @param tokensSpent - Tokens consumed before the failure.
   * @param memoryId - Memory ID of the failure context.
   * @returns CircuitBreakerResult with the new status and updated failure count.
   */
  recordFailure(
    card: KanbanCard,
    worker: string,
    error: string,
    tokensSpent: number,
    memoryId: string,
  ): CircuitBreakerResult {
    const limit = this.getFailureLimit(card);
    const prevCount = this.getFailureCount(card.id);
    const newCount = prevCount + 1;

    this.cardStates.set(card.id, {
      failureCount: newCount,
      failureLimit: limit,
      lastFailureTimestamp: new Date().toISOString(),
    });

    this.failuresToday++;

    const attempt: AttemptEntry = {
      attemptNumber: newCount,
      worker,
      timestamp: new Date().toISOString(),
      result: "failure",
      tokensSpent,
      memoryId,
      summary: error,
    };

    if (newCount >= limit) {
      // Circuit breaker tripped — auto-archive
      this.archivedToday++;

      const reason = `Circuit breaker: ${newCount} consecutive failures. Limit: ${limit}.`;
      this.onStatusChange?.(card.id, card.status, "archived", reason);

      return {
        newStatus: "archived",
        tripped: true,
        reason,
        failureCount: newCount,
      };
    }

    // First failure — move to blocked (still visible)
    this.blockedToday++;

    const reason = `Circuit breaker: ${newCount} of ${limit} failures. Card blocked pending /resume or next dispatch.`;
    this.onStatusChange?.(card.id, card.status, "blocked", reason);

    return {
      newStatus: "blocked",
      tripped: false,
      reason,
      failureCount: newCount,
    };
  }

  /**
   * Record a successful dispatch for a card.
   *
   * Resets the failure count to 0.
   *
   * @param card - The card that succeeded.
   * @param worker - Worker/agent role that completed the card.
   * @param tokensSpent - Tokens consumed during the successful dispatch.
   * @param memoryId - Memory ID of the wrap-up.
   * @returns CircuitBreakerResult with `done` status and reset failure count.
   */
  recordSuccess(
    card: KanbanCard,
    worker: string,
    tokensSpent: number,
    memoryId: string,
  ): CircuitBreakerResult {
    this.cardStates.set(card.id, {
      failureCount: 0,
      failureLimit: this.getFailureLimit(card),
      lastFailureTimestamp: "",
    });

    const reason = `Completed successfully by ${worker}.`;
    this.onStatusChange?.(card.id, card.status, "done", reason);

    return {
      newStatus: "done",
      tripped: false,
      reason,
      failureCount: 0,
    };
  }

  /**
   * Reset a card's failure count via `/resume`.
   *
   * Moves the card from `blocked` back to `ready` with a clean failure count.
   * Can also resurrect an `archived` card back to `ready`.
   *
   * @param cardId - The ID of the card to resume.
   * @returns true if the card was found and reset, false otherwise.
   */
  resetFailureCount(cardId: string): boolean {
    const state = this.cardStates.get(cardId);
    if (!state) return false;

    state.failureCount = 0;
    state.lastFailureTimestamp = "";
    this.onStatusChange?.(cardId, "blocked" as KanbanStatus, "ready", "/resume: failure count reset");
    return true;
  }

  /**
   * Initialize tracking for a card (called when a card is first parsed).
   *
   * This ensures the circuit breaker has state for the card without
   * incrementing any counters.
   */
  registerCard(card: KanbanCard): void {
    if (!this.cardStates.has(card.id)) {
      this.cardStates.set(card.id, {
        failureCount: card.failureCount,
        failureLimit: card.failureLimit,
        lastFailureTimestamp: "",
      });
    }
  }

  // ── Query Methods ──────────────────────────────────────────────────────────

  /** Get the current failure count for a card. */
  getFailureCount(cardId: string): number {
    return this.cardStates.get(cardId)?.failureCount ?? 0;
  }

  /** Get the failure limit for a card. Falls back to instance default. */
  getFailureLimit(card: KanbanCard): number {
    return card.failureLimit ?? this.defaultFailureLimit;
  }

  /** Check if a card has tripped the circuit breaker. */
  isTripped(card: KanbanCard): boolean {
    const state = this.cardStates.get(card.id);
    if (!state) return false;
    return state.failureCount >= state.failureLimit;
  }

  /**
   * Validate a status transition.
   *
   * @param from - Current status.
   * @param to - Target status.
   * @returns true if the transition is valid, false otherwise.
   */
  isValidTransition(from: KanbanStatus, to: KanbanStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return false;
    return allowed.has(to);
  }

  /**
   * Get the valid target statuses for a given source status.
   *
   * @param from - Source status.
   * @returns Array of valid target statuses.
   */
  getValidTransitions(from: KanbanStatus): KanbanStatus[] {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return [];
    return Array.from(allowed);
  }

  /**
   * Get a snapshot of circuit breaker activity.
   *
   * Note: "today" counters are session-scoped (reset on CircuitBreaker
   * construction). For cross-session persistence, cards carry their own
   * `failureCount` in the TASKS.md file.
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return {
      blockedToday: this.blockedToday,
      failuresToday: this.failuresToday,
      archivedToday: this.archivedToday,
    };
  }
}

// ─── Attempt History Formatting ────────────────────────────────────────────────

/**
 * Format an attempt entry as a Markdown string for the `## Previous Attempts`
 * block in a kanban card.
 *
 * Format: `### Attempt N (worker, timestamp, result, N tokens)`
 * Followed by summary and memory_id link.
 */
export function formatAttempt(attempt: AttemptEntry): string {
  const resultLabel = attempt.result === "success" ? "✅ success" : "❌ failure";
  const lines: string[] = [
    `### Attempt ${attempt.attemptNumber} (${attempt.worker}, ${attempt.timestamp}, ${resultLabel}, ${attempt.tokensSpent.toLocaleString()} tokens)`,
    `> ${attempt.summary}`,
    attempt.memoryId ? `Memory: [\`${attempt.memoryId}\`](memory:${attempt.memoryId})` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Format all attempts for a card as a single Markdown block.
 *
 * Output:
 * ```
 * ## Previous Attempts
 *
 * ### Attempt 1 (coder, 2026-06-04T15:30:00Z, ❌ failure, 5,400 tokens)
 * > Cannot determine OAuth spec version
 * Memory: `abc-123`
 *
 * ### Attempt 2 (coder, 2026-06-04T16:00:00Z, ❌ failure, 4,200 tokens)
 * > OAuth scope mismatch
 * Memory: `def-456`
 * ```
 */
export function formatAttemptBlock(attempts: AttemptEntry[]): string {
  if (attempts.length === 0) return "";

  const header = "## Previous Attempts\n";
  const entries = attempts.map(formatAttempt).join("\n\n");
  return header + "\n" + entries;
}