/**
 * Token Accountant — Per-call token counting, aggregation, and reporting.
 *
 * T-033: Implements per-call token counting (input/output/cached/system),
 * per-task/per-agent/per-model tagging, ledger storage in neuralgentics
 * via `type: "token_audit"`, and formatted reports for `/spend`.
 *
 * NO ENFORCEMENT — visibility only per user decision.
 */

import type { NeuralgenticsClient } from "../neuralgentics-client/client.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Token breakdown for any aggregation dimension. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cached: number;
  system: number;
  total: number;
}

/** A single ledger entry for one LLM API call. */
export interface TokenLedgerEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  taskId?: string;
  agentId?: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  system: number;
  total: number;
}

/** Metadata passed alongside each recordCall(). */
export interface CallMetadata {
  taskId?: string;
  agentId?: string;
  model: string;
}

/** Report types for `/spend` sub-commands. */
export interface CardTokenReport {
  taskId: string;
  breakdown: TokenBreakdown;
  calls: number;
}

export interface ModelTokenReport {
  model: string;
  breakdown: TokenBreakdown;
  calls: number;
}

export interface CompactionSavingsReport {
  tokensBefore: number;
  tokensAfter: number;
  savingsRatio: number;
  compactionCount: number;
}

export interface GrandTotalReport {
  session: TokenBreakdown;
  calls: number;
  startTime: number;
  endTime: number;
  byTask: CardTokenReport[];
  byAgent: CardTokenReport[];
  byModel: ModelTokenReport[];
}

/** A persisted batch of token usage for a session (T-084). */
export interface TokenBatch {
  sessionId: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  totalSpend: number;
  model: string;
  operation: string;
}

/** Options for creating a TokenCounter. */
export interface TokenCounterOptions {
  /** NeuralgenticsClient for storing ledger entries (optional — testing). */
  client?: NeuralgenticsClient;
  /** Session ID for tagging entries. */
  sessionId?: string;
  /** Whether to store each entry in neuralgentics memory (default: true). */
  persistToMemory?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Create an empty breakdown with all zeros. */
function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cached: 0, system: 0, total: 0 };
}

/** Add two breakdowns together. */
function addBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    system: a.system + b.system,
    total: a.total + b.total,
  };
}

/** Format a number with locale-aware thousand separators. */
function fmt(n: number): string {
  return n.toLocaleString();
}

// ─── TokenCounter ───────────────────────────────────────────────────────────────

/**
 * TokenCounter — singleton that tracks token usage across the session.
 *
 * - `recordCall()` logs every LLM API call with token counts and metadata.
 * - Aggregation methods (`getTaskTotal`, `getAgentTotal`, `getModelTotal`,
 *   `getSessionTotal`) provide grouped views.
 * - `getProjectedSessionTotal()` estimates total session tokens based on burn rate.
 * - `reset()` clears all data for a fresh session.
 * - If `persistToMemory` is enabled, each call is stored via NeuralgenticsClient
 *   as `sourceType: "token_audit"`.
 */
export class TokenCounter {
  private readonly _entries: TokenLedgerEntry[] = [];
  private readonly _client: NeuralgenticsClient | undefined;
  private readonly _sessionId: string;
  private readonly _persistToMemory: boolean;
  private readonly _startTime: number;
  private _nextId = 1;

  constructor(options?: TokenCounterOptions) {
    this._client = options?.client;
    this._sessionId = options?.sessionId ?? crypto.randomUUID();
    this._persistToMemory = options?.persistToMemory ?? true;
    this._startTime = Date.now();
  }

  // ─── Recording ──────────────────────────────────────────────────────────

