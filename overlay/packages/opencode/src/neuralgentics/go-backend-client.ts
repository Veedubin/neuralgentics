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

// DB URL: we do NOT override the Go backend's built-in default
// (memini:memini@localhost:5434/memini), which matches
// the `memini-postgres` podman container. If the user has
// explicitly set `MEMINI_DB_URL` in their environment, it is passed
// through automatically via the `process.env` spread below — otherwise the
// Go binary uses its own sensible default.

// ---------------------------------------------------------------------------
// Sidecar status check + lazy-load support (v0.9.6+)
// ---------------------------------------------------------------------------

/**
 * gRPC timeout for embed calls — bumped to 60s to allow for cold model load
 * (BGE-Large fp16/int8 on first use can take 5-15s on CPU, longer on a cold
 * HuggingFace cache download).
 */
const SIDECAR_EMBED_TIMEOUT_MS = 60_000;

/** Shape of the sidecar `/status` JSON response. */
export interface SidecarStatus {
  loaded: boolean;
  models: string[];
  dtype: string;
}

/**
 * Cache the "model loaded" state per session so the warming-up message is
 * only emitted ONCE (on the first cold-load detection). Subsequent calls
 * skip the status probe entirely once we've seen `loaded: true`.
 */
let sidecarModelLoaded = false;
let warmingUpMessageShown = false;

/** Resolve the sidecar HTTP /status URL from env vars (sensible defaults). */
function resolveStatusURL(): string {
  if (process.env.NEURALGENTICS_SIDECAR_STATUS_URL) {
    return process.env.NEURALGENTICS_SIDECAR_STATUS_URL;
  }
  const host = process.env.NEURALGENTICS_SIDECAR_HOST ?? "localhost";
  const port = process.env.NEURALGENTICS_SIDECAR_STATUS_PORT ?? "50052";
  return `http://${host}:${port}/status`;
}

/**
 * Probe the sidecar's HTTP `/status` endpoint.
 *
 * Returns `{ loaded: false, models: [], dtype: "unknown" }` if the endpoint
 * is unreachable (sidecar not running, no HTTP status server, network down).
 * Never throws — a failed probe just means the embed call will trigger a
 * load (and the 60s timeout covers it).
 */
export async function checkSidecarStatus(): Promise<SidecarStatus> {
  const statusURL = resolveStatusURL();
  try {
    const resp = await fetch(statusURL, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const body = (await resp.json()) as Partial<SidecarStatus>;
      return {
        loaded: body.loaded === true,
        models: Array.isArray(body.models) ? body.models : [],
        dtype: typeof body.dtype === "string" ? body.dtype : "unknown",
      };
    }
  } catch {
    // Fall through — sidecar unreachable or /status not implemented.
  }
  return { loaded: false, models: [], dtype: "unknown" };
}

/**
 * Pre-embed hook: probe sidecar status, emit a one-time "warming up" message
 * if the model isn't loaded yet, and bump the call timeout for cold loads.
 *
 * Caches the loaded state so the warming-up message is shown at most once
 * per process lifetime (no user spam on every embed call).
 *
 * @returns The gRPC timeout to use for the subsequent embed call
 *          (60s if cold load possible, normal default otherwise).
 */
export async function prepareEmbedCall(): Promise<number> {
  // Once we've confirmed the model is loaded, skip the probe entirely.
  if (sidecarModelLoaded) return SIDECAR_EMBED_TIMEOUT_MS;

  const status = await checkSidecarStatus();
  if (status.loaded) {
    sidecarModelLoaded = true;
    return SIDECAR_EMBED_TIMEOUT_MS;
  }

  // Cold load: show the warming-up message ONCE.
  if (!warmingUpMessageShown) {
    warmingUpMessageShown = true;
    const dtypeLabel = status.dtype !== "unknown" ? status.dtype : "auto";
    process.stderr.write(
      `[neuralgentics] Sidecar model not loaded. Warming up BGE-Large (${dtypeLabel})... ` +
        `this may take 5-15 seconds on first use.\n`,
    );
  }
  // Cold-load path: use the full 60s timeout.
  return SIDECAR_EMBED_TIMEOUT_MS;
}

/** Reset the cached sidecar loaded state (for tests / reconnection). */
export function resetSidecarLoadCache(): void {
  sidecarModelLoaded = false;
  warmingUpMessageShown = false;
}

/** Internal bookkeeping for an in-flight JSON-RPC request. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Loaded OpenCode config (set by the server.ts config hook)
// ---------------------------------------------------------------------------
//
// The plugin's `config` hook in server.ts receives the fully-merged opencode
// config object. We stash it here so GoBackendClient can read the
// `mcp["memini-ai-dev"].env.MEMINI_DB_URL` value and inject it as
// `NEURALGENTICS_DB_URL` into the child env — so the Go backend picks up the
// same DSN the memini-ai MCP server is using, with no extra env gymnastics.

let loadedConfig: Record<string, unknown> | null = null;

/**
 * Stash the opencode config object so the GoBackendClient can resolve
 * NEURALGENTICS_DB_URL from the memini-ai MCP server's env block.
 * Called by the `config` hook in server.ts.
 */
