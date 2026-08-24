/**
 * Tests for T-CFG-SHIP-001 + T-CFG-PRUNE-001: template config hygiene.
 *
 * Guards three invariants:
 *   1. NO builder output ever contains `compaction.prune: true` — Session 33
 *      root-caused TUI token-counter breakage + prompt-cache destruction to
 *      exactly this setting; a regression would silently re-break caching
 *      for every new install.
 *   2. The generated tarball template (gen-template-config.mjs → builder)
 *      contains ONLY the minimal project surface: no maintainer-personal
 *      plugins, exactly one enabled MCP server.
 *   3. The repo-root dev config keeps prune:false (informational guard so a
 *      local revert of the Session 33 fix fails loudly here).
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProjectOpencodeJson,
  buildHomedirOpencodeJson,
} from "./init.js";

const here = dirname(fileURLToPath(import.meta.url));

function hasPruneTrue(obj: unknown): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some(hasPruneTrue);
  const rec = obj as Record<string, unknown>;
  if (rec["prune"] === true) return true;
  return Object.values(rec).some(hasPruneTrue);
}

describe("template config hygiene (T-CFG-SHIP-001 / T-CFG-PRUNE-001)", () => {
  it("buildProjectOpencodeJson emits no prune:true", () => {
    const cfg = buildProjectOpencodeJson({ backend: "pgembed", embedding: "auto" });
    expect(hasPruneTrue(cfg)).toBe(false);
  });

  it("buildHomedirOpencodeJson emits no prune:true", () => {
    const cfg = buildHomedirOpencodeJson({ backend: "pgembed", embedding: "auto" });
    expect(hasPruneTrue(cfg)).toBe(false);
  });

  it("project template ships exactly one enabled MCP server and no personal plugins", () => {
    const cfg = buildProjectOpencodeJson({ backend: "pgembed", embedding: "auto" }) as {
      plugin: string[];
      mcp: Record<string, { enabled: boolean }>;
    };
    const enabled = Object.entries(cfg.mcp)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    expect(enabled).toEqual(["memini-ai-dev"]);
    for (const p of cfg.plugin) {
      expect(p.includes("@franlol")).toBe(false);
      expect(p.includes("md-table-formatter")).toBe(false);
    }
  });

  it("repo-root dev config still has compaction.prune:false (Session 33 guard)", async () => {
    // here = <root>/overlay/packages/opencode/src/neuralgentics → 5 ups = repo root
    const raw = await readFile(
      resolve(here, "..", "..", "..", "..", "..", ".opencode", "opencode.json"),
      "utf-8",
    );
    expect(raw.includes('"prune": true')).toBe(false);
    expect(raw.includes('"prune": false')).toBe(true);
  });
});
