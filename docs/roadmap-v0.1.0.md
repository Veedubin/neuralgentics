# Roadmap: Neuralgentics v0.1.0 — "Roll Your Own App"

**Author:** boomerang-architect (deepseek-v4-pro:cloud)
**Date:** 2026-06-04
**Status:** v0.1.0 P0 (10.5 days) — APPROVED by user 2026-06-04
**Builds on:** v4-FINAL (776 lines) + Addendum 1 (opportunity detector) + Addendum 2 (aggregator-aware)

> v0.1.0 P0 delivers the core TUI + compaction + dispatch pipeline: a standalone OpenTUI terminal app that spawns the Go backend (42 JSON-RPC methods), the OpenCode SDK server on port 4096, the gRPC embedding sidecar, and a podman test DB — all from a single `./neuralgentics` command after a one-time `./scripts/dev-up.sh`. This is the "it compacts, it dispatches, it verifies" milestone: token-aware auto-compaction at 75% threshold, speculative parallel dispatch (8 sub-agents), diff verification with y/n accept, task-scoped model routing, and real-time spend visibility. All 4 Go modules remain green after every P0 card lands.

## User-Confirmed Decisions (P0)

These 8 decisions override the v4-FINAL §512 recommendations where noted:

1. **TUI library = OpenTUI** (`@opentui/core`, Zig core, native bindings). User explicitly rejected `blessed` (v4-FINAL §512 Q1 recommendation). P0 MUST include Zig toolchain setup + `@opentui/core` install verification as a prerequisite task (P0-0).
2. **Binary path resolution order: $PATH first → $NEURALGENTICS_BACKEND_PATH env var → relative path `../neuralgentics/packages/backend-go/neuralgentics-backend` from TUI cwd.** Matches v4-FINAL §512 Q2 recommendation.
3. **gRPC embedding sidecar: auto-start on TUI launch, kill on TUI exit.** TUI checks `ls -la /tmp/neuralgentics-embed.sock`; if missing, spawns `uv run python -m memini_embedding.cli` and tracks the child PID. Sends SIGTERM on TUI exit. Matches v4-FINAL §512 Q3 recommendation.
4. **Default `failure_limit` = 2** (Hermes default; user chose this over the v4-FINAL §512 Q4 recommendation of 3). Circuit breaker auto-blocks a card after 2 consecutive failures.
5. **Budget enforcement is REPLACED by Skill/Script Opportunity Detector** (per Addendum 1 — user rejected budgets in Session 18). Token visibility stays; enforcement is removed.
6. **Opportunity detector is aggregator-aware** (per Addendum 2 — consults 7 aggregators before suggesting "build a new skill").
7. **Token accounting is KEPT** (visibility half) but renamed: `/spend` not `/budget`, panel renamed from `budget.ts` to `spend.ts`.
8. **All other v4-FINAL §512 Q5-Q10 decisions use the recommendations:** comment visibility inline (collapse at >5), agent preferences explicit opt-in, event synthesis major-only, heartbeat surface-don't-auto-block for v0.1.0, overlay plugin retained for vanilla OpenCode users.

## Architecture Diagram (P0)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Neuralgentics v0.1.0 TUI (OpenTUI, TypeScript)            │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                       TUI Surface (OpenTUI Zig core)                     │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────────┐ │ │
│  │  │  Kanban      │  │  Chat        │  │  Chain   │  │  Status Bar    │ │ │
│  │  │  Panel       │  │  Panel       │  │  Panel   │  │  (token gauge, │ │ │
│  │  │              │  │              │  │          │  │   agent roster) │ │ │
│  │  └──────────────┘  └──────────────┘  └──────────┘  └────────────────┘ │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
│  │  │  Input Bar + /commands (compact, spend, memory, board, chain,    │  │ │
│  │  │  agents, resume, harness, review, scaffold, opportunities)       │  │ │
│  │  └──────────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                   │                                          │
│  ┌──────────────────────────────────────────────┐  ┌──────────────────────┐ │
│  │  Boomerang Engine (TypeScript)                │  │  Neuralgentics       │ │
│  │                                               │  │  JSON-RPC Client     │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────┐ │  │  (Go backend stdio)  │ │
│  │  │  Session     │ │  Compaction  │ │ Board │ │  └──────────┬───────────┘ │
│  │  │  Manager     │ │  Loop        │ │ Mgr   │ │              │             │
│  │  └──────┬───────┘ └──────┬───────┘ └──┬────┘ │              │             │
│  │         │                │            │      │              │             │
│  │         │           ┌────┴────────────┴──┐   │              │             │
│  │         │           │  Token Accountant  │   │              │             │
│  │         │           │  (counter + rprtr) │   │              │             │
│  │         │           └───────────────────┘   │              │             │
│  │         │                                   │              │             │
│  │         │    OpenCode SDK                   │              │             │
│  │         │    (@opencode-ai/sdk)             │              │             │
│  │         └───────────────┬───────────────────┘              │             │
│  └─────────────────────────┼──────────────────────────────────┼─────────────┘
│                            │                                  │
└────────────────────────────┼──────────────────────────────────┼─────────────┘
                             │ HTTP (localhost:4096)             │ JSON-RPC stdio
                             ▼                                  ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────────┐
