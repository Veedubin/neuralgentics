/**
 * Tests for T-034 Opportunity Detector — patterns, ranking, prompting, commands.
 *
 * Covers:
 * - All 8 pattern detectors
 * - Candidate ranking formula
 * - OpportunityDetector trigger checking, scanning, silencing
 * - OpportunityPrompter formatting and card drafting
 * - /opportunities command handler
 * - Negative report generation
 */

import { describe, it, expect } from "bun:test";
import {
  detectSequentialToolChains,
  detectRepeatedIdenticalCalls,
  detectHighCostTurns,
  detectLongCardRetries,
  detectReReadingSameFiles,
  detectMissedParallelOpportunities,
  detectManualAggregation,
  detectErrorRetryLoops,
  runAllPatternDetectors,
} from "../opportunity-detector/patterns.js";
import { OpportunityDetector } from "../opportunity-detector/detector.js";
import {
  formatOpportunityPrompt,
  formatDetailedBreakdown,
  draftCard,
  handleOpportunitiesCommand,
} from "../opportunity-detector/prompter.js";
import {
  PATTERN_LABELS,
  type ToolCallLog,
  type CardAttemptHistory,
  type DispatchLog,
  type TriggerConditions,
  type Candidate,
  DEFAULT_TRIGGER_THRESHOLDS,
} from "../opportunity-detector/types.js";
import type { TokenLedgerEntry } from "../observability/token-counter.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────────

/** Create a minimal tool call log. */
function tc(overrides: Partial<ToolCallLog> & { toolName: string; id?: string }): ToolCallLog {
  return {
    id: overrides.id ?? `tc-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? Date.now(),
    toolName: overrides.toolName,
    args: overrides.args ?? {},
    isError: overrides.isError ?? false,
    errorMessage: overrides.errorMessage,
    tokensUsed: overrides.tokensUsed ?? 500,
    taskId: overrides.taskId,
    agentId: overrides.agentId,
    filePath: overrides.filePath,
    turnNumber: overrides.turnNumber ?? 1,
  };
}

/** Create a minimal token ledger entry. */
function tle(overrides: Partial<TokenLedgerEntry> & { model?: string }): TokenLedgerEntry {
  return {
    id: `tle-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now() - Math.random() * 100000,
    sessionId: "test-session",
    model: overrides.model ?? "test-model",
    input: overrides.input ?? 1000,
    output: overrides.output ?? 500,
    cached: overrides.cached ?? 0,
    system: overrides.system ?? 0,
    total: overrides.total ?? 1500,
    taskId: overrides.taskId,
    agentId: overrides.agentId,
  };
}

// ─── Pattern 1: Sequential Tool Chains ──────────────────────────────────────────

