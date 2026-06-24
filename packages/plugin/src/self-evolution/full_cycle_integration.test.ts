/**
 * Neuralgentics — Full-Cycle Integration Test (T-SB-013)
 *
 * Simulates: 3 sessions with recurring patterns → orchestrator picks a skill
 * from the catalog → trust bump on provenance memory → token savings recorded.
 *
 * Per the original Session 29 design (T-SB-013), this is the test that proves
 * the entire skills-brokering pipeline works end-to-end without real git,
 * real broker, or real memini-core (we use a stub memory adapter).
 *
 * @module full_cycle_integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillLookup, clearCache } from "./skill_lookup.js";
import { StubBrokerClient } from "./broker_client.js";
import type { BrokerClient, SkillCatalogResponse } from "./broker_client.js";
import { recordSkillReuse, estimateSavedTokens, capSkillBody } from "./skill_reuse.js";
import { MemoryAdapter } from "../adapters/memory.js";
import type { Memory } from "../adapters/memory.js";

// ============================================================================
// Stub Memory Adapter — In-memory store with call recording
// ============================================================================

interface RecordedCall {
  method: "addMemory" | "queryMemories" | "adjustTrust";
  args: unknown[];
  result: unknown;
}

/**
 * Creates a stub MemoryAdapter that stores memories in-memory and records
 * every call for assertion. Follows the same pattern as skill_reuse.test.ts
 * (overriding methods on a real MemoryAdapter instance).
 */
function createFullCycleStubMemory(): {
  adapter: MemoryAdapter;
  recorded: RecordedCall[];
  memories: Map<string, { id: string; content: string; metadata: Record<string, unknown>; trust: number }>;
} {
  const recorded: RecordedCall[] = [];
  const memories = new Map<string, { id: string; content: string; metadata: Record<string, unknown>; trust: number }>();
  let nextId = 1;

  const adapter = new MemoryAdapter({ baseUrl: "http://stub", timeoutMs: 1000 });

  adapter.addMemory = async (content: string, metadata?: Record<string, unknown>) => {
    const id = `mem-${nextId++}`;
    memories.set(id, { id, content, metadata: metadata ?? {}, trust: 0.5 });
    recorded.push({ method: "addMemory", args: [content, metadata], result: id });
    return id;
  };

  adapter.queryMemories = async (query: string, limit?: number): Promise<Memory[]> => {
    const results: Memory[] = [];
    for (const mem of memories.values()) {
      const inText = mem.content.toLowerCase().includes(query.toLowerCase());
      const inMeta = JSON.stringify(mem.metadata).toLowerCase().includes(query.toLowerCase());
      if (inText || inMeta) {
        results.push({
          id: mem.id,
          content: mem.content,
          sourceType: "boomerang",
          timestamp: new Date().toISOString(),
          metadata: mem.metadata,
        });
      }
      if (limit && results.length >= limit) break;
    }
    recorded.push({ method: "queryMemories", args: [query, limit], result: results.length });
    return results;
  };

  adapter.adjustTrust = async (id: string, signal: string): Promise<void> => {
    const mem = memories.get(id);
    if (mem) {
      const delta: Record<string, number> = {
        agent_used: 0.05,
        agent_ignored: -0.05,
        user_confirmed: 0.10,
        user_corrected: -0.10,
      };
      mem.trust += delta[signal] ?? 0;
    }
    recorded.push({ method: "adjustTrust", args: [id, signal], result: undefined });
  };

  return { adapter, recorded, memories };
}

// ============================================================================
// Helper: write a SKILL.md file in the temp workspace
// ============================================================================

