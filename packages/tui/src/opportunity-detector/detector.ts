/**
 * OpportunityDetector — Orchestrator for T-034 (P1-c, Addendum 1).
 *
 * Runs all 8 pattern detectors, ranks candidates, and provides
 * trigger condition checking. NO auto-action — user opt-in only.
 *
 * T-085: Extended with saveCache/restoreCache/getCachedCandidates
 * for offline opportunity cache persistence.
 */

import type { TokenCounter } from "../observability/token-counter.js";
import {
  runAllPatternDetectors,
  type PatternDetectorInput,
} from "./patterns.js";
import type {
  Candidate,
  CandidateBase,
  RankedCandidate,
  ToolCallLog,
  CardAttemptHistory,
  DispatchLog,
  TriggerConditions,
  SilencedPattern,
  ConsideredCandidate,
  CachedCandidate,
  CachedCandidatesResult,
  OpportunityDetectorOptions,
} from "./types.js";
import { DEFAULT_TRIGGER_THRESHOLDS } from "./types.js";

// ─── Offline Flag (T-085, stub for T-081) ──────────────────────────────────────

/**
 * Whether the system is in offline mode.
 * When true, /opportunities auto-routes to cached results.
 * T-081 will wire this to the actual offline detection.
 */
export let isOffline = false;

/** Set offline mode (for T-081 to wire). */
export function setOffline(value: boolean): void {
  isOffline = value;
}

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

// ─── Opportunity Cache Persistence (T-085) ──────────────────────────────────────

/**
 * NeuralgenticsClient-like interface for cache persistence.
 * Only requires the `call` method for memory operations.
 */
interface CacheClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Save current opportunity candidates to the opportunity_cache in memory.
 *
 * @param candidates - The candidates to cache (from scanAndRank or runAllPatterns).
 * @param client - NeuralgenticsClient for memory persistence.
 * @returns Array of memory IDs for the stored cache entries.
 */
export async function saveCache(
  candidates: Candidate[],
  client: CacheClient,
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const ids: string[] = [];

  for (const candidate of candidates) {
    try {
      const result = await client.call("memory.add", {
        content: JSON.stringify(candidate),
        sourceType: "opportunity_cache",
        metadata: {
          type: "opportunity_cache",
          patternType: candidate.patternType,
          sessionId: candidate.sessionId,
          timestamp: candidate.timestamp,
          priority: candidate.priority,
          estimatedTokenSavings: candidate.estimatedTokenSavings,
          frequency: candidate.frequency,
        },
      }) as { id: string };

      ids.push(result.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[opportunity-detector] Failed to save cache entry: ${msg}`);
    }
  }

  console.log(`[opportunity-detector] Saved ${ids.length} opportunity cache entries`);
  return ids;
}

/**
 * Restore opportunity candidates from the opportunity_cache in memory.
 *
 * @param client - NeuralgenticsClient for memory persistence.
 * @returns Array of cached candidates (without stale flag).
 */
export async function restoreCache(
  client: CacheClient,
): Promise<Candidate[]> {
  try {
    const results = await client.call("memory.queryBySourceType", {
      sourceType: "opportunity_cache",
      limit: 50,
      sortBy: "createdAt",
      sortOrder: "DESC",
    }) as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return [];
    }

    const candidates: Candidate[] = [];

    for (const entry of results) {
      const content = typeof entry.content === "string"
        ? entry.content
        : JSON.stringify(entry.content ?? entry);

      try {
        const parsed = JSON.parse(content) as Candidate;

        // Validate required fields
        if (
          typeof parsed.patternType === "string" &&
          typeof parsed.description === "string" &&
          typeof parsed.timestamp === "string" &&
          typeof parsed.sessionId === "string"
        ) {
          candidates.push(parsed);
        }
      } catch {
        // Skip corrupted entries
        console.warn(`[opportunity-detector] Skipping corrupted cache entry: ${(entry.id as string ?? "unknown").slice(0, 8)}`);
      }
    }

    console.log(`[opportunity-detector] Restored ${candidates.length} opportunity cache entries`);
    return candidates;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[opportunity-detector] Failed to restore cache: ${msg}`);
    return [];
  }
}

/**
 * Get cached candidates with staleness information.
 *
 * @param client - NeuralgenticsClient for memory persistence.
 * @param maxAgeDays - Maximum age in days before filtering out (default 7). 0 = no filter.
 * @returns Cached candidates result with staleness metadata.
 */
export async function getCachedCandidates(
  client: CacheClient,
  maxAgeDays: number = 7,
): Promise<CachedCandidatesResult> {
  const candidates = await restoreCache(client);

  if (candidates.length === 0) {
    return {
      candidates: [],
      totalEntries: 0,
      cacheEmpty: true,
    };
  }

  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : Infinity;
  const now = Date.now();

  const cached: CachedCandidate[] = candidates
    .map((c) => {
      const cachedAt = c.timestamp; // Use candidate timestamp as cache time
      const timestampMs = new Date(c.timestamp).getTime();
      const ageMs = now - timestampMs;
      const stale = ageMs > SEVEN_DAYS_MS;

      // Filter by max age if specified
      if (maxAgeDays > 0 && ageMs > maxAgeMs) {
        return null; // Too old, filter out
      }

      return {
        ...c,
        cachedAt,
        stale,
      } as CachedCandidate;
    })
    .filter((c): c is CachedCandidate => c !== null);

  return {
    candidates: cached,
    totalEntries: candidates.length,
    cacheEmpty: false,
  };
}