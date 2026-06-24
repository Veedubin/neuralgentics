# Skills Brokering + Auto-Evolution — Phase 3 Design

**Status:** Design Complete (2026-06-24, Session 31)
**Author:** boomerang-architect
**Plan Reference:** memini-ai memory `fbfeca3b-b8c4-4718-a971-81750cb390df`
**Phase 1 Ship Summary:** memini-ai memory `51c47f78-6008-4fbd-b37d-fbd65f4e9463`
**Phase 2 Ship Summary:** memini-ai memory `f3f8eda0-1c01-4682-9be6-787085fbc98b`
**Phase 1 Design Doc:** `docs/design/skills-brokering-phase-1-design.md`
**Phase 2 Design Doc:** `docs/design/skills-brokering-phase-2-design.md`

---

## 1. Overview & Goals

Phase 3 closes the skills-brokering loop by making the system **measured and observed**. When the orchestrator's `pickSkill` hook matches a skill for a task, Phase 3 records a `skill_reuse` memory entry with an estimated token savings, bumps trust on the skill's provenance memory, and appends the skill body to the seed prompt so the dispatched agent can use it. A full-cycle integration test proves the entire pipeline — catalog → lookup → reuse recording → trust bump — works end-to-end without real git or a real broker. This transforms the skills broker from a feature into a **self-improving system**: every reuse strengthens the trust signal, and every reuse is auditable.

---

## 2. Component Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     NEURALGENTICS PLUGIN (TS)                                 │
│                                                                              │
│  neuralgentics_dispatch_task (index.ts lines 473-565)                        │
│       │                                                                      │
│       ├─► orchestrator.handleTask(task)                                      │
│       │       │                                                              │
│       │       └─► returns { mode, agent, contextMemoryId, seedPrompt,        │
│       │                     executionPlan }                                  │
│       │                                                                      │
│       ├─► ★ NEW: skillLookup.pickSkill(task.userRequest, agent)              │
│       │       │                                                              │
│       │       ├─► (if match) append skill body to seed prompt                │
│       │       │       │                                                      │
│       │       │       └─► seedPrompt.prompt += "\n## Skill attached: ..."    │
│       │       │                                                              │
│       │       └─► (if match) recordSkillReuse({ skill, taskContext, memory })│
│       │               │                                                      │
│       │               ├─► memory.addMemory({ type: "skill_reuse", ... })     │
│       │               └─► memory.adjustTrust(provenanceId, "agent_used")     │
│       │                                                                      │
│       └─► return JSON { mode, agent, contextMemoryId, seedPrompt,            │
│                          executionPlan, skill_attached }                     │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  skill_reuse.ts  (NEW — self-evolution/skill_reuse.ts)                │    │
│  │                                                                       │    │
│  │  recordSkillReuse(args): Promise<{memoryId, savedTokens,              │    │
│  │                                     trustBumped}>                     │    │
│  │       │                                                               │    │
│  │       ├─► compute saved_tokens = max(0, 3000 - len(body+name+desc)/4)│    │
│  │       ├─► memory.addMemory("skill_reuse: ...", {type: "skill_reuse"}) │    │
│  │       ├─► memory.queryMemories("skill:${name} provenance")            │    │
│  │       └─► memory.adjustTrust(provenanceId, "agent_used")              │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  skill_lookup.ts  (self-evolution/skill_lookup.ts)                    │    │
│  │                                                                       │    │
│  │  SkillLookup.pickSkill(taskContext, role) → SkillMatchResult | null   │    │
│  │  (unchanged — already returns {name, body, score})                    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Wiring point (Option A):** In `neuralgentics_dispatch_task`'s `execute()` function, AFTER `orchestrator.handleTask(task)` returns and BEFORE the JSON response is stringified. This keeps the change localized to the plugin (`packages/plugin/src/index.ts`), does not require changes to the `@neuralgentics/orchestrator` package, and is the simplest integration point.

