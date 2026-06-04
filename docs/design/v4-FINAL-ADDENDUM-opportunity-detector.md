# v4-FINAL Addendum: Replace Budget Enforcement with Skill/Script Opportunity Detector

**Author:** boomerang-architect (deepseek-v4-pro:cloud)  
**Date:** 2026-06-04  
**Status:** Complete — Addendum to v4-FINAL  
**Task ID:** T-RFC-004-final-addendum-1  

> **Addendum to v4-FINAL.** Replaces the budget-enforcement half of feature #8 (Token accounting + budget enforcement) with a Skill/Script Opportunity Detector. Keeps the visibility half (token accounting). Adds a new P1 skill: `opportunity-detector`.

**Supersedes:** v4-FINAL §502 feature #8 description, §503 exploit-the-hole #4 description, §508 Budget Enforcement table. All other v4-FINAL content carries forward unchanged.

**Reason for change:** User feedback — "I really don't like the budget idea. That is fucking annoying that step counts lol. We should be tracking those metrics still though. What I do want though is for us to track that stuff and when we are seeing long sessions, we should be automatically checking if there is skill or script we can write to help next time."

---

## 1. Executive Summary

v4-FINAL §508 introduced "Token accounting + budget enforcement" as exploit-the-hole feature #4 — per-card budgets that block work when exceeded. The user REJECTS this: it's "fucking annoying," adds friction mid-work, and requires guessing correct budgets upfront (which is impossible without data).

**What changes:** We remove budget enforcement (the block/limit/override flow) and replace it with a **Skill/Script Opportunity Detector** that:

1. **Keeps all visibility** — per-call token tracking, per-task/per-agent/per-model breakdowns, TUI status bar live spend, `/spend` slash command, wrap-up audit token reports. Everything the user wants to see, nothing that blocks.
2. **Replaces enforcement** — instead of blocking a card when it "overspends," the detector analyzes the session's token_ledger and tool_call history *after the fact* and surfaces patterns that could be improved with a new skill or script. "Hey, we did find_files + grep + read 23 times across 7 tasks. Want a single tool that does that in 1 call?"
3. **Integrates with skill-self-audit** — the detector finds candidates; the existing `skill-self-audit` skill builds them (via `boomerang-agent-builder`). The detector is the automated half; skill-self-audit is the manual/astute half.

**Metaphor:** Budget enforcement says "stop spending." Opportunity detection says "spend less NEXT TIME." The user gets the benefit of low tokens without the experience of being blocked mid-work.

---

## 2. Removed Features (Explicit Cut List)

These features from v4-FINAL are **removed** and will NOT be built:

