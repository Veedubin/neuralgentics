/**
 * NeuralgenticsClient — JSON-RPC 2.0 client over stdio for the Go backend.
 *
 * Spawns the `neuralgentics-backend` binary as a child process and communicates
 * via newline-delimited JSON-RPC over stdin/stdout. Stderr is inherited so
 * backend logs appear in the parent process' console.
 *
 * Based on the overlay's `go-backend-client.ts` (245 lines) but self-contained —
 * the overlay is being deprecated for v4 users (per v4-FINAL §512 Q10).
 *
 * Binary path resolution is inlined per T-020 scope (T-024 may refactor later).
 * Resolution: $PATH → $NEURALGENTICS_BACKEND_PATH → relative path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveBackendPath, resolveDbUrl } from "./resolver.js";
import type { MethodName, MethodParams, MethodResult } from "./types.js";

/** Internal bookkeeping for an in-flight JSON-RPC request. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** JSON-RPC 2.0 response line (parsed from stdout). */
interface JsonrpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id — pushed by server). */
interface JsonrpcNotification {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Events emitted by NeuralgenticsClient. */
export interface NeuralgenticsClientEvents {
  /** Emitted when the backend exits unexpectedly or fails to start. */
  crash: (error: Error) => void;
  /** Emitted when the backend is ready (received `{"method":"ready"}` notification). */
  ready: () => void;
}

/**
 * NeuralgenticsClient — typed JSON-RPC 2.0 client for the Go backend.
 *
 * Usage:
 * ```ts
 * const client = new NeuralgenticsClient();
 * await client.waitForReady();
 * const pong = await client.call("ping", {});
 * const mem = await client.call("memory.add", { content: "hello" });
 * await client.close();
 * ```
 */
export class NeuralgenticsClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private closed = false;
  private binaryPath: string;
  private crashListeners: Array<(error: Error) => void> = [];
  private readyListeners: Array<() => void> = [];

  /**
   * Create a new client and spawn the backend binary.
   *
   * @param options - Optional configuration.
   * @param options.binaryPath - Explicit path to the binary (skips resolution).
   * @param options.dbUrl - Database URL override (defaults to NEURALGENTICS_DB_URL env or dev DB).
   * @param options.spawn - Whether to spawn the backend immediately (default true).
   *                       Set false for testing with a mock process.
   */
  constructor(options?: {
    binaryPath?: string;
    dbUrl?: string;
    spawn?: boolean;
  }) {
    // Only resolve binary path when actually needed (spawning or explicitly provided).
    // When spawn:false and no explicit path, defer resolution entirely.
    if (options?.binaryPath) {
      this.binaryPath = options.binaryPath;
    } else if (options?.spawn !== false) {
      this.binaryPath = resolveBackendPath();
    } else {
      // Defer resolution — will be resolved lazily if needed later.
      this.binaryPath = "";
    }
    const dbUrl = options?.dbUrl ?? resolveDbUrl();

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    if (options?.spawn !== false) {
      this.spawnBackend(this.binaryPath, dbUrl);
    }
  }

  /**
   * Register event listeners.
   * Supports 'crash' (receives Error) and 'ready' (no args) events.
   */
  on(event: "crash" | "ready", listener: (arg?: Error) => void): this {
    if (event === "crash") {
      this.crashListeners.push(listener as (error: Error) => void);
    } else if (event === "ready") {
      this.readyListeners.push(listener as () => void);
    }
    return this;
  }

