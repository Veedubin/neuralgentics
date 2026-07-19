/**
 * Tests for the library-file-based sysdeps probe.
 *
 * Background: Ubuntu 24.04 renamed `libglib2.0-0` → `libglib2.0-0t64` as
 * part of the 64-bit time_t ("t64") transition. The old code checked for
 * the dpkg package name `libglib2.0-0`, which no longer exists in 24.04+
 * repos — so `dpkg -l libglib2.0-0` ALWAYS reported "not installed",
 * causing `neuralgentics --init-homedir` to prompt the user to install it
 * on EVERY run, even though the actual `.so` file was already present.
 *
 * The fix replaces the dpkg-name check with a probe for the `.so` file
 * via `ldconfig -p` (with an `fs.existsSync` fast path). These tests
 * verify the new probe using mocked ldconfig output and the
 * `_setLdconfigCache` / `_resetLdconfigCache` test hooks.
 *
 * Uses bun:test — the project's test framework.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  libraryInstalled,
  aptPkgFor,
  _setLdconfigCache,
  _resetLdconfigCache,
} from "./sysdeps.js";

// ============================================================================
// Sample ldconfig -p outputs
// ============================================================================

/**
 * A realistic Ubuntu 24.04 ldconfig -p excerpt containing both libGL.so.1
 * and libglib-2.0.so.0 (the libraries videre-mcp needs).
 */
const UBUNTU_2404_LDCONFIG = [
  "1041 libs found in cache `/etc/ld.so.cache'",
  "\tlibGL.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libGL.so.1",
  "\tlibglib-2.0.so.0 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0",
  "\tlibgio-2.0.so.0 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libgio-2.0.so.0",
  "\tlibgobject-2.0.so.0 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libgobject-2.0.so.0",
  "\tlibc.so.6 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libc.so.6",
].join("\n");

/**
 * ldconfig output with NO glib and NO GL — simulates a system where both
 * libraries are genuinely missing.
 */
const EMPTY_LDCONFIG = [
  "3 libs found in cache `/etc/ld.so.cache'",
  "\tlibc.so.6 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libc.so.6",
].join("\n");

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  _resetLdconfigCache();
});

describe("libraryInstalled — ldconfig -p parsing", () => {
  it("returns true when libglib-2.0.so.0 is in ldconfig -p (Ubuntu 24.04 t64)", () => {
    _setLdconfigCache(UBUNTU_2404_LDCONFIG);
    // Pass empty knownPaths so we exercise the ldconfig path only.
    const present = libraryInstalled("libglib-2.0.so.0", []);
    expect(present).toBe(true);
  });

  it("returns true when libGL.so.1 is in ldconfig -p", () => {
    _setLdconfigCache(UBUNTU_2404_LDCONFIG);
    const present = libraryInstalled("libGL.so.1", []);
    expect(present).toBe(true);
  });

  it("returns false when neither file exists nor ldconfig has the entry", () => {
    _setLdconfigCache(EMPTY_LDCONFIG);
    // Use a knownPaths entry that does NOT exist on the test machine
    // (we never want a real /usr/lib path to make this test flaky).
    const present = libraryInstalled("libglib-2.0.so.0", [
      "/definitely/not/a/real/path/libglib-2.0.so.0",
    ]);
    expect(present).toBe(false);
  });

  it("does not false-positive on a similar but different soname", () => {
    _setLdconfigCache(UBUNTU_2404_LDCONFIG);
    // libglib-2.0.so (without the .0) is a different file; we should not
    // match a prefix of an existing entry.
    const present = libraryInstalled("libglib-2.0.so", []);
    expect(present).toBe(false);
  });
});

describe("libraryInstalled — knownPaths fast path", () => {
  it("returns true when the .so file exists at a known absolute path", () => {
    // Point at a file we know exists on every test run — the bun test
    // runner itself. This exercises the existsSync branch without depending
    // on system libraries being installed on the test host.
    const bunPath = process.execPath;
    const present = libraryInstalled("whatever.so", [bunPath]);
    expect(present).toBe(true);
  });

  it("falls back to ldconfig when knownPaths do not exist", () => {
    _setLdconfigCache(UBUNTU_2404_LDCONFIG);
    const present = libraryInstalled("libGL.so.1", [
      "/definitely/not/a/real/path/libGL.so.1",
    ]);
    expect(present).toBe(true);
  });
});

describe("libraryInstalled — empty ldconfig (non-glibc / sandbox)", () => {
  it("returns false gracefully when ldconfig is unavailable", () => {
    // Empty cache simulates ldconfig being absent (e.g. Alpine, sandboxes).
    _setLdconfigCache("");
    const present = libraryInstalled("libglib-2.0.so.0", [
      "/definitely/not/a/real/path/libglib-2.0.so.0",
    ]);
    expect(present).toBe(false);
  });
});

// ============================================================================
// aptPkgFor — version-aware apt package name resolution
// ============================================================================
//
// Background: `aptPkgFor("libglib2.0-0")` is called when the .so is missing
// and we need to suggest an apt install. Ubuntu 24.04+ ships the package as
// `libglib2.0-0t64` (t64 transition), Ubuntu <=22.04 ships it as
// `libglib2.0-0`. The function must probe the current distro's apt cache and
// return the right one, otherwise we ship a broken install command.

describe("aptPkgFor — version-aware apt package name resolution", () => {
  // We mock execSync (which sysdeps.ts imports from "node:child_process") so
  // apt-cache calls don't actually run. The mock returns exit-0 for the
  // "known" package names and exit-1 for "unknown" ones.

  let execSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Default mock: every apt-cache call succeeds.
    execSyncSpy = spyOn(childProcess, "execSync")
      .mockImplementation((() => Buffer.from("")) as never);
  });

  function setAptKnown(...knownPkgs: string[]) {
    execSyncSpy.mockImplementation(((cmd: string) => {
      // Match `apt-cache show <pkg>` and only succeed for known pkgs.
      const m = cmd.match(/^apt-cache show (\S+)/);
      if (m && knownPkgs.includes(m[1])) {
        return Buffer.from("Package: " + m[1] + "\n");
      }
      throw new Error(`apt-cache: package '${m?.[1] ?? cmd}' not found`);
    }) as never);
  }

  it("returns the t64 package name on Ubuntu 24.04+ (where libglib2.0-0t64 is the canonical name)", () => {
    setAptKnown("libglib2.0-0t64");
    expect(aptPkgFor("libglib2.0-0")).toBe("libglib2.0-0t64");
  });

  it("returns the legacy package name on Ubuntu 22.04 and earlier (where libglib2.0-0 is the canonical name)", () => {
    setAptKnown("libglib2.0-0");
    expect(aptPkgFor("libglib2.0-0")).toBe("libglib2.0-0");
  });

  it("prefers the t64 name first (tried before the legacy name)", () => {
    // Both names are known — we should return t64 (the preferred-first order).
    setAptKnown("libglib2.0-0t64", "libglib2.0-0");
    expect(aptPkgFor("libglib2.0-0")).toBe("libglib2.0-0t64");
  });

  it("returns the input name unchanged if the lib is not in the table (safe fallback)", () => {
    expect(aptPkgFor("totally-unknown-lib")).toBe("totally-unknown-lib");
  });
});