  /**
   * Record a single LLM API call's token usage.
   * Automatically calculates total and stores the entry.
   * If persistToMemory is true, also stores in neuralgentics as token_audit.
   */
  recordCall(
    input: number,
    output: number,
    cached: number,
    system: number,
    metadata: CallMetadata,
  ): TokenLedgerEntry {
    const total = input + output + cached + system;
    const entry: TokenLedgerEntry = {
      id: `tc-${this._nextId++}`,
      timestamp: Date.now(),
      sessionId: this._sessionId,
      taskId: metadata.taskId,
      agentId: metadata.agentId,
      model: metadata.model,
      input,
      output,
      cached,
      system,
      total,
    };

    this._entries.push(entry);

    // Persist to neuralgentics memory (fire-and-forget, non-blocking)
    if (this._persistToMemory && this._client) {
      this._persistEntry(entry).catch((err: unknown) => {
        // Non-critical — log and continue
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[token-counter] Failed to persist entry ${entry.id}: ${msg}`);
      });
    }

    return entry;
  }

  // ─── Aggregation ────────────────────────────────────────────────────────

  /** Total token breakdown for a specific task. */
  getTaskTotal(taskId: string): TokenBreakdown {
    let result = emptyBreakdown();
    for (const entry of this._entries) {
      if (entry.taskId === taskId) {
        result = addBreakdown(result, {
          input: entry.input,
          output: entry.output,
          cached: entry.cached,
          system: entry.system,
          total: entry.total,
        });
      }
    }
    return result;
  }

  /** Total token breakdown for a specific agent. */
  getAgentTotal(agentId: string): TokenBreakdown {
    let result = emptyBreakdown();
    for (const entry of this._entries) {
      if (entry.agentId === agentId) {
        result = addBreakdown(result, {
          input: entry.input,
          output: entry.output,
          cached: entry.cached,
          system: entry.system,
          total: entry.total,
        });
      }
    }
    return result;
  }

  /** Total token breakdown for a specific model. */
  getModelTotal(model: string): TokenBreakdown {
    let result = emptyBreakdown();
    for (const entry of this._entries) {
      if (entry.model === model) {
        result = addBreakdown(result, {
          input: entry.input,
          output: entry.output,
          cached: entry.cached,
          system: entry.system,
          total: entry.total,
        });
      }
    }
    return result;
  }

  /** Total token breakdown for the entire session. */
  getSessionTotal(): TokenBreakdown {
    let result = emptyBreakdown();
    for (const entry of this._entries) {
      result = addBreakdown(result, {
        input: entry.input,
        output: entry.output,
        cached: entry.cached,
        system: entry.system,
        total: entry.total,
      });
    }
    return result;
  }

  /**
   * Project total session tokens based on current burn rate.
   * Returns estimated total tokens if the session continues at the same rate
   * for the same number of turns.
   */
  getProjectedSessionTotal(): number {
    if (this._entries.length === 0) return 0;

    const avgPerCall = this.getSessionTotal().total / this._entries.length;
    // Estimate: double the current call count as a projection
    const projectedCalls = this._entries.length * 2;
    return Math.round(avgPerCall * projectedCalls);
  }

  /**
   * Get total token usage within a time window (for per-cycle accounting).
   * @param sinceTimestamp - Start of the cycle (epoch ms).
   */
  getCycleTotal(sinceTimestamp: number): TokenBreakdown {
    let result = emptyBreakdown();
    for (const entry of this._entries) {
      if (entry.timestamp >= sinceTimestamp) {
        result = addBreakdown(result, {
          input: entry.input,
          output: entry.output,
          cached: entry.cached,
          system: entry.system,
          total: entry.total,
        });
      }
    }
    return result;
  }

  /** Get all ledger entries (for reporting). */
  get entries(): ReadonlyArray<TokenLedgerEntry> {
    return this._entries;
  }

  /** Number of recorded calls. */
  get callCount(): number {
    return this._entries.length;
  }

  /** Session start time (epoch ms). */
  get startTime(): number {
    return this._startTime;
  }

  /** Session ID. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Reset all ledger entries for a new session. */
  reset(): void {
    this._entries.length = 0;
  }

  // ─── Batch Persistence (T-084) ──────────────────────────────────────────

  /**
   * Save the current session's token usage as a batch to neuralgentics memory.
   * Persists with sourceType "token_ledger_batch" for later retrieval.
   * Returns the memory ID of the stored batch, or empty string on failure.
   */
  async saveBatch(): Promise<string> {
    if (!this._client) return "";

    const total = this.getSessionTotal();
    const models = new Set<string>();
    let primaryModel = "";
    for (const entry of this._entries) {
      models.add(entry.model);
    }
    primaryModel = Array.from(models).join(",") || "unknown";

    const batch: TokenBatch = {
      sessionId: this._sessionId,
      timestamp: new Date().toISOString(),
      inputTokens: total.input,
      outputTokens: total.output,
      totalSpend: total.total,
      model: primaryModel,
      operation: "session_batch",
    };

    try {
      const result = await this._client.call("memory.add", {
        content: JSON.stringify(batch),
        sourceType: "token_ledger_batch",
        metadata: {
          type: "token_ledger_batch",
          sessionId: batch.sessionId,
          totalSpend: batch.totalSpend,
          model: batch.model,
          timestamp: batch.timestamp,
        },
      });
      const typed = result as { id?: string };
      return typed.id ?? "";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[token-counter] Failed to save batch: ${msg}`);
      return "";
    }
  }

  /**
   * Restore token counter state from the most recent batch in neuralgentics memory.
   * Queries for the latest "token_ledger_batch" and populates internal state
   * with cumulative totals from previous sessions.
   * Returns true if a batch was restored, false otherwise.
   */
  async restoreBatch(sessionId?: string): Promise<boolean> {
    if (!this._client) return false;

    try {
      const results = await this._client.call("memory.queryBySourceType", {
        sourceType: "token_ledger_batch",
        limit: 1,
        sortBy: "createdAt",
        sortOrder: "DESC",
      }) as Array<Record<string, unknown>>;

      if (!Array.isArray(results) || results.length === 0) {
        return false;
      }

      // Filter by sessionId if provided
      let batch: Record<string, unknown> | undefined;
      if (sessionId) {
        batch = results.find((r) => {
          const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? r);
          try {
            const parsed = JSON.parse(content) as Record<string, unknown>;
            return parsed.sessionId === sessionId;
          } catch { return false; }
        });
      }
      if (!batch) {
        batch = results[0];
      }

      const content = typeof batch!.content === "string"
        ? batch!.content
        : JSON.stringify(batch!.content ?? batch!);

      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Validate required fields
      if (typeof parsed.sessionId !== "string" || typeof parsed.totalSpend !== "number") {
        console.warn("[token-counter] Batch has missing or invalid required fields — ignoring");
        return false;
      }

      // Create a synthetic entry to restore cumulative totals
      const syntheticEntry: TokenLedgerEntry = {
        id: `tc-restore-${this._nextId++}`,
        timestamp: Date.now(),
        sessionId: parsed.sessionId as string,
        model: (parsed.model as string) ?? "unknown",
        input: (parsed.inputTokens as number) ?? 0,
        output: (parsed.outputTokens as number) ?? 0,
        cached: 0,
        system: 0,
        total: (parsed.totalSpend as number) ?? 0,
      };
      this._entries.push(syntheticEntry);

      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[token-counter] Failed to restore batch: ${msg}`);
      return false;
    }
  }

  /**
   * Get previous session batches from neuralgentics memory (T-084).
   * Returns the last N batches for the /spend history command.
   */
  async getHistory(limit: number = 5): Promise<TokenBatch[]> {
    if (!this._client) return [];

    try {
      const results = await this._client.call("memory.queryBySourceType", {
        sourceType: "token_ledger_batch",
        limit,
        sortBy: "createdAt",
        sortOrder: "DESC",
      }) as Array<Record<string, unknown>>;

      if (!Array.isArray(results)) return [];

      const batches: TokenBatch[] = [];
      for (const entry of results) {
        const content = typeof entry.content === "string"
          ? entry.content
          : JSON.stringify(entry.content ?? entry);
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          if (typeof parsed.sessionId === "string" && typeof parsed.totalSpend === "number") {
            batches.push({
              sessionId: parsed.sessionId as string,
              timestamp: (parsed.timestamp as string) ?? "",
              inputTokens: (parsed.inputTokens as number) ?? 0,
              outputTokens: (parsed.outputTokens as number) ?? 0,
              totalSpend: (parsed.totalSpend as number) ?? 0,
              model: (parsed.model as string) ?? "unknown",
              operation: (parsed.operation as string) ?? "session_batch",
            });
          }
        } catch {
          // Skip corrupted entries
        }
      }
      return batches;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[token-counter] Failed to get history: ${msg}`);
      return [];
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /** Persist a ledger entry to neuralgentics memory. */
  private async _persistEntry(entry: TokenLedgerEntry): Promise<void> {
    if (!this._client) return;

    await this._client.call("memory.add", {
      content: JSON.stringify({
        id: entry.id,
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        agentId: entry.agentId,
        model: entry.model,
        input: entry.input,
        output: entry.output,
        cached: entry.cached,
        system: entry.system,
        total: entry.total,
        timestamp: entry.timestamp,
      }),
      sourceType: "token_audit",
      metadata: {
        type: "token_audit",
        sessionId: entry.sessionId,
        taskId: entry.taskId ?? "",
        agentId: entry.agentId ?? "",
        model: entry.model,
        total: entry.total,
        timestamp: entry.timestamp,
      },
    });
  }
}

// ─── TokenReporter ──────────────────────────────────────────────────────────────

/**
 * TokenReporter — generates formatted reports from TokenCounter data.
 *
 * Used by `/spend` command to display token usage breakdowns.
 */
export class TokenReporter {
  private readonly _counter: TokenCounter;