│  OpenCode Server (child process) │  │  Go Backend Binary (child process)   │
│  (@opencode-ai/sdk               │  │  (neuralgentics-backend, 26MB)       │
│   createOpencode port 4096)      │  │  42 JSON-RPC methods + ready notif   │
│  LLM engine, tools, file system  │  │  memory.* orchestrator.* broker.*    │
│                                  │  │  agent.* peer.* user.* audit.*       │
└──────────────────────────────────┘  └──────────────┬───────────────────────┘
                                                     │
                  ┌──────────────────────────────────┼─────────────┐
                  ▼                                  ▼             │
          ┌──────────────┐  ┌──────────────────────┐ ┌─────────────┐│
          │ PostgreSQL   │  │ gRPC Sidecar (Python)│ │ Broker (MCP ││
          │ port 6000    │  │ /tmp/neuralgentics-  │ │ management) ││
          │ (podman)     │  │ embed.sock           │ │             ││
          └──────────────┘  └──────────────────────┘ └─────────────┘│
                                                                     │
          ┌──────────────────────────────────────────────────────────┘
          │  Binary resolution: $PATH → $NEURALGENTICS_BACKEND_PATH
          │  → ../neuralgentics/packages/backend-go/neuralgentics-backend
          ▼
    Go backend stdin/stdout JSON-RPC (stdio, not HTTP)
