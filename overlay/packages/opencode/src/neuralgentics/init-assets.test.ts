/**
 * Tests for `copyStaticAssets` in init.ts — specifically the AGENTS.md
 * bootstrap fix (card T-INIT-AGENTS-001).
 *
 * Regression coverage for two bugs:
 *   Bug A (PATH): AGENTS.md was copied into `.opencode/AGENTS.md` but
 *     opencode.json `instructions: ["AGENTS.md"]` resolves at the PROJECT
 *     ROOT. Fresh installs had zero bootstrap guidance.
 *   Bug B (CONTENT): The shipped `overlay/.opencode/AGENTS.md` was the
 *     "--remodel Model Remodeling" WIP doc (since v0.15.18, commit 51b4558),
 *     not a getting-started guide.
 *
 * These tests assert:
 *   - Fresh temp-dir init → root `AGENTS.md` exists with bootstrap markers.
 *   - Pre-existing root AGENTS.md is NOT clobbered (byte-identical after).
 *   - Re-running (idempotency) does not clobber or duplicate.
 *   - The generated root AGENTS.md does NOT contain "--remodel" markers.
 *
 * Uses bun:test with a temp directory per test — never touches the real
 * config dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { copyStaticAssets } from "./init.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

describe("copyStaticAssets — AGENTS.md bootstrap (T-INIT-AGENTS-001)", () => {
  let tmpRoot: string;
  let projectRoot: string;
  let opencodeDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neuralgentics-init-assets-"));
    projectRoot = path.join(tmpRoot, "myproject");
    opencodeDir = path.join(projectRoot, ".opencode");
    mkdirSync(opencodeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes AGENTS.md to the PROJECT ROOT (not .opencode/) on a fresh init", async () => {
    const result = await copyStaticAssets(opencodeDir, false);

    // Root AGENTS.md must exist (project root, not .opencode/).
    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    expect(existsSync(rootAgentsMd)).toBe(true);

    // The .opencode/AGENTS.md path must NOT be where it landed. (Bug A regression.)
    const opencodeAgentsMd = path.join(opencodeDir, "AGENTS.md");
    // Note: copyStaticAssets does not write to .opencode/AGENTS.md at all now.
    // It may or may not pre-exist from a prior flow; here it must not exist
    // because we never wrote it.
    expect(existsSync(opencodeAgentsMd)).toBe(false);

    // The copy flag must be true.
    expect(result.agentsMd).toBe(true);
  });

  it("the generated root AGENTS.md contains bootstrap markers (memini-ai, Quickstart)", async () => {
    await copyStaticAssets(opencodeDir, false);

    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    const content = readFileSync(rootAgentsMd, "utf-8");

    // Bootstrap content markers — these are the generic getting-started
    // markers that MUST be present (Bug B fix).
    expect(content).toContain("memini-ai");
    expect(content).toContain("neuralgentics");
    // A getting-started / quickstart section must be present.
    expect(content.toLowerCase()).toMatch(/quickstart|getting started|your first session/);
    // The agent roster reference must be present.
    expect(content.toLowerCase()).toContain("agent roster");
  });

  it("the generated root AGENTS.md does NOT contain the remodel WIP markers (Bug B)", async () => {
    await copyStaticAssets(opencodeDir, false);

    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    const content = readFileSync(rootAgentsMd, "utf-8");

    // The v0.15.18 remodel WIP doc must NOT be what lands at the root.
    // "## Model Remodeling" was the H1 of the WIP doc that replaced the
    // proper bootstrap since v0.15.18. It must not be the leading section.
    expect(content).not.toContain("## Model Remodeling");
    // The --remodel command reference may appear in the house rules (we kept
    // a one-liner there), but it must NOT be the H1/H2 section title.
    expect(content.startsWith("## Model Remodeling")).toBe(false);
    // The big "Run the remodel command:" block must not be the body.
    expect(content).not.toContain("Run the remodel command:");
  });

  it("does NOT overwrite a pre-existing root AGENTS.md (byte-identical after)", async () => {
    // Pre-existing root AGENTS.md with sentinel content.
    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    const sentinel = "# My Project\n\nThis is my custom AGENTS.md. Do not touch.\n";
    await fs.writeFile(rootAgentsMd, sentinel, "utf-8");
    const sentinelSha = sha256(sentinel);

    const result = await copyStaticAssets(opencodeDir, false);

    // agentsMd must be false (we did not copy).
    expect(result.agentsMd).toBe(false);

    // File must be byte-identical (not clobbered).
    const after = readFileSync(rootAgentsMd, "utf-8");
    expect(sha256(after)).toBe(sentinelSha);
    expect(after).toBe(sentinel);
  });

  it("is idempotent — a second run does not clobber or duplicate", async () => {
    // First run: fresh init.
    await copyStaticAssets(opencodeDir, false);
    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    expect(existsSync(rootAgentsMd)).toBe(true);
    const firstContent = readFileSync(rootAgentsMd, "utf-8");
    const firstSha = sha256(firstContent);

    // Second run: must NOT modify the file (it already exists → skip).
    const result2 = await copyStaticAssets(opencodeDir, false);
    expect(result2.agentsMd).toBe(false); // already exists → not copied

    const secondContent = readFileSync(rootAgentsMd, "utf-8");
    expect(sha256(secondContent)).toBe(firstSha);
    expect(secondContent).toBe(firstContent);
  });

  it("--update flow (dry-run) does not write AGENTS.md and reports not-copied", async () => {
    // Dry-run must not write anything.
    const result = await copyStaticAssets(opencodeDir, true);

    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    expect(existsSync(rootAgentsMd)).toBe(false);
    // In dry-run, agentsMd reflects "would copy" only if absent. The flag
    // is set when the copy would happen — we treat dry-run as "would copy"
    // so callers can preview. Verify the file was NOT actually written.
    expect(result.agentsMd).toBe(true); // would-copy signaled
    expect(existsSync(rootAgentsMd)).toBe(false); // but nothing on disk
  });

  it("dry-run does not overwrite a pre-existing root AGENTS.md", async () => {
    const rootAgentsMd = path.join(projectRoot, "AGENTS.md");
    const sentinel = "# Existing\n\ncustom\n";
    await fs.writeFile(rootAgentsMd, sentinel, "utf-8");

    const result = await copyStaticAssets(opencodeDir, true);
    expect(result.agentsMd).toBe(false);

    const after = readFileSync(rootAgentsMd, "utf-8");
    expect(after).toBe(sentinel);
  });
});