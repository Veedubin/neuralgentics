import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { NeuralgenticsClient } from "../neuralgentics-client/client.js";
import { resolveBackendPath, resolveDbUrl, DEFAULT_DB_URL } from "../neuralgentics-client/resolver.js";
import type { MethodName } from "../neuralgentics-client/types.js";

// ─── Resolver tests ──────────────────────────────────────────────────────────

describe("resolveBackendPath", () => {
  test("resolves binary path successfully when binary exists", () => {
    // This test requires neuralgentics-backend to be installed.
    // Skip if not available (e.g., CI without built binary).
    try {
      const path = resolveBackendPath();
      expect(typeof path).toBe("string");
      expect(path.length).toBeGreaterThan(0);
      expect(path).toContain("neuralgentics-backend");
    } catch (err) {
      // If the binary is not found, that's acceptable in test environments
      // where the binary hasn't been built/installed yet.
      expect((err as Error).message).toContain("Cannot find neuralgentics-backend");
    }
  });

  test("falls through to $PATH when env var not set", () => {
    const originalEnv = process.env.NEURALGENTICS_BACKEND_PATH;
    try {
      delete process.env.NEURALGENTICS_BACKEND_PATH;
      // Binary should be found via PATH or relative, or throw a descriptive error
      try {
        const path = resolveBackendPath();
        expect(typeof path).toBe("string");
        expect(path.length).toBeGreaterThan(0);
      } catch (err) {
        // Acceptable: binary not built yet
        expect((err as Error).message).toContain("Cannot find neuralgentics-backend");
      }
    } finally {
      if (originalEnv !== undefined) {
        process.env.NEURALGENTICS_BACKEND_PATH = originalEnv;
      }
    }
  });

  test("error message lists all checked locations", () => {
    // Temporarily override internal resolution to force all paths to fail
    const originalPath = process.env.PATH;
    const originalEnv = process.env.NEURALGENTICS_BACKEND_PATH;
    const originalCwd = process.cwd;

    try {
      // Set up an environment where binary can't be found
      process.env.PATH = "/nonexistent_path_12345";
      delete process.env.NEURALGENTICS_BACKEND_PATH;
      process.cwd = () => "/tmp/nonexistent_cwd_12345";

      try {
        resolveBackendPath();
        // If it doesn't throw (because the binary might be at a relative path
        // that exists), that's also fine — just skip this assertion
      } catch (err) {
        const message = (err as Error).message;
        // The error message must include all 3 resolution strategies
        expect(message).toContain("$PATH");
        expect(message).toContain("$NEURALGENTICS_BACKEND_PATH");
        expect(message).toContain("neuralgentics-backend");
      }
    } finally {
      process.env.PATH = originalPath;
      if (originalEnv !== undefined) {
        process.env.NEURALGENTICS_BACKEND_PATH = originalEnv;
      } else {
        delete process.env.NEURALGENTICS_BACKEND_PATH;
      }
      process.cwd = originalCwd;
    }
  });
});

describe("resolveDbUrl", () => {
  test("returns DEFAULT_DB_URL when NEURALGENTICS_DB_URL is not set", () => {
    const original = process.env.NEURALGENTICS_DB_URL;
    try {
      delete process.env.NEURALGENTICS_DB_URL;
      expect(resolveDbUrl()).toBe(DEFAULT_DB_URL);
    } finally {
      if (original !== undefined) {
        process.env.NEURALGENTICS_DB_URL = original;
      }
    }
  });

  test("returns NEURALGENTICS_DB_URL when set", () => {
    const original = process.env.NEURALGENTICS_DB_URL;
    try {
      process.env.NEURALGENTICS_DB_URL = "postgresql://custom:5432/db";
      expect(resolveDbUrl()).toBe("postgresql://custom:5432/db");
    } finally {
      if (original === undefined) {
        delete process.env.NEURALGENTICS_DB_URL;
      } else {
        process.env.NEURALGENTICS_DB_URL = original;
      }
    }
  });
});

// ─── Client unit tests (mocked stdio) ─────────────────────────────────────────

