/**
 * GoBackendClient — JSON-RPC 2.0 client over stdio for the Neuralgentics Go backend.
 *
 * Spawns the `neuralgentics-backend` binary as a child process and communicates
 * via newline-delimited JSON-RPC over stdin/stdout. Stderr is inherited so the
 * backend's logs appear in the parent process' console.
 *
 * This replaces the previous HTTP transport to the Python memini-core server,
 * achieving sub-millisecond latency on the same machine with zero port management.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Default database URL the Go backend connects to.
 *
 * IMPORTANT: lib/pq (the Go postgres driver) defaults `sslmode` to `require`
 * when no `sslmode` is specified in the connection string. That works against
 * databases with `ssl = on` but fails against databases with `ssl = off`
 * (e.g. the user's prod timescale-pg18 on 5434). The dev test DB on 6000
 * has SSL enabled, so `?sslmode=require` matches the server's capability
 * and lets the migrator + queries succeed without any CA verification.
 *
 * Override at spawn time by setting `NEURALGENTICS_DB_URL` in the parent
 * process's environment before OpenCode launches the plugin.
 */
const DEFAULT_DB_URL =
  "postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require";

/** Resolve the DB URL — explicit env override wins, otherwise the dev DB. */
function resolveDbUrl(): string {
  return process.env.NEURALGENTICS_DB_URL ?? DEFAULT_DB_URL;
}

/** Internal bookkeeping for an in-flight JSON-RPC request. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 client that talks to the Go backend over stdio.
 *
 * Usage:
 * ```ts
 * const backend = new GoBackendClient("neuralgentics-backend");
 * await backend.waitForReady();
 * const result = await backend.call("memory.add", { content: "hello" });
 * await backend.shutdown();
 * ```
 */
export class GoBackendClient {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  /**
   * Spawn the Go backend binary and begin reading its stdout.
   *
   * @param binaryPath - Absolute or relative path to the `neuralgentics-backend` binary.
   *                     Falls back to $PATH lookup if just the binary name is given.
   */
  constructor(binaryPath: string) {
    // Set NEURALGENTICS_DB_URL so the backend doesn't fall back to its
    // 5434 default (which has no SSL and breaks lib/pq's implicit
    // sslmode=require). Override the env var before launch to point at
    // any database; default is the dev/test DB on 6000 with SSL.
    const childEnv = {
      ...process.env,
      NEURALGENTICS_DB_URL: resolveDbUrl(),
    };

    this.process = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv,
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Read stdout line-by-line and route responses to pending calls.
    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line: string) => this.handleLine(line));
    rl.on("close", () => this.handleClose());

    // Detect binary failure to start.
    this.process.on("error", (err: Error) => {
      this.readyReject(err);
      this.rejectAll(err);
    });
    this.process.on("exit", (code: number | null) => {
      const error = new Error(
        `Go backend exited with code ${code ?? "unknown"}`,
      );
      this.rejectAll(error);
    });
  }

  /**
   * Wait for the backend to be ready (after first stdout line, which is
   * the {"method":"ready"} notification the backend emits post-init).
   *
   * @param timeoutMs - Maximum time to wait before giving up (default 10 000).
   *                    If the backend is slow to start (or crashes silently),
   *                    this prevents the OpenCode plugin from hanging forever.
   *                    On timeout, the promise rejects so callers can decide
   *                    whether to abort or continue with a broken backend.
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
                `Go backend did not emit 'ready' within ${timeoutMs}ms — it may have crashed or the binary path is wrong`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Send a JSON-RPC request and await the response.
   *
   * @param method - JSON-RPC method name (e.g. "memory.add", "thought.startChain").
   * @param params - Request parameters object.
   * @param timeoutMs - Request timeout in milliseconds (default 30 000).
   * @returns The `result` field of the JSON-RPC response.
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    await this.waitForReady();

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

      this.pending.set(id, { resolve, reject, timer });

      this.process.stdin!.write(body, (err?: Error | null) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new Error(`Failed to write JSON-RPC request: ${err.message}`),
          );
        }
      });
    });
  }

  /** Shutdown the backend process gracefully. */
  async shutdown(): Promise<void> {
    try {
      await this.call("shutdown", {});
    } catch {
      // Ignore errors during shutdown — the process may already be exiting.
    }
    this.process.kill();
  }

  /**
   * Handle a single line from the Go backend's stdout.
   *
   * The first valid JSON line marks the backend as ready.
   * Subsequent lines are routed to their pending calls by `id`.
   */
  private handleLine(line: string): void {
    // On first line, mark ready (the backend has finished initialisation).
    if (!this.ready) {
      this.ready = true;
      this.readyResolve();
    }

    let response: Record<string, unknown>;
    try {
      response = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed / non-JSON lines (e.g. debug output).
      return;
    }

    // Ignore notifications (no id).
    if (response.id == null) return;

    const id = response.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (response.error != null) {
      const err = response.error as { code?: number; message?: string };
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
    this.rejectAll(new Error("Go backend stdout closed"));
  }

  /** Reject every pending call with the same error. */
  private rejectAll(reason: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }
}