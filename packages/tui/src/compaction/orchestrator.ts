/**
 * Compaction Orchestrator (T-026)
 *
 * Main compaction loop: monitor → filter → extract (gemma4:31b) →
 * write to neuralgentics → revert session → reseed
 *
 * Key behaviors:
 * - 75% threshold auto-compaction (monitors token count)
 * - Manual `/compact` command
 * - Mutex lock: double-/compact is rejected
 * - Mid-prompt compaction is queued (doesn't interrupt streaming)
 * - gemma4:31b unavailable → disable compaction with warning, don't crash
 * - ≥10:1 token savings ratio (extract aggressively)
 */

import { filterMessages, estimateMessageTokens } from "./filter.js";
import { extractFacts } from "./extractor.js";
import { writeFactsToMemory, queryExtractedFacts, writeCheckpoint } from "./writer.js";
import { TokenMonitor } from "./monitor.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
  type CompactionResult,
  type CompactionStatus,
  type CompactionEvents,
  type CompactionDependencies,
} from "./types.js";

// ─── Event listener types ────────────────────────────────────────────────────────

type StatusListener = (status: CompactionStatus) => void;
type CompactionCompleteListener = (result: CompactionResult) => void;
type ErrorListener = (error: Error) => void;
type ThresholdListener = (tokenPercent: number) => void;

// ─── Compaction Orchestrator ────────────────────────────────────────────────────

/**
 * CompactionOrchestrator — coordinates the compaction pipeline.
 *
 * Usage:
 * ```ts
 * const orchestrator = new CompactionOrchestrator(deps, config);
 * orchestrator.on('compactionComplete', (result) => { ... });
 *
 * // Auto-compaction check (call after each prompt exchange)
 * await orchestrator.checkAndCompact();
 *
 * // Manual /compact
 * const result = await orchestrator.compact();
 *
 * // Query stored facts
 * const facts = await orchestrator.queryFacts("project decisions");
 * ```
 */
export class CompactionOrchestrator {
  private readonly config: CompactionConfig;
  private readonly deps: CompactionDependencies;
  private readonly monitor: TokenMonitor;

  // ─── Mutex & Queue ──────────────────────────────────────────────────────
  /** Whether a compaction is currently in progress (fast-reject guard). */
  private compacting = false;
  /** Promise-chain for async-serialized access to the compaction critical section. */
  private compactionLock: Promise<void> = Promise.resolve();
  private queued = false;

  // ─── Model availability ─────────────────────────────────────────────────
  private modelAvailable: boolean | null = null; // null = not checked yet

  // ─── Event listeners ────────────────────────────────────────────────────
  private statusListeners: StatusListener[] = [];
  private compactionCompleteListeners: CompactionCompleteListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private thresholdListeners: ThresholdListener[] = [];

  // ─── Compaction count ───────────────────────────────────────────────────
  private compactionCount = 0;

  constructor(deps: CompactionDependencies, config?: Partial<CompactionConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this.monitor = new TokenMonitor(this.config);
  }

  // ─── Public Properties ──────────────────────────────────────────────────

  /** Current compaction status. */
  get status(): CompactionStatus {
    return this.monitor.status;
  }

  /** Number of completed compaction cycles. */
  get compactCount(): number {
    return this.compactionCount;
  }

  /** Current token usage. */
  get tokensUsed(): number {
    return this.monitor.tokensUsed;
  }

  /** Token limit. */
  get tokensLimit(): number {
    return this.monitor.tokensLimit;
  }

  /** Current usage as a fraction (0-1). */
  get usagePercent(): number {
    return this.monitor.usagePercent;
  }

  /** Whether compaction is currently in progress. */
  get isCompacting(): boolean {
    return this.compacting;
  }

  /** Whether auto-compaction is enabled (model must be available). */
  get isAutoEnabled(): boolean {
    return this.config.autoCompactEnabled && this.monitor.isEnabled;
  }

  // ─── Event Subscription ─────────────────────────────────────────────────

  /**
   * Register event listeners for compaction lifecycle events.
   */
  on(
    event: keyof CompactionEvents,
    listener: (...args: unknown[]) => void,
  ): this {
    switch (event) {
      case "statusChange":
        this.statusListeners.push(listener as StatusListener);
        break;
      case "compactionComplete":
        this.compactionCompleteListeners.push(listener as CompactionCompleteListener);
        break;
      case "error":
        this.errorListeners.push(listener as ErrorListener);
        break;
      case "thresholdReached":
        this.thresholdListeners.push(listener as ThresholdListener);
        break;
    }
    return this;
  }

  // ─── Model Availability ─────────────────────────────────────────────────

