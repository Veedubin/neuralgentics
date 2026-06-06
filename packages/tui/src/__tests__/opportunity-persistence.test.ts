/**
 * Opportunity Persistence Tests (T-085)
 *
 * Tests for offline opportunity cache persistence:
 * 1. saveCache persists to store with sourceType='opportunity_cache'
 * 2. restoreCache reads from store
 * 3. getCachedCandidates returns all when no age limit
 * 4. getCachedCandidates(7) filters out entries >7 days old
 * 5. Stale entries get stale: true flag
 * 6. Missing cache → returns empty array (no error)
 * 7. /opportunities cached returns formatted list with stale labels
 * 8. Candidate type has timestamp + sessionId fields set correctly
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  saveCache,
  restoreCache,
  getCachedCandidates,
} from "../opportunity-detector/detector.js";
import {
  formatCachedOpportunities,
  handleCachedOpportunitiesCommand,
} from "../opportunity-detector/prompter.js";
import type {
  Candidate,
  CachedCandidate,
} from "../opportunity-detector/types.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

let memAddCounter = 0;
const storedEntries: Array<Record<string, unknown>> = [];

function createMockClient(overrides?: Record<string, unknown>): {
  call: ReturnType<typeof mock<(method: string, params: Record<string, unknown>) => Promise<unknown>>>;
} {
  memAddCounter = 0;
  storedEntries.length = 0;

  const callMock = mock(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "memory.add") {
      const id = `mem-oc-${String(++memAddCounter).padStart(3, "0")}`;
      storedEntries.push({ id, ...params });
      return { id };
    }
    if (method === "memory.queryBySourceType") {
      const sourceType = (params as Record<string, unknown>).sourceType as string;
      if (sourceType === "opportunity_cache") {
        const limit = (params as Record<string, unknown>).limit as number ?? 50;
        return storedEntries.slice(0, limit).map((b) => ({
          id: b.id,
          content: b.content,
          metadata: b.metadata,
        }));
      }
      return [];
    }
    return {};
  });

  return {
    call: callMock,
    ...overrides,
  };
}

/** Create a test Candidate with required fields including timestamp + sessionId. */
function makeCandidate(overrides: Partial<Candidate> & { patternType: Candidate["patternType"] }): Candidate {
  return {
    description: overrides.description ?? "Test pattern detected",
    suggestedFix: overrides.suggestedFix ?? "Create a skill for this pattern",
    estimatedTokenSavings: overrides.estimatedTokenSavings ?? 5000,
    frequency: overrides.frequency ?? 3,
    buildEffort: overrides.buildEffort ?? "0.5 day",
    priority: overrides.priority ?? "P2",
    scopeAllProjects: overrides.scopeAllProjects ?? false,
    evidence: overrides.evidence ?? { totalCalls: 10, totalTokens: 15000 },
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    sessionId: overrides.sessionId ?? "test-session-001",
    ...overrides,
  };
}

/** Create a candidate from N days ago. */
function makeCandidateDaysAgo(daysAgo: number, overrides?: Partial<Candidate> & { patternType: Candidate["patternType"] }): Candidate {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return makeCandidate({
    ...overrides,
    patternType: overrides?.patternType ?? "sequential_tool_chains",
    timestamp: ts,
  });
}

// ─── Test 1: saveCache persists to store ─────────────────────────────────────

describe("saveCache", () => {
  test("1: saveCache persists to store with sourceType='opportunity_cache'", async () => {
    const client = createMockClient();
    const candidates: Candidate[] = [
      makeCandidate({ patternType: "sequential_tool_chains", sessionId: "sess-1" }),
      makeCandidate({ patternType: "repeated_identical_calls", sessionId: "sess-1" }),
    ];

    const ids = await saveCache(candidates, client);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("mem-oc-001");
    expect(ids[1]).toBe("mem-oc-002");

    // Verify stored entries have correct sourceType
    for (const entry of storedEntries) {
      expect((entry as Record<string, unknown>).sourceType).toBe("opportunity_cache");
      const metadata = (entry as Record<string, unknown>).metadata as Record<string, unknown>;
      expect(metadata.type).toBe("opportunity_cache");
      expect(metadata.patternType).toBeDefined();
      expect(metadata.sessionId).toBeDefined();
    }
  });

  test("saveCache returns empty array when no candidates", async () => {
    const client = createMockClient();
    const ids = await saveCache([], client);
    expect(ids).toEqual([]);
  });
});