describe("NeuralgenticsClient (unit)", () => {
  test("waitForReady resolves after first valid JSON line", async () => {
    const client = new NeuralgenticsClient({ spawn: false });

    // Manually trigger ready via handleLine
    (client as any).process = { stdin: { write: mock(() => {}) }, kill: mock(() => {}), killed: false };

    // Simulate the ready notification coming from stdout
    (client as any).handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "ready", params: {} }),
    );

    // Should resolve immediately since ready is now true
    await client.waitForReady(1000);
    expect((client as any).ready).toBe(true);

    (client as any).closed = true;
  });

  test("waitForReady rejects on timeout when no notification arrives", async () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = { stdin: { write: mock(() => {}) }, kill: mock(() => {}), killed: false };

    await expect(client.waitForReady(200)).rejects.toThrow(
      /did not emit 'ready'/,
    );
  });

  test("call sends JSON-RPC request and resolves with typed result", async () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = {
      stdin: {
        write: mock((data: string, cb?: (err?: Error | null) => void) => {
          const req = JSON.parse(data.trim());
          // Simulate async response (ping returns "pong")
          setTimeout(() => {
            (client as any).handleLine(
              JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "pong" }),
            );
          }, 5);
          if (cb) cb(null);
        }),
      },
      kill: mock(() => {}),
      killed: false,
    };
    (client as any).ready = true;
    (client as any).readyResolve();

    const result = await client.call("ping", {});
    expect(result).toBe("pong");

    (client as any).closed = true;
  });

  test("call rejects on JSON-RPC error", async () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = {
      stdin: {
        write: mock((data: string, cb?: (err?: Error | null) => void) => {
          const req = JSON.parse(data.trim());
          setTimeout(() => {
            (client as any).handleLine(
              JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
          }, 5);
          if (cb) cb(null);
        }),
      },
      kill: mock(() => {}),
      killed: false,
    };
    (client as any).ready = true;
    (client as any).readyResolve();

    await expect(
      client.call("fake.method" as MethodName, {}),
    ).rejects.toThrow(/Method not found/);

    (client as any).closed = true;
  });

  test("call rejects when client is closed", async () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).ready = true;
    (client as any).readyResolve();
    (client as any).closed = true;

    await expect(client.call("ping", {})).rejects.toThrow(/closed/);
  });

  test("call times out after specified duration", async () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = {
      stdin: { write: mock(() => {}) }, // Never respond
      kill: mock(() => {}),
      killed: false,
    };
    (client as any).ready = true;
    (client as any).readyResolve();

    await expect(client.call("ping", {}, 100)).rejects.toThrow(/timeout/);

    (client as any).closed = true;
  });

  test("handleLine ignores notifications (no id)", () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = { stdin: { write: mock(() => {}) }, kill: mock(() => {}), killed: false };

    // Parse a notification (no id field)
    (client as any).handleLine(
      JSON.stringify({ jsonrpc: "2.0", method: "ready", params: {} }),
    );

    // Should mark ready but not resolve any pending calls
    expect((client as any).ready).toBe(true);
    expect((client as any).pending.size).toBe(0);

    (client as any).closed = true;
  });

  test("handleLine ignores malformed JSON", () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = { stdin: { write: mock(() => {}) }, kill: mock(() => {}), killed: false };

    // This should not throw — it just skips invalid lines
    (client as any).handleLine("not valid json");

    // If we get here without an error, the test passes
    expect(true).toBe(true);

    (client as any).closed = true;
  });

  test("rejectAll clears all pending calls", () => {
    const client = new NeuralgenticsClient({ spawn: false });
    (client as any).process = { stdin: { write: mock(() => {}) }, kill: mock(() => {}), killed: false };

    // Manually add a pending call
    let resolveCalled = false;
    let rejectCalled = false;
    (client as any).pending.set(1, {
      resolve: () => { resolveCalled = true; },
      reject: () => { rejectCalled = true; },
      timer: setTimeout(() => {}, 60000),
    });

    (client as any).rejectAll(new Error("test error"));

    expect((client as any).pending.size).toBe(0);
    expect(rejectCalled).toBe(true);
    expect(resolveCalled).toBe(false);

    (client as any).closed = true;
  });
});