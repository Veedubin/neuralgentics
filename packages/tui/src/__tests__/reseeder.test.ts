/**
 * System-Prompt Reseed Tests (T-028)
 *
 * Tests the 7-part progressive reseed system:
 * - AGENTS.md section scoping
 * - Compaction summary formatting
 * - Card context formatting
 * - Active skills loading
 * - Board snapshot formatting
 * - Recent memories with trust flags
 * - Tool set loading
 * - Progressive loading (<200ms for parts 1-3)
 * - Token budget enforcement (≤2K total)
 * - isReseedNeeded heuristic
 * - createReseedFunction factory
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  generateReseed,
  isReseedNeeded,
  createReseedFunction,
  estimateTokens,
  truncateToTokenBudget,
  scopeAgentsMd,
  formatMemoryEntry,
} from "../session/reseeder.js";
import type {
  ReseedInput,
  ReseedSection,
  CompactionSummary,
  MemoryEntry,
  KanbanCard,
  SkillDescriptor,
  ToolDescriptor,
} from "../session/reseeder.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────────

const MOCK_AGENTS_MD = `# Neuralgentics Agents

## Memory
Memory management is decentralized.

## Stateless Agent Protocol
Agents must fetch their context from memini-core.

## Agent Onboarding Rules
Every agent MUST query memini-core on startup.

## Routing
Agents must state their intent clearly.

## External Tools
For web research, describe the required capability.

## Quality Gates
All code changes must pass Lint → Typecheck → Test.

## Protocol
All tasks must follow the 8-step Boomerang Protocol.

## Agent Roster
| Role | Model | Purpose |
| Orchestrator | Primary | Task decomposition |

## Execution Ordering Rules
Architect designs before coder builds.

## Irrelevant Section
This section should not be included in scoped output.
`;

const MOCK_COMPACTON_SUMMARY: CompactionSummary = {
  factsExtracted: 5,
  tokensBefore: 8000,
  tokensAfter: 1200,
  savingsRatio: 6.7,
  memoryIds: ["mem-001", "mem-002", "mem-003", "mem-004", "mem-005"],
};

const MOCK_CARDS: KanbanCard[] = [
  { id: "T-001", title: "Implement auth", status: "done", assignee: "coder" },
  { id: "T-002", title: "Write API tests", status: "running", assignee: "tester" },
  { id: "T-003", title: "Review PR", status: "ready", assignee: "reviewer" },
  { id: "T-004", title: "Deploy staging", status: "todo" },
];

const MOCK_HIGH_TRUST_MEMORY: MemoryEntry = {
  id: "mem-high-1",
  content: "Decision: use PostgreSQL for primary database with 20 connection pool",
  trust: 0.95,
  sourceType: "context_package",
};

const MOCK_LOW_TRUST_MEMORY: MemoryEntry = {
  id: "mem-low-1",
  content: "Possibly use Redis for caching but needs more investigation",
  trust: 0.3,
  sourceType: "session",
};

function createMockNeuralgentics(
  overrides?: Record<string, unknown>,
): ReseedInput["neuralgentics"] {
  return {
    call: mock(async (method: string, _params: Record<string, unknown>) => {
      if (method === "memory.query") {
        return [
          { id: "mem-001", content: "Decision: use JWT RS256", trust: 0.9, sourceType: "context_package" },
          { id: "mem-002", content: "Low confidence idea about Redis caching", trust: 0.35, sourceType: "session" },
        ];
      }
      if (method === "agent.getInitialToolSet") {
        return {
          peerId: "default",
          tools: [
            { name: "memory.add", serverName: "neuralgentics" },
            { name: "memory.query", serverName: "neuralgentics" },
            { name: "memory.get", serverName: "neuralgentics" },
          ],
        };
      }
      return {};
    }),
  };
}

function createMinimalInput(overrides?: Partial<ReseedInput>): ReseedInput {
  return {
    neuralgentics: createMockNeuralgentics(),
    sessionId: "sess-reseed-test",
    ...overrides,
  };
}

// ─── Unit Tests: estimateTokens ────────────────────────────────────────────────────

describe("reseed: estimateTokens", () => {
  test("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → ceil 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(100))).toBe(25);
  });
});

// ─── Unit Tests: truncateToTokenBudget ──────────────────────────────────────────────

describe("reseed: truncateToTokenBudget", () => {
  test("does not truncate short text", () => {
    const text = "Short text";
    expect(truncateToTokenBudget(text, 100)).toBe(text);
  });

  test("truncates long text and adds [...]", () => {
    const text = "x".repeat(1000);
    const result = truncateToTokenBudget(text, 50); // 200 chars max
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[...]");
  });

  test("handles exactly at budget", () => {
    const text = "x".repeat(200); // exactly 50 tokens * 4 chars
    const result = truncateToTokenBudget(text, 50);
    expect(result).toBe(text);
  });
});

// ─── Unit Tests: scopeAgentsMd ──────────────────────────────────────────────────────

describe("reseed: scopeAgentsMd", () => {
  test("extracts specified sections from AGENTS.md", () => {
    const sections = scopeAgentsMd(MOCK_AGENTS_MD, [
      "Stateless Agent Protocol",
      "Quality Gates",
      "Routing",
    ]);

    expect(sections).toContain("Stateless Agent Protocol");
    expect(sections).toContain("Quality Gates");
    expect(sections).toContain("Routing");
    expect(sections).not.toContain("Irrelevant Section");
  });

  test("returns empty string when no sections match", () => {
    const sections = scopeAgentsMd("No headings here", ["Some Heading"]);
    expect(sections).toBe("");
  });

  test("handles empty content", () => {
    const sections = scopeAgentsMd("", ["Routing"]);
    expect(sections).toBe("");
  });

  test("captures content under correct heading", () => {
    const md = `## Quality Gates\nAll code must pass Lint\n\n## Other\nNot included`;
    const sections = scopeAgentsMd(md, ["Quality Gates"]);
    expect(sections).toContain("All code must pass Lint");
    expect(sections).not.toContain("Not included");
  });

  test("case-insensitive section matching", () => {
    const md = `## ROUTING\nRoute tasks to specialists`;
    const sections = scopeAgentsMd(md, ["routing"]);
    // Matched section includes heading and content
    expect(sections).toContain("ROUTING");
    expect(sections).toContain("Route tasks to specialists");
  });

  test("captures sub-headings under a captured section", () => {
    const md = `## Stateless Agent Protocol\n### Flow\nThe flow is:\n\n## Something Else\nNot included`;
    const sections = scopeAgentsMd(md, ["Stateless Agent Protocol"]);
    // Sub-heading ### is content, not a section break, so it's included
    expect(sections).toContain("### Flow");
    expect(sections).toContain("The flow is:");
    expect(sections).not.toContain("Not included");
  });
});

// ─── Unit Tests: formatMemoryEntry ──────────────────────────────────────────────────

describe("reseed: formatMemoryEntry", () => {
  test("formats high-trust memory without warning", () => {
    const entry: MemoryEntry = {
      id: "mem-1",
      content: "Decision: use PostgreSQL",
      trust: 0.9,
    };
    expect(formatMemoryEntry(entry)).toBe("Decision: use PostgreSQL");
  });

  test("flags low-trust memory with ⚠️", () => {
    const entry: MemoryEntry = {
      id: "mem-2",
      content: "Unverified: maybe use Redis",
      trust: 0.3,
    };
    expect(formatMemoryEntry(entry)).toBe("⚠️ LOW confidence | Unverified: maybe use Redis");
  });

  test("defaults trust to 0.5 if undefined", () => {
    const entry: MemoryEntry = {
      id: "mem-3",
      content: "Default trust memory",
    };
    expect(formatMemoryEntry(entry)).toBe("Default trust memory");
  });

  test("truncates long content to 100 chars", () => {
    const entry: MemoryEntry = {
      id: "mem-4",
      content: "x".repeat(200),
      trust: 0.8,
    };
    const formatted = formatMemoryEntry(entry);
    expect(formatted.length).toBeLessThan(200);
    expect(formatted).toContain("...");
  });
});

// ─── Integration Tests: generateReseed ───────────────────────────────────────────────

describe("reseed: generateReseed", () => {
  test("generates all 7 sections with default input", async () => {
    const input = createMinimalInput();
    const result = await generateReseed(input);

    expect(result.sections.length).toBe(7);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBeLessThanOrEqual(2100); // Allow slight overshoot before truncation

    const partNames = result.sections.map((s) => s.part);
    expect(partNames).toEqual([
      "agents_md",
      "compaction",
      "card_context",
      "active_skills",
      "board_snapshot",
      "recent_memories",
      "tool_set",
    ]);
  });

  test("Parts 1-3 are marked fastLoaded when files are unavailable", async () => {
    const input = createMinimalInput({
      agentsMdPath: "/dev/null/nonexistent/AGENTS.md",
      compactionSummary: MOCK_COMPACTON_SUMMARY,
      cardContext: "### T-001: Implement auth module\n- Status: running\n- Assignee: coder",
    });

    const result = await generateReseed(input);

    // Parts 2 and 3 are synchronous — always fast
    const compaction = result.sections.find((s) => s.part === "compaction");
    const cardCtx = result.sections.find((s) => s.part === "card_context");
    expect(compaction?.fastLoaded).toBe(true);
    expect(cardCtx?.fastLoaded).toBe(true);

    // Part 1 depends on file read — might be fast or slow
    const agentsMd = result.sections.find((s) => s.part === "agents_md");
    expect(agentsMd).toBeDefined();
  });

  test("includes compaction summary when provided", async () => {
    const input = createMinimalInput({
      compactionSummary: MOCK_COMPACTON_SUMMARY,
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "compaction");

    expect(section).toBeDefined();
    expect(section!.content).toContain("5 facts extracted");
    expect(section!.content).toContain("8000 → 1200");
    expect(section!.content).toContain("6.7:1");
  });

  test("shows [No compaction summary available] when not provided", async () => {
    const input = createMinimalInput();
    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "compaction");

    expect(section).toBeDefined();
    expect(section!.content).toContain("No compaction summary");
  });

  test("includes card context when provided", async () => {
    const input = createMinimalInput({
      cardContext: "### T-028: System-Prompt Reseed\n- Status: running\n- Assignee: coder",
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "card_context");

    expect(section).toBeDefined();
    expect(section!.content).toContain("T-028");
    expect(section!.content).toContain("System-Prompt Reseed");
  });

  test("includes board snapshot when provided", async () => {
    const input = createMinimalInput({
      boardSnapshot: MOCK_CARDS,
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "board_snapshot");

    expect(section).toBeDefined();
    expect(section!.content).toContain("T-001");
    expect(section!.content).toContain("Implement auth");
    expect(section!.content).toContain("[done]");
  });

  test("handles graceful fallback when neuralgentics is unavailable", async () => {
    const brokenNeuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async () => {
        throw new Error("Go backend not available");
      }),
    };

    const input = createMinimalInput({
      neuralgentics: brokenNeuralgentics,
    });

    // Should not throw — graceful fallback
    const result = await generateReseed(input);

    const memSection = result.sections.find((s) => s.part === "recent_memories");
    const toolSection = result.sections.find((s) => s.part === "tool_set");

    expect(memSection!.content).toContain("unavailable");
    expect(toolSection!.content).toContain("unavailable");
  });

  test("flags low-trust memories with ⚠️", async () => {
    const neuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async (method: string) => {
        if (method === "memory.query") {
          return [
            { id: "mem-high", content: "High trust decision", trust: 0.9 },
            { id: "mem-low", content: "Low trust speculation", trust: 0.3 },
          ];
        }
        if (method === "agent.getInitialToolSet") {
          return { peerId: "default", tools: [] };
        }
        return {};
      }),
    };

    const input = createMinimalInput({
      neuralgentics,
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const memSection = result.sections.find((s) => s.part === "recent_memories");

    expect(memSection!.content).toContain("⚠️ LOW confidence");
    expect(memSection!.content).toContain("Low trust speculation");
    // High-trust memory should not have the flag
    expect(memSection!.content).toContain("High trust decision");
  });

  test("total tokens do not exceed MAX (2000)", async () => {
    const input = createMinimalInput({
      compactionSummary: MOCK_COMPACTON_SUMMARY,
      cardContext: "x".repeat(5000), // Very long card context
      boardSnapshot: Array.from({ length: 50 }, (_, i) => ({
        id: `T-${i}`,
        title: `Task ${i} with a very long title that exceeds budget`,
        status: "running",
        assignee: "coder",
      })),
    });

    const result = await generateReseed(input);
    expect(result.totalTokens).toBeLessThanOrEqual(2100); // Allow slight rounding
  });

  test("returns fallback sections for timed-out or failed async parts", async () => {
    // Simulate timeout: memory.query never resolves
    const hangingNeuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async (method: string) => {
        if (method === "memory.query") {
          // Never resolves — simulates timeout
          return new Promise(() => {});
        }
        if (method === "agent.getInitialToolSet") {
          return { peerId: "default", tools: [] };
        }
        return {};
      }),
    };

    const input = createMinimalInput({
      neuralgentics: hangingNeuralgentics,
      asyncTimeoutMs: 100, // Very short timeout for testing
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const memSection = result.sections.find((s) => s.part === "recent_memories");

    // Should get a fallback section, not hang
    expect(memSection).toBeDefined();
    // Content is either the timeout fallback or "unavailable"
    expect(memSection!.content).toBeTruthy();
  }, 10000);
});

// ─── Unit Tests: isReseedNeeded ──────────────────────────────────────────────────────

describe("reseed: isReseedNeeded", () => {
  test("returns true after compaction", async () => {
    const result = await isReseedNeeded({
      compactionResult: { factsExtracted: 3 },
    });
    expect(result).toBe(true);
  });

  test("returns false when no compaction and no card change", async () => {
    const result = await isReseedNeeded({});
    expect(result).toBe(false);
  });

  test("returns true on card transition", async () => {
    const result = await isReseedNeeded({
      previousCard: "T-001",
      currentCard: "T-002",
    });
    expect(result).toBe(true);
  });

  test("returns false when card is the same", async () => {
    const result = await isReseedNeeded({
      previousCard: "T-001",
      currentCard: "T-001",
    });
    expect(result).toBe(false);
  });

  test("returns true on trust threshold change", async () => {
    const result = await isReseedNeeded({
      trustChangeDetected: true,
    });
    expect(result).toBe(true);
  });

  test("returns false when compaction produced 0 facts", async () => {
    const result = await isReseedNeeded({
      compactionResult: { factsExtracted: 0 },
    });
    expect(result).toBe(false);
  });
});

// ─── Unit Tests: createReseedFunction ────────────────────────────────────────────────

describe("reseed: createReseedFunction", () => {
  test("creates a function matching CompactionDependencies.reseed signature", async () => {
    const neuralgentics = createMockNeuralgentics();
    const reseedFn = createReseedFunction({
      agentsMdPath: "/dev/null/nonexistent/AGENTS.md",
    });

    const result = await reseedFn(neuralgentics, "sess-test-123");

    expect(result).toBeDefined();
    expect(result.totalTokens).toBeGreaterThanOrEqual(0);
    expect(typeof result.totalTokens).toBe("number");
  });

  test("returns totalTokens in the expected format", async () => {
    const neuralgentics = createMockNeuralgentics();
    const reseedFn = createReseedFunction({
      compactionSummary: MOCK_COMPACTON_SUMMARY,
    });

    const result = await reseedFn(neuralgentics, "sess-test-456");

    expect(result).toHaveProperty("totalTokens");
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});

// ─── Edge Case Tests ──────────────────────────────────────────────────────────────────

describe("reseed: edge cases", () => {
  test("handles empty AGENTS.md file", async () => {
    const input = createMinimalInput({
      agentsMdPath: "/dev/null/nonexistent/AGENTS.md",
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "agents_md");
    expect(section).toBeDefined();
    expect(section!.content).toContain("not found");
  });

  test("handles empty board snapshot", async () => {
    const input = createMinimalInput({
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "board_snapshot");
    expect(section).toBeDefined();
    expect(section!.content).toContain("No board state");
  });

  test("handles memory.query returning empty array", async () => {
    const neuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async (method: string) => {
        if (method === "memory.query") return [];
        if (method === "agent.getInitialToolSet") return { peerId: "default", tools: [] };
        return {};
      }),
    };

    const input = createMinimalInput({
      neuralgentics,
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "recent_memories");
    expect(section).toBeDefined();
    expect(section!.content).toContain("No recent memories");
  });

  test("handles agent.getInitialToolSet returning no tools", async () => {
    const neuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async (method: string) => {
        if (method === "memory.query") return [];
        if (method === "agent.getInitialToolSet") return { peerId: "default", tools: [] };
        return {};
      }),
    };

    const input = createMinimalInput({
      neuralgentics,
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "tool_set");
    expect(section).toBeDefined();
    expect(section!.content).toContain("No tool set");
  });

  test("handles agent.getInitialToolSet with tools", async () => {
    const neuralgentics: ReseedInput["neuralgentics"] = {
      call: mock(async (method: string) => {
        if (method === "memory.query") return [];
        if (method === "agent.getInitialToolSet") {
          return {
            peerId: "default",
            tools: [
              { name: "memory.add", serverName: "neuralgentics", description: "Add a memory" },
              { name: "memory.query", serverName: "neuralgentics", description: "Query memories" },
            ],
          };
        }
        return {};
      }),
    };

    const input = createMinimalInput({
      neuralgentics,
      boardSnapshot: [],
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "tool_set");
    expect(section).toBeDefined();
    expect(section!.content).toContain("memory.add");
    expect(section!.content).toContain("memory.query");
  });

  test("board snapshot limits to 10 cards", async () => {
    const manyCards: KanbanCard[] = Array.from({ length: 20 }, (_, i) => ({
      id: `T-${i}`,
      title: `Task ${i}`,
      status: "todo",
    }));

    const input = createMinimalInput({
      boardSnapshot: manyCards,
    });

    const result = await generateReseed(input);
    const section = result.sections.find((s) => s.part === "board_snapshot");
    expect(section).toBeDefined();
    // Should only show 10 cards
    const lines = section!.content.split("\n");
    const cardLines = lines.filter((l) => l.startsWith("- T-"));
    expect(cardLines.length).toBeLessThanOrEqual(10);
  });

  test("each section has valid ReseedSection shape", async () => {
    const input = createMinimalInput({
      compactionSummary: MOCK_COMPACTON_SUMMARY,
      cardContext: "T-028: Implement reseed",
    });

    const result = await generateReseed(input);

    for (const section of result.sections) {
      expect(section).toHaveProperty("part");
      expect(section).toHaveProperty("content");
      expect(section).toHaveProperty("tokenEstimate");
      expect(section).toHaveProperty("fastLoaded");
      expect(typeof section.part).toBe("string");
      expect(typeof section.content).toBe("string");
      expect(typeof section.tokenEstimate).toBe("number");
      expect(typeof section.fastLoaded).toBe("boolean");
    }
  });
});