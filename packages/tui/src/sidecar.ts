/**
 * Neuralgentics v0.1.0 — gRPC Sidecar Lifecycle Management (T-022)
 *
 * Manages the Python gRPC embedding sidecar process:
 * - On TUI startup: check if sidecar socket exists
 * - If missing: log a warning and offer guidance
 * - If present: verify socket responds (health ping)
 * - Optionally spawn the sidecar automatically
 * - Track child PID if TUI spawned it
 * - SIGTERM on TUI exit (only if TUI spawned it, not if user pre-started it)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve as pathResolve } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────────────

const SOCKET_PATH = process.env.NEURAL_EMBED_ADDR?.startsWith("unix://")
  ? process.env.NEURAL_EMBED_ADDR.replace("unix://", "")
  : process.env.NEURAL_EMBED_ADDR ?? "/tmp/neuralgentics-embed.sock";

// ─── Sidecar Directory Resolution ───────────────────────────────────────────
// The sidecar dir is where the Python embedding sidecar source + venv live.
// Resolution order:
//   1. $NEURALGENTICS_SIDECAR_DIR (explicit override)
//   2. $NEURALGENTICS_INSTALL_PREFIX/share/neuralgentics/sidecar/ (installed)
//   3. Relative to source tree (dev only)
// If none resolve to an existing directory, returns null (sidecar not configured).

export function resolveSidecarDir(): string | null {
  // 1. Explicit env var override
  const envDir = process.env.NEURALGENTICS_SIDECAR_DIR;
  if (envDir && existsSync(envDir)) {
    return pathResolve(envDir);
  }

  // 2. Install prefix (standard shared data location)
  const installPrefix =
    process.env.NEURALGENTICS_INSTALL_PREFIX ??
    process.env.NEURALGENTICS_PREFIX;
  if (installPrefix) {
    const installedDir = pathResolve(
      installPrefix,
      "share/neuralgentics/sidecar",
    );
    if (existsSync(installedDir)) {
      return installedDir;
    }
  }

  // 3. Source-tree relative (dev mode — works when running from packages/tui/src/)
  const sourceTreeDir = pathResolve(
    import.meta.dir,
    "../../../../memory/cmd/embedding-sidecar",
  );
  if (existsSync(sourceTreeDir)) {
    return sourceTreeDir;
  }

  // No sidecar dir found — sidecar is not configured
  return null;
}

const SIDECAR_DIR: string | null = resolveSidecarDir();

const SIDECAR_PIDFILE = "/tmp/neuralgentics-embed.pid";
const SIDECAR_LOGFILE = "/tmp/neuralgentics-embed.log";

const SOCKET_WAIT_RETRIES = 30;
const SOCKET_WAIT_INTERVAL_MS = 100;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

const SIDECAR_SETUP_URL =
  "https://github.com/Veedubin/neuralgentics/blob/main/docs/sidecar-setup.md";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SidecarStatus {
  available: boolean;
  socketPath: string;
  pid?: number;
  spawnedByTUI: boolean;
  error?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

let sidecarProcess: ChildProcess | null = null;
let spawnedByTUI = false;

// ─── Socket Health Check ─────────────────────────────────────────────────────

/**
 * Check if a Unix domain socket exists at the given path.
 */
function socketExists(socketPath: string): boolean {
  try {
    const stats = Bun.file(socketPath);
    // Use existsSync for synchronicity during startup
    return existsSync(socketPath);
  } catch {
    return false;
  }
}

/**
 * Verify that a Unix domain socket is responsive by attempting a connection.
 * Returns true if the connection succeeds (sidecar is alive).
 */