```

## P0 Task Breakdown

### Task P0-0: Zig Toolchain + OpenTUI Setup (PREREQUISITE)
- **Goal:** Install Zig toolchain and verify `@opentui/core` compiles a hello-world TUI.
- **Scope IN:**
  - Install Zig (latest stable) via system package manager or `zigup`
  - Install Bun (if not present)
  - Create `packages/tui/` skeleton: `package.json`, `tsconfig.json`, `bunfig.toml`
  - `bun add @opentui/core` (verify native Zig bindings compile)
  - Render a single "Neuralgentics v0.1.0" label in an OpenTUI window
  - Document Zig version requirement in README prerequisites
- **Scope OUT:**
  - Any TUI panels, input bars, or slash commands (→ P0-a)
  - Go backend interaction (→ P0-b)
  - OpenCode SDK interaction (→ P0-c)
  - Podman/DB setup (→ P0-d)
- **Acceptance:**
  - `bun run start` renders a terminal window with "Neuralgentics v0.1.0" text
  - `zig version` prints a valid version
  - `bun run build` compiles without errors
  - No blessed/blessed-contrib dependencies in package.json
- **Assignee profile:** boomerang-coder
- **Dependencies:** None
- **Effort:** 0.5 day
- **Roadmap handoff:** None (first task)

### Task P0-a: TUI App Scaffold + Panel Layout
- **Goal:** Full OpenTUI app with 4 panels (kanban, chat, chain, status bar) and input bar.
- **Scope IN:**
  - Entry point `packages/tui/src/index.ts`
  - Panel layout: left (kanban 30%), center (chat 50%), right (chain 20%), bottom (status bar 1 row), command bar (1 row)
  - Status bar shows: session ID, token gauge (live), agent roster status, compaction cycle count
  - Input bar with `/`-prefix command routing (stub handlers for P1-g slash commands)
  - Streaming-first chat panel: renders tokens as they arrive, target <500ms TTFR
  - Kanban panel: renders TASKS.md board state, updates in-place (only changed row)
  - Chain panel: progressive thought display
  - OpenTUI theme (dark, consistent with terminal)
- **Scope OUT:**
  - Backend connectivity (→ P0-b, P0-c)
  - Actual LLM responses via OpenCode SDK (→ P0-c)
  - Real kanban data from Go backend (→ P0-b)
  - Compaction interaction (→ P0-f)
  - Diff verification panel (→ P0-j)
  - `/spend` or `/opportunities` commands (P1-b, P1-c)
- **Acceptance:**
  - `bun run start` renders 4-panel layout with placeholder content
  - Input bar accepts text and routes `/`-prefixed commands to stubs
  - Status bar updates token count (hardcoded for now)
  - Panels resize correctly on terminal resize
  - Zero blessed dependencies — OpenTUI only
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-0 (Zig/OpenTUI working)
- **Effort:** 1.5 days
- **Roadmap handoff:** None

### Task P0-b: Neuralgentics JSON-RPC Client
- **Goal:** Typed JSON-RPC wrapper for all 42 Go backend methods, with binary spawning, ready signal handling, and 10s timeout.
- **Scope IN:**
  - `packages/tui/src/neuralgentics-client/` directory
  - Binary path resolver: `$PATH` → `$NEURALGENTICS_BACKEND_PATH` → relative `../neuralgentics/packages/backend-go/neuralgentics-backend`
  - Spawn `neuralgentics-backend` child process with stdio pipes
  - JSON-RPC 2.0 request/response line protocol (modeled on `go-backend-client.ts` 245 lines)
  - `waitForReady(timeoutMs = 10_000)` — consumes `{"method":"ready"}` notification
  - Typed `call<T>(method, params, timeoutMs?)` for all 42 methods
  - Error handling: backend crash → reject in-flight calls → surface "backend not ready" state
  - Stderr inheritance for backend logs
  - TypeScript types for all 42 method param/result shapes (generated or hand-written from `main.go` switch cases)
- **Scope OUT:**
  - MCP tool registration (this client is NOT an MCP server; it's a direct JSON-RPC consumer)
  - OpenCode SDK integration (→ P0-c)
  - Token accounting or spend tracking (→ P1-b)
  - Kanban data caching (→ P0-g session manager handles this)
- **Acceptance:**
  - `client.call("ping", {})` returns `{ pong: true }` in <10ms
  - `client.call("memory.add", { content: "test" })` returns a memory ID
  - `client.call("memory.query", { query: "test" })` returns matching memories
  - Backend not found on $PATH + env var + relative → clear error "Cannot find neuralgentics-backend. Install it or set NEURALGENTICS_BACKEND_PATH."
  - Backend crashed after start → all in-flight calls reject → client emits "backend not ready" event
  - Binary path resolver returns correct path in all 3 resolution cases
- **Assignee profile:** boomerang-coder
- **Dependencies:** None (go backend binary must exist but client doesn't depend on other P0 tasks)
- **Effort:** 1.0 day
- **Roadmap handoff:** None

### Task P0-c: OpenCode SDK Client
- **Goal:** Spawn OpenCode server on port 4096, wire `@opencode-ai/sdk` for LLM/agent operations.
- **Scope IN:**
  - `packages/tui/src/opencode-client/` directory
  - Spawn OpenCode server as child process on `localhost:4096`
  - Wire `@opencode-ai/sdk` `createOpencode({ hostname: "localhost", port: 4096 })`
  - Session lifecycle: `session.create()`, `session.prompt()`, `session.messages()`, `session.abort()`
  - `session.revert()` for compaction clean-slate
  - `session.summarize()` for reseed compact summaries
  - `session.init()` for fresh sessions
  - Streaming response handling: first token <500ms, progressive render
  - Clean shutdown: kill child process on TUI exit
- **Scope OUT:**
  - System prompt content (→ P0-h reseeder owns this)
  - Compaction logic (→ P0-f)
  - Model selection logic (→ P0-k)
  - Session continuity / resume (→ P2-b)
  - Agent dispatch (→ P0-i)
- **Acceptance:**
  - `session.create()` returns a valid session ID
  - `session.prompt("Hello")` returns a streaming response visible in chat panel
  - `session.revert()` clears the session to clean state
  - OpenCode server port conflict → TUI surfaces "Port 4096 in use. Is another OpenCode server running?"
  - OpenCode server fails to start → TUI enters degraded mode (memory operations still work, agent loop offline warning)
  - Child process killed on TUI SIGTERM/SIGINT — no zombie processes
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-a (TUI surface exists for chat panel rendering)
- **Effort:** 1.0 day
- **Roadmap handoff:** None

### Task P0-d: Podman Setup Script + Sidecar Management
- **Goal:** Create `./scripts/dev-up.sh` and TUI sidecar lifecycle management.
- **Scope IN:**
  - `scripts/dev-up.sh`:
    - Check if `neuralgentics-test-pg` podman container exists; if not, create it on port 6000 with SSL
    - `podman start neuralgentics-test-pg` if stopped
    - Run Go backend migrations (`go run cmd/migrate/main.go`)
    - Check if gRPC sidecar socket exists at `/tmp/neuralgentics-embed.sock`
    - If missing, spawn `uv run python -m memini_embedding.cli` as background process
    - Verify `neuralgentics-backend` binary exists (from `go build`)
    - Idempotent: safe to run multiple times
  - TUI startup sequence in `index.ts`:
    - Check `ls -la /tmp/neuralgentics-embed.sock`
    - If missing, log "gRPC sidecar not running. Run ./scripts/dev-up.sh first."
    - If present, verify socket responds (health ping)
    - Track sidecar child PID (if TUI spawned it)
    - Send SIGTERM on TUI exit (only if TUI spawned it)
  - Podman-only (no docker commands)
- **Scope OUT:**
  - Auto-starting the sidecar from within `./neuralgentics` (per A3: dev-up.sh is separate)
  - Database port 5434 (user's prod) — NEVER touch
  - Database port 5436 — NEVER touch
  - Any docker or Docker Compose references
  - Backend binary building (user runs `go build` separately or via CI)
- **Acceptance:**
  - `./scripts/dev-up.sh` on clean system: creates container, runs migrations, starts sidecar
  - `./scripts/dev-up.sh` second run: "Already running" — no errors
  - TUI surfaces clear error if test DB is down: "Port 6000: no response. Run ./scripts/dev-up.sh. [Retry]"
  - TUI shows "starting sidecar..." spinner if socket not yet bound (retry × 30 with 100ms backoff)
  - TUI kills sidecar on exit (only if TUI spawned it)
  - Zero docker commands anywhere
  - Zero port 5434/5436 references anywhere
- **Assignee profile:** boomerang-coder
- **Dependencies:** None (setup script runs before anything else; P0-b Go client needs the backend binary which dev-up verifies)
- **Effort:** 0.5 day
- **Roadmap handoff:** None

### Task P0-e: Binary Path Resolution
- **Goal:** Resolve the Go backend binary path with the 3-tier fallback: $PATH → env var → relative.
- **Scope IN:**
  - `packages/tui/src/neuralgentics-client/resolver.ts`
  - Resolver function: `resolveBackendPath(): string`
    1. Check `$PATH` for `neuralgentics-backend` (using `which` or equivalent)
    2. Check `$NEURALGENTICS_BACKEND_PATH` env var
    3. Check relative path `../neuralgentics/packages/backend-go/neuralgentics-backend` from TUI cwd
  - Return absolute path or throw descriptive error
  - Error message must include all 3 locations checked
  - Integrated into P0-b client constructor
- **Scope OUT:**
  - Binary building or Go compilation
  - Binary download/update logic
  - Version checking or compatibility validation
- **Acceptance:**
  - Binary on $PATH → resolves to system path
  - Binary NOT on $PATH but env var set → resolves to env var path
  - Binary NOT on $PATH, no env var, but found at relative path → resolves to relative
  - All 3 checks fail → throws `Error("Cannot find neuralgentics-backend. Checked: $PATH (neuralgentics-backend), $NEURALGENTICS_BACKEND_PATH (unset), ../neuralgentics/packages/backend-go/neuralgentics-backend (not found)")`
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-b (client accepts the resolver result)
- **Effort:** 0.25 day
- **Roadmap handoff:** None

### Task P0-f: Compaction Loop
- **Goal:** Token-aware 75% auto-compaction: monitor → filter → extract (gemma4:31b) → write to neuralgentics → revert → reseed.
- **Scope IN:**
  - `packages/tui/src/compaction/` directory (orchestrator, filter, extractor, schema, thresholds)
  - Token monitor: hooks into session manager, checks context usage every LLM turn
  - 75% threshold: triggers compaction queue (non-blocking — user sees "compacting..." spinner)
  - Filter: drops tool noise, keeps decisions, code changes, entity references
  - Extractor: `gemma4:31b` with structured JSON schema, confidence scoring per extract
  - Writer: `neuralgentics-client.call("memory.add", memory)` × N (decisions, questions, files, entities, actions)
  - Reverter: `session.revert()` — clean state
  - Reseeder: triggers system-prompt re-injection (delegates to P0-h)
  - Target savings ratio: ≥10:1 (spend ~8K on extraction, save 80K+ context)
  - `/compact` manual trigger — non-blocking, runs in background
- **Scope OUT:**
  - System prompt content for reseed (→ P0-h owns the 7-part reseed logic)
  - Token counting (→ P1-b counter — P0-f reads the count from session manager)
  - Diff snapshots before compaction (→ P2 hardening)
  - Goal-mode compaction (v0.2.0)
- **Acceptance:**
  - Session reaches 75% token threshold → compaction triggers automatically
  - Post-compaction: session has clean state + reseed prompt ≤2K tokens
  - Extracted memories are queryable via `memory.query` with correct trust scores
  - `gemma4:31b` unavailable at TUI startup → auto-compaction disabled with warning in status bar
  - Compaction in progress + user issues `/compact` → rejected with "Compaction already in progress"
  - User mid-prompt when threshold hit → compaction queued, notification "Compaction completed" after prompt finishes
  - Savings ratio ≥10:1 verified in at least one test run
- **Assignee profile:** boomerang-coder (implementor) + boomerang-architect (extraction schema design)
- **Dependencies:** P0-b (neuralgentics client for writing memories), P0-c (session revert), P0-h (reseed logic)
- **Effort:** 2.0 days
- **Roadmap handoff:** None

### Task P0-g: Session Manager
- **Goal:** Session lifecycle (create, prompt, messages, revert) with stateless agent protocol (seed prompt + memory_id).
- **Scope IN:**
  - `packages/tui/src/session/` directory (manager, reseeder, continuity)
  - `createSession()`: spawns OpenCode session, returns session_id
  - `prompt(message)`: sends user prompt, handles streaming response
  - `messages()`: retrieves message history
  - `revert()`: clears session to clean state (used by compaction loop)
  - Stateless agent protocol:
    - Store context as `type: "context_package"` memory in neuralgentics
    - Seed prompt template: `Task: {description}\nMemory ID: {memory_id}\nAction: Fetch context from neuralgentics and execute.`
    - ~200 token seed prompts (not 2000+ ContextPackages)
    - Agent returns `{memory_id, description}` on completion
    - Trust signal: `agent_used` on context memory on completion
- **Scope OUT:**
  - Multi-session continuity (→ P2-b)
  - Session resume across TUI restarts (→ P2-b)
  - HANDOFF.md auto-generation (→ P2-e)
- **Acceptance:**
  - `createSession()` returns valid session ID
  - `prompt("Implement hello world")` streams response to chat panel
  - `revert()` clears the session, `messages()` returns empty after
  - Seed prompt template generates <250 tokens (measured)
  - Context package stored as `type: "context_package"` memory, retrievable by memory_id
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-b (Go client for memory operations), P0-c (OpenCode SDK for session ops)
- **Effort:** 1.0 day
- **Roadmap handoff:** None

### Task P0-h: System-Prompt Reseed
- **Goal:** 7-part progressive reseed (≤2K tokens), section-scoped AGENTS.md, injected post-compaction.
- **Scope IN:**
  - `packages/tui/src/session/reseeder.ts`
  - 7 parts, ordered by priority:
    1. **AGENTS.md (section-scoped)** — ≤500 tokens. Only the section relevant to current agent role
    2. **Compaction summary** — ≤500 tokens from most recent compaction cycle
    3. **Current card context** — ≤300 tokens from kanban board
    4. **Active skills** — ≤500 tokens (top 3 skills loaded on demand)
    5. **Board state snapshot** — ≤200 tokens (current phase only)
    6. **Recent memories** — ≤500 tokens (last 10 from neuralgentics)
    7. **Tool set** — ≤200 tokens from `agent.getInitialToolSet`
  - Progressive loading: parts 1-3 load immediately (<200ms), 4-7 async in background
  - AGENTS.md section scoping: if full AGENTS.md >3K tokens, auto-summarize
  - Confidence-flagged memories: "⚠️ LOW confidence" prefix in reseed prompt
- **Scope OUT:**
  - Cross-project memories (→ v0.2.0)
  - User preference injection (→ P2-a agent preferences)
- **Acceptance:**
  - Post-compaction reseed produces a system prompt ≤2K tokens
  - Parts 1-3 visible to agent in <200ms
  - AGENTS.md section for `boomerang-coder` only loads the coder section + Protocol section
  - LOW confidence memories flagged with ⚠️ prefix
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-b (neuralgentics client), P0-f (compaction loop triggers reseed)
- **Effort:** 0.5 day
- **Roadmap handoff:** None

### Task P0-i: Speculative Parallel Dispatch
- **Goal:** Fire up to 8 sub-agents simultaneously, merge results, no serial bottleneck.
- **Scope IN:**
  - `packages/tui/src/agents/dispatcher.ts`
  - `dispatchParallel(cards)`: accepts N cards with independent scope, fires N sub-agents simultaneously
  - Max 8 simultaneous dispatches (configurable)
  - Merge results: wait for all agents to return, collect `{memory_id, description}` handles
  - Dependency check: before dispatching, verify cards have no shared files or design dependencies
  - Streaming results: each agent's progress visible in kanban panel (status updates in-place)
  - Failure handling: one agent fails → others continue → failed card moves to blocked
- **Scope OUT:**
  - Agent preferences loading (→ P2-a)
  - Cross-card dependency detection (→ P2-d event synthesis)
  - Goal-mode cards (→ v0.2.0)
- **Acceptance:**
  - 3 independent cards dispatched → all 3 agents start simultaneously (<100ms gap)
  - All 3 complete → results merged and available in session
  - 1 card fails, 2 succeed → failed card is `blocked`, successful cards are `done`
  - 9 cards dispatched → only 8 start, 9th is queued
  - Two cards share a dependency → orchestrator refuses parallel dispatch, enforces serial
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-g (session manager for seed prompts), P0-b (Go client for kanban updates)
- **Effort:** 1.0 day
- **Roadmap handoff:** None

### Task P0-j: Diff Verification Panel
- **Goal:** Show proposed diff side-by-side, y/n accept, tester re-runs on accept, block on fail.
- **Scope IN:**
  - `packages/tui/src/panels/diff.ts`
  - Diff panel: side-by-side view of proposed changes (OpenTUI rendering)
  - y/n keybinding: `y` → accept and apply, `n` → reject and block card
  - On accept (`y`): dispatches tester sub-agent to re-run acceptance criteria
  - On fail: card moves `running → blocked` with test failure evidence
  - On pass: card moves `running → done`
  - Confidence scoring: low confidence → card is `blocked`, not `done`
  - Wrap-up verification evidence: diff + test results + confidence score
- **Scope OUT:**
  - Auto-commit on test pass (→ P4 CI/CD)
  - Three-way merge conflict resolution (→ v0.2.0)
  - Inline edit of the diff (read-only panel for v0.1.0)
- **Acceptance:**
  - Coder proposes change → diff panel renders side-by-side
  - User hits `y` → tester runs → tests pass → card moves to `done`
  - User hits `y` → tester runs → tests fail → card moves to `blocked` with failure evidence
  - User hits `n` → card moves to `blocked` with "rejected by user" reason
  - Confidence score `low` → card is `blocked` regardless of test result
- **Assignee profile:** boomerang-coder
- **Dependencies:** P0-a (TUI panels exist), P0-g (session manager for tester dispatch)
- **Effort:** 1.0 day
- **Roadmap handoff:** None

### Task P0-k: Task-Scoped Model Selection
- **Goal:** Route tasks to big/small/fast models based on task type, with a configurable registry.
- **Scope IN:**
  - `packages/tui/src/agents/model-registry.ts`
  - Model categories:
    - `big_model` — architectural decisions, design docs (deepseek-v4-pro:cloud)
    - `small_model` — code search, file reads, simple edits (devstral-small-2:24b)
    - `fast_model` — quick completions, status checks (qwen3-coder-next:cloud)
  - Default routing rules:
    - Architect tasks → `big_model`
    - Coder tasks → `big_model` (primary) + `small_model` (tool calls)
    - Explorer tasks → `small_model`
    - Tester tasks → `fast_model`
    - Linter tasks → `fast_model`
    - Git/Writer/Release → `small_model`
  - Configurable via `config/default.json`
  - Model names pulled from `.opencode/opencode.json` provider models list
- **Scope OUT:**
  - Dynamic model switching mid-task (→ v0.2.0)
  - Cost-aware model routing (→ P1-b token accountant)
  - User override per-dispatch (→ P2 hardening)
- **Acceptance:**
  - "Implement user auth" (coder task) → routes to `deepseek-v4-pro:cloud`
  - "Find all files matching *.go" (explorer task) → routes to `devstral-small-2:24b`
  - Model not in config → falls back to `big_model` with warning
  - Config file `default.json` overrides default routing
  - Token savings: ≥3× fewer tokens on non-reasoning tasks vs always using big model
- **Assignee profile:** boomerang-coder
- **Dependencies:** None (model registry is independent; P0-i uses it for dispatch)
- **Effort:** 0.5 day
- **Roadmap handoff:** None

### Task P0-l: End-to-End Integration Demo
- **Goal:** Full pipeline walk-through: start TUI → run a sample card → compaction → reseed → dispatch → verify.
- **Scope IN:**
  - Smoke test script or manual run-through
  - Verify full pipeline:
    1. `./scripts/dev-up.sh` → DB running, sidecar socket exists, backend binary found
    2. `./neuralgentics` → TUI renders 4 panels
    3. Create a card: "Implement a hello world function with test"
    4. Dispatch to boomerang-coder (via OpenCode SDK)
    5. Coder produces diff → diff panel shows changes
    6. User accepts → tester re-runs → passes → card moves to done
    7. After 5+ turns, session reaches 75% threshold → compaction triggers
    8. Post-compaction: session reseeded with compact summary ≤2K tokens
    9. Session continues → agent remembers previous decisions via neuralgentics memory
    10. `client.call("memory.query", {query: "hello world"})` returns the implementation memory
  - Verify all 4 Go modules remain green: `go test -short ./...` in each
  - Verify no boomerang-v3 files touched
  - Verify no budget enforcement code anywhere (C6)
  - Verify all tool names use `neuralgentics_*` prefix (C3)
- **Scope OUT:**
  - Performance benchmarking (→ P4)
  - Load testing with 100+ cards (→ v0.2.0)
  - Cross-platform testing (macOS → stretch goal)
- **Acceptance:**
  - Full pipeline completes end-to-end without manual intervention beyond `y`/`n` keypresses
  - All 4 Go modules: `go test -short ./...` PASS (zero failures)
  - Backend crash + TUI shows "backend not ready" with retry option
  - Sidecar crash + TUI auto-restarts it on next detection
  - Compaction savings ≥10:1 verified in at least one cycle
- **Assignee profile:** boomerang-tester (runs the demo script, verifies) + boomerang-coder (fixes any integration bugs found)
- **Dependencies:** P0-a through P0-k (all prior tasks must be complete)
- **Effort:** 0.5 day
- **Roadmap handoff:** None (last P0 task)

## P0 Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OpenTUI Zig toolchain not installable on user's system (zig version conflict, musl/glibc issue, or missing build deps) | Medium | High | Design TUI against a thin `IRenderer` interface with two implementations: `OpenTUIRenderer` and `BlessedRenderer`. The swap is one import change. P0-a builds both; P0-0 verifies Zig works; if not, fallback to BlessedRenderer with zero code changes beyond the import. Documented in `packages/tui/src/renderer/interface.ts`. |
| gRPC sidecar spawn race: TUI checks socket before sidecar binds | Medium | Medium | Retry-with-backoff: `stat /tmp/neuralgentics-embed.sock` every 100ms × 30 attempts (3s total) before declaring sidecar dead. P0-d implements this. Sidecar emits a "ready" line on stdout; TUI reads that instead of polling socket. |
| `@opencode-ai/sdk` version drift (sst/* projects move fast, APIs break) | High | Low | Pin exact version in `package.json`. Document upgrade path in `docs/UPGRADE.md`. P0-c includes version compatibility check at startup. If SDK breaks, the TUI's OpenCode client wrapper insulates the rest of the app — only `opencode-client/` needs changes. |
| Compaction `gemma4:31b` unavailable in user's Ollama Cloud config (API key expired, model removed, rate limited) | Low | High | Verify model at TUI startup via `ollama.com/v1/models` API. If unavailable: disable auto-compaction, surface warning in status bar "gemma4:31b unavailable — auto-compaction disabled. Run /compact with a custom model to override.", keep manual `/compact` functional. |

## P0 Architectural Decisions (Documented)

**A1 — SDK vs Direct JSON-RPC:** The TUI reuses `@neuralgentics/sdk` for its routing/memory/hook abstractions but makes *direct* JSON-RPC calls to the Go backend (not MCP tool invocations). The v0.1.0 TUI is NOT an MCP client — it IS the consumer of the Go backend's stdio JSON-RPC. The `@neuralgentics/sdk` provides typed adapters and the memory adapter but the 42-method thin wrapper in P0-b (`neuralgentics-client/`) calls the backend directly. This is simpler than extending the SDK to wrap all 42 methods (the SDK currently wraps 6), and it reuses the battle-tested `GoBackendClient` pattern from the overlay plugin.

**A2 — Embed OpenCode SDK Client vs Shell Out:** The TUI embeds the `@opencode-ai/sdk` client and spawns the OpenCode server as a child process (port 4096, localhost). This matches the v4-FINAL §504.2 architecture diagram exactly. The TUI manages the server lifecycle (start on launch, SIGTERM on exit) and connects via `createOpencode()`. This is cleaner than the `opencode-base/` patching approach (which was a dead-end per v4-FINAL §504.1). The TUI never reaches into `opencode-base/` source — all interaction is through the SDK's public API.

**A3 — install.sh vs dev-up.sh:** We use a **separate** `./scripts/dev-up.sh` for the gRPC sidecar + podman DB setup. The `./neuralgentics` command only checks that the backend binary exists and the sidecar socket is present — it does NOT auto-start either. This simplifies the TUI startup logic and avoids privilege/state questions (should the TUI be starting podman containers? what if the user has custom sidecar config?). The user runs `./scripts/dev-up.sh` once per machine; the TUI surfaces clear "X not running — run ./scripts/dev-up.sh" errors with a [Retry] button.

**A4 — gemma4:31b Model Availability:** Confirmed: `gemma4:31b` is in the Ollama Cloud provider model registry (`.opencode/opencode.json` line 20, `boomerang-writer.md` model field). It exists and is callable via `https://ollama.com/v1/chat/completions`. The TUI verifies model availability at startup by doing a lightweight model list call. If unavailable, auto-compaction is disabled with a clear status bar warning, but manual `/compact` still works (user can point it at a different model).

