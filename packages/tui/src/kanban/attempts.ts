/**
 * @neuralgentics/tui — Kanban Attempts History (T-038)
 *
 * Manages the attempt history for kanban cards. Auto-appends on failure
 * (called by CircuitBreaker.recordFailure) and truncates to a max of 5
 * visible attempts, linking older ones back to memini-core.
 *
 * TASKS.md format (using T-036 formatAttempt output):
 * ```
 * ## Previous Attempts
 *
 * ### Attempt 1 (coder, 2026-06-04 02:15, ❌ failure, 450 tokens)
 * > Build failed: missing import
 * Memory: `mem-abc-123`
 *
 * ### Attempt 2 (coder, 2026-06-04 02:30, ❌ failure, 520 tokens)
 * > Test failed: 3 errors
 * Memory: `mem-def-456`
 *
 * ... and 3 more in memini-core (memory_id: mem-xyz-789)
 * ```
 */

import type { AttemptEntry, KanbanCard } from "./types.js";
import { formatAttempt, formatAttemptBlock } from "./circuit-breaker.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Maximum number of attempts shown in TASKS.md before truncation. */
const MAX_VISIBLE_ATTEMPTS = 5;

/** Regex for the truncation line: `... and N more in memini-core (memory_id: <id>)` */
const TRUNCATION_LINE_REGEX =
  /^\.{3}\s+and\s+(\d+)\s+more\s+in\s+memini-core\s+\(memory_id:\s*([^\)]+)\)/;

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Result of truncating an attempt history. */
export interface TruncationResult {
  /** The visible attempts (most recent, up to MAX_VISIBLE_ATTEMPTS). */
  visible: AttemptEntry[];
  /** Number of truncated (hidden) attempts. */
  truncatedCount: number;
  /** Memory ID link for the truncated attempts. Empty string if none truncated. */
  truncatedMemoryId: string;
}

/** Result of appending an attempt to a card's history. */
export interface AppendResult {
  /** The updated attempt history (after truncation if needed). */
  attempts: AttemptEntry[];
  /** The new failure count after appending. */
  failureCount: number;
  /** The truncation info, if any attempts were hidden. */
  truncation: TruncationResult | null;
}

// ─── AttemptsHistory Class ───────────────────────────────────────────────────────

/**
 * AttemptsHistory — manages per-card attempt histories with truncation.
 *
 * Responsibilities:
 *   1. Append new attempts on failure (called by CircuitBreaker).
 *   2. Keep max 5 visible attempts in TASKS.md.
 *   3. Truncate older attempts with a link to memini-core.
 *   4. Format the `## Previous Attempts` block for TASKS.md.
 *   5. Parse the truncation line when reading TASKS.md back.
 */
export class AttemptsHistory {
  private readonly maxVisible: number;

  constructor(maxVisible: number = MAX_VISIBLE_ATTEMPTS) {
    this.maxVisible = maxVisible;
  }

  // ── Append ──────────────────────────────────────────────────────────────────

  /**
   * Append a failure attempt to a card's history.
   *
   * Called by CircuitBreaker.recordFailure after it determines the new status.
   * The attempt is added to the end of the history, and if the total exceeds
   * `maxVisible`, older attempts are truncated with a memini-core link.
   *
   * @param card - The card that failed.
   * @param worker - Worker/agent role that attempted the card.
   * @param error - Error message describing the failure.
   * @param tokensSpent - Tokens consumed before the failure.
   * @param memoryId - Memory ID of the failure context.
   * @returns AppendResult with updated history and optional truncation info.
   */
  appendFailure(
    card: KanbanCard,
    worker: string,
    error: string,
    tokensSpent: number,
    memoryId: string,
  ): AppendResult {
    const newAttempt: AttemptEntry = {
      attemptNumber: card.attemptHistory.length + 1,
      worker,
      timestamp: new Date().toISOString(),
      result: "failure",
      tokensSpent,
      memoryId,
      summary: error,
    };

    const allAttempts = [...card.attemptHistory, newAttempt];
    const truncation = this.truncate(allAttempts);

    return {
      attempts: truncation.visible,
      failureCount: card.failureCount + 1,
      truncation: truncation.truncatedCount > 0 ? truncation : null,
    };
  }