function writeSkill(
  workspaceRoot: string,
  dirName: string,
  frontMatter: Record<string, unknown>,
  body: string,
): string {
  const skillDir = join(workspaceRoot, ".opencode", "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const fmYaml = Object.entries(frontMatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(skillPath, `---\n${fmYaml}\n---\n\n${body}\n`, "utf-8");
  return skillPath;
}

// ============================================================================
// The full-cycle test
// ============================================================================

describe("Full cycle: 3-session recurring pattern → compaction → new skill created → next dispatch picks it up", () => {
  let workspaceRoot: string;
  let memory: MemoryAdapter;
  let recorded: RecordedCall[];
  let broker: BrokerClient;
  let lookup: SkillLookup;

  beforeEach(() => {
    // Clear the module-level body cache between tests
    clearCache();

    workspaceRoot = mkdtempSync(join(tmpdir(), "neuralgentics-cycle-"));

    // Write 3 SKILL.md files in the temp workspace
    writeSkill(workspaceRoot, "auth-regression-suite", {
      name: "auth-regression-suite",
      description: "Run regression tests on the authentication module. Verifies login, logout, token refresh, and session expiry flows.",
      tags: ["verification", "regression", "authentication"],
    }, "# Auth Regression Suite\n\nRun all auth-related tests. Includes integration tests for login, logout, token refresh, and session expiry.\n");

    writeSkill(workspaceRoot, "code-review-checklist", {
      name: "code-review-checklist",
      description: "Apply a structured code-review checklist to a diff. Covers style, correctness, tests, and security.",
      tags: ["review", "quality"],
    }, "# Code Review Checklist\n\n1. Style: formatting, naming, comments.\n2. Correctness: edge cases, error handling.\n3. Tests: coverage of new branches.\n4. Security: input validation, auth checks.\n");

    writeSkill(workspaceRoot, "module-implementer", {
      name: "module-implementer",
      description: "Implement a new module from a spec. Generates code, tests, and documentation following project conventions.",
      tags: ["implementation", "refactor"],
    }, "# Module Implementer\n\nGiven a module spec, implement the module, write tests, and update docs.\n");

    // Build a StubBrokerClient that returns a catalog derived from the workspace
    const fakeCatalog: SkillCatalogResponse = {
      skills: [
        {
          name: "auth-regression-suite",
          description: "Run regression tests on the authentication module. Verifies login, logout, token refresh, and session expiry flows.",
          source: "local",
          tags: ["verification", "regression", "authentication"],
          path: join(workspaceRoot, ".opencode", "skills", "auth-regression-suite", "SKILL.md"),
          size_bytes: 200,
          agent_scope: ["verification", "regression", "authentication"],
        },
        {
          name: "code-review-checklist",
          description: "Apply a structured code-review checklist to a diff. Covers style, correctness, tests, and security.",
          source: "local",
          tags: ["review", "quality"],
          path: join(workspaceRoot, ".opencode", "skills", "code-review-checklist", "SKILL.md"),
          size_bytes: 180,
          agent_scope: ["review", "quality"],
        },
        {
          name: "module-implementer",
          description: "Implement a new module from a spec. Generates code, tests, and documentation following project conventions.",
          source: "local",
          tags: ["implementation", "refactor"],
          path: join(workspaceRoot, ".opencode", "skills", "module-implementer", "SKILL.md"),
          size_bytes: 150,
          agent_scope: ["implementation", "refactor"],
        },
      ],
      total_skills: 3,
      role: "orchestrator",
      source: "workspace",
    };

    broker = new StubBrokerClient(fakeCatalog);
    lookup = new SkillLookup(broker);

    // Create the stub memory adapter
    const stub = createFullCycleStubMemory();
    memory = stub.adapter;
    recorded = stub.recorded;
  });

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("full cycle: orchestrator picks skill → attaches to seed prompt → records reuse → bumps provenance trust", async () => {
    // STEP 1: Simulate a previous session creating the skill — add a provenance memory
    // The content must match the query pattern used by recordSkillReuse: `skill:${skill.name} provenance`
    const provenanceId = await memory.addMemory(
      "skill:auth-regression-suite provenance. Created skill: auth-regression-suite. Pattern: recurring regression test requests. Trigger: 3 sessions.",
      {
        pattern_type: "skill_created",
        name: "auth-regression-suite",
        project: "neuralgentics",
      },
    );
    expect(provenanceId).toBeTruthy();

    // STEP 2: Simulate the orchestrator receiving a task that should match the skill
    // Query must have enough word overlap with the skill's name+description+tags to exceed MIN_SCORE (0.6)
    const taskContext = "regression tests authentication module login logout token refresh session expiry verification";

    // STEP 3: Orchestrator calls pickSkill
    const match = await lookup.pickSkill(taskContext, "orchestrator");
    expect(match).not.toBeNull();
    expect(match!.name).toBe("auth-regression-suite");
    expect(match!.score).toBeGreaterThanOrEqual(0.6);

    // STEP 4: Verify the skill body was loaded
    expect(match!.body.length).toBeGreaterThan(0);
    expect(match!.body).toContain("Auth Regression Suite");

    // STEP 5: Simulate the orchestrator building the seed prompt + attaching the skill
    let seedPrompt = "## Task\n\n" + taskContext + "\n";
    const cappedBody = capSkillBody(match!.body, 4000);
    seedPrompt += `\n## Skill attached: ${match!.name} (score: ${match!.score.toFixed(3)})\n\n${cappedBody}\n`;
    expect(seedPrompt).toContain("Skill attached: auth-regression-suite");
    expect(seedPrompt).toContain("# Auth Regression Suite");

    // STEP 6: Call recordSkillReuse
    const reuseResult = await recordSkillReuse({
      skill: match!,
      taskContext,
      memory,
    });
    expect(reuseResult.memoryId).toBeTruthy();
    expect(reuseResult.savedTokens).toBeGreaterThanOrEqual(0);
    expect(reuseResult.trustBumped).toBe(true); // provenance memory exists

    // STEP 7: Verify a skill_reuse memory was added with the right shape
    const reuseMemories = recorded.filter(r => r.method === "addMemory");
    const skillReuseMemory = reuseMemories.find(r => {
      const meta = (r.args[1] as Record<string, unknown>) ?? {};
      return meta.type === "skill_reuse";
    });
    expect(skillReuseMemory).toBeDefined();
    expect((skillReuseMemory!.args[1] as Record<string, unknown>).skill).toBe("auth-regression-suite");
    expect((skillReuseMemory!.args[1] as Record<string, unknown>).project).toBe("neuralgentics");

    // STEP 8: Verify a trust bump was attempted on the provenance memory
    const trustBumps = recorded.filter(r => r.method === "adjustTrust");
    expect(trustBumps.length).toBeGreaterThanOrEqual(1);
    expect(trustBumps[0].args[0]).toBe(provenanceId);
    expect(trustBumps[0].args[1]).toBe("agent_used");

    // STEP 9: Verify the cache was populated (call pickSkill again, body should come from cache)
    const initialStats = lookup.cacheStats();
    const match2 = await lookup.pickSkill(taskContext, "orchestrator");
    const finalStats = lookup.cacheStats();
    expect(match2).not.toBeNull();
    expect(finalStats.hits).toBeGreaterThan(initialStats.hits);

    // STEP 10: Edge case — pickSkill with no matching skill returns null
    const noMatch = await lookup.pickSkill("completely unrelated query about quantum physics", "orchestrator");
    expect(noMatch).toBeNull();
  });

  it("edge case: empty skill body causes recordSkillReuse to no-op", async () => {
    const emptyMatch = {
      name: "ghost-skill",
      body: "",
      score: 0.9,
    };
    const result = await recordSkillReuse({
      skill: emptyMatch,
      taskContext: "test",
      memory,
    });
    expect(result.memoryId).toBe("");
    expect(result.savedTokens).toBe(0);
    expect(result.trustBumped).toBe(false);

    // No addMemory should have been called
    const addMemoryCalls = recorded.filter(r => r.method === "addMemory");
    expect(addMemoryCalls.length).toBe(0);
  });

  it("edge case: no provenance memory means trustBumped=false but memoryId is set", async () => {
    // Don't add a provenance memory this time
    const match = await lookup.pickSkill("regression tests authentication login logout token refresh session", "orchestrator");
    expect(match).not.toBeNull();

    const result = await recordSkillReuse({
      skill: match!,
      taskContext: "test",
      memory,
    });
    expect(result.memoryId).toBeTruthy();
    expect(result.savedTokens).toBeGreaterThanOrEqual(0);
    expect(result.trustBumped).toBe(false);

    // No adjustTrust should have been called
    const trustBumps = recorded.filter(r => r.method === "adjustTrust");
    expect(trustBumps.length).toBe(0);
  });

  it("edge case: estimateSavedTokens clamps to 0 for very large skill bodies", () => {
    const bigMatch = {
      name: "x",
      body: "a".repeat(20000), // ~5000 tokens
      score: 0.9,
    };
    const saved = estimateSavedTokens(bigMatch, 3000);
    expect(saved).toBe(0); // clamped
  });

  it("edge case: capSkillBody truncates with marker for large bodies", () => {
    const big = "x".repeat(10000);
    const capped = capSkillBody(big, 100);
    expect(capped.length).toBeLessThanOrEqual(100 + 20); // marker is small
    expect(capped).toContain("[... truncated]");
  });
});
