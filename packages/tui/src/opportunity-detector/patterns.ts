/**
 * Pattern Detectors — T-034 (P1-c, Addendum 1).
 *
 * 8 detection pattern scanners from the Addendum 1 §4.4 pattern catalog.
 * Each pattern is an independent scanner that queries session data and
 * produces Candidate[] results.
 *
 * NO auto-action — detection only, user opt-in via prompter.
 */

import type { TokenLedgerEntry } from "../observability/token-counter.js";
import type {
  PatternType,
  ToolCallLog,
  CardAttemptHistory,
  DispatchLog,
  Candidate,
  CandidateBase,
  CandidateEvidence,
} from "./types.js";

// ─── Pattern Detector Interface ────────────────────────────────────────────────

/**
 * A single pattern detector. Takes session data and returns zero or more
 * detected candidates. Each detector is independent and can be run in parallel.
 */
export interface PatternDetector {
  /** The pattern type this detector handles. */
  readonly patternType: PatternType;
  /** Run detection against session data. */
  detect(): CandidateBase[];
}

// ─── Pattern 1: Sequential Tool Chains ────────────────────────────────────────

/**
 * Detects a sequence of 3+ different tools called in immediate succession,
 * repeated 5+ times across the session.
 *
 * Example: find_files → grep → read → read repeated 7 times.
 */
export function detectSequentialToolChains(
  toolCalls: ToolCallLog[],
  tokenEntries: TokenLedgerEntry[],
): CandidateBase[] {
  if (toolCalls.length < 15) return []; // Need at least 5 repetitions × 3 tools

  // Group tool calls by turn number
  const byTurn = new Map<number, ToolCallLog[]>();
  for (const tc of toolCalls) {
    const turn = tc.turnNumber ?? 0;
    const arr = byTurn.get(turn) ?? [];
    arr.push(tc);
    byTurn.set(turn, arr);
  }

  // Find runs of 3+ consecutive different tools within each turn
  const chainHashCounts = new Map<string, { count: number; calls: number; tokens: number; toolNames: Set<string> }>();

  for (const [, calls] of byTurn) {
    const sorted = [...calls].sort((a, b) => a.timestamp - b.timestamp);
    let i = 0;
    while (i < sorted.length) {
      // Find a run of 3+ consecutive different tools
      const run: ToolCallLog[] = [sorted[i]!];
      let j = i + 1;
      while (j < sorted.length && sorted[j]!.toolName !== sorted[j - 1]!.toolName) {
        run.push(sorted[j]!);
        j++;
      }

      if (run.length >= 3) {
        // Hash the tool name sequence (ignoring args)
        const key = run.map((tc) => tc.toolName).join("→");
        const existing = chainHashCounts.get(key);
        const runTokens = run.reduce((sum, tc) => sum + (tc.tokensUsed ?? 0), 0);

        if (existing) {
          existing.count += 1;
          existing.calls += run.length;
          existing.tokens += runTokens;
          for (const tc of run) existing.toolNames.add(tc.toolName);
        } else {
          chainHashCounts.set(key, {
            count: 1,
            calls: run.length,
            tokens: runTokens,
            toolNames: new Set(run.map((tc) => tc.toolName)),
          });
        }
      }
      i = j > i + 1 ? j : i + 1;
    }
  }

  const candidates: CandidateBase[] = [];

  for (const [_key, data] of chainHashCounts) {
    if (data.count >= 5) {
      const toolNames = Array.from(data.toolNames);
      // Estimate savings: ~70% fewer calls with a consolidated tool
      const estimatedSavings = Math.round(data.tokens * 0.7);

      candidates.push({
        patternType: "sequential_tool_chains",
        description:
          `Sequential tool chain detected: ${toolNames.join(" → ")} repeated ${data.count} times ` +
          `(${data.calls} total calls, ~${data.tokens.toLocaleString()} tokens)`,
        suggestedFix:
          `Create a consolidated tool that handles ${toolNames.join(", ")} in a single call. ` +
          `Wraps the individual tools and returns combined results.`,
        estimatedTokenSavings: estimatedSavings,
        frequency: data.count,
        buildEffort: "0.5 day",
        priority: "P2",
        scopeAllProjects: true,
        evidence: {
          toolNames,
          totalCalls: data.calls,
          totalTokens: data.tokens,
        },
      });
    }
  }

  return candidates;
}

// ─── Pattern 2: Repeated Identical Calls ────────────────────────────────────────

/**
 * Detects the same tool called 10+ times with only parameter variations.
 *
 * Example: github-mcp_get_file_contents called 15 times for different files.
 */