  constructor(counter: TokenCounter) {
    this._counter = counter;
  }

  /** Generate per-card (task) report. */
  generateCardReport(): CardTokenReport[] {
    const taskIds = new Set<string>();
    for (const entry of this._counter.entries) {
      if (entry.taskId) taskIds.add(entry.taskId);
    }

    return Array.from(taskIds).map((taskId) => {
      const breakdown = this._counter.getTaskTotal(taskId);
      const calls = this._counter.entries.filter((e) => e.taskId === taskId).length;
      return { taskId, breakdown, calls };
    });
  }

  /** Generate per-model report. */
  generateModelReport(): ModelTokenReport[] {
    const models = new Set<string>();
    for (const entry of this._counter.entries) {
      models.add(entry.model);
    }

    return Array.from(models).map((model) => {
      const breakdown = this._counter.getModelTotal(model);
      const calls = this._counter.entries.filter((e) => e.model === model).length;
      return { model, breakdown, calls };
    });
  }

  /** Generate compaction savings report (placeholder — uses entry metadata). */
  generateCompactionReport(): CompactionSavingsReport {
    // Compaction savings are tracked by the compaction orchestrator (T-026).
    // This is a placeholder that returns zeros until wired.
    return {
      tokensBefore: 0,
      tokensAfter: 0,
      savingsRatio: 0,
      compactionCount: 0,
    };
  }