## P0 Acceptance Criteria (Whole-Phase)

- [ ] `git clone` + `./scripts/dev-up.sh` + `./neuralgentics` launches a working TUI
- [ ] All 4 Go modules remain green (`go test -short ./...` in each)
- [ ] TUI can add/query/delete memories via the Go backend (round-trip <50ms)
- [ ] TUI can create a session, send a prompt, get a streaming response
- [ ] TUI can trigger compaction manually (`/compact`) and automatically at 75% threshold
- [ ] TUI can dispatch a card to boomerang-coder and see it progress through the kanban
- [ ] TUI survives backend crash and shows "backend not ready" state with [Retry]
- [ ] TUI survives gRPC sidecar crash and auto-restarts it (retry-with-backoff 100ms × 30)
- [ ] Compaction achieves ≥10:1 savings ratio in at least one cycle
- [ ] All P0 tasks wrap-up with `changed_files`, `verification`, `residual_risk` evidence
- [ ] Zero boomerang-v3 files touched (C7)
- [ ] Zero budget enforcement code anywhere (C6/C9)
- [ ] All tool names use `neuralgentics_*` prefix (C3)
- [ ] Zero port 5434 or 5436 references (C2)
- [ ] Zero docker commands (C1)
- [ ] TUI code is in `neuralgentics/packages/tui/` — NOT in `boomerang-v3/`