export function setLoadedConfig(cfg: Record<string, unknown>): void {
  loadedConfig = cfg;
}

/**
 * Resolve a usable Postgres DSN from the memini-ai MCP server's env block
 * in the loaded opencode config. Returns `undefined` if no usable DSN is
 * found (config not loaded, memini-ai block missing, MEMINI_DB_URL unset,
 * or MEMINI_DB_URL is the sentinel "pgembed"/"" meaning embedded mode).
 *
 * This is a pure data-narrowing helper — no `any`, just `unknown` + type
 * guards — so it survives `tsc --noEmit` under strict mode.
 */
function resolveMeminiDbUrl(
  cfg: Record<string, unknown> | null,
): string | undefined {
  if (cfg == null) return undefined;
  const mcp = cfg.mcp;
  if (typeof mcp !== "object" || mcp == null) return undefined;
  const meminiEntry = (mcp as Record<string, unknown>)["memini-ai-dev"];
  if (typeof meminiEntry !== "object" || meminiEntry == null) return undefined;
  const env = (meminiEntry as Record<string, unknown>).env;
  if (typeof env !== "object" || env == null) return undefined;
  const url = (env as Record<string, unknown>).MEMINI_DB_URL;
  if (typeof url !== "string") return undefined;
  if (url === "" || url === "pgembed") return undefined;
  return url;
}

/**
 * JSON-RPC 2.0 client that talks to the Go backend over stdio.
 *
 * Supports two construction modes:
 *  - **Eager (default):** spawns the binary immediately in the constructor.
 *    Use when `loadedConfig` is already populated (e.g. tests, standalone use).
 *  - **Lazy (`{ lazy: true }`):** defers spawn until `start()` / `waitForReady()`
 *    / `call()` is first invoked. Use in the OpenCode plugin `server()` so the
 *    spawn happens AFTER the `config` hook has called `setLoadedConfig(cfg)`,
 *    allowing `NEURALGENTICS_DB_URL` to be auto-promoted from
 *    `mcp["memini-ai-dev"].env.MEMINI_DB_URL`.
 *
 * Usage (eager):
 * ```ts
 * const backend = new GoBackendClient("neuralgentics-backend");
 * await backend.waitForReady();
 * const result = await backend.call("memory.add", { content: "hello" });
 * await backend.shutdown();
 * ```
 *
 * Usage (lazy — OpenCode plugin):
 * ```ts
 * const backend = new GoBackendClient(binaryPath, { lazy: true });
 * // ... later, in the config hook:
 * setLoadedConfig(cfg);
 * await backend.start();
 * ```
 */
export class GoBackendClient {
  /** The spawned child process (null until `start()` runs, or after shutdown). */
  private process: ChildProcess | null = null;
  /** Remembered binary path — used by `start()` when lazy. */
  private readonly binaryPath: string;
  /** Has `start()` successfully spawned the process? */
  started = false;
  /** Is `start()` currently in progress? (Used for diagnostics only.) */
  starting = false;
  /** Dedupe concurrent `start()` calls — all callers share the same promise. */
  private startPromise: Promise<void> | null = null;

  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private ready = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  /**
   * Construct the client. By default spawns the binary immediately; pass
   * `{ lazy: true }` to defer spawn until `start()` is called (e.g. from
   * the OpenCode plugin config hook, after `setLoadedConfig`).
   *
   * @param binaryPath - Absolute or relative path to the `neuralgentics-backend` binary.
   *                     Falls back to $PATH lookup if just the binary name is given.
   * @param options.lazy - If true, do NOT spawn in the constructor. The caller
   *                       MUST call `start()` (or `waitForReady()`/`call()`,
   *                       which both delegate to `start()`) before the backend
   *                       can be used.
   */
  constructor(binaryPath: string, options: { lazy?: boolean } = {}) {
    this.binaryPath = binaryPath;
    // The ready promise is created eagerly so that event handlers wired in
    // start() can resolve/reject it. It is awaited in waitForReady().
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    if (!options.lazy) {
      // Eager mode: spawn immediately (legacy behaviour).
      void this.start();
    }
  }