describe("Pattern 1: Sequential Tool Chains", () => {
  it("should detect sequential tool chain repeated 5+ times", () => {
    // Create 5 repetitions of find_files → grep → read
    const calls: ToolCallLog[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      calls.push(tc({ toolName: "find_files", turnNumber: turn, timestamp: turn * 1000 }));
      calls.push(tc({ toolName: "grep", turnNumber: turn, timestamp: turn * 1000 + 1 }));
      calls.push(tc({ toolName: "read", turnNumber: turn, timestamp: turn * 1000 + 2 }));
    }

    const candidates = detectSequentialToolChains(calls, []);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("sequential_tool_chains");
    expect(candidates[0]!.frequency).toBeGreaterThanOrEqual(5);
  });

  it("should not detect patterns with fewer than 5 repetitions", () => {
    const calls: ToolCallLog[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      calls.push(tc({ toolName: "find_files", turnNumber: turn }));
      calls.push(tc({ toolName: "grep", turnNumber: turn }));
      calls.push(tc({ toolName: "read", turnNumber: turn }));
    }

    const candidates = detectSequentialToolChains(calls, []);
    expect(candidates.length).toBe(0);
  });

  it("should not detect with too few calls", () => {
    const calls = [tc({ toolName: "find_files" }), tc({ toolName: "grep" })];
    const candidates = detectSequentialToolChains(calls, []);
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 2: Repeated Identical Calls ────────────────────────────────────────

describe("Pattern 2: Repeated Identical Calls", () => {
  it("should detect tool called 10+ times", () => {
    const calls: ToolCallLog[] = [];
    for (let i = 0; i < 15; i++) {
      calls.push(tc({ toolName: "github-mcp_get_file_contents", taskId: "T-004" }));
    }

    const candidates = detectRepeatedIdenticalCalls(calls);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("repeated_identical_calls");
    expect(candidates[0]!.frequency).toBe(15);
    expect(candidates[0]!.priority).toBe("P1");
  });

  it("should not detect tool called fewer than 10 times", () => {
    const calls: ToolCallLog[] = [];
    for (let i = 0; i < 9; i++) {
      calls.push(tc({ toolName: "read" }));
    }

    const candidates = detectRepeatedIdenticalCalls(calls);
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 3: High-Cost Single Turns ─────────────────────────────────────────

describe("Pattern 3: High-Cost Single Turns", () => {
  it("should detect turns exceeding 10K tokens", () => {
    const entries: TokenLedgerEntry[] = [
      tle({ input: 11200, output: 3300, total: 14500, taskId: "T-007", agentId: "boomerang-coder" }),
    ];

    const candidates = detectHighCostTurns(entries);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("high_cost_single_turns");
    expect(candidates[0]!.estimatedTokenSavings).toBeGreaterThan(0);
  });

  it("should not detect turns below 10K tokens", () => {
    const entries: TokenLedgerEntry[] = [
      tle({ input: 5000, output: 2000, total: 7000 }),
    ];

    const candidates = detectHighCostTurns(entries);
    expect(candidates.length).toBe(0);
  });

  it("should suggest output splitting for output-heavy turns", () => {
    const entries: TokenLedgerEntry[] = [
      tle({ input: 5000, output: 8000, total: 13000 }),
    ];

    const candidates = detectHighCostTurns(entries);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.suggestedFix.toLowerCase()).toContain("split");
  });
});

// ─── Pattern 4: Long Card Retries ──────────────────────────────────────────────

describe("Pattern 4: Long Card Retries", () => {
  it("should detect cards with 3+ attempts", () => {
    const cardHistories: CardAttemptHistory[] = [
      {
        cardId: "T-007",
        attemptCount: 5,
        totalTokensSpent: 187000,
        attempts: [
          { attemptNumber: 1, worker: "coder", timestamp: Date.now(), result: "failure", tokensSpent: 40000, summary: "token format error" },
          { attemptNumber: 2, worker: "coder", timestamp: Date.now(), result: "failure", tokensSpent: 35000, summary: "redirect URI mismatch" },
          { attemptNumber: 3, worker: "coder", timestamp: Date.now(), result: "blocked", tokensSpent: 52000, summary: "scope definition error" },
          { attemptNumber: 4, worker: "coder", timestamp: Date.now(), result: "failure", tokensSpent: 30000, summary: "token format error" },
          { attemptNumber: 5, worker: "coder", timestamp: Date.now(), result: "success", tokensSpent: 30000, summary: "implemented" },
        ],
      },
    ];

    const candidates = detectLongCardRetries(cardHistories);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("long_card_retries");
    expect(candidates[0]!.priority).toBe("P1");
    // 75% savings estimate
    expect(candidates[0]!.estimatedTokenSavings).toBe(Math.round(187000 * 0.75));
  });

  it("should not detect cards with fewer than 3 attempts", () => {
    const cardHistories: CardAttemptHistory[] = [
      {
        cardId: "T-001",
        attemptCount: 2,
        totalTokensSpent: 50000,
        attempts: [
          { attemptNumber: 1, worker: "coder", timestamp: Date.now(), result: "failure", tokensSpent: 25000, summary: "error" },
          { attemptNumber: 2, worker: "coder", timestamp: Date.now(), result: "success", tokensSpent: 25000, summary: "ok" },
        ],
      },
    ];

    const candidates = detectLongCardRetries(cardHistories);
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 5: Re-Reading Same Files ───────────────────────────────────────────

describe("Pattern 5: Re-Reading Same Files", () => {
  it("should detect file read 3+ times", () => {
    const calls: ToolCallLog[] = [
      tc({ toolName: "read", filePath: "AGENTS.md", agentId: "architect", tokensUsed: 1200 }),
      tc({ toolName: "read", filePath: "AGENTS.md", agentId: "coder", tokensUsed: 1200 }),
      tc({ toolName: "read", filePath: "AGENTS.md", agentId: "tester", tokensUsed: 1200 }),
      tc({ toolName: "read", filePath: "types.ts", agentId: "coder", tokensUsed: 800 }),
    ];

    const candidates = detectReReadingSameFiles(calls);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("re_reading_same_files");
    expect(candidates[0]!.evidence.filePaths).toContain("AGENTS.md");
    expect(candidates[0]!.priority).toBe("P2");
  });

  it("should not detect file read fewer than 3 times", () => {
    const calls: ToolCallLog[] = [
      tc({ toolName: "read", filePath: "types.ts", tokensUsed: 800 }),
      tc({ toolName: "read", filePath: "types.ts", tokensUsed: 800 }),
    ];

    const candidates = detectReReadingSameFiles(calls);
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 6: Missed Parallel Opportunities ───────────────────────────────────

describe("Pattern 6: Missed Parallel Opportunities", () => {
  it("should detect independent parallel reads across turns", () => {
    const calls: ToolCallLog[] = [];
    // 3 turns, each with 2 independent reads
    for (let turn = 1; turn <= 3; turn++) {
      calls.push(tc({ toolName: "read", filePath: `file${turn}a.ts`, turnNumber: turn, tokensUsed: 1200 }));
      calls.push(tc({ toolName: "read", filePath: `file${turn}b.ts`, turnNumber: turn, tokensUsed: 1200 }));
    }

    const candidates = detectMissedParallelOpportunities(calls);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("missed_parallel_opportunities");
  });

  it("should not detect with fewer than 2 missed opportunities", () => {
    const calls: ToolCallLog[] = [
      tc({ toolName: "read", filePath: "a.ts", turnNumber: 1 }),
      tc({ toolName: "read", filePath: "b.ts", turnNumber: 1 }),
    ];

    const candidates = detectMissedParallelOpportunities(calls);
    // Only 1 turn with parallel reads, need >= 2
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 7: Manual Aggregation ─────────────────────────────────────────────

describe("Pattern 7: Manual Aggregation", () => {
  it("should detect tasks with 3+ dispatches and high tokens", () => {
    const dispatches: DispatchLog[] = [
      { id: "d1", timestamp: Date.now(), agentRole: "researcher", taskId: "T-006", success: true, outputTokens: 2000 },
      { id: "d2", timestamp: Date.now(), agentRole: "researcher", taskId: "T-006", success: true, outputTokens: 2000 },
      { id: "d3", timestamp: Date.now(), agentRole: "researcher", taskId: "T-006", success: true, outputTokens: 2000 },
      { id: "d4", timestamp: Date.now(), agentRole: "researcher", taskId: "T-006", success: true, outputTokens: 2000 },
    ];

    const entries: TokenLedgerEntry[] = [
      tle({ model: "deepseek-v4-pro", total: 18000, taskId: "T-006" }),
      tle({ model: "deepseek-v4-pro", total: 8000, taskId: "T-006" }),
    ];

    const candidates = detectManualAggregation(dispatches, entries);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("manual_aggregation");
  });

  it("should not detect with fewer than 3 dispatches", () => {
    const dispatches: DispatchLog[] = [
      { id: "d1", timestamp: Date.now(), agentRole: "researcher", taskId: "T-001", success: true },
      { id: "d2", timestamp: Date.now(), agentRole: "researcher", taskId: "T-001", success: true },
    ];

    const candidates = detectManualAggregation(dispatches, []);
    expect(candidates.length).toBe(0);
  });
});

// ─── Pattern 8: Error-and-Retry Loops ───────────────────────────────────────────

describe("Pattern 8: Error-and-Retry Loops", () => {
  it("should detect tool errored 3+ times", () => {
    const calls: ToolCallLog[] = [
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout after 30s", tokensUsed: 500 }),
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout after 30s", tokensUsed: 500 }),
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout after 30s", tokensUsed: 500 }),
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout after 30s", tokensUsed: 500 }),
    ];

    const candidates = detectErrorRetryLoops(calls);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.patternType).toBe("error_retry_loops");
    expect(candidates[0]!.priority).toBe("P1");
  });

  it("should not detect with fewer than 3 errors", () => {
    const calls: ToolCallLog[] = [
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "timeout" }),
      tc({ toolName: "searxng_web_search", isError: true, errorMessage: "timeout" }),
    ];

    const candidates = detectErrorRetryLoops(calls);
    expect(candidates.length).toBe(0);
  });
});

// ─── runAllPatternDetectors ────────────────────────────────────────────────────

describe("runAllPatternDetectors", () => {
  it("should return candidates from all pattern types when data matches", () => {
    const calls: ToolCallLog[] = [];
    // Enough for repeated identical calls (10+)
    for (let i = 0; i < 12; i++) {
      calls.push(tc({ toolName: "read", filePath: "/some/file.ts", tokensUsed: 800, turnNumber: Math.floor(i / 3) + 1 }));
    }
    // Add 4 error calls
    for (let i = 0; i < 4; i++) {
      calls.push(tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout" }));
    }

    const entries: TokenLedgerEntry[] = [
      tle({ input: 11200, output: 3300, total: 14500, taskId: "T-007" }), // High-cost turn
    ];

    const result = runAllPatternDetectors({
      toolCalls: calls,
      tokenEntries: entries,
      cardHistories: [],
      dispatchLogs: [],
    });

    expect(result.length).toBeGreaterThan(0);
    // Should have at least repeated_identical_calls, error_retry_loops, high_cost_turns, re_reading_same_files
    const patternTypes = new Set(result.map((c) => c.patternType));
    expect(patternTypes.has("repeated_identical_calls")).toBe(true);
    expect(patternTypes.has("error_retry_loops")).toBe(true);
    expect(patternTypes.has("high_cost_single_turns")).toBe(true);
  });

  it("should return empty array when no patterns match", () => {
    const result = runAllPatternDetectors({
      toolCalls: [],
      tokenEntries: [],
      cardHistories: [],
      dispatchLogs: [],
    });
    expect(result).toEqual([]);
  });
});

// ─── OpportunityDetector ────────────────────────────────────────────────────────

describe("OpportunityDetector", () => {
  it("should check trigger conditions correctly", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    // Manual trigger always passes
    expect(detector.checkTriggers({
      sessionDurationMs: 0,
      sessionTotalTokens: 0,
      sessionLlmCalls: 0,
      isEndOfWrapUp: false,
      isManual: true,
    })).toBe(true);

    // End-of-wrap-up always passes
    expect(detector.checkTriggers({
      sessionDurationMs: 0,
      sessionTotalTokens: 0,
      sessionLlmCalls: 0,
      isEndOfWrapUp: true,
      isManual: false,
    })).toBe(true);

    // No condition met
    expect(detector.checkTriggers({
      sessionDurationMs: 0,
      sessionTotalTokens: 0,
      sessionLlmCalls: 0,
      isEndOfWrapUp: false,
      isManual: false,
    })).toBe(false);

    // Duration threshold met (2 hours = 7200000ms)
    expect(detector.checkTriggers({
      sessionDurationMs: 7200001,
      sessionTotalTokens: 0,
      sessionLlmCalls: 0,
      isEndOfWrapUp: false,
      isManual: false,
    })).toBe(true);

    // Token threshold met (200K)
    expect(detector.checkTriggers({
      sessionDurationMs: 0,
      sessionTotalTokens: 201000,
      sessionLlmCalls: 0,
      isEndOfWrapUp: false,
      isManual: false,
    })).toBe(true);

    // Call threshold met (50)
    expect(detector.checkTriggers({
      sessionDurationMs: 0,
      sessionTotalTokens: 0,
      sessionLlmCalls: 51,
      isEndOfWrapUp: false,
      isManual: false,
    })).toBe(true);
  });

  it("should rank candidates by score descending", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    const candidates: Candidate[] = [
      { patternType: "error_retry_loops", description: "test", suggestedFix: "fix", estimatedTokenSavings: 1000, frequency: 2, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: {} },
      { patternType: "re_reading_same_files", description: "test2", suggestedFix: "fix2", estimatedTokenSavings: 5000, frequency: 1, buildEffort: "0.25 day", priority: "P2", scopeAllProjects: false, evidence: {} },
      { patternType: "repeated_identical_calls", description: "test3", suggestedFix: "fix3", estimatedTokenSavings: 10000, frequency: 3, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: {} },
    ];

    const ranked = detector.rankCandidates(candidates);
    // Score = estimatedTokenSavings × frequency × scopeMultiplier
    // #3: 10000 × 3 × 1.5 = 45000 (highest)
    // #2: 5000 × 1 × 1.0 = 5000
    // #1: 1000 × 2 × 1.5 = 3000
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.patternType).toBe("repeated_identical_calls");
    expect(ranked[0]!.score).toBe(45000);
    expect(ranked[1]!.patternType).toBe("re_reading_same_files");
    expect(ranked[2]!.patternType).toBe("error_retry_loops");
  });

  it("should silence pattern types", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [tc({ toolName: "searxng_web_search", isError: true, errorMessage: "timeout" }),
                     tc({ toolName: "searxng_web_search", isError: true, errorMessage: "timeout" }),
                     tc({ toolName: "searxng_web_search", isError: true, errorMessage: "timeout" })],
      cardHistories: [],
      dispatchLogs: [],
    });

    detector.silencePattern("error_retry_loops");
    const ranked = detector.scanAndRank();
    // Error retry loops should be silenced
    expect(ranked.every((c) => c.patternType !== "error_retry_loops")).toBe(true);
  });

  it("should generate negative report when no candidates", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    const report = detector.generateNegativeReport();
    expect(report).toContain("No new opportunities detected");
  });

  it("should refresh cached results", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    expect(detector.hasScanned).toBe(false);
    detector.scanAndRank();
    expect(detector.hasScanned).toBe(true);
    expect(detector.lastScanTime).toBeGreaterThan(0);

    detector.refresh();
    // After refresh, cached results are cleared; getTopCandidates will re-scan
    const top = detector.getTopCandidates(2);
    expect(top.length).toBeLessThanOrEqual(2);
  });

  it("should respect maxCandidates option", () => {
    const calls: ToolCallLog[] = [];
    for (let i = 0; i < 12; i++) {
      calls.push(tc({ toolName: "read", filePath: "/some/file.ts", tokensUsed: 800 }));
    }
    for (let i = 0; i < 4; i++) {
      calls.push(tc({ toolName: "searxng_web_search", isError: true, errorMessage: "Connection timeout" }));
    }

    const detector = new OpportunityDetector({
      toolCallLogs: calls,
      cardHistories: [],
      dispatchLogs: [],
      maxCandidates: 2,
    });

    const top = detector.getTopCandidates(2);
    expect(top.length).toBeLessThanOrEqual(2);
  });
});

// ─── OpportunityPrompter ────────────────────────────────────────────────────────

describe("OpportunityPrompter", () => {
  const mockCandidates: Candidate[] = [
    { patternType: "repeated_identical_calls", description: "`github-mcp_get_file_contents` called 15 times", suggestedFix: "Create `repo-file-batch-read`", estimatedTokenSavings: 16200, frequency: 15, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: { totalCalls: 15 } },
    { patternType: "error_retry_loops", description: "`searxng_web_search` errored 4 times", suggestedFix: "Create `retry-with-backoff`", estimatedTokenSavings: 1500, frequency: 4, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: { totalCalls: 4 } },
  ];

  const mockRanked: ReturnType<typeof OpportunityDetector.prototype.rankCandidates> = mockCandidates.map((c, i) => ({
    ...c,
    score: c.estimatedTokenSavings * c.frequency * (c.scopeAllProjects ? 1.5 : 1.0),
    rank: i + 1,
  }));

  it("should format opportunity prompt with top candidates", () => {
    const result = formatOpportunityPrompt(mockRanked, 3);
    expect(result.candidateCount).toBe(2);
    expect(result.prompt).toContain("Opportunity Detected");
    expect(result.prompt).toContain("[Y]");
    expect(result.prompt).toContain("[N]");
    expect(result.prompt).toContain("[L]");
    expect(result.prompt).toContain("[S]");
    expect(result.topCandidate).not.toBeNull();
  });

  it("should return negative message when no candidates", () => {
    const result = formatOpportunityPrompt([]);
    expect(result.candidateCount).toBe(0);
    expect(result.prompt).toContain("No new opportunities detected");
    expect(result.topCandidate).toBeNull();
  });

  it("should format detailed breakdown", () => {
    const candidate = mockRanked[0]!;
    const breakdown = formatDetailedBreakdown(candidate);
    expect(breakdown).toContain("Detailed Breakdown");
    expect(breakdown).toContain(candidate.description);
    expect(breakdown).toContain(candidate.suggestedFix);
    expect(breakdown).toContain(candidate.priority);
    expect(breakdown).toContain(candidate.score.toFixed(1));
  });

  it("should draft a T-NNN card", () => {
    const candidate = mockRanked[0]!;
    const card = draftCard(candidate, 34);
    expect(card).toContain("T-034");
    expect(card).toContain("skill-creation");
    expect(card).toContain("ready");
    expect(card).toContain("boomerang-agent-builder");
    expect(card).toContain("Pattern Detected");
    expect(card).toContain("Proposed Skill/Script");
  });
});

// ─── /opportunities Command Handler ────────────────────────────────────────────

describe("/opportunities command handler", () => {
  it("should show top candidates for bare /opportunities", () => {
    const candidates: Candidate[] = [
      { patternType: "error_retry_loops", description: "test", suggestedFix: "fix", estimatedTokenSavings: 5000, frequency: 3, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: {} },
    ];

    // Simulate ranked
    const ranked = candidates.map((c, i) => ({
      ...c,
      score: c.estimatedTokenSavings * c.frequency * (c.scopeAllProjects ? 1.5 : 1.0),
      rank: i + 1,
    }));

    const result = handleOpportunitiesCommand(ranked, "");
    expect(result.command).toBe("opportunities");
    expect(result.message).toContain("Opportunity Detected");
  });

  it("should show all candidates for /opportunities list", () => {
    const ranked = [
      { patternType: "error_retry_loops" as const, description: "err", suggestedFix: "fix1", estimatedTokenSavings: 5000, frequency: 3, buildEffort: "0.25 day", priority: "P1" as const, scopeAllProjects: true, evidence: {}, score: 22500, rank: 1 },
      { patternType: "re_reading_same_files" as const, description: "rer", suggestedFix: "fix2", estimatedTokenSavings: 3000, frequency: 5, buildEffort: "0.25 day", priority: "P2" as const, scopeAllProjects: false, evidence: {}, score: 15000, rank: 2 },
    ];

    const result = handleOpportunitiesCommand(ranked, "list");
    expect(result.message).toContain("All opportunities");
    expect(result.message).toContain("2");
  });

  it("should show refresh message for --refresh", () => {
    const result = handleOpportunitiesCommand([], "--refresh");
    expect(result.message).toContain("Re-scanning");
  });

  it("should show no opportunities message when empty", () => {
    const result = handleOpportunitiesCommand([], "list");
    expect(result.message).toContain("No opportunities detected");
  });
});

// ─── Ranking Formula ──────────────────────────────────────────────────────────

describe("Ranking Formula", () => {
  it("should score scope all projects at 1.5x", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    const local: Candidate = {
      patternType: "re_reading_same_files",
      description: "test",
      suggestedFix: "cache",
      estimatedTokenSavings: 10000,
      frequency: 5,
      buildEffort: "0.25 day",
      priority: "P2",
      scopeAllProjects: false,
      evidence: {},
    };

    const global: Candidate = {
      patternType: "repeated_identical_calls",
      description: "test",
      suggestedFix: "batch",
      estimatedTokenSavings: 10000,
      frequency: 5,
      buildEffort: "0.25 day",
      priority: "P1",
      scopeAllProjects: true,
      evidence: {},
    };

    const ranked = detector.rankCandidates([local, global]);
    // Global should rank higher: 10000 × 5 × 1.5 = 75000 > 10000 × 5 × 1.0 = 50000
    expect(ranked[0]!.patternType).toBe("repeated_identical_calls");
    expect(ranked[0]!.score).toBe(75000);
    expect(ranked[1]!.score).toBe(50000);
  });

  it("should assign rank 1 to highest score", () => {
    const detector = new OpportunityDetector({
      toolCallLogs: [],
      cardHistories: [],
      dispatchLogs: [],
    });

    const candidates: Candidate[] = [
      { patternType: "error_retry_loops", description: "low", suggestedFix: "f", estimatedTokenSavings: 100, frequency: 1, buildEffort: "0.25 day", priority: "P2", scopeAllProjects: false, evidence: {} },
      { patternType: "repeated_identical_calls", description: "high", suggestedFix: "f", estimatedTokenSavings: 5000, frequency: 10, buildEffort: "0.25 day", priority: "P1", scopeAllProjects: true, evidence: {} },
    ];

    const ranked = detector.rankCandidates(candidates);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.patternType).toBe("repeated_identical_calls");
  });
});

// ─── PATTERN_LABELS Completeness ──────────────────────────────────────────────

describe("PATTERN_LABELS completeness", () => {
  it("should have labels for all 8 pattern types", () => {
    const patternTypes = [
      "sequential_tool_chains",
      "repeated_identical_calls",
      "high_cost_single_turns",
      "long_card_retries",
      "re_reading_same_files",
      "missed_parallel_opportunities",
      "manual_aggregation",
      "error_retry_loops",
    ];

    for (const pt of patternTypes) {
      expect(PATTERN_LABELS[pt as keyof typeof PATTERN_LABELS]).toBeDefined();
      expect(PATTERN_LABELS[pt as keyof typeof PATTERN_LABELS].length).toBeGreaterThan(0);
    }
  });
});