function verifySocketResponsive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, HEALTH_CHECK_TIMEOUT_MS);

    try {
      const client = createConnection(socketPath, () => {
        clearTimeout(timer);
        client.destroy();
        resolve(true);
      });
      client.on("error", () => {
        clearTimeout(timer);
        client.destroy();
        resolve(false);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Wait for the sidecar socket to become available.
 * Retries SOCKET_WAIT_RETRIES times with SOCKET_WAIT_INTERVAL_MS delay.
 */
async function waitForSocket(
  socketPath: string,
  retries: number = SOCKET_WAIT_RETRIES,
  intervalMs: number = SOCKET_WAIT_INTERVAL_MS,
): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (socketExists(socketPath)) {
      // Socket file exists, check if it's actually responsive
      const responsive = await verifySocketResponsive(socketPath);
      if (responsive) return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Sidecar Spawn ──────────────────────────────────────────────────────────

/**
 * Spawn the gRPC embedding sidecar as a background process.
 * Returns the child process if successful, null otherwise.
 */
function spawnSidecar(): ChildProcess | null {
  // Guard: cannot spawn without a sidecar directory
  if (!SIDECAR_DIR) {
    return null;
  }

  const sidecarDir = SIDECAR_DIR; // Non-null after guard
  const embedDevice = process.env.NEURALGENTICS_EMBED_DEVICE ?? "cpu";
  const embedAddr = process.env.NEURAL_EMBED_ADDR ?? `unix://${SOCKET_PATH}`;

  // Prefer the sidecar venv Python, fall back to system Python
  const venvPython = pathResolve(sidecarDir, ".venv/bin/python");
  let pythonBin: string;
  try {
    if (existsSync(venvPython)) {
      pythonBin = venvPython;
    } else {
      pythonBin = "python3";
    }
  } catch {
    pythonBin = "python3";
  }

  console.log(
    `[sidecar] Starting gRPC embedding sidecar (device=${embedDevice}, socket=${SOCKET_PATH})`,
  );

  const env = {
    ...process.env,
    PYTHONPATH: sidecarDir,
    NEURALGENTICS_EMBED_DEVICE: embedDevice,
    NEURAL_EMBED_ADDR: embedAddr,
  };

  const child = spawn(pythonBin, ["-m", "embedding_sidecar.main"], {
    cwd: sidecarDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Write PID file
  try {
    Bun.write(SIDECAR_PIDFILE, String(child.pid));
  } catch {
    // Non-critical — best effort
  }

  // Detach so the sidecar survives TUI exit if we didn't spawn it
  child.unref();

  // Log stdout/stderr to sidecar log file
  const logStream = Bun.file(SIDECAR_LOGFILE).writer();
  child.stdout?.on("data", (data: Buffer) => {
    logStream.write(data);
  });
  child.stderr?.on("data", (data: Buffer) => {
    logStream.write(data);
  });

  child.on("exit", (code) => {
    console.log(`[sidecar] Sidecar process exited with code ${code}`);
    // Clean stale socket on unexpected exit
    if (spawnedByTUI) {
      try {
        if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      } catch {
        // Ignore
      }
    }
  });

  return child;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize sidecar lifecycle management.
 *
 * Checks if the sidecar socket is available, and optionally spawns the sidecar
 * if it's not running. Returns a SidecarStatus indicating the result.
 *
 * @param autoSpawn - If true, automatically spawn the sidecar if it's not running.
 *                    If false, just check and report status.
 */
export async function initSidecar(
  autoSpawn: boolean = false,
): Promise<SidecarStatus> {
  // Step 0: If sidecar directory is not configured, return gracefully
  if (!SIDECAR_DIR) {
    console.log("[sidecar] Python embedding sidecar not configured.");
    console.log(
      "[sidecar] Memory will use noop embeddings (works fine for most operations).",
    );
    console.log(`[sidecar] To enable real BGE-Large embeddings, see: ${SIDECAR_SETUP_URL}`);
    return {
      available: false,
      socketPath: SOCKET_PATH,
      spawnedByTUI: false,
      error: "sidecar not configured",
    };
  }

  // Check if the sidecar dir has a venv — if not, also skip auto-spawn
  const venvPython = pathResolve(SIDECAR_DIR, ".venv/bin/python");
  if (!existsSync(venvPython) && !existsSync(pathResolve(SIDECAR_DIR, "main.py"))) {
    console.log("[sidecar] Python embedding sidecar not configured.");
    console.log(
      "[sidecar] Memory will use noop embeddings (works fine for most operations).",
    );
    console.log(`[sidecar] To enable real BGE-Large embeddings, see: ${SIDECAR_SETUP_URL}`);
    return {
      available: false,
      socketPath: SOCKET_PATH,
      spawnedByTUI: false,
      error: "sidecar not configured",
    };
  }

  // Step 1: Check if socket exists
  if (socketExists(SOCKET_PATH)) {
    const responsive = await verifySocketResponsive(SOCKET_PATH);
    if (responsive) {
      console.log(`[sidecar] gRPC sidecar already running on ${SOCKET_PATH}`);
      return {
        available: true,
        socketPath: SOCKET_PATH,
        spawnedByTUI: false,
      };
    }

    // Stale socket — no process bound to it
    console.warn(
      `[sidecar] Socket file exists at ${SOCKET_PATH} but no process is bound. Removing stale socket.`,
    );
    try {
      unlinkSync(SOCKET_PATH);
    } catch (e) {
      return {
        available: false,
        socketPath: SOCKET_PATH,
        spawnedByTUI: false,
        error: `Failed to remove stale socket: ${e}`,
      };
    }
  }

  // Step 2: Sidecar not running
  if (!autoSpawn) {
    const msg =
      "gRPC sidecar not running. Run ./scripts/dev-up.sh first, or start it manually with ./scripts/sidecar.sh start";
    console.warn(`[sidecar] ${msg}`);
    return {
      available: false,
      socketPath: SOCKET_PATH,
      spawnedByTUI: false,
      error: msg,
    };
  }

  // Step 3: Spawn the sidecar
  console.log("[sidecar] Starting sidecar...");
  const child = spawnSidecar();
  if (!child) {
    return {
      available: false,
      socketPath: SOCKET_PATH,
      spawnedByTUI: false,
      error: "Failed to spawn sidecar process",
    };
  }

  sidecarProcess = child;
  spawnedByTUI = true;

  // Step 4: Wait for socket to be ready (30 retries × 100ms = 3s)
  console.log("[sidecar] Waiting for socket to bind...");
  const ready = await waitForSocket(SOCKET_PATH);
  if (ready) {
    console.log(
      `[sidecar] Sidecar ready (pid=${child.pid}, socket=${SOCKET_PATH})`,
    );
    return {
      available: true,
      socketPath: SOCKET_PATH,
      pid: child.pid,
      spawnedByTUI: true,
    };
  }

  // Socket didn't bind in time — check if process is alive
  if (child.exitCode !== null) {
    return {
      available: false,
      socketPath: SOCKET_PATH,
      pid: child.pid,
      spawnedByTUI: true,
      error: `Sidecar process exited with code ${child.exitCode}. Check ${SIDECAR_LOGFILE}`,
    };
  }

  return {
    available: false,
    socketPath: SOCKET_PATH,
    pid: child.pid,
    spawnedByTUI: true,
    error: `Sidecar process alive but socket not bound after ${SOCKET_WAIT_RETRIES * SOCKET_WAIT_INTERVAL_MS}ms. Check ${SIDECAR_LOGFILE}`,
  };
}

/**
 * Check if the database is reachable on port 6000.
 * Returns a SidecarStatus-like object for the DB.
 */
export async function checkDatabase(): Promise<{
  available: boolean;
  host: string;
  port: number;
  error?: string;
}> {
  const dbHost = "localhost";
  const dbPort = 6000;

  try {
    // Use Bun's TCP connect to check if port is open
    const conn = await Bun.connect({
      hostname: dbHost,
      port: dbPort,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    } as unknown as Parameters<typeof Bun.connect>[0]);
    conn.end();
    return { available: true, host: dbHost, port: dbPort };
  } catch (_e: unknown) {
    return {
      available: false,
      host: dbHost,
      port: dbPort,
      error: `Port ${dbPort}: no response. Run ./scripts/dev-up.sh. [Retry]`,
    };
  }
}

/**
 * Shut down the sidecar process if the TUI spawned it.
 * Only sends SIGTERM to processes we started — does NOT kill
 * user-pre-started sidecars.
 */
export function shutdownSidecar(): void {
  if (sidecarProcess && spawnedByTUI) {
    const pid = sidecarProcess.pid;
    if (pid) {
      console.log(
        `[sidecar] Shutting down sidecar (pid=${pid}, spawned by TUI)`,
      );
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
    }
    sidecarProcess = null;
    spawnedByTUI = false;
  } else {
    console.log(
      "[sidecar] Sidecar was pre-started by user — not shutting down",
    );
  }
}

/**
 * Check the health of the OpenCode and Neuralgentics client connections.
 * Returns a snapshot of both clients' online/offline status.
 *
 * This is the diagnostic function that /offline calls under the hood.
 * It does NOT trigger recovery — it just reads the current state.
 *
 * (T-081c — Offline Mode Recovery)
 */
export function checkSidecarHealth(
  opencodeClient: { onlineStatus: "online" | "offline" },
  neuralgenticsClient: { onlineStatus: "online" | "offline" },
): { opencode: "online" | "offline"; neuralgentics: "online" | "offline" } {
  return {
    opencode: opencodeClient.onlineStatus,
    neuralgentics: neuralgenticsClient.onlineStatus,
  };
}

/**
 * Register process exit handlers to clean up sidecar on TUI exit.
 * Only kills sidecar if TUI spawned it.
 */
export function registerSidecarShutdown(): void {
  const handler = () => {
    shutdownSidecar();
    process.exit(0);
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("exit", () => {
    shutdownSidecar();
  });
}