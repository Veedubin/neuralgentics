# Roadmap: Neuralgentics v0.1.0 — P1 Phase

**Author:** boomerang-architect (deepseek-v4-pro:cloud)
**Date:** 2026-06-04
**Status:** v0.1.0 P1 (12.75 days) — DETAILED PLAN for 9 cards
**Builds on:** `roadmap-v0.1.0.md` (P0, 10.5 days, 13 tasks) + Addendum 1 (opportunity detector) + Addendum 2 (aggregator-aware)

> P1 delivers polish, smart features, and permission enforcement on top of the P0 pipeline: a fully-functional TUI with slash commands, token accounting with `/spend`, an aggregator-aware opportunity detector, a kanban board with circuit breaker, inter-agent comments, attempt history, and broker permission-gated dispatch. When P0 + P1 are done, the TUI is usable for daily agent-driven development. P1 assumes all 13 P0 cards ship green (8 of 13 already done as of Session 19).

## P1 Dependency Graph

```
                        ┌─────────────────┐
                        │  P0 Complete     │
                        │  (13 cards, 10.5d)│
                        └────────┬────────┘
                                 │
                ┌────────────────┼────────────────────────────────────┐
                ▼                ▼                ▼                   ▼
         ┌──────────┐    ┌──────────┐    ┌──────────┐       ┌──────────┐
         │  P1-a    │    │  P1-b    │    │  P1-d    │       │  P1-h    │
         │ TUI       │    │ Token    │    │ Kanban   │       │ Broker   │
         │ Polish    │    │ Account  │    │ Circuit  │       │ Perm     │
         │  (2.0d)   │    │ (1.0d)   │    │ (1.0d)   │       │ (1.0d)   │
         └─────┬─────┘    └────┬─────┘    └────┬─────┘       └──────────┘
               │               │               │                    ▲
               ▼               ▼               │                    │
         ┌──────────┐    ┌──────────┐          │                    │
         │  P1-g    │    │  P1-c    │          │                    │
         │ Slash    │    │ Oppty    │          │                    │
         │ Commands │    │ Detector │          │                    │
         │ (1.0d)   │    │ (2.5d)   │          │                    │
         └──────────┘    └─────┬────┘          │                    │
                               │               │                    │
                               ▼               │                    │
                         ┌──────────┐          │                    │
                         │ P1-c-ext │          │                    │
                         │ Agg-aware│          │                    │
                         │ (3.25d)  │          │                    │
                         └──────────┘          │                    │
                                               ▼                    │
                                         ┌──────────┐               │
                                         │  P1-e    │               │
                                         │ Comments │               │
                                         │ (0.5d)   │               │
                                         └────┬─────┘               │
                                              │                     │
                                              ▼                     │
                                         ┌──────────┐               │
                                         │  P1-f    │               │
                                         │ Attempts │               │
                                         │ (0.5d)   │               │
                                         └──────────┘               │

         ┌────────────────── Parallel Tracks ───────────────────────┐
         │ Track A: P1-a → P1-g            (3.0d, TUI)             │
         │ Track B: P1-b → P1-c → P1-c-ext (6.75d, Token+Oppty)   │
         │ Track C: P1-d → P1-e → P1-f     (2.0d, Kanban)          │
         │ Track D: P1-h                    (1.0d, Broker, indep)   │
         │                                                          │
         │ Tracks A, B, C, D can run in PARALLEL (zero shared files)│
         │ P1-g depends on P1-a (same track, sequential)            │
         │ P1-c depends on P1-b (same track, sequential)            │
         │ P1-c-ext depends on P1-c (same track, sequential)        │
         │ P1-e/f depend on P1-d (same track, sequential)           │
         │ P1-h is fully independent (only dep on P0-b client)      │
         └──────────────────────────────────────────────────────────┘
```

## P0 Carry-Over State (Expected at P1 Start)

P1 assumes these P0 deliverables are verified green:

| P0 Card | What Must Exist | Status (Session 19) |
|---------|-----------------|---------------------|
| P0-0 | Zig 0.14.0 + `@opentui/core` v0.3.1 in `packages/tui/` | ✅ DONE |
| P0-a | 4-panel TUI (kanban, chat, chain, status bar) + input bar | ✅ DONE |
| P0-b | `neuralgentics-client/` with 42 typed JSON-RPC methods + 3-tier resolver | ✅ DONE |
| P0-c | `opencode-client/` with session lifecycle + streaming | ✅ DONE |
| P0-d | `scripts/dev-up.sh` + TUI sidecar lifecycle | ✅ DONE |
| P0-e | Binary path resolver (absorbed by P0-b) | ✅ DONE |
| P0-f | Compaction loop (75% auto, gemma4:31b extract, ≥10:1 savings) | TODO (T-026) |
| P0-g | Session manager with stateless protocol (seed prompt ≤250 tokens) | TODO (T-027) |
| P0-h | 7-part reseed ≤2K tokens, section-scoped AGENTS.md | TODO (T-028) |
| P0-i | `dispatchParallel(cards)` with 8 simultaneous agents | TODO (T-029) |
| P0-j | Diff panel with y/n accept + tester re-run | ✅ DONE |
| P0-k | Model registry (big/small/fast routing) | ✅ DONE |
| P0-l | E2E integration demo (12-prior all green) | TODO (T-031) |

**P1 is gated on:** P0-f (compaction), P0-g (session manager), P0-h (reseed), P0-i (parallel dispatch), P0-l (E2E demo) completing and all 101+ TUI tests + 4 Go modules staying green. P1-a, P1-b, P1-d, P1-h can start as soon as P0-b (Go client) and P0-a (TUI scaffold) are done — which they already are per Session 19.

---

## P1 Task Breakdown

### Task P1-a: TUI Surface Polish

- **Goal:** Finish all remaining TUI panels (chain viewer, status bar live data, spend panel), add theming infrastructure (dark/light/oled), and wire accessibility (screen reader tags, high-contrast mode). Transform the P0-a scaffold into a polished, usable terminal application.
- **Scope IN:**
  - `packages/tui/src/panels/chain.ts` — `ChainPanel` class with progressive thought rendering, branch navigation (←/→ arrows), `renderThoughtChain(chainId: string): void`, `navigateBranch(direction: 'prev' | 'next'): void`, `collapseThought(thoughtNumber: number): void`
  - `packages/tui/src/panels/spend.ts` — `SpendPanel` class with real-time token gauge (reads from P1-b `TokenCounter.getSessionTotal()`), progress bar, color thresholds (green <50%, yellow 50-75%, red >75%), `updateSpend(total: number, limit: number): void`
  - `packages/tui/src/panels/status.ts` — `StatusBar` class rewrite to live data: session ID from P0-g `SessionManager`, token gauge from P1-b counter, agent roster from P0-k registry, compaction cycle count from P0-f, LLM online/offline from P0-c client state
  - `packages/tui/src/themes.ts` — `ThemeManager` class: `loadTheme(name: 'dark' | 'light' | 'oled'): Theme`, `applyTheme(theme: Theme): void`, `getCurrentTheme(): Theme`, 3 theme presets with color maps for all panel backgrounds, text, borders, accent colors
  - `packages/tui/src/a11y.ts` — accessibility helpers: `setAriaLabel(element: string, label: string): void`, `enableHighContrast(): void`, `announceToScreenReader(message: string): void`, `focusPanel(panel: PanelName): void`
  - `packages/tui/src/__tests__/p1a-theme.test.ts` — theme load/apply/switch tests
  - `packages/tui/src/__tests__/p1a-a11y.test.ts` — aria label + high-contrast tests
  - `packages/tui/src/index.ts` — wire ChainPanel, SpendPanel, StatusBar live data, theme selector (F2 to cycle), a11y toggle (F3)
