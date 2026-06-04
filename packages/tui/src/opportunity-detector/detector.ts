/**
 * OpportunityDetector — Orchestrator for T-034 (P1-c, Addendum 1).
 *
 * Runs all 8 pattern detectors, ranks candidates, and provides
 * trigger condition checking. NO auto-action — user opt-in only.
 */

import type { TokenCounter } from "../observability/token-counter.js";
import {
  runAllPatternDetectors,
  type PatternDetectorInput,
} from "./patterns.js";
import type {
  Candidate,
  RankedCandidate,
  ToolCallLog,
  CardAttemptHistory,
  DispatchLog,
  TriggerConditions,
  SilencedPattern,
  ConsideredCandidate,
  OpportunityDetectorOptions,
} from "./types.js";
import { DEFAULT_TRIGGER_THRESHOLDS } from "./types.js";

// ─── OpportunityDetector ────────────────────────────────────────────────────────

/**
 * Main entry point for the Opportunity Detector system.
 *
 * Usage:
 * ```ts
 * const detector = new OpportunityDetector({
 *   tokenCounter,
 *   toolCallLogs,
 *   cardHistories,
 *   dispatchLogs,
 * });
 *
 * // Check if triggers are met
 * if (detector.checkTriggers(conditions)) {
 *   const top = detector.getTopCandidates(3);
 *   // ...show to user
 * }
 * ```
 */
export class OpportunityDetector {
  private readonly _tokenCounter: TokenCounter | undefined;
  private readonly _toolCallLogs: ToolCallLog[];
  private readonly _cardHistories: CardAttemptHistory[];
  private readonly _dispatchLogs: DispatchLog[];
  private readonly _triggerThresholds: typeof DEFAULT_TRIGGER_THRESHOLDS;
  private readonly _maxCandidates: number;

  // Session state
  private _silencedPatterns: SilencedPattern[] = [];
  private _consideredCandidates: ConsideredCandidate[] = [];
  private _lastScanTime = 0;
  private _cachedCandidates: RankedCandidate[] | null = null;

  constructor(options: OpportunityDetectorOptions) {
    this._tokenCounter = options.tokenCounter as TokenCounter | undefined;
    this._toolCallLogs = options.toolCallLogs ?? [];
    this._cardHistories = options.cardHistories ?? [];
    this._dispatchLogs = options.dispatchLogs ?? [];
    this._triggerThresholds = {
      ...DEFAULT_TRIGGER_THRESHOLDS,
      ...options.triggerThresholds,
    };
    this._maxCandidates = options.maxCandidates ?? 10;
  }

  // ─── Trigger Checking ───────────────────────────────────────────────────

  /**
   * Check if any trigger conditions are met for running the detector.
   *
   * Per Addendum 1 §4.3:
   * - Session duration > 2 hours
   * - Session tokens > 200K
   * - Session LLM calls > 50
   * - End of wrap-up (always)
   * - Manual /opportunities (always)
   */
  checkTriggers(conditions: TriggerConditions): boolean {
    // Manual trigger always passes
    if (conditions.isManual) return true;

    // End-of-wrap-up always passes
    if (conditions.isEndOfWrapUp) return true;

    // Session duration > threshold
    if (conditions.sessionDurationMs >= this._triggerThresholds.sessionDurationMs) {
      return true;
    }

    // Session tokens > threshold
    if (conditions.sessionTotalTokens >= this._triggerThresholds.sessionTotalTokens) {
      return true;
    }

    // Session LLM calls > threshold
    if (conditions.sessionLlmCalls >= this._triggerThresholds.sessionLlmCalls) {
      return true;
    }

    return false;
  }

  // ─── Pattern Detection ──────────────────────────────────────────────────

  /**
   * Run all 8 pattern detectors against session data.
   * Returns all candidates (before ranking and silencing).
   */
  runAllPatterns(): Candidate[] {
    // Get token entries from counter or use stored data
    const tokenEntries = this._tokenCounter?.entries ?? [];

    const input: PatternDetectorInput = {
      toolCalls: this._toolCallLogs,
      tokenEntries: [...tokenEntries],
      cardHistories: this._cardHistories,
      dispatchLogs: this._dispatchLogs,
    };

    const allCandidates = runAllPatternDetectors(input);
    this._lastScanTime = Date.now();
    return allCandidates;
  }