export function detectRepeatedIdenticalCalls(
  toolCalls: ToolCallLog[],
): CandidateBase[] {
  // Group by tool name
  const byTool = new Map<string, ToolCallLog[]>();
  for (const tc of toolCalls) {
    const arr = byTool.get(tc.toolName) ?? [];
    arr.push(tc);
    byTool.set(tc.toolName, arr);
  }

  const candidates: CandidateBase[] = [];

  for (const [toolName, calls] of byTool) {
    if (calls.length >= 10) {
      const totalTokens = calls.reduce((sum, tc) => sum + (tc.tokensUsed ?? 0), 0);
      // Estimate savings: ~90% fewer calls with batch read
      const estimatedSavings = Math.round(totalTokens * 0.9);
      const taskIds = [...new Set(calls.map((tc) => tc.taskId).filter(Boolean))] as string[];

      candidates.push({
        patternType: "repeated_identical_calls",
        description:
          `\`${toolName}\` called ${calls.length} times across ${taskIds.length || "multiple"} task(s), ` +
          `each time with different parameters (~${totalTokens.toLocaleString()} tokens total)`,
        suggestedFix:
          `Create a batch wrapper for \`${toolName}\` that takes a list of parameters ` +
          `and returns all results in a single call.`,
        estimatedTokenSavings: estimatedSavings,
        frequency: calls.length,
        buildEffort: "0.25 day",
        priority: "P1",
        scopeAllProjects: true,
        evidence: {
          toolNames: [toolName],
          totalCalls: calls.length,
          totalTokens,
          cardIds: taskIds,
        },
      });
    }
  }

  return candidates;
}

// ─── Pattern 3: High-Cost Single Turns ────────────────────────────────────────

/**
 * Detects individual LLM calls exceeding 10,000 total tokens.
 *
 * "Elephant turns" — a single prompt with too much context or too long a response.
 */
export function detectHighCostTurns(
  tokenEntries: TokenLedgerEntry[],
): CandidateBase[] {
  const HIGH_COST_THRESHOLD = 10_000;
  const candidates: CandidateBase[] = [];

  for (const entry of tokenEntries) {
    if (entry.total >= HIGH_COST_THRESHOLD) {
      const outputRatio = entry.output / entry.total;
      const inputRatio = entry.input / entry.total;
      let suggestedFix: string;
      let savingsEstimate: number;

      if (outputRatio > 0.4) {
        // Output-heavy: suggest output splitting
        suggestedFix =
          "Split the output into smaller chunks or use a streaming approach. " +
          "Consider using a smaller model for summarization tasks.";
        savingsEstimate = Math.round(entry.output * 0.5);
      } else if (inputRatio > 0.7) {
        // Input-heavy: suggest context reduction
        suggestedFix =
          "Pre-process large files before sending to the LLM: extract only relevant sections, " +
          "strip comments and whitespace, use a context slicer tool.";
        savingsEstimate = Math.round(entry.input * 0.5);
      } else {
        // Mixed: general optimization
        suggestedFix =
          "Reduce context size by using more targeted prompts, " +
          "or switch to a smaller model for simpler sub-tasks.";
        savingsEstimate = Math.round(entry.total * 0.4);
      }

      candidates.push({
        patternType: "high_cost_single_turns",
        description:
          `Turn consumed ${entry.total.toLocaleString()} tokens ` +
          `(input: ${entry.input.toLocaleString()}, output: ${entry.output.toLocaleString()}) ` +
          `in task ${entry.taskId ?? "unknown"} by agent ${entry.agentId ?? "unknown"} ` +
          `using model ${entry.model}`,
        suggestedFix,
        estimatedTokenSavings: savingsEstimate,
        frequency: 1,
        buildEffort: "0.5 day",
        priority: "P2",
        scopeAllProjects: false,
        evidence: {
          totalTokens: entry.total,
          cardIds: entry.taskId ? [entry.taskId] : undefined,
        },
      });
    }
  }

  return candidates;
}

// ─── Pattern 4: Long Card Retries ──────────────────────────────────────────────

/**
 * Detects a kanban card that required 3+ attempts.
 *
 * Each attempt = a full cycle; the card went through running→blocked→running multiple times.
 */