- **Scope OUT:**
  - `/spend` slash command implementation (→ P1-b owns the counter; P1-g wires the command)
  - `/chain <id>` slash command (→ P1-g wires it; P1-a builds the renderer panel)
  - Token counting logic (→ P1-b `counter.ts`)
  - Real chain data from Go backend (→ P0-i dispatcher passes chain_ids; P1-a renders what's in the TUI state)
  - Auto-compaction trigger UI (→ P0-f owns the compaction orchestration; P1-a just shows the cycle count)
- **Sub-tasks:**
  1. `packages/tui/src/panels/chain.ts` — implement `ChainPanel` with `renderThoughtChain`, branch nav, collapse, OpenTUI `Box` + `Text` constructs, progressive append on new thoughts (~150 lines)
  2. `packages/tui/src/panels/spend.ts` — implement `SpendPanel` with live gauge, progress bar, color thresholds, `updateSpend()` (~80 lines)
  3. `packages/tui/src/panels/status.ts` — rewrite `StatusBar` from hardcoded → live data hooks into P0-c/P0-g/P1-b/P0-f state (~100 lines)
  4. `packages/tui/src/themes.ts` — `ThemeManager` with 3 presets, `loadTheme`/`applyTheme`/`getCurrentTheme`, F2 cycling (~120 lines)
  5. `packages/tui/src/a11y.ts` — screen reader tags + high-contrast + panel focus (~60 lines)
  6. `packages/tui/src/index.ts` — wire ChainPanel to right panel slot, SpendPanel to bottom-right corner, StatusBar to live data, F2/F3 keybindings, SIGWINCH re-layout (~80 lines)
  7. `packages/tui/src/__tests__/p1a-theme.test.ts` — 8 tests (load each theme, apply, cycle, custom theme override)
  8. `packages/tui/src/__tests__/p1a-a11y.test.ts` — 6 tests (aria labels set, high-contrast enable/disable, focusPanel, announce)
- **Acceptance criteria:**
  - [ ] ChainPanel renders thoughts progressively with navigation between branches
  - [ ] SpendPanel shows live token gauge updating <500ms after P1-b counter updates
  - [ ] StatusBar shows all 4 live fields (session ID, token gauge, agent roster, compaction cycles) from real state
  - [ ] F2 cycles dark → light → oled → dark; all panels re-render with correct colors
  - [ ] F3 toggles high-contrast mode; screen reader announces "High contrast enabled"
  - [ ] Terminal resize (SIGWINCH) re-lays out all panels correctly within 100ms
  - [ ] `bun test`: all new tests pass (14+), zero regressions on existing 101
  - [ ] `bun run typecheck`: 0 errors
  - [ ] Zero `blessed` dependencies — OpenTUI only
- **Dependencies:** P0-a (4-panel TUI scaffold, already DONE), P0-c (LLM online/offline state), P0-g (session ID), P0-k (agent roster), P0-f (compaction cycle count). P1-b (token counter) for live SpendPanel data — can stub until P1-b is done.
- **Effort:** 2.0 days
- **Parallelization:** Can run alongside P1-b (different files, no shared state), P1-d (kanban), P1-h (broker). Wait on P1-g until P1-a is done (P1-g wires commands that use P1-a's panels).

---

### Task P1-b: Token Accountant — Counter + Reporter + `/spend` Command

- **Goal:** Implement per-call token counting (input/output/cached/system), per-task/per-agent/per-model tagging, token ledger storage in neuralgentics, TUI status bar live spend, `/spend` slash command with subcommands, and wrap-up audit token reports. Budget enforcement is NOT built — this is visibility-only per user decision #5.
- **Scope IN:**
  - `packages/tui/src/token-accountant/counter.ts` — `TokenCounter` class: `recordCall(input: number, output: number, cached: number, system: number, metadata: {taskId?: string, agentId?: string, model: string}): void`, `getTaskTotal(taskId: string): TokenBreakdown`, `getAgentTotal(agentId: string): TokenBreakdown`, `getModelTotal(model: string): TokenBreakdown`, `getSessionTotal(): TokenBreakdown`, `getProjectedSessionTotal(): number`, `reset(): void`. `TokenBreakdown` interface: `{input: number, output: number, cached: number, system: number, total: number}`
  - `packages/tui/src/token-accountant/reporter.ts` — `TokenReporter` class: `generateCardReport(cardIds: string[]): CardTokenReport`, `generateModelReport(): ModelTokenReport`, `generateCompactionReport(): CompactionSavingsReport`, `generateGrandTotal(): GrandTotalReport`, `formatReport(report: any): string` (Markdown table format matching v4-FINAL §508.3)
  - `packages/tui/src/token-accountant/types.ts` — `TokenBreakdown`, `TokenLedgerEntry` (id, timestamp, sessionId, taskId, agentId, model, input, output, cached, system), `CardTokenReport`, `ModelTokenReport`, `CompactionSavingsReport`, `GrandTotalReport` interfaces
  - `packages/tui/src/token-accountant/index.ts` — barrel export
  - `packages/tui/src/commands/spend.ts` — `/spend` command handler: `/spend` (session total), `/spend today` (today's total), `/spend by-card` (per-card breakdown), `/spend by-agent` (per-agent), `/spend by-model` (per-model), `/spend projected` (estimated session total based on burn rate), `/spend report` (full wrap-up report to chat panel)
  - `packages/tui/src/index.ts` — wire `TokenCounter.recordCall()` into P0-c `OpenCodeClient` on every LLM API response (extract usage from response metadata); wire `TokenCounter.getSessionTotal()` into P1-a `SpendPanel.updateSpend()`; wire `TokenReporter` into handoff flow
  - `packages/tui/src/__tests__/token-accountant.test.ts` — unit tests for counter, reporter, types, spend command parser
- **Scope OUT:**
  - Budget enforcement (max_tokens fields, card blocking on exceed, user override dialog) — **REMOVED per Addendum 1**
  - `/budget` slash command — **renamed to `/spend`**
  - `budget.ts` or `panels/budget.ts` — **deleted, never created**
  - Cost estimation in dollars (tokens only for v0.1.0; dollar mapping is v0.2.0)
  - Per-project spend tracking (across sessions) — P1-b is per-session only
- **Sub-tasks:**
  1. `packages/tui/src/token-accountant/types.ts` — define `TokenBreakdown`, `TokenLedgerEntry`, `CardTokenReport`, `ModelTokenReport`, `CompactionSavingsReport`, `GrandTotalReport` interfaces (~60 lines)
  2. `packages/tui/src/token-accountant/counter.ts` — `TokenCounter` with `recordCall`, `getTaskTotal`, `getAgentTotal`, `getModelTotal`, `getSessionTotal`, `getProjectedSessionTotal`, `reset` (~120 lines)
  3. `packages/tui/src/token-accountant/reporter.ts` — `TokenReporter` with `generateCardReport`, `generateModelReport`, `generateCompactionReport`, `generateGrandTotal`, `formatReport` (Markdown table) (~150 lines)
  4. `packages/tui/src/token-accountant/index.ts` — barrel export (~5 lines)
  5. `packages/tui/src/commands/spend.ts` — `/spend` command handler with 6 subcommand parsers, routes to `TokenReporter` for formatted output (~80 lines)
  6. `packages/tui/src/index.ts` — wire `TokenCounter.recordCall()` into OpenCodeClient response handler; wire `getSessionTotal()` into SpendPanel; register `/spend` command in commands.ts router (~30 lines add)
  7. `packages/tui/src/__tests__/token-accountant.test.ts` — 15 tests (recordCall, breakdowns by task/agent/model/session, projected, reset, report formatting, spend subcommand parsing)
- **Acceptance criteria:**
  - [ ] `TokenCounter.recordCall()` called automatically on every LLM response — counter increments correctly
  - [ ] `/spend` in input bar → chat panel shows "Session total: 45,230 tokens (input: 28,100 | output: 12,450 | cached: 3,200 | system: 1,480)"
  - [ ] `/spend by-card` → per-card breakdown with model split
  - [ ] `/spend by-model` → "Model deepseek-v4-pro:cloud — Input: 24,500 | Output: 8,200 | Total: 32,700"
  - [ ] `/spend projected` → "Projected session total: ~98,000 tokens (burn rate: 2,450/turn, ~40 turns remaining)"
  - [ ] Wrap-up audit at session end includes token report matching v4-FINAL §508.3 format
  - [ ] Zero budget enforcement code anywhere — grep for `budget` in `packages/tui/src/` returns only `token-accountant/reporter.ts` (CompactionSavingsReport field name only)
  - [ ] `bun test`: 15 new tests pass; zero regressions
- **Dependencies:** P0-c (OpenCode client — hooks into LLM response for token extraction), P0-g (session manager — session ID for ledger), P0-b (Go client — stores `type: "token_ledger"` memories in neuralgentics). P1-a (SpendPanel) for TUI rendering — can start before P1-a if stubbing the panel render.
- **Effort:** 1.0 day
- **Parallelization:** Can run alongside P1-a (different files), P1-d (kanban), P1-h (broker). Is prerequisite for P1-c (opportunity detector needs counter+reporter for token_ledger data).

---

### Task P1-c: Opportunity Detector — Patterns + Ranker + Prompter

- **Goal:** Implement the 8 detection pattern catalog, candidate ranker, and user-facing prompter from Addendum 1. Detects token/tool-call patterns, surfaces skill/script creation candidates at session end, and auto-drafts T-NNN cards in TASKS.md when user accepts. Replaces the removed budget enforcement with a value-add "spend less NEXT TIME" feedback loop.
- **Scope IN:**
  - `packages/tui/src/opportunity-detector/patterns.ts` — `PatternDetector` class with 8 `detect*` methods (one per pattern): `detectSequentialToolChains(ledger: TokenLedgerEntry[], toolCalls: ToolCallLog[]): Candidate[]`, `detectRepeatedIdenticalCalls(toolCalls: ToolCallLog[]): Candidate[]`, `detectHighCostTurns(ledger: TokenLedgerEntry[]): Candidate[]`, `detectLongCardRetries(cardHistory: CardAttemptHistory[]): Candidate[]`, `detectReReadingSameFiles(toolCalls: ToolCallLog[]): Candidate[]`, `detectMissedParallelOpportunities(toolCalls: ToolCallLog[]): Candidate[]`, `detectManualAggregation(subAgentDispatches: DispatchLog[]): Candidate[]`, `detectErrorRetryLoops(toolCalls: ToolCallLog[]): Candidate[]`. Each returns `Candidate[]` with `{patternType, description, suggestedFix, estimatedSavings, buildEffort, priority, evidence}`
  - `packages/tui/src/opportunity-detector/detector.ts` — `OpportunityDetector` class: `runAllPatterns(): Candidate[]` (parallel dispatch of all 8 `detect*`), `rankCandidates(candidates: Candidate[]): RankedCandidate[]` (formula: `score = estimated_token_savings × frequency_per_session × scope_multiplier`), `getTopCandidates(n: number): RankedCandidate[]`, `checkTriggers(): boolean` (session duration >2h, tokens >200K, calls >50, end-of-wrap-up, manual `/opportunities`)
  - `packages/tui/src/opportunity-detector/prompter.ts` — `OpportunityPrompter` class: `showPrompt(candidates: RankedCandidate[]): void` (TUI dialog with [Y]/[1]/[2]/[N]/[L]/[S] keybindings per Addendum 1 §4.6), `draftCard(candidate: RankedCandidate): string` (T-NNN markdown card per §4.7 format), `writeCardToBoard(card: string): void` (appends to TASKS.md via P1-d KanbanManager), `handleKeypress(key: string): void` (Y/N/1/2/L/S routing)
  - `packages/tui/src/opportunity-detector/types.ts` — `Candidate`, `RankedCandidate`, `CardAttemptHistory`, `ToolCallLog`, `DispatchLog`, `TriggerCondition` interfaces
  - `packages/tui/src/opportunity-detector/index.ts` — barrel export
  - `skills/opportunity-detector/SKILL.md` — skill documentation: 8 patterns, trigger conditions, candidate ranking, integration with skill-self-audit
  - `packages/tui/src/commands/opportunities.ts` — `/opportunities` command handler: manual trigger, `/opportunities list` (show all candidates), `/opportunities --refresh` (force re-scan)
  - `packages/tui/src/__tests__/opportunity-detector.test.ts` — tests for all 8 pattern detectors, ranking formula, prompter dialog states, card draft format
- **Scope OUT:**
  - Aggregator lookup (→ P1-c-ext adds the 7-aggregator search pre-check)
  - Budget enforcement (REMOVED) — this replaces it
  - Auto-building skills (→ `skill-self-audit` skill + `boomerang-agent-builder` handle the actual build)
  - Installing external packages (→ P1-c-ext adds install command generation)
  - The `budget.ts` or `/budget` command (REMOVED — deleted code paths covered in P1-b refactor)
- **Sub-tasks:**
  1. `packages/tui/src/opportunity-detector/types.ts` — `Candidate`, `RankedCandidate`, `CardAttemptHistory`, `ToolCallLog`, `DispatchLog`, `TriggerCondition` interfaces (~50 lines)
  2. `packages/tui/src/opportunity-detector/patterns.ts` — 8 `detect*` methods, each queries memini-ai for token_ledger/tool_call data via P0-b client, runs detection algorithm, returns Candidate[] (~300 lines)
  3. `packages/tui/src/opportunity-detector/detector.ts` — `OpportunityDetector` with `runAllPatterns` (Promise.all), `rankCandidates`, `checkTriggers` (~120 lines)
  4. `packages/tui/src/opportunity-detector/prompter.ts` — `OpportunityPrompter` with TUI dialog rendering, keybinding handling, card drafting to TASKS.md (~150 lines)
  5. `packages/tui/src/opportunity-detector/index.ts` — barrel export (~5 lines)
  6. `packages/tui/src/commands/opportunities.ts` — `/opportunities` handler with `list` and `--refresh` subcommands (~60 lines)
  7. `skills/opportunity-detector/SKILL.md` — pattern catalog, trigger conditions, integration guide (~100 lines)
  8. `packages/tui/src/__tests__/opportunity-detector.test.ts` — 20 tests (2-3 per pattern × 8 + ranker + prompter dialog states + card draft format + trigger checks)
- **Acceptance criteria:**
  - [ ] Session reaches 2-hour mark → opportunity detector auto-runs at session end
  - [ ] Pattern #1 detects `find_files(7×) → grep(12×) → read(4×)` and suggests `codebase-search` skill
  - [ ] Pattern #8 detects `searxng_web_search` errored 4× and suggests circuit breaker or retry-with-backoff
  - [ ] Prompter shows [Y]/[1]/[2]/[N]/[L]/[S] dialog as an OpenTUI modal overlay
  - [ ] User hits [Y] → card auto-drafted in TASKS.md with all required fields (Status, Priority, Assignee, Source, Pattern Detected, Proposed Skill Spec, Build Effort, Acceptance)
  - [ ] User hits [N] → recorded in "considered" log; same pattern not re-suggested for 7 days
  - [ ] User hits [L] → full breakdown with match details shown in chat panel
  - [ ] `/opportunities` manual trigger works at any time
  - [ ] Negative report at session end when no patterns detected: "No new opportunities detected this session"
  - [ ] `bun test`: 20 new tests pass; zero regressions
- **Dependencies:** P1-b (token counter + reporter — patterns query token_ledger data), P0-b (Go client — queries memini-ai), P0-g (session manager — session duration tracking for triggers), P1-d (kanban manager — drafts cards to TASKS.md). P1-a (TUI panels) for modal dialog rendering — can stub modal until P1-a done.
- **Effort:** 2.5 days
- **Parallelization:** Sequential on P1-b (needs counter). Can run in parallel with P1-d (different files; P1-c depends on P1-d for card drafting but can stub that interface). Is prerequisite for P1-c-ext.

---

### Task P1-c-ext: Aggregator-Aware Lookup — Search + Install + Trust + Caching

- **Goal:** Extend the P1-c Opportunity Detector with a 7-aggregator pre-check before suggesting "build." Before surfacing a "build a skill" suggestion, query the Official MCP Registry, mcpservers.org, Orchestra Research AI-Research-SKILLs, Anthropic Skills Hub, npm, PyPI, and our internal skills directory for existing solutions. If a match is found, surface a 1-line install command instead of a build task. Implements the 4-tier trust model, weekly aggregator index, LLM-based semantic lookup (Option B), and install command generation (suggest, not auto-install).
- **Scope IN:**
  - `packages/tui/src/opportunity-detector/aggregator-index.ts` — `AggregatorIndexBuilder` class: `buildIndex(): Promise<void>` (fetches from 7 aggregators, normalizes to flat JSON, stores as `type: "aggregator_index"` memini-ai memories, 1 per aggregator), `refreshIndex(force: boolean): Promise<void>` (force re-fetches all 7), `getIndexAge(): number` (days since last build). Weekly cron job equivalent: called on `--refresh` flag or TUI startup if index >7 days old.
  - `packages/tui/src/opportunity-detector/aggregator-lookup.ts` — `AggregatorLookup` class: `lookup(patternType: string, patternDescription: string, context: string): Promise<AggregatorResult[]>` (prompts gemma4:31b with index + pattern → returns ranked matches in structured JSON per Addendum 2 §4.4), `fallbackToInternal(): Promise<AggregatorResult[]>` (internal skills only), `fallbackToStale(): Promise<AggregatorResult[]>` (cached previous results with staleness warning)
  - `packages/tui/src/opportunity-detector/install-generator.ts` — `InstallGenerator` class: `generateCommand(result: AggregatorResult): string` (maps aggregator → install command template per Addendum 2 §5.1), `generateMCPConfig(name: string, package: string): MCPConfig` (JSON block for `opencode.json`), `writeConfig(config: MCPConfig): Promise<void>` (appends to `.opencode/opencode.json` mcpServers block)
  - `packages/tui/src/opportunity-detector/trust-scorer.ts` — `TrustScorer` class: `scoreResult(result: AggregatorResult, searchQuery: string): number` (formula: name_similarity×0.3 + description_similarity×0.4 + trust_tier_score×0.2 + install_simplicity×0.1), `getTrustTierScore(tier: 1|2|3|4): number` ({1: 1.0, 2: 0.7, 3: 0.4, 4: 0.2}), `recordInstall(result: AggregatorResult): void` (saves `type: "aggregator_install"` memory, adjusts trust on aggregator_index), `recordReject(result: AggregatorResult): void` (saves `type: "aggregator_reject"` memory, adjusts trust signal `agent_ignored`)
  - `packages/tui/src/__tests__/aggregator-lookup.test.ts` — unit tests for index builder, lookup engine, install generator, trust scorer with mocked aggregator responses
  - Modify `packages/tui/src/opportunity-detector/detector.ts` — insert `aggregatorLookup.lookup()` step before `rankCandidates()`, tier results (1=aggregator match, 2=package match, 3=internal skill, 4=build new)
  - Modify `packages/tui/src/opportunity-detector/prompter.ts` — extend dialog to show 4-tier results per §3.4, add [1]/[2]/[3]/[B]/[N]/[L]/[S] keybindings, wire `InstallGenerator` on [1]/[2] selection
  - Modify `skills/opportunity-detector/SKILL.md` — add aggregator-aware section: 7 sources, 4 tiers, trust scoring, `/opportunities --refresh`
- **Scope OUT:**
  - Remaining 4 aggregators (mcpservers.org, Anthropic Skills Hub, npm, PyPI are all IN scope for v0.1.0 per the aggregator catalog §2.1 — the "MVP 3 of 7" refers to which are FULLY automated vs. LLM-indexed. The LLM-based approach (Option B) makes all 7 usable at v0.1.0 without per-aggregator API clients. **Correction from roadmap**: all 7 aggregators are consulted; 3 (Official MCP Registry, Orchestra, Internal) are Tier 1 trust; the remaining 4 are Tier 2/3 via LLM match against the weekly index.)
  - PulseMCP, Glama, Skills.sh, SkillHub, OpenAI Skills, pkg.go.dev, crates.io (secondary aggregators; deferred to v0.2.0)
  - Auto-install (no auto-installing third-party code without user approval)
  - MCP server process management (start/stop/reload) — just config writing
- **Sub-tasks:**
  1. `packages/tui/src/opportunity-detector/aggregator-index.ts` — `AggregatorIndexBuilder` fetching from 7 sources, normalizing to flat JSON, storing in memini-ai, `refreshIndex`, `getIndexAge` (~180 lines)
  2. `packages/tui/src/opportunity-detector/aggregator-lookup.ts` — `AggregatorLookup` with gemma4:31b prompt builder, result parser, `fallbackToInternal`, `fallbackToStale` (~150 lines)
  3. `packages/tui/src/opportunity-detector/install-generator.ts` — `InstallGenerator` with per-aggregator command templates, MCP config generation, config file writing (~100 lines)
  4. `packages/tui/src/opportunity-detector/trust-scorer.ts` — `TrustScorer` with scoring formula, trust tier mapping, install/reject recording (~80 lines)
  5. Modify `packages/tui/src/opportunity-detector/detector.ts` — insert `aggregatorLookup.lookup()` pre-step, tier results, merge with pattern candidates (~50 lines add)
  6. Modify `packages/tui/src/opportunity-detector/prompter.ts` — extend dialog with 4-tier display, install keybindings, wire InstallGenerator (~80 lines add)
  7. Modify `skills/opportunity-detector/SKILL.md` — aggregator-aware section (~40 lines add)
  8. `packages/tui/src/__tests__/aggregator-lookup.test.ts` — 15 tests (index build, lookup with mock gemma4:31b, install command generation, trust scoring, cache invalidation, offline fallback, stale results)
- **Acceptance criteria:**
  - [ ] `--refresh` builds aggregator index from 7 sources in <30s, stores as 7 `type: "aggregator_index"` memories
  - [ ] Pattern detected → aggregator lookup → Context7 MCP matches "find_files+grep+read" → Tier 1 result shown before build suggestion per §3.4 dialog
  - [ ] User hits [1] → MCP server config block generated and appended to `.opencode/opencode.json`
  - [ ] User hits [2] → `bun add ripgrep-tree` install command shown; user must manually run it (suggest-install per §5.2)
  - [ ] No aggregator match → falls back to P1-c Tier 4 "Build New" suggestion
  - [ ] gemma4:31b unreachable → falls back to internal skills match + stale cached results with "Cached from {date}" label
  - [ ] Aggregator index >7 days old → lookup prompt includes "⚠️ Aggregator index is 8 days old" warning per §7.2
  - [ ] Install recorded as `type: "aggregator_install"` memory with trust signal `agent_used` on the aggregator_index
  - [ ] Reject recorded as `type: "aggregator_reject"` memory with trust signal `agent_ignored`; same result suppressed for 30 days
  - [ ] `bun test`: 15 new tests + all P1-c tests still pass; zero regressions
- **Dependencies:** P1-c (opportunity detector — extends its detector.ts + prompter.ts), P1-b (token accountant — token_ledger data feeds patterns), P0-b (Go client — memini-ai storage for index/results), P0-c (OpenCode client — gemma4:31b model access for LLM lookup)
- **Effort:** 3.25 days
- **Parallelization:** Sequential on P1-c (extends it). Can run in parallel with P1-d+e+f (different files). Cannot run before P1-b (needs token accountant for pattern detection data) or P1-c (extends its code).

---

### Task P1-d: Kanban Board with Circuit Breaker

- **Goal:** Implement a full kanban board manager with 7-column TASKS.md state machine, `failure_count`/`failure_limit` fields, auto-block on N consecutive failures (`failure_limit = 2` per user decision #4), card status transitions (ready→running→done, running→blocked), and board queries (find ready cards, blocked cards, cards by phase).
- **Scope IN:**
  - `packages/tui/src/kanban/manager.ts` — `KanbanManager` class: `parseBoard(): Map<Status, Card[]>` (reads TASKS.md, parses ## sections into typed cards), `getReadyCards(): Card[]`, `getBlockedCards(): Card[]`, `getCardsByStatus(status: Status): Card[]`, `transitionCard(cardId: string, from: Status, to: Status): void` (validates transition legality, updates TASKS.md atomically), `incrementFailureCount(cardId: string): void` (++failure_count, if ≥ failure_limit → auto-block), `resetFailureCount(cardId: string): void`, `createCard(card: NewCard): string` (generates T-NNN card with all required fields per kanban-board-manager SKILL.md schema), `updateCardStatus(cardId: string, status: Status): void` (in-place update in TASKS.md), `getCircuitBreakerState(): {blockedToday: number, failuresToday: number}`
  - `packages/tui/src/kanban/types.ts` — extend `Card` interface: add `failureCount: number`, `failureLimit: number` (default 2), `attemptHistory: AttemptEntry[]`, `comments: Comment[]`
  - `packages/tui/src/kanban/parser.ts` — extend `parseTASKS()` to extract `failure_count`, `failure_limit`, `attempts` from card frontmatter
  - `packages/tui/src/__tests__/kanban-manager.test.ts` — tests for state machine, circuit breaker, card creation, transition validation, failure counting
- **Scope OUT:**
  - Comments rendering (→ P1-e adds `## Comments` block display)
  - Attempts history rendering (→ P1-f adds `## Previous Attempts` block)
  - Cross-card dependency tracking (→ P2-d event synthesis)
  - Goal-mode cards (→ v0.2.0)
  - Auto-archive on N failures (P1-d blocks; archive is manual or via wrap-up audit)
- **Sub-tasks:**
  1. `packages/tui/src/kanban/types.ts` — extend `Card` with `failureCount`, `failureLimit`, `attemptHistory`, `comments` (~30 lines add)
  2. `packages/tui/src/kanban/parser.ts` — extend to extract new fields from card frontmatter (~40 lines add)
  3. `packages/tui/src/kanban/manager.ts` — `KanbanManager` with `parseBoard`, `getReadyCards`, `getBlockedCards`, `getCardsByStatus`, `transitionCard` with state validation, `incrementFailureCount` with auto-block logic, `resetFailureCount`, `createCard`, `updateCardStatus`, `getCircuitBreakerState` (~200 lines)
  4. `packages/tui/src/index.ts` — instantiate `KanbanManager`, wire into status bar (blocked count), wire `transitionCard` calls from P0-j diff panel (on accept/reject) and P0-i dispatcher (on dispatch/complete/fail) (~30 lines add)
  5. `packages/tui/src/__tests__/kanban-manager.test.ts` — 15 tests (parse all statuses, ready/blocked queries, valid transitions, invalid transition rejection, failure_count increment, circuit breaker trigger at limit=2, limit=1 edge case, card creation with template, status update, circuit breaker state query)
- **Acceptance criteria:**
  - [ ] `KanbanManager.getReadyCards()` returns all `## Ready` cards with correct parsed fields
  - [ ] Card transitions: `ready → running`, `running → done`, `running → blocked` all work; `done → running` rejected
  - [ ] Card fails once (`failure_count = 1`, `failure_limit = 2`) → card stays `running`
  - [ ] Card fails twice (`failure_count = 2`, `failure_limit = 2`) → card auto-blocked with reason "Circuit breaker: 2 consecutive failures. Limit: 2."
  - [ ] `failure_count` resets to 0 on successful card completion (running→done)
  - [ ] `KanbanManager.createCard()` generates valid T-NNN card with all required fields per kanban-board-manager SKILL.md schema
  - [ ] Card updates written to TASKS.md atomically (no partial writes)
  - [ ] Status bar shows `🔴 2 blocked` or `✅ 0 blocked` correctly
  - [ ] `bun test`: 15 new tests pass; zero regressions
- **Dependencies:** P0-g (session manager — board state tracking), P0-b (Go client — card updates may need to sync to memini-ai). P1-a (TUI status bar render) — can stub display until P1-a done.
- **Effort:** 1.0 day
- **Parallelization:** Can run alongside P1-a, P1-b, P1-h (different files). Prerequisite for P1-e and P1-f (both extend the kanban manager).

---

### Task P1-e: Comments on Cards — Inter-Agent Protocol

- **Goal:** Add a `## Comments` block to kanban cards and a `comment` operation for inter-agent communication. Workers leave structured comments with author, timestamp, and body; the orchestrator displays them inline in the kanban panel. Comments are NOT evidence — they're conversation. This implements v3 P0-a.
- **Scope IN:**
  - `packages/tui/src/kanban/comments.ts` — `CommentManager` class: `addComment(cardId: string, author: string, body: string): void` (appends to `## Comments` block in card), `getComments(cardId: string): Comment[]`, `formatComment(comment: Comment): string` (Markdown: `**@author** (2026-06-04 14:30):\n> body`), `collapseComments(cardId: string, maxVisible: number): string` (collapses if >5, shows "Show N more comments...")
  - `packages/tui/src/kanban/types.ts` — extend `Comment` interface: `{author: string, timestamp: string, body: string, id: string}`
  - `packages/tui/src/kanban/manager.ts` — extend `KanbanManager` with `addComment(cardId, author, body)` delegation to `CommentManager`
  - `packages/tui/src/panels/kanban.ts` — extend kanban panel render to show inline comments under each card (collapsed if >5), expand on `Enter` keypress
  - `packages/tui/src/__tests__/kanban-comments.test.ts` — tests for add, get, format, collapse
- **Scope OUT:**
  - Comment threads/replies (flat comments only for v0.1.0)
  - Comment editing/deletion (immutable after post)
  - Real-time comment notifications (no websocket — manual refresh via `/board`)
  - Comment author avatars or rich formatting
- **Sub-tasks:**
  1. `packages/tui/src/kanban/types.ts` — add `Comment` interface (~10 lines)
  2. `packages/tui/src/kanban/comments.ts` — `CommentManager` with `addComment`, `getComments`, `formatComment`, `collapseComments` (~60 lines)
  3. `packages/tui/src/kanban/manager.ts` — extend with `addComment` delegation (~10 lines)
  4. `packages/tui/src/panels/kanban.ts` — extend kanban render: show last 2 comments inline per card, `…5 more comments` link, `Enter` to expand full thread (~50 lines add)
  5. `packages/tui/src/__tests__/kanban-comments.test.ts` — 8 tests (add single, add multiple, get by card, format, collapse with count, no comments edge case, empty body rejection, duplicate ID detection)
- **Acceptance criteria:**
  - [ ] `CommentManager.addComment("T-003", "boomerang-coder", "Cannot determine OAuth spec version — need architect review")` appends a formatted comment to T-003's `## Comments` block in TASKS.md
  - [ ] Kanban panel shows last 2 comments under T-003 inline; "…3 more comments" if 5 total
  - [ ] `Enter` on card with comments → expands full comment thread in kanban panel
  - [ ] Comments persist across TASKS.md reads (no loss on `/board` refresh)
  - [ ] Comment format: `**@author** (ISO timestamp):\n> body` with proper Markdown
  - [ ] `bun test`: 8 new tests pass; zero regressions
- **Dependencies:** P1-d (kanban manager — extends it with comment mutation), P1-a (kanban panel rendering — extends it). P0-g (session manager — author identity from session).
- **Effort:** 0.5 day
- **Parallelization:** Sequential on P1-d. Can run in parallel with P1-f (different code; both extend P1-d but don't conflict). Cannot run before P1-d.

---

### Task P1-f: Attempts History — `## Previous Attempts` Block

- **Goal:** Add a `## Previous Attempts` block to kanban cards that logs each attempt (architect→coder→tester cycle) with the worker identity, timestamp, result, token cost, and a link to the wrap-up memory_id. Workers read this block before starting a retry so they don't repeat previous mistakes. This implements v3 P0-c.
- **Scope IN:**
  - `packages/tui/src/kanban/attempts.ts` — `AttemptManager` class: `recordAttempt(cardId: string, attempt: AttemptEntry): void` (appends to `## Previous Attempts` block in card), `getAttempts(cardId: string): AttemptEntry[]`, `formatAttempt(attempt: AttemptEntry): string` (Markdown: `### Attempt N (worker, timestamp, result, N tokens)`), `getLastFailure(cardId: string): AttemptEntry | null`
  - `packages/tui/src/kanban/types.ts` — extend `AttemptEntry` interface: `{attemptNumber: number, worker: string, timestamp: string, result: 'success' | 'failure', tokensSpent: number, memoryId: string, summary: string}`
  - `packages/tui/src/kanban/manager.ts` — extend `KanbanManager` with `recordAttempt` delegation; call `recordAttempt` on every `running→done` and `running→blocked` transition
  - `packages/tui/src/index.ts` — wire `recordAttempt` calls from P0-j diff panel (on accept+tester pass → success; on accept+tester fail or reject → failure). Wire `recordAttempt` from P0-i dispatcher (agent returns → success or failure based on wrap-up evidence).
  - `packages/tui/src/__tests__/kanban-attempts.test.ts` — tests for record, get, format, last failure query
- **Scope OUT:**
  - Attempt diff comparison (auto-detect if two attempts made the same mistake) — v0.2.0
  - Cross-card attempt pattern detection (detecting similar failures across different cards) — v0.2.0
  - Attempt rollback or revert
- **Sub-tasks:**
  1. `packages/tui/src/kanban/types.ts` — extend `AttemptEntry` interface (~15 lines)
  2. `packages/tui/src/kanban/attempts.ts` — `AttemptManager` with `recordAttempt`, `getAttempts`, `formatAttempt`, `getLastFailure` (~70 lines)
  3. `packages/tui/src/kanban/manager.ts` — extend with `recordAttempt` delegation; wire into `transitionCard` for auto-recording on running→done/blocked (~20 lines add)
  4. `packages/tui/src/index.ts` — wire `recordAttempt` from P0-j diff panel and P0-i dispatcher (~20 lines add)
  5. `packages/tui/src/__tests__/kanban-attempts.test.ts` — 8 tests (record success, record failure, get all attempts, format with correct attempt numbers, last failure query, attempt count increment, memoryId link, multiple failures formatting)
- **Acceptance criteria:**
  - [ ] Card T-003 goes running→blocked (circuit breaker) → `## Previous Attempts` block auto-appended with Attempt 1 (failure, "Cannot determine OAuth spec version", 5,400 tokens)
  - [ ] Card T-003 unblocked → re-dispatched → runs again → running→blocked → Attempt 2 appended (failure, "OAuth scope mismatch", 4,200 tokens)
  - [ ] Card T-003 eventually succeeds → Attempt 3 appended (success, "OAuth flow implemented", 8,100 tokens, memoryId: abc-123)
  - [ ] `AttemptManager.getLastFailure("T-003")` returns Attempt 2 (most recent failure)
  - [ ] Format: `### Attempt 2 (boomerang-coder, 2026-06-04 15:45, failure, 4,200 tokens)` with summary line and memory_id link
  - [ ] Attempts persist in TASKS.md across TUI sessions
  - [ ] `bun test`: 8 new tests pass; zero regressions
- **Dependencies:** P1-d (kanban manager — extends `transitionCard` hook), P0-j (diff panel — wired for attempt recording), P0-i (dispatcher — wired for attempt recording). P1-e (comments) — no dependency (attempts ≠ comments).
- **Effort:** 0.5 day
- **Parallelization:** Sequential on P1-d. Can run in parallel with P1-e (different code; both extend P1-d but don't conflict). Cannot run before P1-d.

---

### Task P1-g: Slash Commands — 10 Functional Commands

- **Goal:** Wire all 10 planned slash commands as functional TypeScript handlers (not stubs). Replace the P0-a stubs with real implementations that query backends, trigger actions, and output results to the chat panel with proper formatting. This makes the input bar the primary TUI interaction surface.
- **Scope IN:**
  - `packages/tui/src/commands/compact.ts` — `/compact` handler: `handleCompact(): void` → triggers P0-f compaction orchestrator, shows "compacting..." spinner, outputs `Compaction complete. Saved 23 memories. Savings: 85K tokens.` on completion
  - `packages/tui/src/commands/memory.ts` — `/memory <query>` handler: `handleMemory(query: string): void` → queries neuralgentics via P0-b client `memory.query`, renders results as formatted list in chat panel
  - `packages/tui/src/commands/board.ts` — `/board [cardId?]` handler: `handleBoard(cardId?: string): void` → if no arg: shows kanban summary (counts per status). If cardId: shows full card details (scope, acceptance, comments, attempts)
  - `packages/tui/src/commands/chain.ts` — `/chain <id>` handler: `handleChain(chainId: string): void` → queries neuralgentics `thought.getThoughtChain`, renders chain in P1-a `ChainPanel`, outputs summary to chat panel
  - `packages/tui/src/commands/agents.ts` — `/agents` handler: `handleAgents(): void` → shows agent roster from P0-k registry with status (idle/running), model assignment, active card
  - `packages/tui/src/commands/resume.ts` — `/resume` handler: `handleResume(): void` → queries neuralgentics for last session state, loads TASKS.md board state, outputs "Resumed session sess-abc. 3 cards in progress, 2 ready." (P2-b adds full continuity; P1-g implements the query + summary)
  - `packages/tui/src/commands/harness.ts` — `/harness` handler: `handleHarness(): void` → runs `bun test` in packages/tui/, streams output to chat panel with pass/fail coloring
  - `packages/tui/src/commands/review.ts` — `/review <cardId>` handler: `handleReview(cardId: string): void` → dispatches reviewer agent for card, streams review output to chat panel
  - `packages/tui/src/commands/scaffold.ts` — `/scaffold <prompt>` handler: `handleScaffold(prompt: string): void` → dispatches architect → coder pipeline (via P0-g session manager + P0-i dispatcher), streams progress to chat panel
  - `packages/tui/src/commands/help.ts` — `/help [command?]` handler: `handleHelp(command?: string): void` → shows command list with descriptions; if command arg, shows detailed usage
  - `packages/tui/src/commands/spend.ts` — already built in P1-b (wire registration here)
  - `packages/tui/src/commands/opportunities.ts` — already built in P1-c (wire registration here)
  - `packages/tui/src/commands/index.ts` — `CommandRouter` class refactor: `route(input: string): void` (parses `/`-prefix, dispatches to handler), `register(command: string, handler: CommandHandler): void`, `getCommands(): CommandDef[]`
  - `packages/tui/src/__tests__/p1g-commands.test.ts` — tests for each of the 10 command handlers with mocked backends
- **Scope OUT:**
  - `/spend` (built in P1-b — P1-g just registers it)
  - `/opportunities` (built in P1-c — P1-g just registers it)
  - P2 commands: `/resume` with full cross-session continuity, `/harness` with CI integration (P1-g does basic `bun test`; P2 adds CI pipeline)
  - Auto-complete for commands (v0.2.0)
  - Command aliases (v0.2.0)
- **Sub-tasks:**
  1. `packages/tui/src/commands/index.ts` — refactor `CommandRouter` from stub router to dispatch-based with `route`/`register`/`getCommands` (~60 lines rewrite)
  2. `packages/tui/src/commands/compact.ts` — wire P0-f compaction orchestrator trigger (~30 lines)
  3. `packages/tui/src/commands/memory.ts` — `handleMemory` with P0-b client query, formatted output (~40 lines)
  4. `packages/tui/src/commands/board.ts` — `handleBoard` with P1-d KanbanManager query, card detail rendering (~50 lines)
  5. `packages/tui/src/commands/chain.ts` — `handleChain` with P0-b client thought chain fetch, ChainPanel push (~40 lines)
  6. `packages/tui/src/commands/agents.ts` — `handleAgents` with P0-k registry query (~30 lines)
  7. `packages/tui/src/commands/resume.ts` — `handleResume` with P0-b client session state query (~40 lines)
  8. `packages/tui/src/commands/harness.ts` — `handleHarness` with `child_process.spawn('bun', ['test'])`, streaming output (~50 lines)
  9. `packages/tui/src/commands/review.ts` — `handleReview` with P0-g session manager dispatch to reviewer agent (~40 lines)
  10. `packages/tui/src/commands/scaffold.ts` — `handleScaffold` with architect→coder pipeline dispatch (~50 lines)
  11. `packages/tui/src/commands/help.ts` — `handleHelp` with command list + detailed mode (~40 lines)
  12. `packages/tui/src/index.ts` — register all 10 commands in CommandRouter; replace stub routing (~20 lines add)
  13. `packages/tui/src/__tests__/p1g-commands.test.ts` — 10 tests (one per command handler with mocked backends, verify correct output format)
- **Acceptance criteria:**
  - [ ] `/compact` → compacts (non-blocking spinner) → outputs completion message with token savings
  - [ ] `/memory "user auth"` → queries neuralgentics → returns formatted memory list in chat panel
  - [ ] `/board T-003` → shows full card details (scope, acceptance, comments, attempts) in chat panel
  - [ ] `/chain abc-123` → renders thought chain in ChainPanel + summary in chat
  - [ ] `/agents` → shows roster with model + status
  - [ ] `/resume` → queries last session → shows summary of remaining work
  - [ ] `/harness` → runs `bun test` → streams pass/fail with colors
  - [ ] `/review T-003` → dispatches reviewer → streams review to chat
  - [ ] `/scaffold "build user auth"` → dispatches architect→coder → streams progress
  - [ ] `/help` → lists all 10 commands with 1-line descriptions; `/help compact` → shows detailed usage
  - [ ] P0-a stub handlers fully replaced — no "not implemented yet" messages for any P1-g command
  - [ ] `bun test`: 10 new tests pass; zero regressions
- **Dependencies:** P1-a (TUI panels — commands render to chat panel, chain panel, etc.), P1-b (spend command registration), P1-c (opportunities command registration), P1-d (board command queries kanban), P0-f (compaction orchestrator for /compact), P0-g (session manager for /resume, /scaffold dispatch), P0-i (dispatcher for /scaffold, /review), P0-k (model registry for /agents)
- **Effort:** 1.0 day
- **Parallelization:** Sequential on P1-a (needs panels for rendering). Can run in parallel with P1-c-ext (different files). Must run after P1-b, P1-c, P1-d (registers their commands).

---

### Task P1-h: Broker Permission-Gated Dispatch — `CanAccess(role, server)`

- **Goal:** Implement permission-gated agent dispatch via the Go backend broker. Before the orchestrator dispatches a sub-agent, call `CanAccess(role, server)` to verify the agent has the required tools. On denied access, narrow the agent's tool set or reassign to a role with the right permissions. This closes the security gap where agents could be dispatched to MCP servers they shouldn't access.
- **Scope IN:**
  - `packages/tui/src/agents/permission-gate.ts` — `PermissionGate` class: `canAccess(role: string, server: string): Promise<boolean>` (calls `broker.CanAccess` via P0-b JSON-RPC client), `getAllowedServers(role: string): Promise<string[]>` (returns list of accessible server names), `narrowOrReassign(role: string, requiredServers: string[]): Promise<{ role: string, allowedServers: string[] }>` (if current role lacks access to a required server, find an alternate role that has it)
  - `packages/tui/src/agents/dispatcher.ts` — extend `dispatchParallel` (from P0-i): before dispatching each sub-agent, call `permissionGate.canAccess(role, requiredServer)`; if denied → call `permissionGate.narrowOrReassign`; if no viable role → block the card with "No agent role has access to required server: github-mcp"
  - `packages/broker-go/src/neuralgentics/broker/access/access.go` — verify `CanAccess(roleName string, serverName string) bool` is implemented (checking against agent permission YAML from `.opencode/agents/*.md` tool allow/deny lists). If not yet implemented, implement it: load agent permissions on broker startup, maintain `map[string]map[string]bool` (role → server → allowed), expose via `broker.CanAccess` JSON-RPC.
  - `packages/tui/src/__tests__/permission-gate.test.ts` — tests for canAccess, getAllowedServers, narrowOrReassign, dispatch denial, circuit breaker on perm denial
- **Scope OUT:**
  - Lazy tool exposure (already built in Session 16-17: 4 JSON-RPC methods + agent_tools table)
  - MCP server lifecycle management (already built: `StartServer`, `ReloadServer`)
  - Dynamic permission reload (hot-reload when agent YAML changes) — v0.2.0
  - Permission shadowing (overload env vars/args per card) — deferred TODO #9
  - User override to force-dispatch with elevated permissions — v0.2.0
- **Sub-tasks:**
  1. `packages/broker-go/src/neuralgentics/broker/access/access.go` — verify or implement `CanAccess(roleName, serverName) bool`. If missing: add `canAccessCache map[string]map[string]bool`, populate on `StartServer`, expose via `CanAccess`. Write unit test in `access_test.go`. (~80 lines if new; 0 if already exists)
  2. `packages/backend-go/cmd/backend/main.go` — verify or add `broker.CanAccess` JSON-RPC handler: `case "broker.canAccess":` → parse `role, server` → call `access.CanAccess` → return `{allowed: true/false}`. (~15 lines add)
  3. `packages/tui/src/neuralgentics-client/types.ts` — add `CanAccessParams {role: string, server: string}`, `CanAccessResult {allowed: boolean}`, `GetAllowedServersParams {role: string}`, `GetAllowedServersResult {servers: string[]}`. (~15 lines add)
  4. `packages/tui/src/agents/permission-gate.ts` — `PermissionGate` with `canAccess`, `getAllowedServers`, `narrowOrReassign` (~100 lines)
  5. `packages/tui/src/agents/dispatcher.ts` — extend `dispatchParallel` with pre-dispatch permission check (~30 lines add)
  6. `packages/tui/src/__tests__/permission-gate.test.ts` — 10 tests (canAccess true, canAccess false, getAllowedServers list, narrowOrReassign finds alternate, narrowOrReassign finds none → error, dispatch blocked by perm denial, dispatch passes with perm gate, circuit breaker triggered on perm denial × 2, cache invalidation, edge case: role has no permissions at all)
- **Acceptance criteria:**
  - [ ] `canAccess("boomerang-coder", "neuralgentics")` → `true` (coder has `neuralgentics_*` tools)
  - [ ] `canAccess("boomerang-coder", "github-mcp")` → `false` (coder does NOT have github-mcp tools)
  - [ ] `canAccess("boomerang-git", "github-mcp")` → `true` (git agent HAS github-mcp tools)
  - [ ] Card dispatched with `role: "boomerang-coder", requiredServer: "github-mcp"` → `narrowOrReassign` finds `boomerang-git` as alternate → card reassigned
  - [ ] Card dispatched with `role: "boomerang-coder", requiredServer: "admin-panel"` → no role has access → card blocked with "No agent role has access to required server: admin-panel"
  - [ ] Permission denial triggers circuit breaker: 2 consecutive denials on same card → auto-blocked
  - [ ] Go backend `broker.CanAccess` JSON-RPC call returns in <10ms (in-memory map lookup)
  - [ ] Go modules: `go test -short ./...` in broker-go passes (no regression)
  - [ ] `bun test`: 10 new TUI tests pass; zero regressions
- **Dependencies:** P0-b (Go client — JSON-RPC call to broker.CanAccess), P0-i (dispatcher — extends dispatchParallel). Go backend broker module must have `CanAccess` implemented (verify at P1 start; implement if missing).
- **Effort:** 1.0 day (0.25 day Go if missing, 0.75 day TypeScript)
- **Parallelization:** Fully independent of P1-a through P1-g (no shared TUI files). Can run in parallel with any other P1 task. Only depends on P0-b and P0-i (both already done per Session 19).

---

## P1 Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| P1-c-ext aggregator index build is slow (7 HTTP/LFS calls + LLM indexing >30s) | Medium | Low | Build index in background on TUI startup; surface "indexing aggregators..." in status bar. First opportunity detection uses stale index if background build hasn't completed. |
| gemma4:31b unavailable for P1-c-ext lookup (cloud API down) | Low | Medium | Fallback to internal skills match + stale cached results + Tier 4 build suggestion. All P1-c patterns still fire; only the pre-check degrades. |
| P1-c 8 pattern detectors query memini-ai 8 times in parallel, causing DB contention | Low | Low | Each pattern queries token_ledger + tool_calls memories (read-only). PostgreSQL handles concurrent reads fine at this scale. Batch into 1-2 queries if contention observed. |
| P1-d circuit breaker triggers too aggressively (failure_limit=2 may be low for complex cards) | Medium | Medium | failure_limit is configurable per card (`failure_limit: 5` on complex cards). User can override. Default 2 is safe per user decision #4. Review after first 100 cards. |
| P1-g slash commands have cascading dependency: if P0-f compaction isn't ready, /compact fails | Medium | Low | P1-g command handlers check backend readiness before executing. `/compact` when compaction isn't ready → "Compaction engine not available. Run P0-f first." All commands graceful-degrade. |
| P1-h broker.CanAccess not yet implemented in Go backend (wasn't wired in Session 16-17) | Medium | High | Verify at P1 start. If missing, ~80 lines of Go + 1 JSON-RPC handler = 0.25 day. Tracked as first sub-task; boomerang-coder can implement it in <1 hour. All 4 Go modules stay green. |
| P1-a theming breaks OpenTUI layout (color changes overflow panel boundaries) | Low | Low | Themes only change color properties, not dimensions. OpenTUI uses CSS-like layout; color changes don't affect geometry. Verify with theme cycling test. |

## Aggregator MVP for v0.1.0

Per the aggregator-aware addendum §2.1, the LLM-based Option B approach makes all 7 aggregators queryable at v0.1.0 without per-aggregator API clients. The index is built weekly and matched semantically by gemma4:31b. Trust tiers differentiate:

| Aggregator | Trust Tier | v0.1.0 Support |
|-----------|-----------|----------------|
| Official MCP Registry | Tier 1 ★★★ | Index + LLM match + install command generation |
| Orchestra Research AI-Research-SKILLs | Tier 1 ★★★ | Index + LLM match + `npx @orchestra-research/ai-research-skills install` |
| Internal Skills Directory | Tier 1 ★★★ | Direct filesystem glob + auto-register (our code) |
| mcpservers.org | Tier 2 ★★☆ | Index + LLM match + install command generation |
| Anthropic Skills Hub | Tier 2 ★★☆ | Index + LLM match + copy-SKILL.md instructions |
| npm | Tier 2 ★★☆ | Index + LLM match + `bun add` install command |
| PyPI | Tier 2 ★★☆ | Index + LLM match + `uv add` install command |

**Remaining 4 secondary aggregators** (PulseMCP, Glama, Skills.sh, SkillHub, OpenAI Skills, pkg.go.dev, crates.io) deferred to v0.2.0 per the roadmap §"Aggregator MVP for v0.1.0."

---

## Document Metadata

| Field | Value |
|-------|-------|
| **Total estimated effort (P1)** | **12.75 days** |
| **P1 tasks** | 9 (P1-a through P1-h + P1-c-ext) |
| **P1 parallel tracks** | 4 (Track A: P1-a→P1-g, Track B: P1-b→P1-c→P1-c-ext, Track C: P1-d→P1-e→P1-f, Track D: P1-h) |
| **Longest critical path** | Track B: P1-b (1d) + P1-c (2.5d) + P1-c-ext (3.25d) = 6.75 days |
| **P0+P1 combined effort** | 10.5 days (P0) + 12.75 days (P1) = **23.25 days** |
| **P1 depends on P0** | P0-f (compaction), P0-g (session manager), P0-h (reseed), P0-i (parallel dispatch), P0-l (E2E demo) must all ship green |
| **P0 cards already done (Session 19)** | 8/13: P0-0, P0-a, P0-b, P0-c, P0-d, P0-e, P0-j, P0-k |
| **P0 cards remaining** | 5: P0-f (T-026), P0-g (T-027), P0-h (T-028), P0-i (T-029), P0-l (T-031) |
| **Reference** | `roadmap-v0.1.0.md` (554 lines, P0 plan) + Addendum 1 (668 lines) + Addendum 2 (631 lines) + v4-FINAL §509.2 (P1 baseline) |
| **v4-FINAL Memory ID** | `400a2db3-af29-4d76-9f09-c95c95d0ea88` |
| **Addendum 1 Memory ID** | `359f0dcd-c973-430f-971c-c3e6b7df49a6` |
| **Addendum 2 Memory ID** | `4cf6a04e-...` (aggregator-aware detector) |

---

> **Next step for orchestrator:** When the last 5 P0 cards ship green (T-026 through T-031), seed the P1 kanban cards from this document using the kanban-board-manager skill. Dispatch Track B (token account + opportunity detector + aggregator-aware) first — it's the longest critical path at 6.75 days. Tracks A, C, and D can run in parallel with Track B after their prerequisites are met. All 4 Go modules must remain green throughout P1.
