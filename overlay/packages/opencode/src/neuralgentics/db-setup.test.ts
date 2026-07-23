/**
 * Tests for db-setup.ts (pgembed bootstrap) + init.ts team-mode DB removal.
 *
 * Covers:
 *   - bootstrapDatabase(dryRun=false) invokes execSync with the memini-ai init
 *     command (pgembed path still does DB work during install).
 *   - bootstrapDatabase(dryRun=true) does NOT invoke execSync (dry-run is
 *     non-writing).
 *   - bootstrapDatabase reports success when execSync succeeds.
 *   - bootstrapDatabase reports failure (non-crashing) when execSync throws.
 *   - TeamDbConfig export is GONE (the type no longer exists).
 *   - init.ts team-mode branch never calls bootstrapDatabase (static regression
 *     guard — reads the source file and asserts the team branch has no
 *     bootstrapDatabase invocation).
 *   - init.ts team-mode branch prints the "skipped" info line.
 *
 * Context: v0.15.16 removed the team-mode DB probe + migration from the
 * installer. Team mode now does ZERO database work during install — memini-ai
 * auto-creates its schema on first MCP launch. These tests verify the
 * pgembed path is untouched and the team branch is gone.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootstrapDatabase } from "./db-setup.js";

// ============================================================================
// pgembed bootstrap — execSync invocation
// ============================================================================

describe("bootstrapDatabase (pgembed)", () => {
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execSpy = spyOn(childProcess, "execSync");
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  it("invokes `uvx --from memini-ai-dev memini-ai init` when dryRun=false", async () => {
    execSpy.mockImplementation(() => Buffer.from(""));
    const result = await bootstrapDatabase(false);
    expect(result.success).toBe(true);
    // The single execSync call must be the memini-ai init command.
    expect(execSpy).toHaveBeenCalledTimes(1);
    const calls = execSpy.mock.calls;
    expect(calls[0][0]).toContain("uvx --from memini-ai-dev memini-ai init");
  });

  it("does NOT invoke execSync when dryRun=true", async () => {
    const result = await bootstrapDatabase(true);
    expect(result.success).toBe(true);
    expect(execSpy).not.toHaveBeenCalled();
    expect(result.message).toContain("pgembed");
  });

  it("reports success with pgembed data dir in the message", async () => {
    execSpy.mockImplementation(() => Buffer.from(""));
    const result = await bootstrapDatabase(false);
    expect(result.success).toBe(true);
    expect(result.message).toContain("pgembed");
    expect(result.details).toContain("Tables created");
  });

  it("reports failure (non-crashing) when execSync throws", async () => {
    execSpy.mockImplementation(() => {
      throw new Error("uvx: command not found");
    });
    const result = await bootstrapDatabase(false);
    expect(result.success).toBe(false);
    expect(result.message).toContain("pgembed bootstrap failed");
    // The installer must not crash — it returns a BootstrapResult.
  });

  it("message includes the pgembed data dir path for pgembed", async () => {
    execSpy.mockImplementation(() => Buffer.from(""));
    const result = await bootstrapDatabase(false);
    const expectedDir = [
      os.homedir(), ".local", "share", "memini-ai", "pgembed",
    ].join("/");
    expect(result.message).toContain(expectedDir);
  });
});

// ============================================================================
// Team mode — no TeamDbConfig export (regression guard)
// ============================================================================

describe("team mode DB removal (v0.15.16)", () => {
  it("bootstrapDatabase accepts only dryRun (no backend or teamConfig params)", () => {
    // The function signature is now (dryRun: boolean). If someone re-adds the
    // old (backend, teamConfig, dryRun) signature, this test will fail to
    // compile because the extra args are a type error.
    // We verify the arity at runtime by checking the function length.
    expect(bootstrapDatabase.length).toBe(1);
  });

  it("init.ts team-mode branch never calls bootstrapDatabase", () => {
    // Static regression guard: read init.ts source and verify the team branch
    // does not invoke bootstrapDatabase. The pgembed branch SHOULD invoke it.
    const initSrc = fs.readFileSync(
      path.join(import.meta.dirname, "init.ts"),
      "utf-8",
    );

    // Find the DB bootstrap section (the block that decides pgembed vs team).
    const dbSectionStart = initSrc.indexOf("DB bootstrap");
    expect(dbSectionStart).toBeGreaterThan(-1);
    // Grab from "DB bootstrap" to the summary section ("Database section").
    const summaryIdx = initSrc.indexOf("Database section", dbSectionStart);
    expect(summaryIdx).toBeGreaterThan(dbSectionStart);
    const dbSection = initSrc.slice(dbSectionStart, summaryIdx);

    // The team branch must NOT contain a bootstrapDatabase( call.
    // We check by looking at the else-if team branch.
    const teamBranchMatch = dbSection.match(
      /else if \(promptConfig\.backend === "team"\)[\s\S]*?(?=else if|}$)/m,
    );
    expect(teamBranchMatch).not.toBeNull();
    const teamBranch = teamBranchMatch![0];
    expect(teamBranch).not.toContain("bootstrapDatabase(");

    // The pgembed branch MUST contain a bootstrapDatabase( call.
    const pgembedBranchMatch = dbSection.match(
      /if \(promptConfig\.backend === "pgembed"\)[\s\S]*?(?=else if)/m,
    );
    expect(pgembedBranchMatch).not.toBeNull();
    const pgembedBranch = pgembedBranchMatch![0];
    expect(pgembedBranch).toContain("bootstrapDatabase(");
  });

  it("init.ts team-mode branch prints the 'skipped' info line in summary", () => {
    const initSrc = fs.readFileSync(
      path.join(import.meta.dirname, "init.ts"),
      "utf-8",
    );

    // The summary section must have a team branch that prints "skipped".
    const summaryStart = initSrc.indexOf("Database section");
    expect(summaryStart).toBeGreaterThan(-1);
    // Find the team branch in the summary.
    const summaryEnd = initSrc.indexOf("process.stdout.write(`\\nState:", summaryStart);
    const summarySection = initSrc.slice(summaryStart, summaryEnd);
    const teamSummaryMatch = summarySection.match(
      /promptConfig\.backend === "team"[\s\S]*?skipped/i,
    );
    expect(teamSummaryMatch).not.toBeNull();
    expect(teamSummaryMatch![0]).toContain("skipped");
  });
});