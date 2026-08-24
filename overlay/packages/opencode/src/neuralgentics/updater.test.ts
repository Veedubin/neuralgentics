/**
 * Tests for T-UPDATER-PATH-001: updater must never run git on end-user machines.
 *
 * OPENCODE_BASE_DIR previously hardcoded the original developer's machine
 * path, so every npm user's checkLatest() ran a doomed `git fetch` with a
 * 15s timeout. Update checking is now opt-in via NEURALGENTICS_OPENCODE_BASE_DIR
 * and silently skipped unless the dir is a real git checkout.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("NeuralgenticsUpdater dev-checkout guard (T-UPDATER-PATH-001)", () => {
  const savedEnv = process.env.NEURALGENTICS_OPENCODE_BASE_DIR;
  let mod: typeof import("./updater.js");
  let fakeCheckout: string;

  beforeEach(async () => {
    // Re-import the module under a fresh env per test — the constant is
    // captured at import time.
    delete process.env.NEURALGENTICS_OPENCODE_BASE_DIR;
    mod = await import(`./updater.js?t=${Date.now()}-${Math.random()}`);
    fakeCheckout = await mkdtemp(join(tmpdir(), "ng-updater-"));
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env.NEURALGENTICS_OPENCODE_BASE_DIR;
    } else {
      process.env.NEURALGENTICS_OPENCODE_BASE_DIR = savedEnv;
    }
    await rm(fakeCheckout, { recursive: true, force: true });
  });

  it("checkLatest returns undefined when NEURALGENTICS_OPENCODE_BASE_DIR is unset", () => {
    expect(mod.NeuralgenticsUpdater.checkLatest()).toBeUndefined();
  });

  it("checkLatest returns undefined when the configured dir has no .git", async () => {
    process.env.NEURALGENTICS_OPENCODE_BASE_DIR = fakeCheckout; // exists, not a checkout
    const fresh = await import(`./updater.js?t=${Date.now()}-nogit`);
    expect(fresh.NeuralgenticsUpdater.checkLatest()).toBeUndefined();
  });

  it("checkLatest probes git only for a real .git checkout (non-repo → undefined)", async () => {
    await mkdir(join(fakeCheckout, ".git"));
    process.env.NEURALGENTICS_OPENCODE_BASE_DIR = fakeCheckout;
    const fresh = await import(`./updater.js?t=${Date.now()}-gitdir`);
    // A .git directory without valid git internals → execSync throws → caught → undefined.
    expect(fresh.NeuralgenticsUpdater.checkLatest()).toBeUndefined();
  });
});