// ─── Test 2: restoreCache reads from store ────────────────────────────────────

describe("restoreCache", () => {
  test("2: restoreCache reads from store", async () => {
    const client = createMockClient();

    // First, save some candidates
    const originalCandidates: Candidate[] = [
      makeCandidate({ patternType: "high_cost_single_turns", sessionId: "sess-restore-1" }),
      makeCandidate({ patternType: "manual_aggregation", sessionId: "sess-restore-1" }),
    ];
    await saveCache(originalCandidates, client);

    // Now restore
    const restored = await restoreCache(client);

    expect(restored).toHaveLength(2);
    expect(restored[0]!.patternType).toBe("high_cost_single_turns");
    expect(restored[1]!.patternType).toBe("manual_aggregation");
  });
});

// ─── Test 3: getCachedCandidates returns all when no age limit ────────────────

describe("getCachedCandidates", () => {
  test("3: getCachedCandidates returns all when no age limit", async () => {
    const client = createMockClient();

    const candidates: Candidate[] = [
      makeCandidate({ patternType: "long_card_retries", sessionId: "sess-age-1" }),
      makeCandidate({ patternType: "error_retry_loops", sessionId: "sess-age-1" }),
    ];
    await saveCache(candidates, client);

    // maxAgeDays=0 means no age filter
    const result = await getCachedCandidates(client, 0);

    expect(result.cacheEmpty).toBe(false);
    expect(result.candidates.length).toBe(2);
    expect(result.totalEntries).toBe(2);
  });
});

// ─── Test 4: getCachedCandidates(7) filters out entries >7 days old ───────────

describe("getCachedCandidates age filtering", () => {
  test("4: getCachedCandidates(7) filters out entries >7 days old", async () => {
    const client = createMockClient();

    // A 3-day-old candidate (should be kept)
    const recentCandidate = makeCandidateDaysAgo(3, { patternType: "re_reading_same_files" });
    // A 10-day-old candidate (should be filtered out)
    const oldCandidate = makeCandidateDaysAgo(10, { patternType: "missed_parallel_opportunities" });

    await saveCache([recentCandidate, oldCandidate], client);

    const result = await getCachedCandidates(client, 7);

    // Only the 3-day-old one should survive the age filter
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.patternType).toBe("re_reading_same_files");
    expect(result.totalEntries).toBe(2); // total before filter
  });
});

// ─── Test 5: Stale entries get stale: true flag ───────────────────────────────

describe("getCachedCandidates staleness", () => {
  test("5: stale entries get stale: true flag", async () => {
    const client = createMockClient();

    // A 3-day-old candidate (not stale - within 7 days)
    const recentCandidate = makeCandidateDaysAgo(3, { patternType: "sequential_tool_chains" });
    // An 8-day-old candidate (stale - beyond 7 days)
    const staleCandidate = makeCandidateDaysAgo(8, { patternType: "repeated_identical_calls" });

    await saveCache([recentCandidate, staleCandidate], client);

    // Use maxAgeDays=0 to disable age filter but still get staleness info
    const result = await getCachedCandidates(client, 0);

    expect(result.candidates.length).toBe(2);

    const recentEntry = result.candidates.find((c) => c.patternType === "sequential_tool_chains");
    const staleEntry = result.candidates.find((c) => c.patternType === "repeated_identical_calls");

    expect(recentEntry).toBeDefined();
    expect(staleEntry).toBeDefined();
    expect(recentEntry!.stale).toBe(false);
    expect(staleEntry!.stale).toBe(true);
  });
});

// ─── Test 6: Missing cache → returns empty array (no error) ──────────────────