export function detectLongCardRetries(
  cardHistories: CardAttemptHistory[],
): CandidateBase[] {
  const candidates: CandidateBase[] = [];

  for (const card of cardHistories) {
    if (card.attemptCount >= 3) {
      const lastFailure = card.attempts
        .filter((a) => a.result === "failure" || a.result === "blocked")
        .pop();

      // Check if same error repeated
      const failureSummaries = card.attempts
        .filter((a) => a.result === "failure")
        .map((a) => a.summary);
      const uniqueFailureSummaries = new Set(failureSummaries);
      const sameErrorRepeated = failureSummaries.length > 1 && uniqueFailureSummaries.size === 1;

      let suggestedFix: string;
      if (sameErrorRepeated) {
        suggestedFix =
          `Card failed ${card.attemptCount} times with the same error: "${lastFailure?.summary ?? "unknown"}". ` +
          `Create an error-handling skill or validation script to catch this before implementation.`;
      } else {
        suggestedFix =
          `Card went through ${card.attemptCount} attempts with different failures each time. ` +
          `Decompose the card into smaller, independently verifiable sub-cards.`;
      }

      candidates.push({
        patternType: "long_card_retries",
        description:
          `Card ${card.cardId} went through ${card.attemptCount} attempts ` +
          `consuming ${card.totalTokensSpent.toLocaleString()} tokens total`,
        suggestedFix,
        estimatedTokenSavings: Math.round(card.totalTokensSpent * 0.75),
        frequency: card.attemptCount,
        buildEffort: sameErrorRepeated ? "0.5 day" : "1 day",
        priority: "P1",
        scopeAllProjects: false,
        evidence: {
          cardIds: [card.cardId],
          totalTokens: card.totalTokensSpent,
        },
      });
    }
  }

  return candidates;
}

// ─── Pattern 5: Re-Reading Same Files ─────────────────────────────────────────

/**
 * Detects the same file read 3+ times across different turns/agents.
 * The content hasn't changed between reads — wasted tokens.
 */
export function detectReReadingSameFiles(
  toolCalls: ToolCallLog[],
): CandidateBase[] {
  // Find all "read" tool calls with filePath
  const readCalls = toolCalls.filter(
    (tc) => tc.toolName === "read" && tc.filePath != null && tc.filePath !== "",
  );

  // Group by filePath
  const byPath = new Map<string, ToolCallLog[]>();
  for (const tc of readCalls) {
    if (!tc.filePath) continue;
    const arr = byPath.get(tc.filePath) ?? [];
    arr.push(tc);
    byPath.set(tc.filePath, arr);
  }

  const candidates: CandidateBase[] = [];

  for (const [filePath, calls] of byPath) {
    if (calls.length >= 3) {
      const totalTokens = calls.reduce((sum, tc) => sum + (tc.tokensUsed ?? 0), 0);
      // Check different agents read the same file
      const agents = new Set(calls.map((tc) => tc.agentId).filter(Boolean));

      candidates.push({
        patternType: "re_reading_same_files",
        description:
          `\`${filePath}\` was read ${calls.length} times across ${agents.size || "multiple"} agent(s). ` +
          `Each read cost ~${Math.round(totalTokens / calls.length)} tokens. Total: ${totalTokens.toLocaleString()} tokens.`,
        suggestedFix:
          `Create a project-context-cache skill that stores frequently-read files ` +
          `in memoryManager with type "file_cache". Subsequent reads query memory (~0 tokens) ` +
          `instead of re-reading the file.`,
        estimatedTokenSavings: Math.round(totalTokens * 0.7), // Save ~70% by caching
        frequency: calls.length,
        buildEffort: "0.25 day",
        priority: "P2",
        scopeAllProjects: true,
        evidence: {
          filePaths: [filePath],
          totalTokens,
          totalCalls: calls.length,
        },
      });
    }
  }

  return candidates;
}

// ─── Pattern 6: Missed Parallel Opportunities ──────────────────────────────────

/**
 * Detects independent tool calls that were run sequentially
 * but could have been run in parallel (no data dependency).
 */
