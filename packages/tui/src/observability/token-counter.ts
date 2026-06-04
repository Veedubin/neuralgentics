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
 * Handle the `/spend` slash command with sub-commands.
 *
 * Sub-commands:
 * - `/spend`         → session total
 * - `/spend today`   → session total (same as bare /spend, per-session only)
 * - `/spend by-card` → per-task breakdown
 * - `/spend by-agent` → per-agent breakdown
 * - `/spend by-model` → per-model breakdown
 * - `/spend projected` → burn rate estimate
 * - `/spend report`  → full wrap-up report
 */
export function handleSpendCommand(
  counter: TokenCounter,
  input: string,
): SpendCommandResult {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  // First part is "spend", second is the sub-command
  const sub = parts[1]?.toLowerCase() ?? "";

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
        message: `Unknown /spend sub-command: "${sub}". Available: /spend, /spend today, /spend by-card, /spend by-agent, /spend by-model, /spend projected, /spend report`,
        refreshKanban: false,
      };
  }
}