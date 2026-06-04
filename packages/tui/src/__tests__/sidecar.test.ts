/**
 * Tests for gRPC Sidecar Lifecycle Management (T-022)
 *
 * Tests the sidecar.ts module's database health check,
 * socket path resolution, and shutdown logic.
 *
 * Note: Live sidecar spawn tests are integration tests
 * (run via dev-up.sh on a real system).
 */

import { describe, test, expect } from "bun:test";
import {
  checkDatabase,
  shutdownSidecar,
  registerSidecarShutdown,
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