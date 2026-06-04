/**
 * Compaction Token Monitor (T-026)
 *
 * Monitors session token usage and triggers auto-compaction
 * when the usage exceeds the configured threshold (default 75%).
 *
 * The monitor is designed to be called periodically (e.g., after each
 * prompt exchange) and checks if the token threshold has been reached.
 */

import type { CompactionConfig, CompactionStatus } from "./types.js";

// ─── Token Monitor ──────────────────────────────────────────────────────────────

/** Internal state for the token monitor. */
interface MonitorState {
  /** Current token usage (estimated). */
  tokensUsed: number;
  /** Maximum token budget. */
  tokensLimit: number;
  /** Number of times the threshold was reached. */
  thresholdHits: number;
  /** Whether a threshold check is currently in progress (debounce). */
  checkInProgress: boolean;
}

/**
 * TokenMonitor — watches session token usage and detects threshold crossings.
 *
 * Usage:
 * ```ts
 * const monitor = new TokenMonitor(0.75);
 * monitor.update(60000, 100000); // 60K of 100K tokens
 * if (monitor.isThresholdReached()) {
 *   // trigger compaction
 * }
 * ```
 */
export class TokenMonitor {
  private readonly config: CompactionConfig;
  private state: MonitorState;
  private _status: CompactionStatus = "idle";

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG_MONITOR, ...config };
    this.state = {
      tokensUsed: 0,
      tokensLimit: 100_000,
      thresholdHits: 0,
      checkInProgress: false,
    };
  }

  /** Current compaction status. */
  get status(): CompactionStatus {
    return this._status;
  }

  /** Current token usage. */
  get tokensUsed(): number {
    return this.state.tokensUsed;
  }

  /** Token limit. */
  get tokensLimit(): number {
    return this.state.tokensLimit;
  }

  /** Current usage as a percentage (0-1). */
  get usagePercent(): number {
    if (this.state.tokensLimit === 0) return 0;
    return this.state.tokensUsed / this.state.tokensLimit;
  }

  /** Number of threshold hits. */
  get thresholdHits(): number {
    return this.state.thresholdHits;
  }

  /**
   * Update the token counts.
   * @param used - Current token usage.
   * @param limit - Maximum token budget.
   */
  update(used: number, limit?: number): void {
    this.state.tokensUsed = used;
    if (limit !== undefined) {
      this.state.tokensLimit = limit;
    }
  }

  /**
   * Check if the token usage has reached the compaction threshold.
   * Does NOT trigger compaction — the orchestrator decides what to do.
   *
   * @returns true if usage percent ≥ threshold.
   */
  isThresholdReached(): boolean {
    return this.usagePercent >= this.config.threshold;
  }

  /**
   * Record a threshold hit and return the current usage percent.
   * Called by the orchestrator when it decides to start compaction.
   */
  recordThresholdHit(): number {
    this.state.thresholdHits++;
    return this.usagePercent;
  }

  /**
   * Reset token counts after a compaction cycle.
   * @param newUsed - New token usage (e.g. after reseed).
   */
  resetAfterCompaction(newUsed: number): void {
    this.state.tokensUsed = newUsed;
    this.state.checkInProgress = false;
  }

  /**
   * Set the monitor status.
   */
  setStatus(status: CompactionStatus): void {
    this._status = status;
  }

  /**
   * Disable monitoring (e.g., when extraction model is unavailable).
   */
  disable(): void {
    this._status = "disabled";
  }

  /**
   * Re-enable monitoring.
   */
  enable(): void {
    this._status = "idle";
  }

  /**
   * Check if monitoring is currently enabled.
   */
  get isEnabled(): boolean {
    return this._status !== "disabled";
  }
}

/** Default config for TokenMonitor (subset used by monitor). */
const DEFAULT_COMPACTION_CONFIG_MONITOR: CompactionConfig = {
  threshold: 0.75,
  extractionModelId: "gemma4:31b",
  extractionProvider: "ollama",
  maxExtractionPromptTokens: 500,
  minSavingsRatio: 10,
  autoCompactEnabled: true,
  maxFactsPerCycle: 50,
  maxFilteredContentChars: 50000,
};