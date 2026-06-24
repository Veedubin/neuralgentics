/**
 * Neuralgentics — Skill Reuse Unit Tests
 *
 * Tests for recordSkillReuse, estimateSavedTokens, and capSkillBody.
 * Uses bun:test with a stub MemoryAdapter.
 *
 * @module skill_reuse.test
 */

import { describe, it, expect } from "bun:test";
import {
  estimateSavedTokens,
  capSkillBody,
  recordSkillReuse,
} from "./skill_reuse.js";
import type { SkillMatchResult } from "./skill_lookup.js";
import { MemoryAdapter } from "../adapters/memory.js";
import type { Memory } from "../adapters/memory.js";

// ============================================================================
// Stub MemoryAdapter
// ============================================================================

interface StubMemoryCalls {
  addMemory: Array<{ content: string; metadata?: Record<string, unknown> }>;
  adjustTrust: Array<{ id: string; signal: string }>;
  queryMemories: Array<{ query: string; limit?: number }>;
}

/**
 * Creates a stub MemoryAdapter for testing.
 *
 * Only the three methods used by recordSkillReuse are functional;
 * all others throw if called (should never happen in these tests).
 *
 * @param options.failAddMemory - If true, addMemory throws.
 * @param options.failAdjustTrust - If true, adjustTrust throws.
 * @param options.failQueryMemories - If true, queryMemories throws.
 * @param options.queryResults - Memories returned by queryMemories.
 */
function createStubMemory(options?: {
  failAddMemory?: boolean;
  failAdjustTrust?: boolean;
  failQueryMemories?: boolean;
  queryResults?: Memory[];
}): { adapter: MemoryAdapter; calls: StubMemoryCalls } {
  const calls: StubMemoryCalls = {
    addMemory: [],
    adjustTrust: [],
    queryMemories: [],
  };

  const queryResults = options?.queryResults ?? [];
  const failAdd = options?.failAddMemory ?? false;
  const failAdjust = options?.failAdjustTrust ?? false;
  const failQuery = options?.failQueryMemories ?? false;

  const adapter: MemoryAdapter = new MemoryAdapter({ baseUrl: "http://stub", timeoutMs: 1000 });

  // Override the methods we need for testing with stubs
  adapter.addMemory = async (content: string, metadata?: Record<string, unknown>) => {
    calls.addMemory.push({ content, metadata });
    if (failAdd) throw new Error("addMemory failed");
    return "mem-test-id-123";
  };
  adapter.adjustTrust = async (id: string, signal: string) => {
    calls.adjustTrust.push({ id, signal });
    if (failAdjust) throw new Error("adjustTrust failed");
  };
  adapter.queryMemories = async (query: string, limit?: number) => {
    calls.queryMemories.push({ query, limit });
    if (failQuery) throw new Error("queryMemories failed");
    return queryResults;
  };

  return { adapter, calls };
}

// ============================================================================
// Helper: create a SkillMatchResult
// ============================================================================

function makeSkill(overrides?: Partial<SkillMatchResult>): SkillMatchResult {
  return {
    name: overrides?.name ?? "test-skill",
    body: overrides?.body ?? "This is the skill body content.",
    score: overrides?.score ?? 0.85,
  };
}

// ============================================================================
// estimateSavedTokens Tests
// ============================================================================

describe("estimateSavedTokens", () => {
  it("should calculate saved tokens as baseline minus actual token estimate", () => {
    const skill = makeSkill({ name: "my-skill", body: "A".repeat(400) });
    // totalChars = 400 (body) + 8 (name) = 408
    // actualTokens = ceil(408 / 4) = 102
    // savedTokens = max(0, 3000 - 102) = 2898
    const result = estimateSavedTokens(skill);
    expect(result).toBe(2898);
  });

  it("should clamp to 0 when actual tokens exceed baseline", () => {
    const longBody = "X".repeat(20000);
    const skill = makeSkill({ name: "huge-skill", body: longBody });
    // totalChars > 3000*4 = 12000, so savedTokens = max(0, 3000 - ceil(total/4)) = 0
    const result = estimateSavedTokens(skill);
    expect(result).toBe(0);
  });

  it("should use a custom baseline when provided", () => {
    const skill = makeSkill({ name: "short", body: "Hi" });
    // totalChars = 2 + 5 = 7, actualTokens = ceil(7/4) = 2
    // savedTokens = max(0, 100 - 2) = 98
    const result = estimateSavedTokens(skill, 100);
    expect(result).toBe(98);
  });
});

// ============================================================================
// capSkillBody Tests
// ============================================================================

