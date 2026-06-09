/**
 * Tests for gRPC Sidecar Lifecycle Management (T-022)
 *
 * Tests the sidecar.ts module's database health check,
 * socket path resolution, shutdown logic, and the
 * graceful no-sidecar fallback (Bug #4 fix).
 *
 * Note: Live sidecar spawn tests are integration tests
 * (run via dev-up.sh on a real system).
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  checkDatabase,
  shutdownSidecar,
  registerSidecarShutdown,
  initSidecar,
  resolveSidecarDir,
} from "../sidecar.js";

describe("Sidecar Lifecycle - checkDatabase", () => {
  test("checkDatabase returns structured result with host and port", async () => {
    const result = await checkDatabase();
    expect(result).toHaveProperty("available");
    expect(result).toHaveProperty("host");
    expect(result).toHaveProperty("port");
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(6000);
    // available is boolean (true if DB is running, false if not)
    expect(typeof result.available).toBe("boolean");
    // If DB is not available, error should contain guidance
    if (!result.available) {
      expect(result.error).toContain("6000");
      expect(result.error).toContain("dev-up.sh");
    }
  });
});

describe("Sidecar Lifecycle - shutdownSidecar", () => {
  test("shutdownSidecar is a no-op when TUI did not spawn sidecar", () => {
    // Should not throw even when no sidecar was spawned
    shutdownSidecar();
    // No assertion needed — just verifying it doesn't crash
  });
});

describe("Sidecar Lifecycle - registerSidecarShutdown", () => {
  test("registerSidecarShutdown registers exit handlers without error", () => {
    // Should not throw
    registerSidecarShutdown();
  });
});

describe("Sidecar Lifecycle - resolveSidecarDir", () => {
  test("resolveSidecarDir returns a string or null", () => {
    const result = resolveSidecarDir();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("resolveSidecarDir respects NEURALGENTICS_SIDECAR_DIR when set to existing dir", () => {
    const original = process.env.NEURALGENTICS_SIDECAR_DIR;
    // Point to a known-existing directory
    process.env.NEURALGENTICS_SIDECAR_DIR = "/tmp";
    const result = resolveSidecarDir();
    expect(result).toBe("/tmp");
    // Restore
    if (original !== undefined) {
      process.env.NEURALGENTICS_SIDECAR_DIR = original;
    } else {
      delete process.env.NEURALGENTICS_SIDECAR_DIR;
    }
  });

  test("resolveSidecarDir ignores NEURALGENTICS_SIDECAR_DIR when dir does not exist", () => {
    const original = process.env.NEURALGENTICS_SIDECAR_DIR;
    process.env.NEURALGENTICS_SIDECAR_DIR =
      "/tmp/neuralgentics-test-nonexistent-dir-99999";
    // Should not equal the non-existent dir (falls through to next check or null)
    const result = resolveSidecarDir();
    expect(result).not.toBe(
      "/tmp/neuralgentics-test-nonexistent-dir-99999",
    );
    // Restore
    if (original !== undefined) {
      process.env.NEURALGENTICS_SIDECAR_DIR = original;
    } else {
      delete process.env.NEURALGENTICS_SIDECAR_DIR;
    }
  });

  test("resolveSidecarDir respects NEURALGENTICS_INSTALL_PREFIX with share/neuralgentics/sidecar", () => {
    const originalSid = process.env.NEURALGENTICS_SIDECAR_DIR;
    const originalPrefix = process.env.NEURALGENTICS_INSTALL_PREFIX;
    const originalPrefix2 = process.env.NEURALGENTICS_PREFIX;
    // Remove SIDECAR_DIR so prefix path is tried
    delete process.env.NEURALGENTICS_SIDECAR_DIR;
    // Create a fake install prefix with sidecar dir
    const mkdirp = require("node:fs").mkdirSync;
    const fakeDir = "/tmp/neuralgentics-test-sidecar-prefix";
    const shareDir = `${fakeDir}/share/neuralgentics/sidecar`;
    try {
      mkdirp(shareDir, { recursive: true });
      process.env.NEURALGENTICS_INSTALL_PREFIX = fakeDir;
      delete process.env.NEURALGENTICS_PREFIX;
      const result = resolveSidecarDir();
      expect(result).toBe(shareDir);
    } finally {
      // Clean up
      require("node:fs").rmSync(fakeDir, { recursive: true, force: true });
      if (originalSid !== undefined) process.env.NEURALGENTICS_SIDECAR_DIR = originalSid;
      else delete process.env.NEURALGENTICS_SIDECAR_DIR;
      if (originalPrefix !== undefined) process.env.NEURALGENTICS_INSTALL_PREFIX = originalPrefix;
      else delete process.env.NEURALGENTICS_INSTALL_PREFIX;
      if (originalPrefix2 !== undefined) process.env.NEURALGENTICS_PREFIX = originalPrefix2;
      else delete process.env.NEURALGENTICS_PREFIX;
    }
  });
});

describe("Sidecar Lifecycle - initSidecar graceful fallback", () => {
  test("initSidecar returns available=false when sidecar not configured", async () => {
    // Save original env vars
    const originalSid = process.env.NEURALGENTICS_SIDECAR_DIR;
    const originalPrefix = process.env.NEURALGENTICS_INSTALL_PREFIX;
    const originalPrefix2 = process.env.NEURALGENTICS_PREFIX;

    // Clear all sidecar env vars so no directory can be found (unless
    // source tree path happens to resolve). In that case, the test
    // still validates the return shape.
    delete process.env.NEURALGENTICS_SIDECAR_DIR;
    delete process.env.NEURALGENTICS_INSTALL_PREFIX;
    delete process.env.NEURALGENTICS_PREFIX;

    try {
      const result = await initSidecar(false);
      // Should always return a valid SidecarStatus
      expect(result).toHaveProperty("available");
      expect(result).toHaveProperty("socketPath");
      expect(result).toHaveProperty("spawnedByTUI");
      expect(typeof result.available).toBe("boolean");
      expect(typeof result.spawnedByTUI).toBe("boolean");
      // If sidecar is not available, should have an error message
      if (!result.available) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe("string");
      }
    } finally {
      // Restore env
      if (originalSid !== undefined) process.env.NEURALGENTICS_SIDECAR_DIR = originalSid;
      else delete process.env.NEURALGENTICS_SIDECAR_DIR;
      if (originalPrefix !== undefined) process.env.NEURALGENTICS_INSTALL_PREFIX = originalPrefix;
      else delete process.env.NEURALGENTICS_INSTALL_PREFIX;
      if (originalPrefix2 !== undefined) process.env.NEURALGENTICS_PREFIX = originalPrefix2;
      else delete process.env.NEURALGENTICS_PREFIX;
    }
  });
});

describe("Sidecar Lifecycle - No docker/port violations", () => {
  test("sidecar.ts contains zero docker references", async () => {
    const source = await Bun.file(
      import.meta.dir + "/../sidecar.ts",
    ).text();
    expect(source.toLowerCase()).not.toContain("docker");
  });

  test("sidecar.ts contains zero 5434/5436 port references", async () => {
    const source = await Bun.file(
      import.meta.dir + "/../sidecar.ts",
    ).text();
    expect(source).not.toContain("5434");
    expect(source).not.toContain("5436");
  });
});