  /**
   * Append a success attempt to a card's history.
   *
   * Called by CircuitBreaker.recordSuccess after the card completes.
   *
   * @param card - The card that succeeded.
   * @param worker - Worker/agent role that completed the card.
   * @param tokensSpent - Tokens consumed during the successful dispatch.
   * @param memoryId - Memory ID of the wrap-up.
   * @returns AppendResult with updated history. Failure count resets to 0.
   */
  appendSuccess(
    card: KanbanCard,
    worker: string,
    tokensSpent: number,
    memoryId: string,
  ): AppendResult {
    const newAttempt: AttemptEntry = {
      attemptNumber: card.attemptHistory.length + 1,
      worker,
      timestamp: new Date().toISOString(),
      result: "success",
      tokensSpent,
      memoryId,
      summary: `Completed by ${worker}`,
    };

    // Success resets failure count to 0
    const allAttempts = [...card.attemptHistory, newAttempt];
    const truncation = this.truncate(allAttempts);

    return {
      attempts: truncation.visible,
      failureCount: 0,
      truncation: truncation.truncatedCount > 0 ? truncation : null,
    };
  }

  // ── Truncation ─────────────────────────────────────────────────────────────

  /**
   * Truncate an attempt list to `maxVisible` entries.
   *
   * Keeps the most recent attempts and generates a truncation line
   * linking to memini-core for the older ones.
   *
   * @param attempts - Full attempt history (ordered oldest to newest).
   * @returns TruncationResult with visible and hidden attempts.
   */
  truncate(attempts: AttemptEntry[]): TruncationResult {
    if (attempts.length <= this.maxVisible) {
      return {
        visible: attempts,
        truncatedCount: 0,
        truncatedMemoryId: "",
      };
    }

    // Keep the most recent `maxVisible` attempts
    const visible = attempts.slice(-this.maxVisible);
    const truncatedCount = attempts.length - this.maxVisible;

    // Use the memory ID of the oldest truncated attempt as the link
    const oldestTruncated = attempts[0];
    const truncatedMemoryId = oldestTruncated?.memoryId ?? "";

    return {
      visible,
      truncatedCount,
      truncatedMemoryId,
    };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /**
   * Format the attempt history as a `## Previous Attempts` block for TASKS.md.
   *
   * Includes the truncation line if any attempts were hidden.
   *
   * @param attempts - Visible attempt entries (after truncation).
   * @param truncation - Optional truncation info from a previous truncate() call.
   * @returns Formatted Markdown string, or empty string if no attempts.
   */
  formatForTasksMd(attempts: AttemptEntry[], truncation?: TruncationResult | null): string {
    if (attempts.length === 0) return "";

    const block = formatAttemptBlock(attempts);

    if (truncation && truncation.truncatedCount > 0) {
      const truncLine = `\n\n... and ${truncation.truncatedCount} more in memini-core (memory_id: ${truncation.truncatedMemoryId})`;
      return block + truncLine;
    }

    return block;
  }

  // ── Parsing ─────────────────────────────────────────────────────────────────

  /**
   * Parse the truncation line from a `## Previous Attempts` section.
   *
   * Format: `... and N more in memini-core (memory_id: <id>)`
   *
   * @param line - A single line from the TASKS.md attempts section.
   * @returns Parsed truncation info, or null if the line is not a truncation line.
   */
  parseTruncationLine(line: string): { count: number; memoryId: string } | null {
    const match = line.match(TRUNCATION_LINE_REGEX);
    if (!match) return null;
    return {
      count: parseInt(match[1]!, 10),
      memoryId: match[2]!.trim(),
    };
  }
}

// ─── Standalone Functions ───────────────────────────────────────────────────────

/**
 * Format a truncation line for TASKS.md.
 *
 * @param count - Number of hidden attempts.
 * @param memoryId - Memory ID to link to for the hidden attempts.
 * @returns Formatted truncation line.
 */
export function formatTruncationLine(count: number, memoryId: string): string {
  return `... and ${count} more in memini-core (memory_id: ${memoryId})`;
}

/**
 * Parse a truncation line from TASKS.md.
 *
 * @param line - A single line that may be a truncation line.
 * @returns Parsed count and memoryId, or null if not a truncation line.
 */
export function parseTruncationLine(line: string): { count: number; memoryId: string } | null {
  const match = line.match(TRUNCATION_LINE_REGEX);
  if (!match) return null;
  return {
    count: parseInt(match[1]!, 10),
    memoryId: match[2]!.trim(),
  };
}

/**
 * Truncate attempts to a maximum number of visible entries.
 *
 * Convenience function that creates a temporary AttemptsHistory instance.
 *
 * @param attempts - Full attempt history.
 * @param maxVisible - Maximum visible attempts (default: 5).
 * @returns TruncationResult with visible and hidden entries.
 */
export function truncateAttempts(attempts: AttemptEntry[], maxVisible: number = MAX_VISIBLE_ATTEMPTS): TruncationResult {
  const history = new AttemptsHistory(maxVisible);
  return history.truncate(attempts);
}