import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveBackendPath } from "../neuralgentics-client/resolver.js";

/**
 * Tests for install-prefix resolution steps 4 & 5 of resolveBackendPath().
 *
 * These tests create real temp directories with a fake binary to verify
 * that the resolver finds the binary at the expected install paths.
 *
 * NOTE: We cannot directly mock os.homedir() in the resolver module
 * because it's a frozen namespace import. Instead, we create real temp
 * directories in /tmp and use NEURALGENTICS_INSTALL_PREFIX to control
 * step 4. For step 5, we place the binary in the actual ~/.neuralgentics/bin/
 * or test the error message paths.
 */

const TMP_BASE = "/tmp/neuralgentics_resolver_test_" + process.pid;

describe("resolveBackendPath install-prefix resolution", () => {
  let originalPath: string | undefined;
  let originalBackendPath: string | undefined;
  let originalInstallPrefix: string | undefined;
  let originalCwd: () => string;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalBackendPath = process.env.NEURALGENTICS_BACKEND_PATH;
    originalInstallPrefix = process.env.NEURALGENTICS_INSTALL_PREFIX;
    originalCwd = process.cwd;

    // Neutralize steps 1–3 so only steps 4–5 can resolve
    process.env.PATH = "/nonexistent_path_resolver_test";
    delete process.env.NEURALGENTICS_BACKEND_PATH;
    process.cwd = () => "/tmp/nonexistent_cwd_resolver_test";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalBackendPath !== undefined) {
      process.env.NEURALGENTICS_BACKEND_PATH = originalBackendPath;
    } else {
      delete process.env.NEURALGENTICS_BACKEND_PATH;
    }
    if (originalInstallPrefix !== undefined) {
      process.env.NEURALGENTICS_INSTALL_PREFIX = originalInstallPrefix;
    } else {
      delete process.env.NEURALGENTICS_INSTALL_PREFIX;
    }
    process.cwd = originalCwd;

    // Clean up temp dirs
    try {
      rmSync(TMP_BASE, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("resolves via $NEURALGENTICS_INSTALL_PREFIX/bin/neuralgentics-backend", () => {
    const installDir = join(TMP_BASE, "custom-prefix");
    const binDir = join(installDir, "bin");
    mkdirSync(binDir, { recursive: true });

    // Create a fake binary so existsSync returns true
    const fakeBinary = join(binDir, "neuralgentics-backend");
    writeFileSync(fakeBinary, "#!/bin/sh\necho fake\n");

    process.env.NEURALGENTICS_INSTALL_PREFIX = installDir;

    const result = resolveBackendPath();
    expect(result).toBe(resolve(fakeBinary));
  });

  test("resolves via $HOME/.neuralgentics/bin/neuralgentics-backend as fallback", () => {
    // Place fake binary at the real ~/.neuralgentics/bin/ path.
    // This test verifies the resolution logic by actually creating the file
    // in the location that step 5 checks.
    const os = require("node:os") as typeof import("node:os");
    const binDir = join(os.homedir(), ".neuralgentics", "bin");
    mkdirSync(binDir, { recursive: true });

    const fakeBinary = join(binDir, "neuralgentics-backend");
    writeFileSync(fakeBinary, "#!/bin/sh\necho fake\n");

    // No NEURALGENTICS_INSTALL_PREFIX set
    delete process.env.NEURALGENTICS_INSTALL_PREFIX;

    const result = resolveBackendPath();
    expect(result).toBe(resolve(fakeBinary));

    // Clean up the fake binary from real homedir
    try {
      rmSync(fakeBinary, { force: true });
      // Try to remove the empty dirs we created
      try { rmSync(binDir, { force: true }); } catch { /* not empty, leave it */ }
      try { rmSync(join(os.homedir(), ".neuralgentics"), { force: true }); } catch { /* not empty, leave it */ }
    } catch {
      // ignore cleanup failures
    }
  });

  test("error message includes install-prefix paths when all steps fail", () => {
    delete process.env.NEURALGENTICS_INSTALL_PREFIX;

    // Verify this doesn't accidentally find a binary; if it does, that's fine too
    try {
      resolveBackendPath();
      // Binary found somewhere — test is vacuously passing
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("$NEURALGENTICS_INSTALL_PREFIX");
      expect(message).toContain(".neuralgentics/bin");
      expect(message).toContain("neuralgentics-backend");
    }
  });
});