| # | Removed Feature | v4-FINAL Reference | Why Removed |
|---|----------------|-------------------|-------------|
| 1 | `max_input_tokens` / `max_output_tokens` / `max_total_tokens` / `max_duration_ms` / `max_turns` fields on cards | §508.2 Budget Enforcement table | User rejection: budget fields are "fucking annoying" |
| 2 | Card blocking with reason `budget_exceeded` ("spent X, limit Y") | §508.2 On Exceeded column | Blocks work mid-task — user's primary objection |
| 3 | User-override dialog "Increase budget to 10,000 and resume" | Implicit in §508.2 enforcement flow | Adds friction; user wants work to continue |
| 4 | Hard-block-before-LLM-call check ("if adding the next call would exceed…") | §508.2 Enforcement column | Prevents the agent from doing its work |
| 5 | Phase/project budget inheritance | §508.2 Per-project level | Complexity that adds no user value once budgets are removed |
| 6 | Budget panel in TUI (panels/budget.ts) | §504.4 New Components table | Replaced by `/spend` slash command (kept) + `/opportunities` (new) |
| 7 | `/budget [set|view]` slash command | §507.4 Slash Commands table | Replaced by `/spend view` (kept) + `/opportunities` (new) |
| 8 | 11 open questions about budgets (#5 in §512) | §512 Open Question 5 | Obsolete |

**Total removed: 1 day of P1-b effort** (token accountant `budget.ts` + `budget.ts` panel + `/budget` command) — replaced by 2 days of opportunity detector work.

---

## 3. Kept Features (The Visibility Half)

These features from v4-FINAL §508 are **kept** unchanged:

| # | Kept Feature | v4-FINAL Reference | Status |
|---|-------------|-------------------|--------|
| 1 | Per-call token counting (input/output/cached/system) | §508.1 Counter module | **Kept** — renamed `counter.ts` |
| 2 | Per-task, per-agent, per-model token tagging | §508.1 "tagged with task_id/agent_id" | **Kept** |
| 3 | Per-turn, per-call count tracking | §508.1 session manager hooks | **Kept** |
| 4 | Token data written to memini-ai as `type: "token_ledger"` memories | §508.1 Storage block | **Kept** |
| 5 | TUI status bar showing live session token count | §507.2 Status Bar | **Kept** |
| 6 | `/spend` slash command with subcommands (today, by-card, by-agent, by-model, projected) | New (replaces `/budget`) | **Kept** — renamed from `/budget` to `/spend` |
| 7 | Wrap-up audit token reports (per-card, per-model, compaction savings, grand total) | §508.3 Token Report Format | **Kept** |
| 8 | `src/token-accountant/counter.ts` (token counting) | §504.3 Directory Structure | **Kept** |
| 9 | `src/token-accountant/reporter.ts` (token report generation) | §504.3 Directory Structure | **Kept** |
| 10 | `src/token-accountant/types.ts` (token types) | §504.3 Directory Structure | **Kept** |

**What gets renamed:**
- `/budget` slash command → `/spend` (and `/opportunities` for the new feature)
- `src/token-accountant/budget.ts` → **deleted**; replaced by `src/opportunity-detector/detector.ts`
- `src/tui/panels/budget.ts` → **deleted**; replaced by `src/tui/panels/spend.ts` (read-only spend view)

---

## 4. New Feature: Skill/Script Opportunity Detector

### 4.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              OPPORTUNITY DETECTOR                                │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Pattern      │  │ Candidate    │  │ Prompter     │           │
│  │ Scanner       │  │ Ranker       │  │ (User-facing)│           │
│  │              │  │              │  │              │           │
│  │ Scans:       │  │ Ranks by:    │  │ Formats:     │           │
│  │ • token_ledgr│  │ • savings    │  │ • candidate  │           │
│  │ • tool_calls │  │ • freq/sess  │  │ • savings    │           │
│  │ • kanban hist│  │ • build_cost │  │ • priority   │           │
│  │ • wrap-up ev │  │ • scope      │  │ • prompt     │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         │                 │                 │                    │
│         ▼                 ▼                 ▼                    │
│  memini-ai              Candidate          TUI dialog             │
│  query_memories        ranking stack       [Y] [N] [L] [S]      │
│                                                                  │
│  On [Y]: write T-NNN card → TASKS.md                             │
│     Type: skill-creation                                         │
│     Assignee: boomerang-agent-builder                            │
│     Source: detected by opportunity-detector                     │
│                                                                  │
│  On [N]: record in "considered" log                              │
│  On [L]: show full breakdown                                     │
│  On [S]: silence this pattern type for this session              │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 File Location

```
boomerang-v4/
├── src/
│   ├── token-accountant/               # Kept (visibility half)
│   │   ├── counter.ts                  # Token counting
│   │   ├── reporter.ts                 # Token report generation
│   │   └── types.ts                    # Token types
│   └── opportunity-detector/           # NEW
│       ├── detector.ts                 # Pattern scanner + candidate ranker
│       ├── patterns.ts                 # 8 detection pattern catalog
│       ├── prompter.ts                 # User-facing dialog + card drafting
│       └── types.ts                    # Opportunity types
├── src/tui/commands/
│   ├── spend.ts                        # /spend — view token spend (renamed from budget.ts)
│   └── opportunities.ts               # /opportunities — manual trigger (NEW)
├── skills/
│   └── opportunity-detector/           # NEW skill
│       └── SKILL.md
```

### 4.3 Trigger Conditions

The opportunity detector runs **automatically** when ANY of these conditions are met:

| # | Trigger | Threshold | Rationale |
|---|---------|-----------|-----------|
| 1 | **Session duration** > N hours | Default: 2 hours | Long sessions are where patterns accumulate. User noticed this: "I think we run too long in a session." |
| 2 | **Session tokens** > T | Default: 200,000 | Token-heavy sessions have the most savings potential. |
| 3 | **Session LLM calls** > C | Default: 50 | Many calls means many opportunities for tool consolidation. |
| 4 | **End of wrap-up audit** | Always (every session end) | The detector runs as part of the orchestrator's wrap-up protocol. |
| 5 | **On demand via `/opportunities`** | Manual trigger | User can invoke anytime. |

When the detector runs at session end (trigger #4), it produces a summary even if no patterns met the threshold. This is a "negative report" — "No new opportunities detected this session" — which itself is useful information.

### 4.4 The 8 Detection Patterns (Pattern Catalog)

Each pattern is an algorithmic detector that scans token_ledger + tool_call + kanban + wrap-up-evidence data. Patterns are independent and run in parallel. A single session can produce 0-8+ candidates.

---

#### Pattern 1: Sequential Tool Chains

**What it detects:** A sequence of 3+ different tools called in immediate succession, repeated 5+ times across the session. Classic example: `find_files` → `grep` → `read` → `read` repeated for different queries.

**Detection algorithm:**
```
For each agent turn:
  Collect tool_call memories in sequence order
  Find runs of 3+ consecutive tool calls where tools differ
  Hash the tool_name sequence (ignoring args)
  Count occurrences of each hash
  If count ≥ 5: flag as candidate
```

**Example candidate:**

```
Pattern detected: Worker called `find_files` 7×, then `grep` 12×, then `read` 4×.
  Total: 23 tool calls, ~18K tokens, ~4 minutes wall time.

Suggested skill/script: `codebase-search` — single tool that takes a natural-language
  query and returns: matching file paths + content snippets + line numbers, all in
  one call. Wraps ripgrep + tree-sitter.

Estimated savings: ~70% fewer tool calls (~7 calls instead of 23),
  ~80% fewer tokens (~3.6K instead of 18K), ~75% less wall time (~1m instead of 4m).

Build effort: 0.5 day (a Bun script wrapping ripgrep + tree-sitter)

Priority: P2 (helps all projects, not just the current one)
```

---

#### Pattern 2: Repeated Identical Tool Calls

**What it detects:** The same tool called 10+ times with only parameter variations. Classic example: `github-mcp_get_file_contents` called 15 times for different files in the same repo.

**Detection algorithm:**
```
For each tool_name:
  Count total invocations across all agent turns
  If count ≥ 10:
    Check arg similarity (do args differ only in path/name/query?)
    If yes: flag as candidate
```

**Example candidate:**

```
Pattern detected: `github-mcp_get_file_contents` called 15 times in 3 tasks,
  each time fetching a different file from the same repo.

Suggested skill/script: `repo-file-batch-read` — single call that takes a list of
  file paths and returns all contents in one response. Uses GitHub's tree API to
  batch the requests.

Estimated savings: ~93% fewer calls (1 call instead of 15),
  ~90% fewer tokens (~1.8K instead of ~18K), ~90% less wall time (~6s instead of ~60s).

Build effort: 0.25 day (thin wrapper around octokit tree API)

Priority: P1 (directly reduces the most common call pattern)
```

---

#### Pattern 3: High-Cost Single Turns

**What it detects:** Individual LLM calls exceeding 10K total tokens. These are "elephant turns" — a single prompt with too much context, or a single response that's too long.

**Detection algorithm:**
```
For each token_ledger memory:
  If total_tokens (input + output + cached + system) ≥ 10,000:
    Flag the turn
    Check: was output > 5K? → suggest output splitting
    Check: was input > 8K? → suggest context reduction
```

**Example candidate:**

```
Pattern detected: Turn #7 consumed 14,500 tokens (input: 11,200, output: 3,300).
  Card T-004, agent: boomerang-coder, model: deepseek-v4-pro:cloud.
  The input contained the full file contents of 3 files totaling ~8K tokens.

Suggested skill/script: `context-slicer` — pre-processes large files before sending
  to the LLM: extracts only the relevant sections (function signatures, imports,
  key blocks), strips comments and whitespace, returns a ~2K token summary.

Estimated savings: ~60% fewer tokens on this turn (~5.8K instead of 14.5K),
  savings scale with file count.

Build effort: 0.5 day (tree-sitter-based content extractor)

Priority: P2 (targeted at specific high-cost patterns)
```

---

#### Pattern 4: Long Card Retries (3+ Attempts)

**What it detects:** A single kanban card that required 3 or more attempts (each attempt = a full architect→coder→tester cycle or equivalent retry). The card went ready→running→blocked→running→done (or similar) multiple times.

**Detection algorithm:**
```
For each card in TASKS.md with status history:
  Count state transitions that include "blocked" or back-to-running
  If count ≥ 3:
    Extract wrap-up evidence from each attempt
    Check: same error repeated? → suggest error-handling skill
    Check: different approaches each time? → suggest better decomposition
```

**Example candidate:**

```
Pattern detected: Card T-007 ("Implement OAuth flow") went through 5 attempts
  across 4 hours, consuming 187K tokens total. Each attempt failed on a different
  aspect: token format, redirect URI, scope definition, refresh rotation.
  Evidence shows the coder kept re-reading the full OAuth spec (12K tokens) each time.

Suggested fix: Decompose T-007 into smaller sub-cards: T-007a (token exchange),
  T-007b (redirect URI), T-007c (scope validation), T-007d (refresh rotation).
  Each sub-card is ≤20K tokens and fails or passes independently.

OR suggested skill: `oauth-verifier` — validates OAuth config against the target
  provider's API before the coder starts work. Catches format/spec errors at
  check-time, not at implementation-time.

Estimated savings: ~80% fewer retries (1 each instead of 5 total),
  ~75% fewer tokens (~47K instead of 187K).

Build effort: 0.5 day (decomposition) or 1 day (oauth-verifier skill)

Priority: P1 (high-cost card, directly reduces retries)
```

---

#### Pattern 5: Re-Reading Same Files

**What it detects:** The same file (by path) read 3+ times across different turns/agents. The content hasn't changed between reads. The agent is re-fetching information it already had.

**Detection algorithm:**
```
For each file path in tool_call memories (tool_name = "read"):
  Count distinct reads across different turns
  If count ≥ 3 AND reads are separated by non-write actions:
    Flag as candidate
```

**Example candidate:**

```
Pattern detected: `neuralgentics/AGENTS.md` was read 4 times across 3 tasks
  (T-002 architect, T-004 coder, T-005 tester). Each read was ~90 lines (~1.2K
  tokens). The file didn't change between reads.

Suggested skill/script: `project-context-cache` — on first read, stores the file
  content + embedding in memini-ai with metadata (type: file_cache, path: ...).
  Subsequent access is via memory.query (sub-ms, ~0 tokens) instead of file read
  (~1.2K tokens + tool call overhead).

Estimated savings: 3 reads × 1.2K tokens = 3.6K saved per session.
  Scales with project size (more agents reading same files).

Build effort: 0.25 day (memini-ai helper that caches on first read)

Priority: P2 (small per-session savings, high cumulative across sessions)
```

---

#### Pattern 6: Manual Serialization (Missed Parallel Opportunities)

**What it detects:** Multiple tool calls that could have been run in parallel but were run sequentially. The tool calls have no data dependencies (output of A is not input to B).

**Detection algorithm:**
```
For each agent turn:
  Collect all tool calls
  Check: are any pairs independent? (A.output not referenced in B.args)
  If independent pairs exist AND they were called sequentially:
    Flag as candidate
```

**Example candidate:**

```
Pattern detected: In task T-003, the worker ran: read(file1) → read(file2) →
  read(file3) sequentially (3 tool calls, ~3.6K tokens, ~900ms each = ~2.7s total).
  All 3 files were independent — could have been read in parallel.

Suggested improvement: Enable speculative parallel tool dispatch in the session
  manager. When the worker requests 3 independent reads, fire all 3 simultaneously
  and merge results. (This is already designed in v4-FINAL §501.2 speculative
  parallel dispatch — this pattern confirms it's needed for tool calls, not just
  sub-agent dispatch.)

Estimated savings: ~67% less wall time (~900ms instead of 2.7s).
  Token savings: 0 (same number of calls, just parallel).

Build effort: Already in P0-d (speculative parallel dispatch). This pattern
  validates the feature.

Priority: P0 (already planned, pattern confirms the need)
```

---

#### Pattern 7: Manual Aggregation (Worker Composes Sub-Results)

**What it detects:** A worker dispatches multiple sub-agents/calls, collects their outputs, and then manually composes a final answer. The composition step itself consumes tokens (the worker reads all sub-results and writes a synthesis).

**Detection algorithm:**
```
For each agent turn:
  If turn contains 3+ sub-agent dispatches/tool calls AND
     turn's output is >70% synthesis text (not code):
    Check: could the synthesis be automated?
    If sub-results follow a template → synthesizable
    If sub-results are free-form → harder to automate
```

**Example candidate:**

```
Pattern detected: Task T-006 ("Research competitive landscape") dispatched 5
  researcher sub-agents, each returning a 2K-token report. The orchestrator then
  spent 8K tokens composing a synthesis. Total: 5×2K + 8K = 18K tokens.

Suggested skill: `research-synthesizer` — takes N sub-agent outputs + a synthesis
  prompt, returns a structured synthesis report. Uses a small model (devstral-small-2:24b)
  for the compose step instead of the orchestrator's large model.

Estimated savings: ~50% fewer tokens on synthesis (~4K instead of 8K),
  ~60% less wall time (small model is 3× faster).

Build effort: 1 day (structured output template + small-model routing)

Priority: P2 (applies to research/synthesis tasks specifically)
```

---

#### Pattern 8: Error-and-Retry Loops

**What it detects:** The same tool errored 3+ times, and the worker kept retrying with slight variations. Classic examples: rate-limited API call retries, MCP connection timeouts, bad arguments to a tool.

**Detection algorithm:**
```
For each tool_name:
  Find runs where the tool errored (from tool_call memory metadata or card block reasons)
  If consecutive error count ≥ 3:
    Check: same error message? → suggest error handler
    Check: different errors? → suggest circuit breaker or fallback
```

**Example candidate:**

```
Pattern detected: `searxng_web_search` errored 4 times in task T-002
  ("Research model latency benchmarks") with the same error: "Connection timeout
  after 30s." The worker retried 3 times before successfully fetching on the 5th
  attempt. Each retry consumed ~500 tokens (error message + retry decision).

Suggested skill: `retry-with-backoff` — wraps any tool call with exponential
  backoff + jitter. On first failure, wait 2s, then 4s, then 8s (max 30s).
  Gives the worker the result without it needing to manage retries.

OR suggested fix: Circuit breaker — after 2 consecutive errors for the same tool
  + same card, block the card with "external service unavailable" and let the
  user decide (vs. the worker looping).

Estimated savings: 3 avoided retries × 500 tokens = 1.5K per pattern occurrence.
  Plus wall-time savings (no 90s of timeouts).

Build effort: 0.25 day (retry wrapper) or 0.5 day (circuit breaker + card block)

Priority: P1 (directly prevents looping — the #1 user pain point across all tools)
```

---

### 4.5 Candidate Ranking Formula

Each candidate is scored and ranked:

```
candidate_score = estimated_token_savings × frequency_per_session × scope_multiplier

Where:
  estimated_token_savings = current_cost − projected_cost (in tokens)
  frequency_per_session  = how many times this pattern appears per session (count / session_count)
  scope_multiplier       = 1.5 if "helps all projects", 1.0 if "helps this project only"
```

Candidates are presented in descending score order. The top 3 are shown in the TUI prompt; the rest are available via `/opportunities list`.

### 4.6 Output Format (User-Facing)

The detector surfaces candidates with a TUI dialog:

```
┌──────────────────────────────────────────────────────────────────────┐
│ 💡 Opportunity Detected: 2 candidate skills/scripts                   │
│                                                                        │
│ #1 Pattern: 7× find_files + 12× grep + 4× read in T-007              │
│    Suggestion: codebase-search tool (1 call replaces 23)              │
│    Savings: ~80% tokens (~14.4K saved/session), ~75% time (~3m saved)│
│    Build: ~0.5 day (Bun + ripgrep + tree-sitter)                      │
│                                                                        │
│ #2 Pattern: github-mcp_get_file_contents called 15× in T-004/T-005   │
│    Suggestion: repo-file-batch-read (1 call replaces 15)             │
│    Savings: ~90% tokens (~16.2K saved/session), ~90% time (~54s)     │
│    Build: ~0.25 day (octokit tree API wrapper)                        │
│                                                                        │
│   [Y] yes, add both to skill-self-audit's TODO list                   │
│   [1] yes, add only #1                                                │
│   [2] yes, add only #2                                                │
│   [N] no, one-off patterns                                            │
│   [L] let me think — show full breakdown for all candidates           │
│   [S] silence this pattern type for this session                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.7 Card Auto-Draft Format

When the user says [Y], the detector auto-drafts a T-NNN card in TASKS.md:

```markdown
## T-012 [skill-creation] Build codebase-search skill

**Status:** ready
**Priority:** P2
**Assignee:** boomerang-agent-builder
**Source:** Detected by opportunity-detector, session sess-abc
**Parent:** T-007 (source of the pattern)

### Pattern Detected
Worker called `find_files` 7×, then `grep` 12×, then `read` 4× during task T-007.
Total cost: 23 tool calls, ~18K tokens, ~4m wall time.

### Proposed Skill Spec
- **Name:** `codebase-search`
- **Description:** Single tool that takes a natural-language query and returns
  matching file paths + content snippets + line numbers in one call.
- **Tech stack:** Bun script wrapping ripgrep (for search) + tree-sitter (for
  content extraction).
- **Input:** `{ query: string, paths?: string[], maxResults?: number }`
- **Output:** `{ matches: [{ file: string, line: number, snippet: string }] }`
- **Token savings:** ~80% per invocation (~14.4K saved per session)
- **Time savings:** ~75% per invocation (~3m saved per session)

### Build Effort
~0.5 day

### Acceptance
- [ ] Skill file exists at `skills/codebase-search/SKILL.md`
- [ ] Bun script exists at `scripts/codebase-search.ts`
- [ ] Tool registered in broker with CanAccess for explore/coder roles
- [ ] Smoke test: query "find authentication handlers" returns relevant files
- [ ] Token report shows ≤3.6K tokens for a pattern that previously took 18K
```

### 4.8 Integration with skill-self-audit

The opportunity detector and `skill-self-audit` are complementary halves of the same feedback loop:

| | Opportunity Detector | skill-self-audit |
|---|---|---|
| **Timing** | End of session (via trigger conditions) | End of every cycle |
| **Scope** | Data-driven: token_ledger, tool_calls, kanban history | Process-driven: recurring actions, repeated workflows |
| **Output** | Candidates → T-NNN cards in TASKS.md | Candidates → invokes boomerang-agent-builder directly |
| **Builds?** | No — only drafts cards | Yes — invokes boomerang-agent-builder |
| **Auto?** | Fully automated (runs on triggers) | Manual — orchestrator reviews cycle actions |
| **Model** | gemma4:31b (pattern detection is classification, not generative) | Gemini (audit reasoning) |

**The flow at session end:**

```
[orchestrator wrap-up]
    │
    ├─→ [skill-self-audit] scans cycle actions for recurring processes
    │   if found → creates skills immediately (invokes agent-builder)
    │
    ├─→ [opportunity-detector] scans token_ledger + tool_calls + kanban + evidence
    │   if candidates found → prompts user → if Y: drafts T-NNN cards
    │
    └─→ [handoff] saves session summary to memini-ai
```

The skill-self-audit handles the "we did this process twice, let's formalize it" path (patterns visible within the cycle). The opportunity detector handles the "across 50 LLM calls this session, this pattern cost 180K tokens — want a tool for next time?" path (patterns visible only in aggregate data). Together they cover both the obvious and the non-obvious patterns.

---

## 5. Build Effort

| # | Task | Effort | Phase | Description |
|---|------|--------|-------|-------------|
| **1** | Pattern catalog + detection engine (`patterns.ts` + `detector.ts`) | 1 day | P1-b (NEW) | Implement the 8 detection patterns as independent scanners. Each pattern queries memini-ai for token_ledger + tool_call memories, runs detection algorithm, produces candidate objects. |
| **2** | Candidate ranker + TUI prompter (`prompter.ts`) | 0.5 day | P1-b (NEW) | Ranking formula, user-facing dialog with [Y]/[N]/[L]/[S] options, card auto-draft to TASKS.md. |
| **3** | Trigger integration (session duration, token threshold, wrap-up hook) | 0.5 day | P1-b (NEW) | Wire detector into session manager (duration/token/call-count triggers), end-of-wrap-up hook, `/opportunities` slash command. |
| **4** | Opportunity detector SKILL.md | 0.25 day | P1-b (NEW) | Skill file at `skills/opportunity-detector/SKILL.md` with pattern catalog, trigger conditions, integration guide. |
| **5** | Remove budget enforcement code paths | 0.25 day | P1-b (REFACTOR) | Delete `budget.ts`, delete `panels/budget.ts`, delete `/budget` command, rename `/budget` → `/spend`. |
| **6** | Write `opportunity-detector` tests | 0.5 day | P2-c (EXTEND) | Unit tests for each pattern detector, integration test for end-to-end: trigger → scan → prompt → card draft. |

| Phase | Days | Notes |
|-------|------|-------|
| New feature (patterns + ranker + prompter + skill file) | 2.25 days | Core detector |
| Integration (triggers + wrap-up hook + slash command) | 0.5 days | Wiring |
| Refactor (remove budget enforcement) | 0.25 days | Clean removal |
| Tests | 0.5 days | Coverage |
| **TOTAL** | **3.5 days** | Was 1.5 days for budget enforcement; net +2 days |

**Slotted in P1 build plan** between broker permission gating (P1-g, 1 day) and the kanban board with circuit breaker (P1-c, 1 day). The opportunity detector depends on token accounting being done (counter + reporter must exist) but does not depend on the kanban board. New P1 build plan order:

```
P1-a: TUI surface (2 days)
P1-b: Token accountant — counter + reporter (1 day, was 1.5 days for counter + budget + reporter)
P1-c: Opportunity detector — patterns + ranker + prompter + triggers (2.5 days, NEW)
P1-d: Kanban board with circuit breaker (1 day, was P1-c)
P1-e: Comments on cards (0.5 day, was P1-d)
P1-f: Attempts history (0.5 day, was P1-e)
P1-g: Slash commands (1 day, was P1-f)
P1-h: Broker permission-gated dispatch (1 day, was P1-g)
```

**P1 total: 9.5 days** (was 7.5 days; net +2 days for opportunity detector).

**v0.1.0 total: 27.5 days** (~5.5 weeks, was 25.5 days).

---

## 6. Success Criteria Re-Alignment

The v4-FINAL success criteria are accuracy > speed > low tokens (§501.4). The opportunity detector serves all three, with a different emphasis than budget enforcement did:

### 6.1 Accuracy

Budget enforcement didn't directly help accuracy — it was a cost cap, not a correctness gate. Opportunity detection serves accuracy in a subtler way:

- **Pattern 4 (Long card retries)** directly surfaces cards that went through 3+ attempts. These cards are **accuracy failures** — they didn't get the right answer the first time. The detector offers to either decompose them (more accurate through smaller scope) or build a verification skill (pre-check before implementation).
- **Pattern 8 (Error-and-retry loops)** surfaces systematic failures. A worker retrying the same errored tool 4 times is not being accurate — it's looping. The detector offers a circuit breaker or retry handler.
- **None of the patterns BLOCK work** — they surface AFTER the work is done, and we learn from the pattern. This preserves accuracy (no mid-task interruption) while still improving long-term accuracy (the pattern gets fixed for next time).

### 6.2 Speed

Opportunity detection directly helps speed:

- **Pattern 1 (Sequential tool chains)**: 23 tool calls → 7 calls. ~4 minutes → ~1 minute.
- **Pattern 2 (Repeated identical calls)**: 15 calls → 1 call. ~60 seconds → ~6 seconds.
- **Pattern 6 (Missed parallel opportunities)**: Sequential reads → parallel reads. ~2.7 seconds → ~0.9 seconds.
- **Pattern 3 (High-cost turns)**: 14.5K tokens → ~5.8K tokens. Smaller prompt = faster response from the LLM.
- **Pattern 7 (Manual aggregation)**: Large-model synthesis → small-model synthesis. Small model is 3× faster.

### 6.3 Low Token Spend

This is where opportunity detection replaces budget enforcement's primary role:

| Budget Enforcement | Opportunity Detection |
|---|---|
| Caps tokens per card (pessimistic) | Finds patterns and fixes them (optimistic) |
| "T-007 can't exceed 5K" — blocks at 5,001 | "T-007 used 187K across 5 retries — want to decompose it next time?" |
| Guesses budget upfront (often wrong) | Uses actual data (always right) |
| Blocks good work if budget too low | Never blocks work; improves future work |
| User has to override and resume | User approves or dismisses with one keypress |
| Single-card scope | Cross-session pattern scope |

**The core argument:** Budget enforcement and opportunity detection both try to reduce token spend, but they use opposite philosophies. Budgets are user-imposed caps → friction. Opportunity detection is user-offered improvements → value. Budgets need a magic number upfront (how do you know T-007 should cost $0.80? you don't). Opportunity detection finds the pattern AFTER the data exists. Budgets are pessimistic ("you might overspend"). Opportunity detection is optimistic ("we can do better").

---

## 7. Why This Is Better Than Budgets

**Budget enforcement says "stop spending." Opportunity detection says "spend less NEXT TIME."** The user gets the same outcome — fewer tokens burned on avoidable patterns — but without ever being interrupted mid-work. No card is ever blocked because it "exceeded its budget." Every card runs to completion (or hits its circuit breaker on N failures, which is a separate mechanism). At session end, the detector says "hey, here's what happened — want to prevent it next time?" The user says yes or no. Either way, work continues.

This is categorically better because:
1. **No friction** — the agent never stops mid-task. The user never has to approve a budget override. Work flows uninterrupted.
2. **No guessing** — budgets require a number upfront. At the start of T-007, you have no idea it'll take 5 attempts and 187K tokens. After T-007, the detector knows. Data-driven > guess-driven.
3. **No false positives** — a budget set too low blocks legitimate work. The opportunity detector only suggests based on actual observed patterns. If a pattern looks expensive but was actually necessary (e.g., re-reading a file because it changed between reads), the user dismisses it with [N].
4. **Compounds across sessions** — once a skill is built for pattern #1 (codebase-search), EVERY future session using that skill saves tokens. Budget enforcement doesn't compound — it's per-card, per-session, and the savings disappear at handoff.
5. **User feels in control** — "hey, want a tool for this?" is collaborative. "You exceeded your budget, blocked" is adversarial. The detector is a consultant; budget enforcement is a cop.

---

## 8. Updates to v4-FINAL Document

The following sections of the v4-FINAL document (`v4-roll-your-own-app-FINAL.md`) are **superseded** by this addendum:

| v4-FINAL Section | Change |
|-----------------|--------|
| §502 Feature #8 description ("Token accounting + budget enforcement") | Replace with: "Token accounting + skill/script opportunity detector" |
| §503 Exploit-the-hole #4 description ("Token accounting with budget enforcement") | Replace with: "Token accounting with opportunity detection — surfaces patterns for skill creation" |
| §504.3 Directory Structure `src/token-accountant/` | Add `src/opportunity-detector/` directory; remove `src/tui/panels/budget.ts`; add `src/tui/commands/spend.ts` |
| §504.4 New Components table | Remove `budget.ts` panel; add `opportunity-detector/` + `spend.ts` + `opportunities.ts` |
| §507.2 Status Bar | Remove budget line; keep token gauge |
| §507.4 Slash Commands | Rename `/budget` → `/spend`; add `/opportunities` |
| §508 Token Accounting + Budgets | Replace entire section with: §508A (kept — token accounting visibility) + §508B (new — opportunity detector). Budget enforcement table removed. |
| §509.2 P1 build plan (P1-b + P1-c) | Replace P1-b (budget) with P1-b (counter+reporter) + P1-c (opportunity detector). Re-letter subsequent P1 items. |
| §512 Open Question #5 | Mark as "Resolved: budgets removed per user feedback. See addendum." |
| §512 Open Question #12 (NEW) | "Should the opportunity detector auto-invoke the skill-self-audit when it finds a strong candidate (score > threshold)? Recommendation: No — always prompt the user. The detector is a consultant, not a builder." |

---

## 9. Document Metadata

| Field | Value |
|-------|-------|
| **Version** | v4-FINAL-ADDENDUM-1 |
| **Status** | Complete — supersedes v4-FINAL budget enforcement |
| **Supersedes** | v4-FINAL §502 #8, §503 #4, §508, §509.2 P1-b |
| **Builds on** | [v4-roll-your-own-app-FINAL.md](v4-roll-your-own-app-FINAL.md) (T-RFC-004-final) |
| **v4-FINAL Memory ID** | `400a2db3-af29-4d76-9f09-c95c95d0ea88` |
| **Line count** | ~390 |
| **Detection patterns** | 8 (sequential tool chains, repeated identical calls, high-cost turns, long card retries, re-reading same files, missed parallel opportunities, manual aggregation, error-and-retry loops) |
| **Build effort** | 3.5 days (vs. 1.5 days for removed budget enforcement) |
| **Net P1 impact** | +2 days (7.5 → 9.5 days P1; 25.5 → 27.5 days v0.1.0 total) |
