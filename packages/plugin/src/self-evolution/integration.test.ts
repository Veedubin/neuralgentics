/**
 * Neuralgentics — Skill Lookup Integration Tests
 *
 * End-to-end tests for the skill lookup pipeline:
 *   StubBrokerClient → SkillLookup.pickSkill → loadSkillBody
 *
 * Uses bun:test — the project's test framework.
 * Creates real temp directories with SKILL.md files for disk I/O tests.
 */

import { describe, it, expect } from "bun:test";
import { SkillLookup, loadSkillBody } from "./skill_lookup.js";
import { StubBrokerClient } from "./broker_client.js";
import type { SkillCatalogResponse } from "./broker_client.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ============================================================================
// Integration Tests — Full Pipeline
// ============================================================================

describe("SkillLookup integration", () => {
  it("should match testing skill for regression test query", async () => {
    // Create a temp dir with a real SKILL.md file
    const tmpDir = join(tmpdir(), `skill-lookup-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const skillPath = join(tmpDir, "SKILL.md");
    const skillBody = `---
name: regression-tester
description: Run regression tests and verify builds
tags:
  - verification
  - quality
  - regression
  - e2e
---
# Regression Tester

Run the full regression suite and verify build output.
`;
    await writeFile(skillPath, skillBody, "utf-8");

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "regression-tester",
            description: "Run regression tests and verify builds",
            source: "local",
            tags: ["verification", "quality", "regression", "e2e"],
            path: skillPath,
            size_bytes: skillBody.length,
            agent_scope: ["tester"],
          },
        ],
        total_skills: 1,
        role: "tester",
        source: "local",
      };
      const stub = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stub);

      // Query: "verify regression tests builds quality"
      // Tokens: {verify, regression, tests, builds, quality}
      // Skill haystack: "regression-tester Run regression tests and verify builds verification quality regression e2e"
      // Tokens: {regression, tester, run, tests, verify, builds, verification, quality, e2e}
      // Intersection: {verify, regression, tests, builds, quality} → size 5
      // |A| = 5, |B| = 9
      // cosine = 5 / sqrt(5 * 9) = 5 / sqrt(45) ≈ 0.745 ≥ 0.6 ✓
      const result = await lookup.pickSkill(
        "verify regression tests builds quality",
        "tester",
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe("regression-tester");
      expect(result!.score).toBeGreaterThanOrEqual(0.6);
      expect(result!.body).toContain("Regression Tester");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return null for completely unrelated query", async () => {
    const tmpDir = join(tmpdir(), `skill-lookup-unrelated-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const skillPath = join(tmpDir, "SKILL.md");
    await writeFile(
      skillPath,
      "# Coder Skill\nWrite code fast.",
      "utf-8",
    );

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "code-gen",
            description: "Generate production code",
            source: "local",
            tags: ["implementation", "code", "generation"],
            path: skillPath,
            size_bytes: 30,
            agent_scope: ["coder"],
          },
        ],
        total_skills: 1,
        role: "tester",
        source: "local",
      };
      const stub = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stub);

      // "completely unrelated query about quantum physics"
      // Tokens: {completely, unrelated, query, quantum, physics}
      // Skill haystack: "code-gen Generate production code implementation code generation"
      // Tokens: {code, gen, generate, production, implementation, generation}
      // Intersection: ∅ → score 0
      const result = await lookup.pickSkill(
        "completely unrelated query about quantum physics",
        "tester",
      );
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should work correctly in orchestrator mode", async () => {
    const tmpDir = join(tmpdir(), `skill-lookup-orch-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const coderPath = join(tmpDir, "coder-skill.md");
    const testerPath = join(tmpDir, "tester-skill.md");
    await writeFile(coderPath, "# Coder\nWrite code.", "utf-8");
    await writeFile(testerPath, "# Tester\nTest code.", "utf-8");

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "code-gen",
            description: "Generate production code",
            source: "local",
            tags: ["implementation", "code", "generation"],
            path: coderPath,
            size_bytes: 20,
            agent_scope: ["coder", "orchestrator"],
          },
          {
            name: "test-runner",
            description: "Run tests and verify quality",
            source: "local",
            tags: ["verification", "testing", "quality"],
            path: testerPath,
            size_bytes: 20,
            agent_scope: ["tester", "orchestrator"],
          },
        ],
        total_skills: 2,
        role: "orchestrator",
        source: "local",
      };
      const stub = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stub);

      // "run tests verify quality" → should match test-runner
      // Tokens: {run, tests, verify, quality} → size 4
      // test-runner haystack: "test-runner Run tests and verify quality verification testing quality"
      // Tokens: {test, runner, run, tests, verify, quality, verification, testing} → size 8
      // Intersection: {run, tests, verify, quality} → size 4
      // cosine = 4 / sqrt(4 * 8) = 4 / sqrt(32) ≈ 0.707 ≥ 0.6 ✓
      const result = await lookup.pickSkill(
        "run tests verify quality",
        "orchestrator",
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe("test-runner");
      expect(result!.score).toBeGreaterThanOrEqual(0.6);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should load real SKILL.md body from disk", async () => {
    const tmpDir = join(tmpdir(), `skill-lookup-body-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const skillPath = join(tmpDir, "SKILL.md");
    const expectedBody = `---
name: disk-skill
description: A skill loaded from disk
tags:
  - testing
---
# Disk Skill

This skill was written to disk and should be loaded by loadSkillBody.
`;
    await writeFile(skillPath, expectedBody, "utf-8");

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "disk-skill",
            description: "A skill loaded from disk",
            source: "local",
            tags: ["testing"],
            path: skillPath,
            size_bytes: expectedBody.length,
            agent_scope: ["tester"],
          },
        ],
        total_skills: 1,
        role: "tester",
        source: "local",
      };
      const stub = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stub);

      // "testing skill disk load" → tokens: {testing, skill, disk, load} → size 4
      // Skill haystack: "disk-skill A skill loaded from disk testing"
      // Tokens: {disk, skill, loaded, from, testing} → size 5
      // Intersection: {testing, skill, disk} → size 3
      // cosine = 3 / sqrt(4 * 5) = 3 / sqrt(20) ≈ 0.671 ≥ 0.6 ✓
      const result = await lookup.pickSkill("testing skill disk load", "tester");
      expect(result).not.toBeNull();
      expect(result!.body).toBe(expectedBody);
      expect(result!.body).toContain("Disk Skill");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