  /**
   * Run all pattern detectors and rank the results.
   * Filters out silenced patterns and sorts by score (descending).
   */
  scanAndRank(): RankedCandidate[] {
    const raw = this.runAllPatterns();

    // Filter silenced patterns
    const silencedTypes = new Set(
      this._silencedPatterns
        .filter((sp) => Date.now() - sp.silencedAt < 24 * 60 * 60 * 1000) // 24h silence
        .map((sp) => sp.patternType),
    );

    const filtered = raw.filter((c) => !silencedTypes.has(c.patternType));

    // Rank candidates
    const ranked = this.rankCandidates(filtered);

    // Cache the result
    this._cachedCandidates = ranked;
    return ranked;
  }

  // ─── Ranking ────────────────────────────────────────────────────────────

  /**
   * Rank candidates by score using the Addendum 1 §4.5 formula:
   *
   * score = estimatedTokenSavings × frequency × scopeMultiplier
   *
   * Where scopeMultiplier:
   * - 1.5 for "helps all projects"
   * - 1.0 for "helps this project only"
   */
  rankCandidates(candidates: Candidate[]): RankedCandidate[] {
    const scored = candidates.map((c) => {
      const scopeMultiplier = c.scopeAllProjects ? 1.5 : 1.0;
      const score = c.estimatedTokenSavings * c.frequency * scopeMultiplier;
      return { ...c, score } as RankedCandidate;
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Assign ranks
    for (let i = 0; i < scored.length; i++) {
      scored[i]!.rank = i + 1;
    }

    return scored.slice(0, this._maxCandidates);
  }

  /**
   * Get the top N candidates from the last scan.
   * Re-ranks if needed.
   */
  getTopCandidates(n: number): RankedCandidate[] {
    if (this._cachedCandidates === null) {
      this.scanAndRank();
    }
    return (this._cachedCandidates ?? []).slice(0, n);
  }

  // ─── User Actions ──────────────────────────────────────────────────────

  /**
   * Silence a pattern type for this session (user pressed [S]).
   */
  silencePattern(patternType: Candidate["patternType"]): void {
    this._silencedPatterns.push({
      patternType,
      silencedAt: Date.now(),
    });
  }

  /**
   * Mark a candidate as considered/dismissed (user pressed [N]).
   */
  markConsidered(candidate: RankedCandidate, reason: ConsideredCandidate["reason"]): void {
    this._consideredCandidates.push({
      candidate,
      consideredAt: Date.now(),
      reason,
    });
  }

  /**
   * Get all silenced patterns for this session.
   */
  getSilencedPatterns(): SilencedPattern[] {
    return [...this._silencedPatterns];
  }

  /**
   * Get all considered (dismissed) candidates for this session.
   */
  getConsideredCandidates(): ConsideredCandidate[] {
    return [...this._consideredCandidates];
  }

  // ─── Negative Report ────────────────────────────────────────────────────

  /**
   * Generate a negative report when no opportunities are detected.
   * Per §4.3: "No new opportunities detected this session"
   */
  generateNegativeReport(): string {
    const lines = [
      "═══ Opportunity Detector ═══",
      "",
      "No new opportunities detected this session.",
      "",
    ];

    const sessionTotal = this._tokenCounter?.getSessionTotal();
    if (sessionTotal) {
      lines.push(`Session tokens: ${sessionTotal.total.toLocaleString()}`);
      lines.push(`LLM calls: ${this._tokenCounter?.callCount ?? 0}`);
    }

    lines.push(`Patterns scanned: 8`);
    lines.push(`Candidates found: 0`);

    if (this._silencedPatterns.length > 0) {
      lines.push("");
      lines.push(`Silenced patterns: ${this._silencedPatterns.length}`);
    }

    lines.push("═════════════════════════════");
    return lines.join("\n");
  }

  // ─── Accessors ─────────────────────────────────────────────────────────

  /** Get the last scan time (epoch ms). 0 if never scanned. */
  get lastScanTime(): number {
    return this._lastScanTime;
  }

  /** Whether a scan has been performed. */
  get hasScanned(): boolean {
    return this._lastScanTime > 0;
  }

  /** Force a refresh (clears cached results). */
  refresh(): void {
    this._cachedCandidates = null;
  }
}