describe("capSkillBody", () => {
  it("should return the body as-is when under the limit", () => {
    const body = "Short body content";
    const result = capSkillBody(body, 4000);
    expect(result).toBe(body);
  });

  it("should truncate and append marker when over the limit", () => {
    const body = "A".repeat(5000);
    const result = capSkillBody(body, 4000);
    expect(result.length).toBe(4000 + "\n[... truncated]".length);
    expect(result.startsWith("A".repeat(4000))).toBe(true);
    expect(result.endsWith("\n[... truncated]")).toBe(true);
  });

  it("should use default maxChars of 4000", () => {
    const body = "B".repeat(5000);
    const result = capSkillBody(body);
    expect(result.endsWith("\n[... truncated]")).toBe(true);
  });
});

// ============================================================================
// recordSkillReuse Tests
// ============================================================================

describe("recordSkillReuse", () => {
  it("happy path: stores memory and bumps trust on provenance", async () => {
    const { adapter, calls } = createStubMemory({
      queryResults: [
        { id: "prov-mem-1", content: "skill provenance", sourceType: "boomerang", timestamp: "2026-01-01" },
      ],
    });
    const skill = makeSkill({ name: "code-review", body: "Review code for quality." });

    const result = await recordSkillReuse({
      skill,
      taskContext: "Review the auth module",
      memory: adapter,
    });

    expect(result.memoryId).toBe("mem-test-id-123");
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(result.trustBumped).toBe(true);

    // Verify addMemory was called with the right shape
    expect(calls.addMemory).toHaveLength(1);
    expect(calls.addMemory[0].content).toContain("Skill reused: code-review");
    expect(calls.addMemory[0].metadata?.type).toBe("skill_reuse");
    expect(calls.addMemory[0].metadata?.skill).toBe("code-review");

    // Verify adjustTrust was called on the provenance memory
    expect(calls.adjustTrust).toHaveLength(1);
    expect(calls.adjustTrust[0].id).toBe("prov-mem-1");
    expect(calls.adjustTrust[0].signal).toBe("agent_used");
  });

  it("empty body: returns no-op result without calling memory", async () => {
    const { adapter, calls } = createStubMemory();
    const skill = makeSkill({ name: "empty-skill", body: "" });

    const result = await recordSkillReuse({
      skill,
      taskContext: "Do something",
      memory: adapter,
    });

    expect(result.memoryId).toBe("");
    expect(result.savedTokens).toBe(0);
    expect(result.trustBumped).toBe(false);
    expect(calls.addMemory).toHaveLength(0);
  });

  it("whitespace-only body: returns no-op result", async () => {
    const { adapter, calls } = createStubMemory();
    const skill = makeSkill({ name: "ws-skill", body: "   \n\t  " });

    const result = await recordSkillReuse({
      skill,
      taskContext: "Do something",
      memory: adapter,
    });

    expect(result.memoryId).toBe("");
    expect(result.savedTokens).toBe(0);
    expect(result.trustBumped).toBe(false);
  });

  it("addMemory throws: returns graceful result, does not throw", async () => {
    const { adapter, calls } = createStubMemory({ failAddMemory: true });
    const skill = makeSkill({ name: "failing-skill", body: "Some body" });

    const result = await recordSkillReuse({
      skill,
      taskContext: "This should not throw",
      memory: adapter,
    });

    expect(result.memoryId).toBe("");
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(result.trustBumped).toBe(false);
  });

  it("queryMemories returns 0 results: trustBumped is false but memoryId is set", async () => {
    const { adapter, calls } = createStubMemory({ queryResults: [] });
    const skill = makeSkill({ name: "no-prov-skill", body: "Body text here" });

    const result = await recordSkillReuse({
      skill,
      taskContext: "No provenance exists",
      memory: adapter,
    });

    expect(result.memoryId).toBe("mem-test-id-123");
    expect(result.trustBumped).toBe(false);
    expect(calls.adjustTrust).toHaveLength(0);
  });

  it("adjustTrust throws: trustBumped is false but memoryId is still set", async () => {
    const { adapter, calls } = createStubMemory({
      failAdjustTrust: true,
      queryResults: [
        { id: "prov-mem-2", content: "skill provenance", sourceType: "boomerang", timestamp: "2026-01-01" },
      ],
    });
    const skill = makeSkill({ name: "trust-fail-skill", body: "Body" });

    const result = await recordSkillReuse({
      skill,
      taskContext: "Trust bump fails",
      memory: adapter,
    });

    expect(result.memoryId).toBe("mem-test-id-123");
    expect(result.trustBumped).toBe(false);
    // The addMemory still succeeded
    expect(calls.addMemory).toHaveLength(1);
  });

  it("taskContext is truncated to 200 chars in the memory content and metadata", async () => {
    const { adapter, calls } = createStubMemory();
    const longContext = "A".repeat(300);
    const skill = makeSkill({ name: "trunc-skill", body: "Body" });

    await recordSkillReuse({
      skill,
      taskContext: longContext,
      memory: adapter,
    });

    // The content should contain the truncated context
    const addCall = calls.addMemory[0];
    expect(addCall.metadata?.task).toBe("A".repeat(200));
    // The content string also includes the truncated context
    expect(addCall.content).toContain("A".repeat(200).slice(0, 50));
  });
});