  /** Generate grand total report for the session. */
  generateGrandTotal(): GrandTotalReport {
    const entries = this._counter.entries;
    const startTime = entries.length > 0 ? entries[0]!.timestamp : this._counter.startTime;
    const endTime = entries.length > 0 ? entries[entries.length - 1]!.timestamp : Date.now();

    return {
      session: this._counter.getSessionTotal(),
      calls: this._counter.callCount,
      startTime,
      endTime,
      byTask: this.generateCardReport(),
      byAgent: this.generateAgentReport(),
      byModel: this.generateModelReport(),
    };
  }

  /** Generate per-agent report (reuses CardTokenReport structure with agentId). */
  generateAgentReport(): CardTokenReport[] {
    const agentIds = new Set<string>();
    for (const entry of this._counter.entries) {
      if (entry.agentId) agentIds.add(entry.agentId);
    }

    return Array.from(agentIds).map((agentId) => {
      const breakdown = this._counter.getAgentTotal(agentId);
      const calls = this._counter.entries.filter((e) => e.agentId === agentId).length;
      return { taskId: agentId, breakdown, calls };
    });
  }

  // ─── Formatters ──────────────────────────────────────────────────────────

  /** Format a session total as a human-readable string. */
  formatSessionTotal(): string {
    const b = this._counter.getSessionTotal();
    return (
      `Session total: ${fmt(b.total)} tokens ` +
      `(input: ${fmt(b.input)} | output: ${fmt(b.output)} | ` +
      `cached: ${fmt(b.cached)} | system: ${fmt(b.system)})`
    );
  }