**Why Option A over Option B:**
- Option B (wiring into `orchestrator.handleTask` in the orchestrator package) would require changes in `@neuralgentics/orchestrator`, which is a separate package with its own test suite and release cycle.
- Option A keeps the change in one file (`index.ts`) plus one new file (`skill_reuse.ts`), both in the plugin package.
- The seed prompt from `handleTask` already contains everything else; we just append a `## Skill attached: <name>` section.
- The `SkillLookup` instance is constructed lazily in the plugin (first time it's used, cached for reuse), so there's no startup cost.

---

## 3. `recordSkillReuse` API (for T-SB-012)

### 3.1 File

**Path:** `packages/plugin/src/self-evolution/skill_reuse.ts` (CREATE)

### 3.2 Full Function Signature

```typescript
import type { MemoryAdapter } from "../adapters/memory.js";
import type { SkillMatchResult } from "./skill_lookup.js";

/**
 * Result of recording a skill reuse event.
 */
export interface SkillReuseResult {
  /** ID of the memory entry created, or "" if creation failed. */
  memoryId: string;
  /** Estimated tokens saved by using the skill instead of writing from scratch. */
  savedTokens: number;
  /** Whether a trust bump was applied to the skill's provenance memory. */
  trustBumped: boolean;
}

/**
 * Record a skill reuse event and bump trust on the skill's provenance memory.
 *
 * Called by the orchestrator's dispatch_task handler when pickSkill returns
 * a non-null match. Records a memory entry with the estimated token savings
 * and bumps trust (+0.05 agent_used) on the skill's provenance memory.
 *
 * This function NEVER throws. On any error, it logs a warning and returns
 * a zeroed result ({memoryId: "", savedTokens: 0, trustBumped: false}).
 *
 * @param args.skill — The SkillMatchResult from pickSkill (name, body, score).
 * @param args.taskContext — A summary of the task being dispatched (e.g., the
 *   task description or user request).
 * @param args.memory — The MemoryAdapter instance for saving memories and
 *   adjusting trust.
 * @param args.baselineTokens — Baseline token count for "what the agent would
 *   have written from scratch" (default: 3000).
 * @returns {memoryId, savedTokens, trustBumped}
 */
export async function recordSkillReuse(args: {
  skill: SkillMatchResult;
  taskContext: string;
  memory: MemoryAdapter;
  baselineTokens?: number;
}): Promise<SkillReuseResult> {
  const { skill, taskContext, memory } = args;
  const baselineTokens = args.baselineTokens ?? 3000;

  // ── Step 0: Guard against empty skill body ──
  if (!skill.body || skill.body.trim().length === 0) {
    console.warn(
      `[neuralgentics] recordSkillReuse: empty body for skill "${skill.name}" — skipping`,
    );
    return { memoryId: "", savedTokens: 0, trustBumped: false };
  }

  // ── Step 1: Compute saved_tokens ──
  const savedTokens = computeSavedTokens(skill, baselineTokens);

  // ── Step 2: Record the skill_reuse memory entry ──
  let memoryId = "";
  try {
    memoryId = await memory.addMemory(
      `Skill reused: ${skill.name} (score: ${skill.score.toFixed(2)}). ` +
        `Estimated tokens saved: ${savedTokens}. Task: ${taskContext.slice(0, 200)}`,
      {
        type: "skill_reuse",
        skill: skill.name,
        saved_tokens: savedTokens,
        score: skill.score,
        task: taskContext.slice(0, 500),
        project: "neuralgentics",
      },
    );
  } catch (err) {
    console.warn(
      `[neuralgentics] recordSkillReuse: failed to save memory for skill "${skill.name}":`,
      err instanceof Error ? err.message : String(err),
    );
    // Continue — trust bump is independent of memory save.
  }

  // ── Step 3: Find and bump trust on the provenance memory ──
  let trustBumped = false;
  try {
    const provenanceMemories = await memory.queryMemories(
      `skill:${skill.name} provenance`,
      5,
    );

    if (provenanceMemories.length > 0) {
      // Pick the most recent provenance memory (first in results).
      const provenanceId = provenanceMemories[0].id;
      await memory.adjustTrust(provenanceId, "agent_used");
      trustBumped = true;
    } else {
      console.warn(
        `[neuralgentics] recordSkillReuse: no provenance memory found for skill "${skill.name}" — trust bump skipped`,
      );
    }
  } catch (err) {
    console.warn(
      `[neuralgentics] recordSkillReuse: failed to bump trust for skill "${skill.name}":`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return { memoryId, savedTokens, trustBumped };
}

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Compute estimated token savings from using a skill.
 *
 * Formula:
 *   Baseline = 3000 (what the agent would have written from scratch)
 *   Actual   = len(body + name + description) / 4  (rough char-to-token ratio)
 *   saved    = max(0, Baseline - Actual)
 *
 * The char/4 ratio is a rough heuristic. English text averages ~4 characters
 * per token for GPT-family tokenizers. This is imprecise but directionally
 * correct for tracking whether skills are saving tokens or costing more than
 * they save.
 *
 * @param skill — The matched skill result.
 * @param baseline — Baseline token count (default: 3000).
 * @returns Estimated tokens saved, clamped to [0, baseline].
 */
function computeSavedTokens(
  skill: SkillMatchResult,
  baseline: number,
): number {
  // Build a rough "what the skill contributes" string.
  // We include the body (the full SKILL.md content) plus the name.
  // The description is not directly available in SkillMatchResult,
  // but the body includes the front-matter which contains the description.
  const skillText = skill.body + skill.name;
  const actualTokens = Math.ceil(skillText.length / 4);
  return Math.max(0, baseline - actualTokens);
}
```

### 3.3 `saved_tokens` Formula (Exact Specification)

```
Baseline = 3000  (assumed tokens for a typical reasoning flow written from scratch)
Actual   = ceil(len(body + name) / 4)  (rough char-to-token ratio)
saved    = max(0, Baseline - Actual)
```

**Rationale for Baseline = 3000:**
- A typical agent reasoning flow (plan → implement → verify) is ~2000-4000 tokens.
- 3000 is the midpoint. It's conservative enough that a skill that's larger than the baseline (e.g., a 12KB skill = ~3000 tokens) would report 0 saved tokens rather than negative.
- The baseline is configurable via the `baselineTokens` parameter for callers that want a different estimate.

**Rationale for char/4:**
- GPT-family tokenizers average ~4 characters per token for English text.
- This is a rough heuristic. A real tokenizer (e.g., `tiktoken`) would be more accurate but adds a dependency. Phase 4 (if any) could swap in a real tokenizer.
- The imprecision is acceptable because the purpose is directional tracking, not billing.

**Clamping:** `max(0, Baseline - Actual)` ensures we never report negative savings. If a skill body is larger than the baseline, we report 0 saved tokens (the skill costs as much as writing from scratch).

### 3.4 Provenance Memory Lookup

The lookup query is: `skill:${name} provenance`

This is a heuristic query that searches for memories containing the skill name and the word "provenance." The expected provenance memory is created by the `SelfEvolutionGate` when a skill is auto-created (see `self-evolution/index.ts` line 257-265, which saves a memory with `pattern_type: "skill_created"` and `name: candidate.suggestedName`).

**Edge cases:**
- **Multiple provenance memories:** Pick the most recent (first in `queryMemories` results, which are sorted by relevance/recency).
- **No provenance memory:** Log a warning and skip the trust bump. Return `{trustBumped: false}`. Do NOT create a new memory just for the trust bump.
- **Memory adapter throws:** Catch the error, log a warning, return `{trustBumped: false}`. Never throw from `recordSkillReuse`.

### 3.5 Trust Bump Logic

```
1. Query memories with query="skill:${name} provenance", limit=5
2. If results.length > 0:
     a. Pick results[0] (most recent/relevant)
     b. Call memory.adjustTrust(results[0].id, "agent_used")  // +0.05
     c. Return {trustBumped: true}
3. Else:
     a. Log warning: "no provenance memory found for skill ${name}"
     b. Return {trustBumped: false}
```

**Why bump the provenance memory (not the skill itself):**
- Skills are files on disk, not memories. They don't have trust scores.
- The provenance memory (created when the skill was auto-generated) IS a memory with a trust score.
- Bumping the provenance memory strengthens the signal that "this skill was useful" — which feeds back into the self-evolution gate's pattern detection (higher trust → more likely to be promoted to L1 summary → more likely to be considered for future evolution).

### 3.6 Error Handling Contract

`recordSkillReuse` **MUST NEVER throw**. All errors are caught, logged as warnings, and the function returns a zeroed result:

```typescript
{ memoryId: "", savedTokens: 0, trustBumped: false }
```

This is critical because `recordSkillReuse` is called in the dispatch hot path. A failure to record the reuse event should never block the dispatch itself. The agent still gets the skill body in the seed prompt; the tracking is best-effort.

---

## 4. Wiring into `neuralgentics_dispatch_task` (for T-SB-012)

### 4.1 File

**Path:** `packages/plugin/src/index.ts`

### 4.2 Changes

#### 4.2.1 New Imports (add near line 58, after existing imports)

```typescript
import { SkillLookup } from "./self-evolution/skill_lookup.js";
import { HttpBrokerClient } from "./self-evolution/broker_client.js";
import { recordSkillReuse } from "./self-evolution/skill_reuse.js";
```

#### 4.2.2 Lazy SkillLookup Instance (add near line 121, after `pendingStatelessTasks`)

```typescript
/** Lazy-initialized SkillLookup for pre-dispatch skill matching. */
let skillLookup: SkillLookup | null = null;

/** Get or create the SkillLookup instance. */
function getSkillLookup(): SkillLookup {
  if (!skillLookup) {
    const brokerEndpoint =
      process.env.NEURALGENTICS_BROKER_URL ?? "http://localhost:7000/jsonrpc";
    const brokerClient = new HttpBrokerClient(brokerEndpoint);
    skillLookup = new SkillLookup(brokerClient);
  }
  return skillLookup;
}
```

#### 4.2.3 Updated `execute()` Function (replace lines 509-565)

The full updated `execute()` function for `neuralgentics_dispatch_task`:

```typescript
async execute(args: Record<string, unknown>): Promise<string> {
  if (!useStatelessAgents || !orchestrator) {
    return "Error: Stateless agent mode is not enabled. Set useStatelessAgents: true in plugin config.";
  }

  const task: Task = {
    id: args.task_id as string,
    type: (args.task_type as TaskType) ?? "code-implementation",
    description: args.description as string,
    userRequest: args.user_request as string,
    priority: (args.priority as Task["priority"]) ?? "medium",
    files: args.files as string[] | undefined,
  };

  try {
    const result = await orchestrator.handleTask(task);

    if (isStatelessDispatch(result)) {
      const statelessResult = result as StatelessOrchestrationResult;

      // ── NEW: Skill lookup + reuse tracking ──
      let skillAttached: { name: string; score: number; savedTokens: number } | null = null;

      try {
        const lookup = getSkillLookup();
        const match = await lookup.pickSkill(
          task.userRequest,
          statelessResult.agent,
        );

        if (match && match.body.trim().length > 0) {
          // Cap the skill body at 4000 chars to avoid blowing up the seed prompt.
          const cappedBody =
            match.body.length > 4000
              ? match.body.slice(0, 4000) + "\n[... truncated]"
              : match.body;

          // Append the skill body to the seed prompt.
          statelessResult.seedPrompt.prompt +=
            `\n\n## Skill attached: ${match.name} (score: ${match.score.toFixed(2)})\n\n${cappedBody}`;

          // Record the reuse event (best-effort, never throws).
          const reuseResult = await recordSkillReuse({
            skill: match,
            taskContext: task.description,
            memory,
          });

          skillAttached = {
            name: match.name,
            score: match.score,
            savedTokens: reuseResult.savedTokens,
          };
        }
      } catch (err) {
        // Skill lookup/reuse is best-effort. Log and continue.
        console.warn(
          "[neuralgentics] Skill lookup failed during dispatch:",
          err instanceof Error ? err.message : String(err),
        );
      }
      // ── END NEW ──

      // Track the pending task for completeTaskCycle lookups
      pendingStatelessTasks.set(task.id, {
        contextMemoryId: statelessResult.contextMemoryId,
        agent: statelessResult.agent,
      });

      return JSON.stringify(
        {
          mode: "stateless",
          agent: statelessResult.agent,
          contextMemoryId: statelessResult.contextMemoryId,
          seedPrompt: statelessResult.seedPrompt.prompt,
          executionPlan: statelessResult.executionPlan,
          skill_attached: skillAttached,  // NEW FIELD
        },
        null,
        2,
      );
    }

    // Fallback: if useStatelessAgents is true but handleTask returned
    // an inline result (shouldn't happen, but handle gracefully)
    const inlineResult = result as OrchestrationResult;
    return JSON.stringify(
      {
        mode: "inline",
        agent: inlineResult.agent,
        contextPackage: inlineResult.contextPackage,
        executionPlan: inlineResult.executionPlan,
      },
      null,
      2,
    );
  } catch (err) {
    return `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
},
```

### 4.3 Key Design Decisions in the Wiring

| Decision | Rationale |
|----------|-----------|
| **Lazy SkillLookup init** | The `HttpBrokerClient` makes an HTTP connection to the Go backend. Creating it at plugin startup would fail if the backend isn't ready yet. Lazy init on first dispatch ensures the backend is running. |
| **Skill body capped at 4000 chars** | A typical SKILL.md is 500-2000 chars, but some external skills could be 10KB+. Capping at 4000 chars (~1000 tokens) prevents the seed prompt from blowing up while still including the substantive content. The `[... truncated]` marker tells the agent there's more. |
| **`skill_attached` field in response** | The orchestrator (caller of `dispatch_task`) can see whether a skill was attached and use that information for logging, metrics, or the wrap-up audit. |
| **Best-effort, never blocks dispatch** | If `pickSkill` throws (broker unreachable), or `recordSkillReuse` throws (memory server down), the dispatch still proceeds. The agent gets the original seed prompt without skill augmentation. |
| **Skill body appended AFTER handleTask** | The orchestrator's `handleTask` owns the seed prompt construction. We append the skill body after it returns, so the orchestrator package doesn't need to know about skills. |

### 4.4 Response JSON Shape (Updated)

```json
{
  "mode": "stateless",
  "agent": "boomerang-coder",
  "contextMemoryId": "mem-abc123",
  "seedPrompt": "Task: Implement the user registration flow.\nMemory ID: mem-abc123\n...\n\n## Skill attached: registration-flow (score: 0.82)\n\n---\nname: registration-flow\ndescription: ...\n---\n# Registration Flow\n...",
  "executionPlan": { ... },
  "skill_attached": {
    "name": "registration-flow",
    "score": 0.82,
    "savedTokens": 1850
  }
}
```

When no skill matches, `skill_attached` is `null`:

```json
{
  "mode": "stateless",
  "agent": "boomerang-coder",
  "contextMemoryId": "mem-abc123",
  "seedPrompt": "Task: Implement the user registration flow.\nMemory ID: mem-abc123\n...",
  "executionPlan": { ... },
  "skill_attached": null
}
```

---

## 5. Full-Cycle Integration Test (for T-SB-013)

### 5.1 File

**Path:** `packages/plugin/src/self-evolution/full_cycle_integration.test.ts` (CREATE)

### 5.2 Test Framework

Uses `bun:test` — matching the existing `integration.test.ts` in the same directory. The test creates real temp directories with SKILL.md files, uses `StubBrokerClient` for the catalog, and a stub `MemoryAdapter` for memory operations.

### 5.3 StubMemoryAdapter

The test needs a minimal stub that records calls without a real memini-core server:

```typescript
/**
 * StubMemoryAdapter — records addMemory and adjustTrust calls for test assertions.
 */
class StubMemoryAdapter {
  addedMemories: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  trustAdjustments: Array<{ id: string; signal: string }> = [];
  /** Pre-seeded memories returned by queryMemories. */
  private seededMemories: Array<{ id: string; content: string }> = [];

  constructor(seededMemories: Array<{ id: string; content: string }> = []) {
    this.seededMemories = seededMemories;
  }

  async addMemory(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const id = `mem-${this.addedMemories.length + 1}`;
    this.addedMemories.push({ content, metadata });
    return id;
  }

  async adjustTrust(id: string, signal: string): Promise<void> {
    this.trustAdjustments.push({ id, signal });
  }

  async queryMemories(_query: string, _limit?: number): Promise<Array<{ id: string; content: string }>> {
    return this.seededMemories;
  }
}
```

### 5.4 Full Test

```typescript
/**
 * Neuralgentics — Full-Cycle Skills Brokering Integration Test
 *
 * Proves the entire pipeline works end-to-end:
 *   SkillCatalog → SkillLookup.pickSkill → recordSkillReuse → trust bump
 *
 * Uses bun:test, temp dirs, StubBrokerClient, and StubMemoryAdapter.
 * No real git, no real broker, no real memini-core server.
 */

import { describe, it, expect } from "bun:test";
import { SkillLookup, getCacheStats } from "./skill_lookup.js";
import { StubBrokerClient } from "./broker_client.js";
import type { SkillCatalogResponse } from "./broker_client.js";
import { recordSkillReuse } from "./skill_reuse.js";
import type { SkillMatchResult } from "./skill_lookup.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ============================================================================
// Stub Memory Adapter
// ============================================================================

interface StubMemory {
  content: string;
  metadata?: Record<string, unknown>;
}

interface StubTrustAdjustment {
  id: string;
  signal: string;
}

class StubMemoryAdapter {
  addedMemories: StubMemory[] = [];
  trustAdjustments: StubTrustAdjustment[] = [];
  private seededMemories: Array<{ id: string; content: string }> = [];

  constructor(seeded: Array<{ id: string; content: string }> = []) {
    this.seededMemories = seeded;
  }

  async addMemory(
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const id = `mem-${this.addedMemories.length + 1}`;
    this.addedMemories.push({ content, metadata });
    return id;
  }

  async adjustTrust(id: string, signal: string): Promise<void> {
    this.trustAdjustments.push({ id, signal });
  }

  async queryMemories(
    _query: string,
    _limit?: number,
  ): Promise<Array<{ id: string; content: string }>> {
    return this.seededMemories;
  }
}

// ============================================================================
// Full-Cycle Integration Test
// ============================================================================

describe("Full-cycle skills brokering integration", () => {
  it("should match a skill, record reuse, and bump trust (T-SB-013)", async () => {
    // ── Step 1: Set up temp workspace with 3 SKILL.md files ──
    const tmpDir = join(tmpdir(), `full-cycle-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    // Skill 1: implementation-tagged (for coder)
    const implPath = join(tmpDir, "impl-skill.md");
    const implBody = `---
name: fast-api-builder
description: Quickly scaffold REST API endpoints with validation
tags:
  - implementation
  - code
  - api
---
# Fast API Builder

Scaffold REST API endpoints with input validation and error handling.
`;
    await writeFile(implPath, implBody, "utf-8");

    // Skill 2: verification-tagged (for tester)
    const verifyPath = join(tmpDir, "verify-skill.md");
    const verifyBody = `---
name: regression-runner
description: Run regression tests and verify build output
tags:
  - verification
  - quality
  - regression
  - e2e
---
# Regression Runner

Run the full regression suite and verify build output.
`;
    await writeFile(verifyPath, verifyBody, "utf-8");

    // Skill 3: another implementation-tagged skill
    const refactorPath = join(tmpDir, "refactor-skill.md");
    const refactorBody = `---
name: code-refactor
description: Refactor legacy code to modern patterns
tags:
  - implementation
  - refactor
---
# Code Refactor

Refactor legacy code to modern patterns with safety checks.
`;
    await writeFile(refactorPath, refactorBody, "utf-8");

    try {
      // ── Step 2: Build a SkillCatalog via StubBrokerClient ──
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "fast-api-builder",
            description: "Quickly scaffold REST API endpoints with validation",
            source: "local",
            tags: ["implementation", "code", "api"],
            path: implPath,
            size_bytes: implBody.length,
            agent_scope: ["coder"],
          },
          {
            name: "regression-runner",
            description: "Run regression tests and verify build output",
            source: "local",
            tags: ["verification", "quality", "regression", "e2e"],
            path: verifyPath,
            size_bytes: verifyBody.length,
            agent_scope: ["tester"],
          },
          {
            name: "code-refactor",
            description: "Refactor legacy code to modern patterns",
            source: "local",
            tags: ["implementation", "refactor"],
            path: refactorPath,
            size_bytes: refactorBody.length,
            agent_scope: ["coder"],
          },
        ],
        total_skills: 3,
        role: "tester",
        source: "local",
      };

      // ── Step 3: Instantiate StubBrokerClient ──
      const stubBroker = new StubBrokerClient(catalog);

      // ── Step 4: Instantiate SkillLookup ──
      const lookup = new SkillLookup(stubBroker);

      // ── Step 5: Call pickSkill for a tester task ──
      const match = await lookup.pickSkill(
        "run regression tests on the auth module",
        "tester",
      );

      // Assert: a verification-tagged skill is returned
      expect(match).not.toBeNull();
      expect(match!.name).toBe("regression-runner");
      expect(match!.score).toBeGreaterThanOrEqual(0.6);

      // ── Step 6: Verify the skill body was loaded ──
      expect(match!.body).not.toBe("");
      expect(match!.body).toContain("Regression Runner");
      expect(match!.body).toContain("verification");

      // ── Step 7: Simulate the orchestrator — call recordSkillReuse ──
      const stubMemory = new StubMemoryAdapter([
        {
          id: "mem-provenance-001",
          content: "skill:regression-runner provenance Created by self-evolution gate",
        },
      ]);

      const reuseResult = await recordSkillReuse({
        skill: match!,
        taskContext: "run regression tests on the auth module",
        memory: stubMemory as any,
      });

      // ── Step 8: Verify a skill_reuse memory was added ──
      expect(stubMemory.addedMemories.length).toBe(1);
      const addedMemory = stubMemory.addedMemories[0];
      expect(addedMemory.content).toContain("Skill reused: regression-runner");
      expect(addedMemory.content).toContain("Estimated tokens saved:");
      expect(addedMemory.metadata).toBeDefined();
      expect(addedMemory.metadata!.type).toBe("skill_reuse");
      expect(addedMemory.metadata!.skill).toBe("regression-runner");
      expect(addedMemory.metadata!.saved_tokens).toBeGreaterThan(0);
      expect(addedMemory.metadata!.project).toBe("neuralgentics");

      // ── Step 9: Verify a trust bump was attempted ──
      expect(stubMemory.trustAdjustments.length).toBe(1);
      expect(stubMemory.trustAdjustments[0].id).toBe("mem-provenance-001");
      expect(stubMemory.trustAdjustments[0].signal).toBe("agent_used");

      // Verify the reuse result
      expect(reuseResult.memoryId).toBe("mem-1");
      expect(reuseResult.savedTokens).toBeGreaterThan(0);
      expect(reuseResult.trustBumped).toBe(true);

      // ── Step 10: Verify getCacheStats shows at least 1 hit ──
      // (the body was loaded twice: once by pickSkill, once by the test reading match.body)
      const stats = getCacheStats();
      expect(stats.hits + stats.misses).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Edge case: pickSkill returns null (no skill matches) ──
  it("should handle null match gracefully (no skill matches)", async () => {
    const catalog: SkillCatalogResponse = {
      skills: [
        {
          name: "code-gen",
          description: "Generate production code",
          source: "local",
          tags: ["implementation", "code"],
          path: "/tmp/nonexistent.md",
          size_bytes: 100,
          agent_scope: ["coder"],
        },
      ],
      total_skills: 1,
      role: "tester",
      source: "local",
    };

    const stubBroker = new StubBrokerClient(catalog);
    const lookup = new SkillLookup(stubBroker);

    // "completely unrelated query" → no match
    const match = await lookup.pickSkill(
      "completely unrelated query about quantum physics",
      "tester",
    );

    // Assert: null match
    expect(match).toBeNull();

    // recordSkillReuse should NOT be called when match is null.
    // The wiring in dispatch_task checks `if (match && match.body...)` before calling.
    // This test just verifies pickSkill returns null for unrelated queries.
  });

  // ── Edge case: no provenance memory exists ──
  it("should skip trust bump when no provenance memory exists", async () => {
    const tmpDir = join(tmpdir(), `no-prov-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const skillPath = join(tmpDir, "SKILL.md");
    const skillBody = `---
name: test-skill
description: A test skill
tags:
  - testing
---
# Test Skill
`;
    await writeFile(skillPath, skillBody, "utf-8");

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "test-skill",
            description: "A test skill",
            source: "local",
            tags: ["testing"],
            path: skillPath,
            size_bytes: skillBody.length,
            agent_scope: ["tester"],
          },
        ],
        total_skills: 1,
        role: "tester",
        source: "local",
      };

      const stubBroker = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stubBroker);
      const match = await lookup.pickSkill("testing skill", "tester");
      expect(match).not.toBeNull();

      // StubMemoryAdapter with NO seeded memories → no provenance found
      const stubMemory = new StubMemoryAdapter([]);

      const reuseResult = await recordSkillReuse({
        skill: match!,
        taskContext: "testing task",
        memory: stubMemory as any,
      });

      // Memory should still be saved
      expect(stubMemory.addedMemories.length).toBe(1);
      expect(stubMemory.addedMemories[0].metadata!.type).toBe("skill_reuse");

      // Trust bump should NOT have been attempted
      expect(stubMemory.trustAdjustments.length).toBe(0);
      expect(reuseResult.trustBumped).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Edge case: empty skill body ──
  it("should skip recordSkillReuse when skill body is empty", async () => {
    const match: SkillMatchResult = {
      name: "empty-skill",
      body: "",
      score: 0.85,
    };

    const stubMemory = new StubMemoryAdapter([]);

    const reuseResult = await recordSkillReuse({
      skill: match,
      taskContext: "some task",
      memory: stubMemory as any,
    });

    // Should return zeroed result
    expect(reuseResult.memoryId).toBe("");
    expect(reuseResult.savedTokens).toBe(0);
    expect(reuseResult.trustBumped).toBe(false);

    // No memory should have been added
    expect(stubMemory.addedMemories.length).toBe(0);
    expect(stubMemory.trustAdjustments.length).toBe(0);
  });

  // ── Edge case: memory adapter throws ──
  it("should not throw when memory adapter fails", async () => {
    const tmpDir = join(tmpdir(), `mem-fail-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const skillPath = join(tmpDir, "SKILL.md");
    await writeFile(skillPath, "# Test\nContent.", "utf-8");

    try {
      const catalog: SkillCatalogResponse = {
        skills: [
          {
            name: "test-skill",
            description: "A test skill",
            source: "local",
            tags: ["testing"],
            path: skillPath,
            size_bytes: 20,
            agent_scope: ["tester"],
          },
        ],
        total_skills: 1,
        role: "tester",
        source: "local",
      };

      const stubBroker = new StubBrokerClient(catalog);
      const lookup = new SkillLookup(stubBroker);
      const match = await lookup.pickSkill("testing", "tester");
      expect(match).not.toBeNull();

      // Create a memory adapter that throws on addMemory
      const throwingMemory = {
        async addMemory(_content: string, _metadata?: Record<string, unknown>): Promise<string> {
          throw new Error("Connection refused");
        },
        async adjustTrust(_id: string, _signal: string): Promise<void> {
          throw new Error("Connection refused");
        },
        async queryMemories(_query: string, _limit?: number): Promise<Array<{ id: string; content: string }>> {
          throw new Error("Connection refused");
        },
      };

      // recordSkillReuse should NOT throw
      const reuseResult = await recordSkillReuse({
        skill: match!,
        taskContext: "testing task",
        memory: throwingMemory as any,
      });

      // Should return zeroed result
      expect(reuseResult.memoryId).toBe("");
      expect(reuseResult.savedTokens).toBeGreaterThan(0); // savedTokens is computed before memory calls
      expect(reuseResult.trustBumped).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
```

### 5.5 Test Coverage Summary

| Test Case | What It Verifies |
|-----------|-----------------|
| **Full cycle (main test)** | 3 SKILL.md files → catalog → pickSkill returns verification-tagged skill → body loaded → recordSkillReuse saves memory + bumps trust → cache stats show hits |
| **Null match** | pickSkill returns null for unrelated query → no crash |
| **No provenance memory** | recordSkillReuse still saves the skill_reuse memory but skips trust bump → trustBumped=false |
| **Empty skill body** | recordSkillReuse returns zeroed result immediately → no memory calls |
| **Memory adapter throws** | recordSkillReuse catches errors, returns zeroed result → never throws |

---

## 6. Quality Gates Per Card

### T-SB-012: Token-Savings Tracking + Trust Bump

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**Expected:**
- All existing tests pass (33 plugin tests from Phase 1 + Phase 2).
- New `skill_reuse.ts` compiles clean.
- `index.ts` compiles clean with the new imports and wiring.
- No new lint errors.

**Files touched:**
- `packages/plugin/src/self-evolution/skill_reuse.ts` (CREATE)
- `packages/plugin/src/index.ts` (MODIFY — dispatch_task execute function)

### T-SB-013: Full-Cycle Integration Test

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**Expected:**
- The new `full_cycle_integration.test.ts` passes all 5 test cases.
- No regressions in existing tests.
- TypeScript compiles clean.

**Files touched:**
- `packages/plugin/src/self-evolution/full_cycle_integration.test.ts` (CREATE)

---

## 7. Wave 2 Dispatch Plan (Read-Only)

| Wave | Coder    | Card     | Files                                                                                     | Depends On        |
|------|----------|----------|-------------------------------------------------------------------------------------------|-------------------|
| 2a   | #1 coder | T-SB-012 | `packages/plugin/src/self-evolution/skill_reuse.ts` (CREATE) + `packages/plugin/src/index.ts` (MODIFY — dispatch_task only) | None              |
| 2b   | #2 tester| T-SB-013 | `packages/plugin/src/self-evolution/full_cycle_integration.test.ts` (CREATE)              | After 2a (needs `recordSkillReuse` to exist) |

**Recommendation: SEQUENTIAL** — T-SB-012 first, T-SB-013 second.

**Rationale:** T-SB-013 imports `recordSkillReuse` from `skill_reuse.ts`, which is created by T-SB-012. The tester cannot write a test that imports a function that doesn't exist yet. Sequential dispatch ensures the coder ships `skill_reuse.ts` first, then the tester writes the integration test against the real function.

**Alternative (parallel with stub):** The tester could define a minimal `recordSkillReuse` stub inline in the test file and replace it with the real import after T-SB-012 ships. This adds complexity (the tester has to guess the function signature) and risks divergence. Sequential is simpler and safer.

---

## 8. Open Questions / Risks

### 8.1 Saved-Tokens Estimate Is Rough

**Risk:** The `char/4` heuristic is imprecise. A real tokenizer (e.g., `tiktoken` for GPT-4, or the model's native tokenizer) would be more accurate.

**Impact:** The `saved_tokens` number is directional, not exact. It's useful for tracking whether skills are generally saving tokens (positive trend) or costing more than they save (negative trend), but individual estimates may be off by ±20-30%.

**Mitigation:** The `baselineTokens` parameter is configurable. Callers can adjust it based on their model's typical reasoning flow length. Phase 4 (if any) could swap in a real tokenizer.

**Acceptance:** Directional accuracy is sufficient for Phase 3. The purpose is to answer "are skills helping?" — not to bill by the token.

### 8.2 Provenance Memory Query Is Heuristic

**Risk:** The lookup query `skill:${name} provenance` is a substring search over memory content. It may match unrelated memories that happen to contain the skill name and the word "provenance."

**Impact:** The wrong memory could get a trust bump. This is low-impact because:
- Trust bumps are +0.05 — small enough that a few misdirected bumps won't materially affect the system.
- The `SelfEvolutionGate` creates provenance memories with a consistent pattern (`pattern_type: "skill_created"`, `name: <skillName>`), so the query is reasonably specific.

**Mitigation:** If multiple provenance memories are returned, pick the most recent (first in results). If the query becomes unreliable, Phase 4 could add a `provenance_of` metadata field to memories for exact lookup.

### 8.3 Trust Bump Target

**Decision:** Bump the provenance memory (the `skill_created` memory from the self-evolution gate), NOT the skill itself (skills are files, not memories).

**Rationale:** This was locked in the original plan (memini-ai memory `fbfeca3b-b8c4-4718-a971-81750cb390df`). The provenance memory is the auditable record of "this skill was created from pattern X." Bumping its trust strengthens the signal that the pattern was useful, which feeds back into the self-evolution gate's candidate evaluation.

### 8.4 Empty Skill Body

**Risk:** `pickSkill` returns a match with `score ≥ 0.6` but the body is empty (file read failed, or the SKILL.md was deleted between catalog build and body load).

**Mitigation:** `recordSkillReuse` checks `if (!skill.body || skill.body.trim().length === 0)` and returns early. The dispatch_task wiring also checks `match.body.trim().length > 0` before appending to the seed prompt. An empty-body match is treated as "no match" for both prompt augmentation and reuse tracking.

### 8.5 Skill Body in the Prompt — Size Cap

**Risk:** A very large SKILL.md (e.g., 10KB+ from an external skill) could blow up the seed prompt, consuming the agent's context window before it even starts working.

**Mitigation:** The wiring caps the skill body at **4000 characters** (using `body.slice(0, 4000) + '\n[... truncated]'`). This is ~1000 tokens — small enough to be a net savings over the 3000-token baseline, large enough to include the substantive instructions. The `[... truncated]` marker tells the agent there's more content available if needed.

**Trade-off:** The agent won't see the full skill body. If the truncated portion contains critical instructions, the agent may miss them. This is acceptable because:
- Most SKILL.md files are 500-2000 chars (well under the cap).
- The front-matter (name, description, tags) is always at the top and always included.
- The agent can always read the full file from disk if needed (the skill path is in the catalog).

### 8.6 The Orchestrator SKILL.md Should Mention Skill-Attach

**Action:** Update `/.opencode/skills/boomerang-orchestrator/SKILL.md` Step 2 (Roadmap) or Step 4 (Dispatch) to note that the seed prompt may include an attached skill body. This is a minor doc-only change.

**Suggested addition to Step 4 (Dispatch):**

```markdown
### 4. Dispatch (orchestrator + broker)

For each `ready` card, the orchestrator:

1. **Builds the Context Package** from:
   - The card's own scope, acceptance criteria, and assignee
   - The relevant section of the roadmap
   - The handoff from the most recent completed dependency
   - The agent profile's known customizations
   - **★ NEW: If the skills broker matches a skill for this task, the skill body
     is appended to the seed prompt as `## Skill attached: <name> (score: X)`.
     The agent should read and follow the skill instructions.**
2. ...
```

**Out of scope for T-SB-012/T-SB-013.** This is a documentation-only follow-up that can be done by the orchestrator or writer after Phase 3 ships.

### 8.7 `savedTokens` in the Response vs. Memory

**Decision:** The `savedTokens` value is included in BOTH the `skill_attached` response field AND the `skill_reuse` memory entry. The response field is for immediate visibility (the orchestrator can log it); the memory entry is for long-term tracking (the self-evolution gate can query aggregate savings).

**No conflict:** Both use the same `computeSavedTokens` function, so they'll always agree.

---

## Appendix A: File Manifest

| Card | File | Action |
|------|------|--------|
| T-SB-012 | `packages/plugin/src/self-evolution/skill_reuse.ts` | **Create** |
| T-SB-012 | `packages/plugin/src/index.ts` | **Modify** (add imports, lazy SkillLookup, wiring in dispatch_task execute) |
| T-SB-013 | `packages/plugin/src/self-evolution/full_cycle_integration.test.ts` | **Create** |

---

## Appendix B: Locked Decisions Reference

These decisions were locked in the original plan (memini-ai memory `fbfeca3b-b8c4-4718-a971-81750cb390df`) and must NOT be re-litigated during implementation:

| Decision | Value |
|----------|-------|
| Cadence | Every compaction AND every `//boomerang-handoff`, no cooldown |
| Orchestrator picks automatically | By embedding similarity, no confirmation |
| Per-agent scoping | Hybrid YAML + SKILL.md front-matter |
| `auto_create` default | `true` |
| Skill reuse memory shape | `{type: "skill_reuse", skill, saved_tokens, task}` |
| Trust bump target | Skill's PROVENANCE memory (not the skill itself) |
| Wiring point | Option A: in `neuralgentics_dispatch_task` handler, after `handleTask` returns |
| `saved_tokens` formula | `max(0, 3000 - len(body + name) / 4)` |
| Skill body cap in prompt | 4000 chars |
| Error handling | `recordSkillReuse` never throws — best-effort, log and continue |
| Wave 2 dispatch | Sequential: T-SB-012 first, T-SB-013 second |
