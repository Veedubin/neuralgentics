/**
 * Tests for T-VERSIONS-001: plugin VERSION constant must match package.json.
 *
 * The overlay previously reported VERSION "0.2.0" while the shipped npm
 * package was 0.16.x — drift made support/debugging ambiguous. This test
 * mechanically pins the constant to the package version so future bumps
 * that forget server.ts fail the gate.
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("version consistency (T-VERSIONS-001)", () => {
  it("server.ts VERSION matches overlay package.json version", async () => {
    const pkg = JSON.parse(
      await readFile(
        resolve(import.meta.dir, "..", "..", "package.json"),
        "utf-8",
      ),
    ) as { version: string };

    // Import the constant via the exported module surface: server.ts only
    // exports the function surface, so read the source instead — cheap and
    // exact.
    const src = await readFile(resolve(import.meta.dir, "..", "server.ts"), "utf-8");
    const match = src.match(/const VERSION = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.version);
  });
});
