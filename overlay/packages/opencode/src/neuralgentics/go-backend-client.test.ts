/**
 * Tests for GoBackendClient lazy-init + NEURALGENTICS_DB_URL auto-promotion.
 *
 * Verifies the v0.15.20 ordering fix: when constructed with `{ lazy: true }`,
 * the client does NOT spawn in the constructor. The spawn (and the env
 * building, which reads `loadedConfig`) is deferred until `start()` is
 * called — which the OpenCode plugin `config` hook does AFTER
 * `setLoadedConfig(cfg)`.
 *
 * Strategy: mock `node:child_process.spawn` via `mock.module` so we can
 * capture the `env` passed to spawn without actually launching a process.
 * The mock emits a single `{"jsonrpc":"2.0","method":"ready"}` line on
 * stdout so `readyPromise` resolves.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// spawn mock
// ---------------------------------------------------------------------------

/** Captured spawn calls. */
interface SpawnCall {
  binary: string;
  args: string[];
  env: Record<string, string | undefined>;
}

let capturedCalls: SpawnCall[] = [];
let mockSpawnImpl: ((...args: unknown[]) => ChildProcess) | null = null;

/**
 * Install the child_process mock. The mocked `spawn` returns a fake
 * ChildProcess whose stdout is a PassThrough; the test writes a ready
 * line into it to resolve the client's readyPromise.
 */
async function installSpawnMock(): Promise<void> {
  mock.module("node:child_process", () => {
    const actual = require("node:child_process");
    return {
      ...actual,
      spawn: (...args: unknown[]): ChildProcess => {
        const [binary, spawnArgs, opts] = args as [
          string,
          string[],
          { env?: Record<string, string | undefined> },
        ];
        capturedCalls.push({
          binary,
          args: spawnArgs,
          env: opts?.env ?? {},
        });
        if (mockSpawnImpl) {
          return mockSpawnImpl(...args);
        }
        // Default fake: a ChildProcess with PassThrough stdio.
        const stdout = new PassThrough();
        const stdin = new PassThrough();
        const stderr = new PassThrough();
        const fake = Object.assign(new EventEmitter(), {
          stdout,
          stdin,
          stderr,
          pid: 99999,
          kill: () => true,
        }) as unknown as ChildProcess;
        // Emit a ready line so the client's readyPromise resolves.
        queueMicrotask(() => stdout.write('{"jsonrpc":"2.0","method":"ready"}\n'));
        // Echo JSON-RPC responses: when stdin receives a request line,
        // emit a matching response line on stdout so `call()` resolves
        // (otherwise shutdown() hangs for 30s waiting on a timeout).
        stdin.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const req = JSON.parse(line) as { id?: number };
              if (typeof req.id === "number") {
                stdout.write(
                  JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) +
                    "\n",
                );
              }
            } catch {
              // ignore non-JSON
            }
          }
        });
        return fake;
      },
    };
  });
}

/** Wait a tick for the mock module to take effect + queued microtasks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Imports (after mock is installed where needed)
// ---------------------------------------------------------------------------

// We import lazily inside tests so the mock applies. The module under test
// captures `spawn` at import time, so we install the mock BEFORE importing.
// Bun's mock.module replaces the module registry entry, and since the test
// file imports the SUT *after* installSpawnMock(), the SUT picks up the mock.

let GoBackendClient: typeof import("./go-backend-client.js").GoBackendClient;
let setLoadedConfig: typeof import("./go-backend-client.js").setLoadedConfig;

async function importSut(): Promise<void> {
  const mod = await import("./go-backend-client.js");
  GoBackendClient = mod.GoBackendClient;
  setLoadedConfig = mod.setLoadedConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GoBackendClient lazy mode + DB URL auto-promotion", () => {
  beforeEach(async () => {
    capturedCalls = [];
    mockSpawnImpl = null;
    // Clear env to avoid leakage from the real environment.
    delete process.env.NEURALGENTICS_DB_URL;
    await installSpawnMock();
    await importSut();
    await flush();
  });

  afterEach(() => {
    mock.restore();
    delete process.env.NEURALGENTICS_DB_URL;
  });

  it("lazy=true does NOT spawn in the constructor", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    expect(client.started).toBe(false);
    expect(capturedCalls.length).toBe(0);
  });

  it("lazy=false (default) DOES spawn in the constructor", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new GoBackendClient("neuralgentics-backend");
    await flush();
    expect(capturedCalls.length).toBe(1);
    expect(client.started).toBe(true);
  });

  it("start() auto-promotes MEMINI_DB_URL → NEURALGENTICS_DB_URL", async () => {
    setLoadedConfig({
      mcp: {
        "memini-ai-dev": {
          env: {
            MEMINI_DB_URL: "postgresql://test:test@host/db",
          },
        },
      },
    });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    await client.start();
    await flush();
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].env.NEURALGENTICS_DB_URL).toBe(
      "postgresql://test:test@host/db",
    );
  });

  it("explicit process.env.NEURALGENTICS_DB_URL wins over setLoadedConfig", async () => {
    process.env.NEURALGENTICS_DB_URL = "postgresql://explicit:env@host/db";
    setLoadedConfig({
      mcp: {
        "memini-ai-dev": {
          env: { MEMINI_DB_URL: "postgresql://from:config@host/db" },
        },
      },
    });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    await client.start();
    await flush();
    expect(capturedCalls[0].env.NEURALGENTICS_DB_URL).toBe(
      "postgresql://explicit:env@host/db",
    );
  });

  it("start() is idempotent — concurrent calls share the same promise", async () => {
    setLoadedConfig({
      mcp: {
        "memini-ai-dev": { env: { MEMINI_DB_URL: "postgresql://u:p@h/d" } },
      },
    });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    const p1 = client.start();
    const p2 = client.start();
    expect(p1).toBe(p2);
    await p1;
    await flush();
    expect(capturedCalls.length).toBe(1);
  });

  it("start() after shutdown is a no-op (does not re-spawn)", async () => {
    setLoadedConfig({
      mcp: {
        "memini-ai-dev": { env: { MEMINI_DB_URL: "postgresql://u:p@h/d" } },
      },
    });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    await client.start();
    await flush();
    expect(capturedCalls.length).toBe(1);
    await client.shutdown();
    // After shutdown, started is false but start() returns a resolved
    // promise without re-spawning (restart is not supported).
    await client.start();
    await flush();
    expect(capturedCalls.length).toBe(1);
  });

  it("sentinel MEMINI_DB_URL values (pgembed, empty) are NOT promoted", async () => {
    setLoadedConfig({
      mcp: {
        "memini-ai-dev": { env: { MEMINI_DB_URL: "pgembed" } },
      },
    });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    await client.start();
    await flush();
    expect(capturedCalls[0].env.NEURALGENTICS_DB_URL).toBeUndefined();
  });

  it("missing memini-ai-dev block leaves NEURALGENTICS_DB_URL unset", async () => {
    setLoadedConfig({ mcp: {} });
    const client = new GoBackendClient("neuralgentics-backend", { lazy: true });
    await client.start();
    await flush();
    expect(capturedCalls[0].env.NEURALGENTICS_DB_URL).toBeUndefined();
  });
});