  /** Format a per-task breakdown as a table. */
  formatByCard(): string {
    const reports = this.generateCardReport();
    if (reports.length === 0) return "No per-task data yet.";

    const lines = reports.map((r) =>
      `  ${r.taskId}: ${fmt(r.breakdown.total)} tokens ` +
      `(in: ${fmt(r.breakdown.input)} | out: ${fmt(r.breakdown.output)} | ` +
      `cached: ${fmt(r.breakdown.cached)} | system: ${fmt(r.breakdown.system)}) ` +
      `— ${r.calls} calls`,
    );
    return `Per-task breakdown:\n${lines.join("\n")}`;
  }

  /** Format a per-agent breakdown as a table. */
  formatByAgent(): string {
    const reports = this.generateAgentReport();
    if (reports.length === 0) return "No per-agent data yet.";

    const lines = reports.map((r) =>
      `  ${r.taskId}: ${fmt(r.breakdown.total)} tokens ` +
      `(in: ${fmt(r.breakdown.input)} | out: ${fmt(r.breakdown.output)}) ` +
      `— ${r.calls} calls`,
    );
    return `Per-agent breakdown:\n${lines.join("\n")}`;
  }

  /** Format a per-model breakdown as a table. */
  formatByModel(): string {
    const reports = this.generateModelReport();
    if (reports.length === 0) return "No per-model data yet.";

    const lines = reports.map((r) =>
      `  Model ${r.model}: ` +
      `Input: ${fmt(r.breakdown.input)} | Output: ${fmt(r.breakdown.output)} | ` +
      `Cached: ${fmt(r.breakdown.cached)} | System: ${fmt(r.breakdown.system)} | ` +
      `Total: ${fmt(r.breakdown.total)} — ${r.calls} calls`,
    );
    return `Per-model breakdown:\n${lines.join("\n")}`;
  }

  /** Format projected spend as a string. */
  formatProjected(): string {
    const projected = this._counter.getProjectedSessionTotal();
    const current = this._counter.getSessionTotal().total;
    const calls = this._counter.callCount;

    if (calls === 0) {
      return "No calls recorded yet — projection unavailable.";
    }

    const burnRate = Math.round(current / calls);
    return (
      `Projected session total: ~${fmt(projected)} tokens ` +
      `(burn rate: ${fmt(burnRate)}/turn, ${calls} turns so far)`
    );
  }