  /**
   * Check if the extraction model is available.
   * If unavailable, auto-compaction is disabled with a warning.
   *
   * This should be called at startup and cached. The orchestrator
   * will not crash if the model is unavailable.
   */
  async checkModelAvailability(): Promise<boolean> {
    try {
      const available = await this.deps.isModelAvailable(
        this.config.extractionModelId,
        this.config.extractionProvider,
      );
      this.modelAvailable = available;

      if (!available) {
        console.warn(
          `[compaction] Extraction model ${this.config.extractionModelId} unavailable — ` +
          `auto-compaction disabled. Manual /compact with a custom model still works.`,
        );
        this.monitor.disable();
        this.emitStatusChange("disabled");
      } else {
        this.monitor.enable();
        this.emitStatusChange("monitoring");
      }

      return available;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[compaction] Model availability check failed: ${msg}`);
      this.modelAvailable = false;
      this.monitor.disable();
      this.emitStatusChange("disabled");
      return false;
    }
  }

  // ─── Auto-Compaction Check ──────────────────────────────────────────────

  /**
   * Check if auto-compaction should trigger and do it if needed.
   * Called after each prompt exchange.
   *
   * If the session is mid-prompt (streaming), compaction is queued
   * for after the response completes.
   */
  async checkAndCompact(): Promise<CompactionResult | null> {
    // Update token counts from the session
    const { used, limit } = this.deps.getTokenCount();
    this.monitor.update(used, limit);

    // Check if threshold is reached
    if (!this.monitor.isThresholdReached()) {
      return null;
    }

    // Check if session is mid-prompt (streaming)
    if (this.deps.session.status === "streaming") {
      // Queue compaction for after the response
      if (!this.queued && !this.compacting) {
        this.queued = true;
        const percent = this.monitor.recordThresholdHit();
        console.log(
          `[compaction] Threshold reached (${(percent * 100).toFixed(1)}%) — ` +
          `queued (session is streaming)`,
        );
        this.emitThresholdReached(percent);
      }
      return null;
    }

    // Threshold reached, session not streaming — trigger compaction
    if (this.compacting) {
      // Double-/compact rejected
      console.warn("[compaction] Compaction already in progress — request rejected");
      return null;
    }

    const percent = this.monitor.recordThresholdHit();
    this.emitThresholdReached(percent);
    return this.compact();
  }

  // ─── Promise-based Lock (serialization) ───────────────────────────────

  /**
   * Promise-based mutex that serializes access to a critical section.
   *
   * If a caller is already inside the lock, subsequent callers are queued
   * in order and execute one at a time. This is safe for both sync and
   * async code paths (no race window between check and set).
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.compactionLock;
    let release!: () => void;
    this.compactionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ─── Manual Compaction ─────────────────────────────────────────────────

  /**
   * Trigger a manual compaction cycle (e.g., from /compact command).
   *
   * @returns CompactionResult with stats, or null if compaction was rejected.
   * @throws Error if the extraction model is unavailable.
   */
  async compact(): Promise<CompactionResult | null> {
    // ─── Fast-reject: refuse double-/compact ──────────────────────────────
    if (this.compacting) {
      console.warn("[compaction] Compaction already in progress — double-/compact rejected");
      return null;
    }

    // ─── Set flag BEFORE any await (closes the read-check-write race) ────
    this.compacting = true;
    this.queued = false;
    this.emitStatusChange("compacting");

    // ─── Check model availability (lazy init) ─────────────────────────────
    if (this.modelAvailable === null) {
      await this.checkModelAvailability();
    }

    if (!this.modelAvailable) {
      this.compacting = false;
      this.emitStatusChange("monitoring");
      throw new Error(
        `Extraction model ${this.config.extractionModelId} is unavailable. ` +
        `Auto-compaction is disabled. Fix the model or use /compact with a custom model.`,
      );
    }

    // ─── Execute compaction inside promise-based lock ────────────────────
    // The withLock serializes the actual work for any callers that arrive
    // before the fast-reject flag takes effect (e.g. during the model check
    // await above). Without it, a second caller could see `compacting ===
    // false` and also proceed.
    return this.withLock(async () => {
      const startTime = Date.now();

      try {
        // ─── Step 1: Get messages from session ──────────────────────────────
        const messages = await this.deps.session.messages(
          this.deps.session.sessionId,
        );
        const tokensBefore = estimateMessageTokens(messages);

        // ─── Step 2: Filter messages ────────────────────────────────────────
        const filterResult = filterMessages(messages, this.config.maxFilteredContentChars);

        if (filterResult.extractionText.trim().length === 0) {
          console.log("[compaction] No content to extract after filtering");
          this.emitStatusChange("monitoring");
          return null;
        }

        // ─── Step 3: Extract facts via gemma4:31b ───────────────────────────
        const extractionResult = await extractFacts(
          filterResult.extractionText,
          this.deps.callExtractionModel,
          this.config.extractionModelId,
          this.config.extractionProvider,
          this.config.maxFactsPerCycle,
        );

        // ─── Step 4: Write facts to Neuralgentics ───────────────────────────
        const memoryIds = await writeFactsToMemory(extractionResult.facts, this.deps);

        // ─── Step 5: Revert session ─────────────────────────────────────────
        let reverted = false;
        try {
          await this.deps.session.revert(this.deps.session.sessionId);
          reverted = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[compaction] Session revert failed: ${msg}`);
        }

        // ─── Step 6: Reseed (T-028 stub) ────────────────────────────────────
        let reseeded = false;
        let tokensAfter = tokensBefore;
        if (this.deps.session.sessionId) {
          try {
            const reseedResult = await this.deps.reseed(
              this.deps.neuralgentics,
              this.deps.session.sessionId,
            );
            reseeded = true;
            tokensAfter = reseedResult.totalTokens;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[compaction] Reseed failed: ${msg}`);
            // Estimate: even without reseed, reverting saves most tokens
            tokensAfter = estimateTokensForMemoryIds(memoryIds.length);
          }
        }

        // ─── Calculate savings ratio ────────────────────────────────────────
        const tokensSpentOnCompaction = estimateExtractionCost(filterResult.extractionText);
        const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
        const savingsRatio = tokensSpentOnCompaction > 0
          ? tokensSaved / tokensSpentOnCompaction
          : 0;

        const result: CompactionResult = {
          factsExtracted: extractionResult.facts.length,
          memoryIds,
          tokensBefore,
          tokensAfter,
          savingsRatio,
          reverted,
          reseeded,
          messagesFiltered: filterResult.filteredOut,
          durationMs: Date.now() - startTime,
          checkpointId: null,
        };

        // ─── Step 7: Persist checkpoint (T-079) ──────────────────────────────
        const confidenceScores: Record<string, number> = {};
        for (let i = 0; i < extractionResult.facts.length; i++) {
          if (i < memoryIds.length) {
            confidenceScores[memoryIds[i]] = extractionResult.facts[i].confidence;
          }
        }

        try {
          const checkpointId = await writeCheckpoint({
            sessionId: this.deps.session.sessionId ?? "",
            timestamp: new Date().toISOString(),
            factsExtracted: result.factsExtracted,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            savingsRatio: result.savingsRatio,
            reverted: result.reverted,
            reseeded: result.reseeded,
            confidenceScores,
            extractedMemoryIds: memoryIds,
          }, this.deps);

          result.checkpointId = checkpointId;
          console.log(`[compaction] Checkpoint persisted: ${checkpointId}`);
        } catch (chkErr: unknown) {
          // Checkpoint failure is non-critical — log and continue with null
          const msg = chkErr instanceof Error ? chkErr.message : String(chkErr);
          console.warn(`[compaction] Failed to persist checkpoint: ${msg}`);
        }

        // ─── Update state ──────────────────────────────────────────────────
        this.compactionCount++;
        this.monitor.update(tokensAfter);
        this.monitor.resetAfterCompaction(tokensAfter);
        this.emitStatusChange("monitoring");

        console.log(
          `[compaction] Cycle #${this.compactionCount} complete: ` +
          `${result.factsExtracted} facts, ` +
          `${result.tokensBefore} → ${result.tokensAfter} tokens, ` +
          `${result.savingsRatio.toFixed(1)}:1 savings, ` +
          `${result.durationMs}ms`,
        );

        // ─── Notify listeners ──────────────────────────────────────────────
        for (const listener of this.compactionCompleteListeners) {
          try { listener(result); } catch { /* swallow */ }
        }

        return result;

      } catch (err: unknown) {
        this.emitStatusChange("monitoring");

        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[compaction] Compaction failed: ${error.message}`);

        for (const listener of this.errorListeners) {
          try { listener(error); } catch { /* swallow */ }
        }

        throw error;
      } finally {
        this.compacting = false;
      }
    });
  }

  /**
   * Process a queued compaction (called after a streaming response completes).
   * If a compaction was queued during mid-prompt, this will execute it.
   */
  async processQueued(): Promise<CompactionResult | null> {
    if (!this.queued) {
      return null;
    }

    this.queued = false;
    return this.compact();
  }

  /**
   * Query stored extracted facts from memory.
   */
  async queryFacts(query: string, limit: number = 10): Promise<unknown[]> {
    return queryExtractedFacts(query, this.deps, limit);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private emitStatusChange(status: CompactionStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* swallow */ }
    }
  }

  private emitThresholdReached(percent: number): void {
    for (const listener of this.thresholdListeners) {
      try { listener(percent); } catch { /* swallow */ }
    }
  }
}

// ─── Token Estimation Helpers ────────────────────────────────────────────────────

/**
 * Estimate token cost of the extraction process.
 * Includes the extraction prompt (~50 tokens) and the model's response overhead.
 */
function estimateExtractionCost(extractionText: string): number {
  const promptTokens = 50; // EXTRACTION_PROMPT is ~50 tokens per spec
  const overheadTokens = 200; // LLM processing overhead
  const textTokens = Math.ceil(extractionText.length / 4);
  return promptTokens + textTokens + overheadTokens;
}

/**
 * Estimate post-compaction token count from the number of stored memory IDs.
 * Each memory reference is ~20 tokens in a reseed prompt.
 */
function estimateTokensForMemoryIds(count: number): number {
  // Approximate: each memory ID reference is ~20 tokens in reseed context
  return Math.min(count * 20, 2000); // Capped at ≤2K tokens per T-028
}