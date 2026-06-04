/**
 * Opportunity Detector types — T-034 (P1-c, Addendum 1).
 *
 * Replaces budget enforcement with a Skill/Script Opportunity Detector
 * that surfaces token/tool-call patterns and suggests skill creation.
 * NO auto-action — user opt-in only.
 */

import type { TokenCounter, TokenLedgerEntry } from "../observability/token-counter.js";

// ─── Pattern Types ────────────────────────────────────────────────────────────

/** The 8 detection pattern types from Addendum 1 §4.4. */
export type PatternType =
  | "sequential_tool_chains"
  | "repeated_identical_calls"
  | "high_cost_single_turns"
  | "long_card_retries"
  | "re_reading_same_files"
  | "missed_parallel_opportunities"
  | "manual_aggregation"
  | "error_retry_loops";

/** Human-readable labels for each pattern type. */
export const PATTERN_LABELS: Record<PatternType, string> = {
  sequential_tool_chains: "Sequential Tool Chains",
  repeated_identical_calls: "Repeated Identical Calls",
  high_cost_single_turns: "High-Cost Single Turns",
  long_card_retries: "Long Card Retries",
  re_reading_same_files: "Re-Reading Same Files",
  missed_parallel_opportunities: "Missed Parallel Opportunities",
  manual_aggregation: "Manual Aggregation",
  error_retry_loops: "Error-and-Retry Loops",
};

/** Short descriptions for each pattern type. */
export const PATTERN_DESCRIPTIONS: Record<PatternType, string> = {
  sequential_tool_chains:
    "A sequence of 3+ different tools called in succession, repeated 5+ times",
  repeated_identical_calls:
    "The same tool called 10+ times with only parameter variations",
  high_cost_single_turns:
    "Individual LLM calls exceeding 10,000 total tokens",
  long_card_retries:
    "A kanban card that required 3+ attempts to complete",
  re_reading_same_files:
    "The same file read 3+ times across different turns/agents",
  missed_parallel_opportunities:
    "Independent tool calls that could have been run in parallel",
  manual_aggregation:
    "Worker manually composes results from 3+ sub-dispatches",
  error_retry_loops:
    "The same tool errored 3+ times with retries",
};

// ─── Data Input Types ─────────────────────────────────────────────────────────

/** A log entry for a tool call (from session history). */
export interface ToolCallLog {
  /** Unique identifier for this call. */
  id: string;
  /** Timestamp (epoch ms). */
  timestamp: number;
  /** Name of the tool called (e.g. "read", "grep", "github-mcp_get_file_contents"). */
  toolName: string;
  /** Arguments passed to the tool (stringified for comparison). */
  args: Record<string, unknown>;
  /** Whether the call resulted in an error. */
  isError: boolean;
  /** Error message if isError is true. */
  errorMessage?: string;
  /** Token cost of this call (from associated ledger entry, if any). */
  tokensUsed?: number;
  /** Task/card ID this call belongs to. */
  taskId?: string;
  /** Agent that made this call. */
  agentId?: string;
  /** File path if the tool operates on a file (for re-reading detection). */
  filePath?: string;
  /** Turn number within the session. */
  turnNumber?: number;
}

/** History of attempts for a kanban card. */
export interface CardAttemptHistory {
  /** Card ID (e.g. "T-007"). */
  cardId: string;
  /** Number of attempts (full cycles). */
  attemptCount: number;
  /** Total tokens spent across all attempts. */
  totalTokensSpent: number;
  /** List of attempt summaries. */
  attempts: CardAttempt[];
}

/** A single attempt on a card. */
export interface CardAttempt {
  /** Attempt number (1-indexed). */
  attemptNumber: number;
  /** Agent that was dispatched. */
  worker: string;
  /** Timestamp of the attempt start. */
  timestamp: number;
  /** Result of the attempt. */
  result: "success" | "failure" | "blocked";
  /** Tokens spent on this attempt. */
  tokensSpent: number;
  /** Summary of what happened. */
  summary: string;
  /** Memory ID of the wrap-up context (if any). */
  memoryId?: string;
}

/** A log entry for a sub-agent dispatch (for aggregation detection). */
export interface DispatchLog {
  /** Unique identifier. */
  id: string;
  /** Timestamp (epoch ms). */
  timestamp: number;
  /** The agent role dispatched (e.g. "boomerang-coder"). */
  agentRole: string;
  /** Task/card ID. */
  taskId: string;
  /** Whether the dispatch succeeded. */
  success: boolean;
  /** Output size in tokens. */
  outputTokens?: number;
  /** Whether the output was mostly text synthesis (vs code). */
  synthesisOutput?: boolean;
}