## What's NOT in P0 (Deferred to P1+)

### P1 — "It Has a TUI + Smart Features" (~12.75 days including addenda)
- **P1-a:** TUI surface polish (2 days) — remaining panels, themes, accessibility
- **P1-b:** Token accountant — counter + reporter + `/spend` command (1 day)
- **P1-c:** Opportunity detector — patterns + ranker + prompter (2.5 days, Addendum 1)
- **P1-c-ext:** Aggregator-aware lookup — 7-aggregator search + install + trust + caching (3.25 days, Addendum 2)
- **P1-d:** Kanban board with circuit breaker (1 day, `failure_limit` = 2 per decision #4)
- **P1-e:** Comments on cards — inter-agent protocol (0.5 day)
- **P1-f:** Attempts history — `## Previous Attempts` block (0.5 day)
- **P1-g:** Slash commands — 10 functional commands (1 day)
- **P1-h:** Broker permission-gated dispatch — `CanAccess(role, server)` (1 day)

**Aggregator MVP for v0.1.0 (3 of 7):** Official MCP Registry, Orchestra Research AI-Research-SKILLs, Internal Skills Directory. Remaining 4 (mcpservers.org, Anthropic Skills Hub, npm, PyPI) deferred to v0.2.0.

### P2 — "Slash Commands + Cross-Session" (~4 days)
- Agent preferences (persistent identity), multi-session continuity, heartbeat + stale detection, event synthesis, HANDOFF.md auto-generation

### P3 — "Hardening" (~3 days)
- Error recovery, respawn guard, skill pinning, scheduled tasks, cross-project memory sharing

### P4 — "Polish + Release" (~3.5 days)
- Documentation, single-binary bundling, CI/CD pipeline, smoke/E2E tests

### v0.2.0 Backlog
- Cross-project memory sharing (global scope)
- Goal-mode cards (Judge agent + sub-cycle)
- Sandboxed workspace isolation (per-task podman)
- Cross-card pattern detection
- Priority time-decay
- Remaining 4 aggregators (mcpservers.org, Anthropic Skills Hub, npm, PyPI)
- macOS support (stretch goal from P0)

### NEVER in Scope
- Hosted SaaS, Web UI, VSCode extension, Mobile app, Real-time collaboration, Multi-host coordination, New model training, Marketplace

## Document Metadata

| Field | Value |
|-------|-------|
| **Total estimated effort (P0)** | **10.5 days** |
| **v4-FINAL baseline** | 7.5 days (8 tasks: P0-a through P0-h) |
| **New P0 scope** | +3.0 days: P0-0 (Zig/OpenTUI, 0.5d), P0-c (OpenCode SDK, 1.0d), P0-e (bin path, 0.25d), P0-l (E2E demo, 0.5d), OpenTUI complexity bump on P0-a (+0.5d vs blessed), P0-f expanded (+0.25d vs original) |
| **P0 tasks** | 13 (P0-0 through P0-l) |
| **P0 dependency chain** | P0-0 → P0-a → P0-b + P0-c + P0-d (parallel) → P0-e → P0-f → P0-g → P0-h → P0-i → P0-j → P0-k → P0-l |
| **Reference** | v4-FINAL §509.1 (P0 plan baseline) + v4 §512 (open questions) + Addendum 1 + Addendum 2 |
| **Chain ID** | `13df554f-0dff-47d7-be5c-1811a4803136` |
| **Task ID** | `T-RFC-005` |
| **v4-FINAL Memory ID** | `400a2db3-af29-4d76-9f09-c95c95d0ea88` |
| **Addendum 1 Memory ID** | `359f0dcd-c973-430f-971c-c3e6b7df49a6` |