export function detectMissedParallelOpportunities(
  toolCalls: ToolCallLog[],
): CandidateBase[] {
  if (toolCalls.length < 2) return [];

  // Group by turn
  const byTurn = new Map<number, ToolCallLog[]>();
  for (const tc of toolCalls) {
    const turn = tc.turnNumber ?? 0;
    const arr = byTurn.get(turn) ?? [];
    arr.push(tc);
    byTurn.set(turn, arr);
  }

  const candidates: CandidateBase[] = [];
  let totalMissedOpportunities = 0;
  let totalTokens = 0;

  for (const [, calls] of byTurn) {
    // Check for sequential calls to the same tool that could be parallel
    // Heuristic: multiple calls to "read" with different file paths = independent
    const reads = calls.filter((tc) => tc.toolName === "read" && calls.filter((c) => c.toolName === "read").length >= 2);

    if (reads.length >= 2) {
      // Check they have different filePaths (independent)
      const filePaths = new Set(reads.map((tc) => tc.filePath).filter(Boolean));
      if (filePaths.size >= 2) {
        totalMissedOpportunities++;
        totalTokens += reads.reduce((sum, tc) => sum + (tc.tokensUsed ?? 0), 0);
      }
    }

    // Also check for mixed tool calls that are independent
    // Heuristic: multiple different tools with no data deps (grep + read, etc.)
    const distinctTools = new Set(calls.map((tc) => tc.toolName));
    if (distinctTools.size >= 3 && calls.length >= 3) {
      // At least 3 different tools in one turn — likely some could be parallel
      totalMissedOpportunities++;
      totalTokens += calls.reduce((sum, tc) => sum + (tc.tokensUsed ?? 0), 0);
    }
  }

  if (totalMissedOpportunities >= 2) {
    candidates.push({
      patternType: "missed_parallel_opportunities",
      description:
        `${totalMissedOpportunities} turns had independent tool calls that could have run in parallel ` +
        `(~${totalTokens.toLocaleString()} tokens across those turns)`,
      suggestedFix:
        "Enable speculative parallel tool dispatch in the session manager. " +
        "When the worker requests independent operations (reads, greps), fire all simultaneously.",
      estimatedTokenSavings: 0, // Same tokens, but saves wall time
      frequency: totalMissedOpportunities,
      buildEffort: "1 day",
      priority: "P0",
      scopeAllProjects: true,
      evidence: {
        totalCalls: totalMissedOpportunities,
        totalTokens,
      },
    });
  }

  return candidates;
}

// ─── Pattern 7: Manual Aggregation ────────────────────────────────────────────

/**
 * Detects a worker dispatching 3+ sub-agents and then manually
 * composing a final answer (the synthesis step itself consumes tokens).
 */
export function detectManualAggregation(
  dispatchLogs: DispatchLog[],
  tokenEntries: TokenLedgerEntry[],
): CandidateBase[] {
  if (dispatchLogs.length < 3) return [];

  // Group dispatches by taskId
  const byTask = new Map<string, DispatchLog[]>();
  for (const dl of dispatchLogs) {
    const arr = byTask.get(dl.taskId) ?? [];
    arr.push(dl);
    byTask.set(dl.taskId, arr);
  }

  const candidates: CandidateBase[] = [];

  for (const [taskId, dispatches] of byTask) {
    if (dispatches.length < 3) continue;

    // Check if output was mostly synthesis (not code)
    const synthesisDispatches = dispatches.filter((dl) => dl.synthesisOutput === true);
    if (synthesisDispatches.length === 0) {
      // Look for a "compose" or "synthesize" turn in token entries
      const taskEntries = tokenEntries.filter((te) => te.taskId === taskId);
      const totalTaskTokens = taskEntries.reduce((sum, te) => sum + te.total, 0);

      // Heuristic: if this task used many tokens and had many dispatches,
      // it's likely a manual aggregation pattern
      if (dispatches.length >= 3 && totalTaskTokens > 5000) {
        const subAgentTokens = dispatches.reduce(
          (sum, dl) => sum + (dl.outputTokens ?? 2000), // estimate 2K tokens per sub-call
          0,
        );
        const estimatedSynthesisTokens = Math.round(totalTaskTokens * 0.3);

        candidates.push({
          patternType: "manual_aggregation",
          description:
            `Task ${taskId} dispatched ${dispatches.length} sub-agents and then synthesized ` +
            `the results manually (~${totalTaskTokens.toLocaleString()} total tokens, ` +
            `~${estimatedSynthesisTokens.toLocaleString()} in synthesis)`,
          suggestedFix:
            `Create a research-synthesizer skill that takes N sub-agent outputs + a synthesis ` +
            `prompt and returns a structured report.Uses a small model for the compose step.`,
          estimatedTokenSavings: Math.round(estimatedSynthesisTokens * 0.5),
          frequency: 1,
          buildEffort: "1 day",
          priority: "P2",
          scopeAllProjects: false,
          evidence: {
            totalTokens: totalTaskTokens,
            cardIds: [taskId],
          },
        });
      }
    }
  }

  return candidates;
}

// ─── Pattern 8: Error-and-Retry Loops ──────────────────────────────────────────

/**
 * Detects the same tool errored 3+ times and the worker kept retrying.
 *
 * Classic: rate-limited API call retries, MCP connection timeouts,
 * bad arguments to a tool.
 */