  /**
   * Wait for the backend to emit the `{"method":"ready"}` notification.
   *
   * @param timeoutMs - Maximum time to wait (default 10 seconds).
   *                     Rejects with a clear error if timeout expires.
   */
  async waitForReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) return;
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Go backend did not emit 'ready' within ${timeoutMs}ms — ` +
                  `it may have crashed or the binary path is wrong`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Send a typed JSON-RPC request and await the response.
   *
   * @param method - JSON-RPC method name.
   * @param params - Request parameters.
   * @param timeoutMs - Request timeout in ms (default 30 seconds).
   * @returns The typed result field of the JSON-RPC response.
   */
  async call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    timeoutMs = 30_000,
  ): Promise<MethodResult<M>> {
    await this.waitForReady();

    if (this.closed) {
      throw new Error("NeuralgenticsClient is closed");
    }

    const id = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const body = JSON.stringify(request) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout: ${method} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      if (!this.process?.stdin) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Backend process stdin is not available"));
        return;
      }

      this.process.stdin.write(body, (err?: Error | null) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write JSON-RPC request: ${err.message}`));
        }
      });
    });
  }

  /**
   * Shutdown the backend process gracefully.
   * Sends a "shutdown" request first, then kills the process.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      // Try graceful shutdown (best-effort, ignore errors)
      if (this.process?.stdin && !this.process.killed) {
        const id = this.nextId++;
        const request = { jsonrpc: "2.0", id, method: "shutdown", params: {} };
        const body = JSON.stringify(request) + "\n";
        try {
          this.process.stdin.write(body);
        } catch {
          // Ignore — the process may already be exiting
        }
      }
    } finally {
      // Small delay to allow the shutdown message to be sent
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.process?.kill();
      this.rejectAll(new Error("NeuralgenticsClient closed"));
    }
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  private spawnBackend(binaryPath: string, dbUrl: string): void {
    const childEnv = {
      ...process.env,
      NEURALGENTICS_DB_URL: dbUrl,
    };

    this.process = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv,
    });

    // Read stdout line-by-line and route to pending calls.
    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line: string) => this.handleLine(line));
    rl.on("close", () => this.handleClose());

    // Detect binary failure to start.
    this.process.on("error", (err: Error) => {
      const error = new Error(`Failed to spawn neuralgentics-backend: ${err.message}`);
      this.readyReject(error);
      this.rejectAll(error);
      this.emitCrash(error);
    });

    this.process.on("exit", (code: number | null) => {
      const error = new Error(
        `Go backend exited with code ${code ?? "unknown"}`,
      );
      // If we haven't resolved ready yet, reject it
      if (!this.ready) {
        this.readyReject(error);
      }
      this.rejectAll(error);
      this.emitCrash(error);
    });
  }

  /**
   * Handle a single line from the Go backend's stdout.
   *
   * The first valid JSON line marks the backend as ready (the `{"method":"ready"}`
   * notification). Subsequent lines are routed to their pending calls by `id`.
   */
  private handleLine(line: string): void {
    let response: JsonrpcResponse;
    try {
      response = JSON.parse(line) as JsonrpcResponse;
    } catch {
      // Skip malformed/non-JSON lines (e.g. debug output)
      return;
    }

    // On first JSON line, mark ready (the backend has finished init).
    if (!this.ready) {
      this.ready = true;
      this.readyResolve();
      for (const listener of this.readyListeners) {
        listener();
      }
    }

    // Ignore notifications (no id) — "ready" is one such notification.
    if (response.id == null) return;

    const id = response.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (response.error != null) {
      const err = response.error;
      pending.reject(
        new Error(
          `JSON-RPC error ${err.code ?? "unknown"}: ${err.message ?? "unknown error"}`,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /** Handle stdout close — reject all pending calls. */
  private handleClose(): void {
    const error = new Error("Go backend stdout closed");
    if (!this.ready) {
      this.readyReject(error);
    }
    this.rejectAll(error);
    this.emitCrash(error);
  }

  /** Reject every pending call with the same error. */
  private rejectAll(reason: Error): void {
    for (const [, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  /** Emit a crash event to all listeners. */
  private emitCrash(error: Error): void {
    for (const listener of this.crashListeners) {
      try {
        listener(error);
      } catch {
        // Swallow listener errors
      }
    }
  }
}