  /**
   * Lazily start the backend. Idempotent — concurrent calls share the same
   * promise. If the backend has already been started, returns immediately.
   * If it has been shut down, returns a rejected promise (restart is not
   * supported — construct a new client instead).
   *
   * Builds the child environment with the same precedence as the legacy
   * eager constructor:
   *   1. Explicit `process.env.NEURALGENTICS_DB_URL` — wins.
   *   2. `mcp["memini-ai-dev"].env.MEMINI_DB_URL` from `loadedConfig`
   *      (set by `setLoadedConfig` in the config hook).
   *   3. The Go binary's own hardcoded default.
   *
   * Sentinel values `""` and `"pgembed"` are skipped (they mean memini-ai
   * is in embedded mode, not against a shareable external Postgres).
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.starting = true;
    this.startPromise = (async () => {
      // Build the child environment from the parent process env. We do NOT
      // force a NEURALGENTICS_DB_URL here — the Go binary has its own
      // built-in default which matches the `neuralgentics-postgres` compose
      // stack. If the user has set NEURALGENTICS_DB_URL in their environment,
      // it is already in childEnv via the spread and will override the Go
      // binary's default. Otherwise the binary uses its own default.
      const childEnv: Record<string, string | undefined> = { ...process.env };

      // Precedence resolution for NEURALGENTICS_DB_URL:
      //   1. Explicit process.env.NEURALGENTICS_DB_URL (already in childEnv) — wins.
      //   2. The memini-ai MCP server's MEMINI_DB_URL from the loaded opencode
      //      config (set by the config hook in server.ts). This lets the Go
      //      backend reuse the same DSN as the sibling memini-ai server with
      //      no extra configuration from the user. The sentinel values
      //      "pgembed" and "" are skipped — they mean memini-ai is running in
      //      embedded mode, not against an external Postgres the Go backend
      //      could share.
      //   3. process.env.MEMINI_DB_URL (the canonical memini-ai env var).
      if (!childEnv.NEURALGENTICS_DB_URL) {
        const meminiUrl = resolveMeminiDbUrl(loadedConfig);
        if (meminiUrl !== undefined) {
          childEnv.NEURALGENTICS_DB_URL = meminiUrl;
        } else if (process.env.MEMINI_DB_URL) {
          childEnv.NEURALGENTICS_DB_URL = process.env.MEMINI_DB_URL;
        }
      }

      const child = spawn(this.binaryPath, [], {
        stdio: ["pipe", "pipe", "inherit"],
        env: childEnv,
      });
      this.process = child;

      // Read stdout line-by-line and route responses to pending calls.
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line: string) => this.handleLine(line));
      rl.on("close", () => this.handleClose());

      // Detect binary failure to start.
      child.on("error", (err: Error) => {
        this.readyReject(err);
        this.rejectAll(err);
      });
      child.on("exit", (code: number | null) => {
        const error = new Error(
          `Go backend exited with code ${code ?? "unknown"}`,
        );
        this.rejectAll(error);
      });

      try {
        await this.readyPromise;
        this.started = true;
      } finally {
        this.starting = false;
      }
    })();
    return this.startPromise;
  }

  /**
   * Wait for the backend to be ready (after first stdout line, which is
   * the {"method":"ready"} notification the backend emits post-init).
   *
   * Delegates to `start()` so a lazy client is spawned on first await.
   *
   * @param timeoutMs - Maximum time to wait before giving up (default 10 000).
   *                    If the backend is slow to start (or crashes silently),
   *                    this prevents the OpenCode plugin from hanging forever.
   *                    On timeout, the promise rejects so callers can decide
   *                    whether to abort or continue with a broken backend.
   */
  async waitForReady(timeoutMs = 10_000): Promise<void> {
    // Ensure the backend has been spawned (no-op if already started).
    const startP = this.start();
    if (this.ready) return;
    await Promise.race([
      startP.then(() => this.readyPromise),
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
   * Lazily starts the backend on first call (if constructed with
   * `{ lazy: true }`).
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

    const proc = this.process;
    if (proc == null || proc.stdin == null) {
      throw new Error(
        `GoBackendClient.call(${method}): backend process not running`,
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout: ${method} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      proc.stdin!.write(body, (err?: Error | null) => {
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

  /** Shutdown the backend process gracefully. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    if (this.process != null) {
      try {
        await this.call("shutdown", {});
      } catch {
        // Ignore errors during shutdown — the process may already be exiting.
      }
      this.process.kill();
      this.process = null;
    }
    this.started = false;
  }

  /**
   * Embed a text via the Go backend, with sidecar cold-load awareness.
   *
   * Before the gRPC call, probes the sidecar's HTTP `/status` endpoint
   * (if configured). If the model isn't loaded yet, emits a one-time
   * "warming up" message and uses a 60s timeout (vs. the default 30s)
   * to allow for cold model load (BGE-Large fp16/int8 can take 5-15s on
   * first use).
   *
   * @param text - The text to embed.
   * @param method - JSON-RPC method (default "memory.embed").
   * @returns The embedding vector (array of numbers) from the backend.
   */
  async embed(
    text: string,
    method = "memory.embed",
  ): Promise<number[]> {
    const timeoutMs = await prepareEmbedCall();
    const result = await this.call(method, { text }, timeoutMs);
    if (!Array.isArray(result)) {
      throw new Error(
        `embed: expected array result from ${method}, got ${typeof result}`,
      );
    }
    // Mark the model as loaded after a successful embed (idempotent).
    sidecarModelLoaded = true;
    return result as number[];
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