export function detectErrorRetryLoops(
  toolCalls: ToolCallLog[],
): CandidateBase[] {
  // Group error calls by tool name
  const errorsByTool = new Map<string, ToolCallLog[]>();
  for (const tc of toolCalls) {
    if (tc.isError) {
      const arr = errorsByTool.get(tc.toolName) ?? [];
      arr.push(tc);
      errorsByTool.set(tc.toolName, arr);
    }
  }

  const candidates: CandidateBase[] = [];

  for (const [toolName, errors] of errorsByTool) {
    if (errors.length < 3) continue;

    // Check for consecutive errors (retries)
    const sorted = [...errors].sort((a, b) => a.timestamp - b.timestamp);
    let consecutiveCount = 1;
    let maxConsecutive = 1;
    const errorMessages = new Set<string>();

    // Add first error message
    const firstErrMsg = sorted[0]!.errorMessage;
    if (firstErrMsg != null) errorMessages.add(firstErrMsg);

    for (let i = 1; i < sorted.length; i++) {
      const curr = sorted[i]!.errorMessage ?? "";
      const prev = sorted[i - 1]!.errorMessage ?? "";
      if (curr === prev && curr !== "") {
        consecutiveCount++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
      } else {
        consecutiveCount = 1;
      }
      const errMsg = sorted[i]!.errorMessage;
      if (errMsg != null) {
        errorMessages.add(errMsg);
      }
    }

    if (maxConsecutive >= 3 || errors.length >= 3) {
      const sameError = errorMessages.size === 1;
      const totalRetries = errors.length;
      const retryTokens = errors.reduce((sum, tc) => sum + (tc.tokensUsed ?? 500), 0); // estimate 500 tokens per retry

      let suggestedFix: string;
      if (sameError) {
        const errorMsg = [...errorMessages][0] ?? "unknown error";
        suggestedFix =
          `Create a retry-with-backoff wrapper for \`${toolName}\` that catches "${errorMsg}" ` +
          `and retries with exponential backoff + jitter. ` +
          `Or add a circuit breaker that blocks after 2 consecutive errors for the same tool+card.`;
      } else {
        suggestedFix =
          `Add error handling for \`${toolName}\` — ${errors.length} different errors encountered. ` +
          `Consider a circuit breaker pattern or fallback tool.`;
      }

      candidates.push({
        patternType: "error_retry_loops",
        description:
          `\`${toolName}\` errored ${totalRetries} times ` +
          `(${errorMessages.size === 1 ? "same error" : `${errorMessages.size} different errors`}) ` +
          `(~${retryTokens.toLocaleString()} tokens wasted on retries)`,
        suggestedFix,
        estimatedTokenSavings: Math.round(retryTokens * 0.8),
        frequency: totalRetries,
        buildEffort: sameError ? "0.25 day" : "0.5 day",
        priority: "P1",
        scopeAllProjects: true,
        evidence: {
          toolNames: [toolName],
          totalCalls: totalRetries,
          totalTokens: retryTokens,
        },
      });
    }
  }

  return candidates;
}

// ─── Run All Patterns ──────────────────────────────────────────────────────────

/** Data needed to run all pattern detectors. */
export interface PatternDetectorInput {
  toolCalls: ToolCallLog[];
  tokenEntries: TokenLedgerEntry[];
  cardHistories: CardAttemptHistory[];
  dispatchLogs: DispatchLog[];
  /** Session ID for stamping candidates. (T-085) */
  sessionId?: string;
}

/** Stamp candidate bases with timestamp and sessionId. (T-085) */
function stampCandidate(c: CandidateBase, sessionId: string): Candidate {
  return {
    ...c,
    timestamp: new Date().toISOString(),
    sessionId,
  };
}

/**
 * Run all 8 pattern detectors in sequence and collect results.
 * Each detector is independent and produces zero or more candidates.
 * Candidates are stamped with timestamp and sessionId. (T-085)
 */
export function runAllPatternDetectors(input: PatternDetectorInput): Candidate[] {
  const sessionId = input.sessionId ?? "unknown";
  const rawCandidates: CandidateBase[] = [
    ...detectSequentialToolChains(input.toolCalls, input.tokenEntries),
    ...detectRepeatedIdenticalCalls(input.toolCalls),
    ...detectHighCostTurns(input.tokenEntries),
    ...detectLongCardRetries(input.cardHistories),
    ...detectReReadingSameFiles(input.toolCalls),
    ...detectMissedParallelOpportunities(input.toolCalls),
    ...detectManualAggregation(input.dispatchLogs, input.tokenEntries),
    ...detectErrorRetryLoops(input.toolCalls),
  ];

  // Stamp each candidate with timestamp + sessionId (T-085)
  const allCandidates: Candidate[] = rawCandidates.map((c) => stampCandidate(c, sessionId));

  return allCandidates;
}