  /** Format the full wrap-up report matching v4-FINAL §508.3 format. */
  formatReport(): string {
    const grand = this.generateGrandTotal();
    const b = grand.session;
    const durationMs = grand.endTime - grand.startTime;
    const durationMin = Math.round(durationMs / 60000);

    const lines: string[] = [
      "═══ Token Spend Report ═══",
      "",
      `Session: ${this._counter.sessionId}`,
      `Duration: ${durationMin}m | Calls: ${grand.calls}`,
      `Total: ${fmt(b.total)} tokens`,
      `  Input:   ${fmt(b.input)}`,
      `  Output:  ${fmt(b.output)}`,
      `  Cached:  ${fmt(b.cached)}`,
      `  System:  ${fmt(b.system)}`,
      "",
    ];

    if (grand.byModel.length > 0) {
      lines.push("── By Model ──");
      for (const r of grand.byModel) {
        lines.push(`  ${r.model}: ${fmt(r.breakdown.total)} (${r.calls} calls)`);
      }
      lines.push("");
    }

    if (grand.byTask.length > 0) {
      lines.push("── By Task ──");
      for (const r of grand.byTask) {
        lines.push(`  ${r.taskId}: ${fmt(r.breakdown.total)} (${r.calls} calls)`);
      }
      lines.push("");
    }

    if (grand.byAgent.length > 0) {
      lines.push("── By Agent ──");
      for (const r of grand.byAgent) {
        lines.push(`  ${r.taskId}: ${fmt(r.breakdown.total)} (${r.calls} calls)`);
      }
      lines.push("");
    }

    lines.push(`Projected: ${fmt(this._counter.getProjectedSessionTotal())} tokens`);
    lines.push("═══════════════════════════");

    return lines.join("\n");
  }
}

// ─── /spend Command Handler ──────────────────────────────────────────────────────

/** Result of handling the /spend command. */
export interface SpendCommandResult {
  command: string;
  message: string;
  refreshKanban: boolean;
}

/**
 * Handle the `/spend` slash command with sub-commands (T-084: async for /history).
 *
 * Sub-commands:
 * - `/spend`         → session total
 * - `/spend today`   → session total (same as bare /spend, per-session only)
 * - `/spend by-card` → per-task breakdown
 * - `/spend by-agent` → per-agent breakdown
 * - `/spend by-model` → per-model breakdown
 * - `/spend projected` → burn rate estimate
 * - `/spend report`  → full wrap-up report
 * - `/spend history`  → show previous 5 session batches (T-084, async)
 *
 * Note: `/spend history` is async; all other sub-commands are synchronous.
 * If the caller needs history, use handleSpendHistoryCommand() instead.
 */
export function handleSpendCommand(
  counter: TokenCounter,
  input: string,
): SpendCommandResult {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  // First part is "spend", second is the sub-command
  const sub = parts[1]?.toLowerCase() ?? "";

  // /spend history requires async — caller should use handleSpendHistoryCommand instead
  if (sub === "history") {
    return {
      command: "spend",
      message: "Loading spend history...",
      refreshKanban: false,
    };
  }

  const reporter = new TokenReporter(counter);

  switch (sub) {
    case "":
    case "today":
      return {
        command: "spend",
        message: reporter.formatSessionTotal(),
        refreshKanban: false,
      };

    case "by-card":
      return {
        command: "spend",
        message: reporter.formatByCard(),
        refreshKanban: false,
      };

    case "by-agent":
      return {
        command: "spend",
        message: reporter.formatByAgent(),
        refreshKanban: false,
      };

    case "by-model":
      return {
        command: "spend",
        message: reporter.formatByModel(),
        refreshKanban: false,
      };

    case "projected":
      return {
        command: "spend",
        message: reporter.formatProjected(),
        refreshKanban: false,
      };

    case "report":
      return {
        command: "spend",
        message: reporter.formatReport(),
        refreshKanban: false,
      };

    default:
      return {
        command: "spend",
        message: `Unknown /spend sub-command: "${sub}". Available: /spend, /spend today, /spend by-card, /spend by-agent, /spend by-model, /spend projected, /spend report, /spend history`,
        refreshKanban: false,
      };
  }
}

/**
 * Handle the `/spend history` sub-command (T-084, async).
 * Returns formatted list of previous session batches.
 */
export async function handleSpendHistoryCommand(
  counter: TokenCounter,
  limit: number = 5,
): Promise<SpendCommandResult> {
  const batches = await counter.getHistory(limit);

  if (batches.length === 0) {
    return {
      command: "spend",
      message: "No previous session spend history found.",
      refreshKanban: false,
    };
  }

  const lines: string[] = [
    "═══ Spend History ═══",
    "",
  ];

  for (const batch of batches) {
    const date = batch.timestamp
      ? new Date(batch.timestamp).toLocaleString()
      : "unknown date";
    lines.push(`  Session ${batch.sessionId.slice(0, 8)}...`);
    lines.push(`    Date: ${date}`);
    lines.push(`    Model: ${batch.model}`);
    lines.push(`    Input: ${fmt(batch.inputTokens)} | Output: ${fmt(batch.outputTokens)} | Total: ${fmt(batch.totalSpend)}`);
    lines.push("");
  }

  lines.push("═════════════════════");

  return {
    command: "spend",
    message: lines.join("\n"),
    refreshKanban: false,
  };
}