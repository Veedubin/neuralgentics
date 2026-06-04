/**
 * Compaction Filter Pipeline (T-026)
 *
 * Takes raw chat messages and filters them to high-signal content,
 * preparing a concise extraction text for the LLM.
 *
 * Filter rules:
 * - Drop system messages
 * - Drop messages shorter than MIN_MESSAGE_LENGTH chars
 * - Drop consecutive repetition (same content within last N messages)
 * - Truncate individual messages longer than MAX_SINGLE_MESSAGE_CHARS
 * - Mark high-signal messages (contain keywords, decisions, constraints)
 */

import type { ChatMessage } from "../opencode-client/types.js";
import type { FilteredMessage, FilterResult } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Minimum message length (chars) to include. Shorter = likely filler. */
const MIN_MESSAGE_LENGTH = 20;

/** Maximum chars for a single message before truncation. */
const MAX_SINGLE_MESSAGE_CHARS = 4000;

/** Number of recent messages to deduplicate against. */
const REPETITION_WINDOW = 5;

/** Keywords that signal high-value content. */
const HIGH_SIGNAL_KEYWORDS = [
  "decision",
  "decided",
  "important",
  "constraint",
  "requirement",
  "must",
  "should",
  "bug",
  "fix",
  "error",
  "issue",
  "api",
  "endpoint",
  "config",
  "setting",
  "architecture",
  "design",
  "implemented",
  "refactored",
  "changed",
  "updated",
  "created",
  "added",
  "removed",
  "deleted",
];

// ─── Token Estimation ───────────────────────────────────────────────────────────

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is a conservative heuristic — actual tokenizers vary.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Filter Pipeline ────────────────────────────────────────────────────────────

/**
 * Filter a list of chat messages to high-signal content.
 *
 * @param messages - Raw chat messages from the session.
 * @param maxChars - Maximum total characters for the extraction text (default 50000).
 * @returns A FilterResult with filtered messages and concatenated extraction text.
 */
export function filterMessages(
  messages: ChatMessage[],
  maxChars: number = 50000,
): FilterResult {
  const filtered: FilteredMessage[] = [];
  let totalTokens = 0;
  const recentContent: string[] = [];
  let filteredOut = 0;

  for (const msg of messages) {
    // Rule 1: Drop system messages (shouldn't exist in ChatMessage, but defensive)
    const role = msg.role === "user" ? "user" : "assistant";

    // Rule 2: Drop messages shorter than MIN_MESSAGE_LENGTH
    if (msg.content.length < MIN_MESSAGE_LENGTH) {
      filteredOut++;
      recentContent.push(msg.content);
      continue;
    }

    // Rule 3: Drop consecutive repetition
    if (recentContent.includes(msg.content)) {
      filteredOut++;
      continue;
    }

    // Rule 4: Truncate long messages
    const content = msg.content.length > MAX_SINGLE_MESSAGE_CHARS
      ? msg.content.slice(0, MAX_SINGLE_MESSAGE_CHARS) + "…[truncated]"
      : msg.content;

    // Rule 5: Determine high-signal
    const contentLower = content.toLowerCase();
    const highSignal = HIGH_SIGNAL_KEYWORDS.some((kw) => contentLower.includes(kw));

    const tokenEstimate = estimateTokens(content);
    const filteredMsg: FilteredMessage = {
      content,
      role,
      highSignal,
      tokenEstimate,
    };

    filtered.push(filteredMsg);
    totalTokens += tokenEstimate;

    // Track recent content for dedup
    recentContent.push(msg.content);
    if (recentContent.length > REPETITION_WINDOW) {
      recentContent.shift();
    }
  }

  // Build extraction text: high-signal first, then remainder
  const highSignalMsgs = filtered.filter((m) => m.highSignal);
  const lowSignalMsgs = filtered.filter((m) => !m.highSignal);

  // Always include high-signal messages
  const ordered = [...highSignalMsgs, ...lowSignalMsgs];

  // Build extraction text within the char budget
  let extractionText = "";
  for (const msg of ordered) {
    const prefix = msg.role === "user" ? "USER: " : "ASSISTANT: ";
    const line = prefix + msg.content + "\n\n";

    if (extractionText.length + line.length <= maxChars) {
      extractionText += line;
    } else {
      // Budget exhausted — stop adding
      break;
    }
  }

  return {
    messages: filtered,
    totalTokens,
    filteredOut,
    extractionText,
  };
}

/**
 * Estimate the total token count for a list of chat messages.
 * Useful for the monitor to decide when to trigger compaction.
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
}