// ─── Output Types ─────────────────────────────────────────────────────────────

/** A detected opportunity candidate (output of a pattern detector). */
export interface Candidate {
  /** Which pattern detected this. */
  patternType: PatternType;
  /** Human-readable description of what was detected. */
  description: string;
  /** Suggested fix: skill name or improvement. */
  suggestedFix: string;
  /** Estimated token savings per occurrence. */
  estimatedTokenSavings: number;
  /** How many times this pattern was observed in the current session. */
  frequency: number;
  /** Build effort estimate (e.g. "0.5 day"). */
  buildEffort: string;
  /** Priority band (P0, P1, P2). */
  priority: "P0" | "P1" | "P2";
  /** Does this help all projects (1.5x) or just this one (1.0x)? */
  scopeAllProjects: boolean;
  /** Supporting evidence (turn numbers, tool names, token counts). */
  evidence: CandidateEvidence;
}

/** Evidence supporting a candidate. */
export interface CandidateEvidence {
  /** Tool names involved (for tool-related patterns). */
  toolNames?: string[];
  /** File paths involved (for re-reading patterns). */
  filePaths?: string[];
  /** Card IDs involved (for card-retry patterns). */
  cardIds?: string[];
  /** Total calls/turns in the pattern. */
  totalCalls?: number;
  /** Total tokens consumed by the pattern. */
  totalTokens?: number;
  /** Wall time in ms (if calculable). */
  wallTimeMs?: number;
}

/** A ranked candidate (output of the ranker). */
export interface RankedCandidate extends Candidate {
  /** Computed score: estimatedTokenSavings × frequency × scopeMultiplier. */
  score: number;
  /** Rank position (1 = highest priority). */
  rank: number;
}

// ─── Trigger Types ────────────────────────────────────────────────────────────

/** Conditions that trigger the detector. */
export interface TriggerConditions {
  /** Session duration > 2 hours (ms). */
  sessionDurationMs: number;
  /** Session total tokens > 200K. */
  sessionTotalTokens: number;
  /** Session total LLM calls > 50. */
  sessionLlmCalls: number;
  /** Whether this is an end-of-wrap-up trigger. */
  isEndOfWrapUp: boolean;
  /** Whether this is a manual /opportunities trigger. */
  isManual: boolean;
}

/** Default trigger thresholds from Addendum 1 §4.3. */
export const DEFAULT_TRIGGER_THRESHOLDS = {
  /** 2 hours in ms. */
  sessionDurationMs: 2 * 60 * 60 * 1000,
  /** 200K tokens. */
  sessionTotalTokens: 200_000,
  /** 50 LLM calls. */
  sessionLlmCalls: 50,
} as const;

// ─── Silenced Pattern ─────────────────────────────────────────────────────────

/** A pattern type silenced for the current session. */
export interface SilencedPattern {
  /** The pattern that was silenced. */
  patternType: PatternType;
  /** When it was silenced (epoch ms). */
  silencedAt: number;
}

/** A considered (dismissed) candidate. */
export interface ConsideredCandidate {
  /** The original candidate. */
  candidate: RankedCandidate;
  /** When it was considered (epoch ms). */
  consideredAt: number;
  /** Why it was dismissed (user reason). */
  reason: "not_interested" | "already_exists" | "too_complex" | "other";
}

// ─── Detector Options ─────────────────────────────────────────────────────────

/** Options for creating an OpportunityDetector. */
export interface OpportunityDetectorOptions {
  /** TokenCounter instance (provides live token entries + session totals). */
  tokenCounter?: TokenCounter;
  /** Token ledger entries (alternative to TokenCounter for testing). */
  tokenEntries?: TokenLedgerEntry[];
  /** Tool call logs (populated from session data). */
  toolCallLogs?: ToolCallLog[];
  /** Card attempt histories (from kanban). */
  cardHistories?: CardAttemptHistory[];
  /** Sub-agent dispatch logs. */
  dispatchLogs?: DispatchLog[];
  /** Custom trigger thresholds (overrides defaults). */
  triggerThresholds?: Partial<typeof DEFAULT_TRIGGER_THRESHOLDS>;
  /** Maximum candidates to return from getTopCandidates. */
  maxCandidates?: number;
}