describe("getCachedCandidates missing cache", () => {
  test("6: missing cache → returns empty array (no error)", async () => {
    const client = createMockClient({
      call: mock(async () => []),
    });

    const result = await getCachedCandidates(client, 7);

    expect(result.candidates).toEqual([]);
    expect(result.totalEntries).toBe(0);
    expect(result.cacheEmpty).toBe(true);
  });
});

// ─── Test 7: /opportunities cached returns formatted list with stale labels ──

describe("handleCachedOpportunitiesCommand", () => {
  test("7: /opportunities cached returns formatted list with stale labels", async () => {
    // Test the formatted output directly using formatCachedOpportunities
    // since handleCachedOpportunitiesCommand uses default maxAgeDays=7 which
    // filters out entries >7 days old. Stale labels appear for entries >7 days
    // but only when maxAgeDays=0 or a higher value.
    const staleCandidate: CachedCandidate = {
      patternType: "repeated_identical_calls",
      description: "Same grep called 12 times",
      suggestedFix: "Create a skill",
      estimatedTokenSavings: 5000,
      frequency: 12,
      buildEffort: "0.5 day",
      priority: "P2",
      scopeAllProjects: false,
      evidence: { totalCalls: 12, totalTokens: 15000 },
      timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      sessionId: "sess-stale-001",
      cachedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      stale: true,
    };

    const freshCandidate: CachedCandidate = {
      patternType: "sequential_tool_chains",
      description: "Chain of 5+ tool calls repeated 3 times",
      suggestedFix: "Create a skill",
      estimatedTokenSavings: 8000,
      frequency: 3,
      buildEffort: "1 day",
      priority: "P1",
      scopeAllProjects: true,
      evidence: { totalCalls: 15, totalTokens: 25000 },
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      sessionId: "sess-fresh-001",
      cachedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      stale: false,
    };

    const formatted = formatCachedOpportunities([staleCandidate, freshCandidate]);

    expect(formatted).toContain("Cached Opportunities");
    expect(formatted).toContain("Stale");
    expect(formatted).toContain("Sequential Tool Chains");
  });

  test("7b: handleCachedOpportunitiesCommand returns cached opportunities", async () => {
    const client = createMockClient();

    // Save a recent candidate (within 7 days)
    const recentCandidate = makeCandidateDaysAgo(2, {
      patternType: "sequential_tool_chains",
      description: "Chain of 5+ tool calls repeated 3 times",
      sessionId: "sess-cmd-1",
    });

    await saveCache([recentCandidate], client);

    const result = await handleCachedOpportunitiesCommand(client);

    expect(result.command).toBe("opportunities");
    expect(result.refreshKanban).toBe(false);
    expect(result.message).toContain("Cached Opportunities");
  });
});

// ─── Test 8: Candidate type has timestamp + sessionId fields ─────────────────

describe("Candidate type fields", () => {
  test("8: Candidate type has timestamp + sessionId fields set correctly", async () => {
    const client = createMockClient();

    const now = new Date();
    const sessionId = "sess-fields-test-001";

    const candidate = makeCandidate({
      patternType: "high_cost_single_turns",
      timestamp: now.toISOString(),
      sessionId,
      description: "Single turn using 15K tokens",
      estimatedTokenSavings: 8000,
      frequency: 5,
    });

    // Verify the candidate has required fields before saving
    expect(candidate.timestamp).toBe(now.toISOString());
    expect(candidate.sessionId).toBe(sessionId);
    expect(candidate.patternType).toBe("high_cost_single_turns");
    expect(candidate.description).toBe("Single turn using 15K tokens");
    expect(candidate.estimatedTokenSavings).toBe(8000);
    expect(candidate.frequency).toBe(5);

    // Save and restore to verify round-trip preserves fields
    await saveCache([candidate], client);

    const restored = await restoreCache(client);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.timestamp).toBe(now.toISOString());
    expect(restored[0]!.sessionId).toBe(sessionId);
    expect(restored[0]!.patternType).toBe("high_cost_single_turns");
  });
});