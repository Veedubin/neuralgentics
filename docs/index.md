# Multi-Agent Orchestration, Permissions-based MCP Server Broker, Context Continuity Across Sessions

<p align="center">
  <img src="assets/neuralgentics-logo.png" alt="Neuralgentics logo" width="600">
</p>

> An open-source agent runtime, built for engineers who ship.

Neuralgentics is the **harness** for AI agents - the execution environment, permission broker, and persistent memory that turns a language model into a reliable, debuggable, and trustworthy agent.

**What is a harness?**
A harness provides the structural scaffolding that a raw model lacks. It wraps the LLM with specific prompts, tools, context, and strict permissions, ensuring the agent operates within defined boundaries and maintains continuity across sessions.

**23 specialist agents, a trust-scored memory engine, and a permissions-based tool broker -- all in a 26 MB Go binary.** No cloud account, no telemetry, no vendor lock-in. You run it on your machine; it remembers what your agents did; it stops them from doing things they shouldn't.

**Install in seconds:**
```bash
uv pip install neuralgentics && neuralgentics init && opencode
```

v0.3.0 adds the IMPROVE phase runner, 7 new slash commands for tiered memory + peer context, and `elevate_memory_to_1024` for dual-model promotion. v0.3.1 adds mid-session edit detection and precompression guidance to the IMPROVE phase. v0.4.0 adds multi-transport MCP support (npx/uvx/local/docker), a curated catalog of 20 popular MCP servers, runtime LLM provider switching between Ollama Cloud / Docker Model Runner / OpenRouter, and Docker Compose v2.38+ model integration. v0.6.7 makes the curl|bash one-liner work end-to-end and adds docker support (was podman-only). v0.6.3 fixes 3 critical install-script bugs (broken symlink, curl|bash stdin trap, container credential recovery) and adds multi-project registration. v0.6.0 fixes 5 critical install-script bugs and adds graceful sidecar fallback. v0.5.0 adds HTTP/SSE transport for hosted MCPs, OCI-shareable profile export/import (tar.gz + HMAC-SHA256), provider-aware small_model, and CI short-test fix. v0.4.0 adds multi-transport MCP support (npx/uvx/local/docker), a curated catalog of 20 popular MCP servers, runtime LLM provider switching between Ollama Cloud / Docker Model Runner / OpenRouter, and Docker Compose v2.38+ model integration.


[**Get Started →**](getting-started/installation.md)

---

## The Problem

Generic LLM coding agents have no persistent memory, no concept of role-based authority, and a single bloated context window. They forget Monday on Friday. Every agent sees every tool -- no roles, no scoped permissions, no audit trail. Prompts fight for the same slot, so you re-explain the project every session, or ship bugs the agent invented because it had no record of what failed.

## What Neuralgentics Is

Neuralgentics replaces one "do-it-all" bot with structured, role-based orchestration. Twenty-three specialist agents -- architect, coder, tester, git, and more -- each receive only the tools their role authorizes and only the context their task requires.

Every decision lands in PostgreSQL + pgvector with **trust scoring**. Successful patterns get promoted; failed approaches decay and fade. The MCP broker gates every tool call against the agent's role, cutting token overhead by up to 95%. Context survives sessions through L0/L1/L2 tiered loading -- a new agent picks up where the last one left off.

Agent prompts are ~200 tokens each. State lives in memory, not in the prompt. Ships as a Go binary (26 MB) + podman PostgreSQL + Python gRPC sidecar + 4 container images. Open-source under the [MIT License](https://github.com/Veedubin/neuralgentics/blob/main/LICENSE).

## How It Works

```text
    USER PROMPT
         │
         ▼
  ╔══════════════════╗
  ║   THOUGHT CHAIN  ║ ◄── Logged to memoryManager
  ╚══════════════════╝
         │
         ▼
  ╔══════════════════╗
  ║ TASK DECOMPOSE   ║ ◄── Create Kanban cards
  ╚══════════════════╝
         │
         ▼
  ╔══════════════════╗
  ║ ROUTE MATRIX     ║ ◄── Select specialist agent
  ╚══════════════════╝
         │
         ▼
  ╔══════════════════╗
  ║ CONTEXT PACKAGE  ║ ◄── Fetch L0/L1 memory
  ╚══════════════════╝
         │
         ▼
  ╔══════════════════╗
  ║    TASK() CALL   ║ ◄── Dispatch to agent
  ╚══════════════════╝
         │
         ▼
    [ SPECIALIST AGENT ]
```

A task enters the orchestrator, gets routed to a specialist, who calls the broker for tools, who checks RBAC, who executes -- and every decision lands in the trust-scored memory store. Full details at [Dispatch Flow](architecture/dispatch-flow.md).

## Features in Depth

The rest of this page walks through each major subsystem, with a small mockup showing what the feature looks like in practice. MOCKUPs are Unicode terminal drawings -- they show the real shape of the UI, not real screenshots.

### Memory Engine -- Trust-Scored, Self-Decaying

- **Harness-grade reliability** - every tool call goes through the broker; every memory write is trust-scored; every permission is enforced at the code layer, not in the prompt.
- **Memory Engine** - Every decision an agent makes lands in PostgreSQL + pgvector with a **trust score** (default 0.5). Successful patterns get promoted; failed approaches decay and fade. The system is honest about what worked.


The memory store is `pgvector`-backed, so semantic search works the way you'd expect: "show me every dispatch that hit a build failure" returns similar past dispatches, ranked by trust. Trust is a first-class column, not a side table.

```text
    MEMORY INSPECTOR  ·  query: "broker rbac dispatch"  ·  results: 4
    ─────────────────────────────────────────────────────────────────
    ID        TRUST   DECAY/DAY   USED   AGE     CONTENT
    a1b2c3..  0.91    0.01        17     12d     "Architect designs before
                                                  coder builds (Rule 1)"
    e5f6g7..  0.85    0.02        9      3d      "RBAC matrix: 23 roles x
                                                  7 restricted servers"
    i9j0k1..  0.62    0.08        2      1d      "MCP broker proxy is shared
                                                  across servers, do NOT
                                                  Stop() on deregister"
    m3n4o5..  0.42    0.05        1      2h      "Tested with fixture db,
                                                  weak signal, decay fast"
    ─────────────────────────────────────────────────────────────────
    Trust:  ● active (>0.5)   ○ fading (<0.5)   ∅ archived (<0.2)
```

See [Memory System Reference](reference/memory-system.md) for the trust engine, decay math, and embedding strategy.

### MCP Broker -- RBAC-Gated Tool Calls

Every tool call goes through a broker that checks the calling agent's role before forwarding. The `coder` role can read files and run tests, but cannot push to GitHub. The `boomerang-git` role is the only one allowed to use the `github-mcp` server. The `playwright` server is restricted to `tester`, `researcher`, and `scraper`. This is enforced in code at [`access/access.go`](https://github.com/Veedubin/neuralgentics/blob/main/packages/broker-go/src/neuralgentics/broker/access/access.go) -- 23 roles, 7 restricted server classes.

The practical effect: agents never see tools they can't use, which cuts the tool list in their prompt and reduces token overhead by up to 95% per dispatch. The broker also routes the actual call, retries on failure, and logs every invocation to the audit log.

### Container Support -- First-Class Deployment Option

Neuralgentics ships with four container images on `pgvector/pgvector:pg18` multi-stage builds:

- `ghcr.io/veedubin/neuralgentics-postgres:v0.3.0` — PostgreSQL 18 + pgvector, schema baked in
- `ghcr.io/veedubin/neuralgentics-sidecar:v0.3.0` — Python gRPC embedding service
- `ghcr.io/veedubin/neuralgentics-backend:v0.3.0` — Go JSON-RPC backend, distroless
- `ghcr.io/veedubin/neuralgentics-tui:v0.3.0` — TUI binary, distroless

Bring up the full stack with `docker-compose up` or `podman-compose up`. The `podman-compose.yml` includes Podman-specific tweaks (SELinux `:Z` labels, `userns_mode: keep-id`, `pids_limit`).

See [Installation Guide](getting-started/installation.md) for the container quickstart.

```text
    ROLE x SERVER MATRIX
    ─────────────────────────────────────────────────────────────────
    SERVER          architect  coder  tester  git  writer  scraper
    ─────────────────────────────────────────────────────────────────
    filesystem          ✓        ✓      ✓      ✓     ✓       ✓
    postgres            ✓        ✓      ✓      ✓     ✓       ✓
    shell               ✓        ✓      ✓      ✓     ✓       ✓
    ─────────────────────────────────────────────────────────────────
    github-mcp          ✗        ✗      ✗      ✓     ✗       ✗
    playwright          ✗        ✗      ✓      ✗     ✗       ✓
    searxng             ✓        ✓      ✗      ✓     ✗       ✓
    markitdown          ✓        ✗      ✗      ✓     ✓       ✗
    webfetch/search     ✓        ✓      ✓      ✗     ✗       ✓
    ─────────────────────────────────────────────────────────────────
    23 total roles  ·  7 restricted servers  ·  default-deny
```

See [Permission Model](architecture/permission-model.md) for the full matrix and [Broker Flow](architecture/broker-flow.md) for the request path.

### Sidecar Lifecycle

The embedding sidecar provides gRPC embedding services over a Unix domain socket. It can be managed two ways:

**Systemd (Linux)** — `install.sh` generates a user service at `~/.config/systemd/user/neuralgentics-sidecar.service`:

```bash
systemctl --user start neuralgentics-sidecar
systemctl --user stop neuralgentics-sidecar
systemctl --user status neuralgentics-sidecar
systemctl --user enable neuralgentics-sidecar   # auto-start on login
journalctl --user -u neuralgentics-sidecar -f   # view logs
```

**PID-file wrapper (containers, WSL1, macOS)** — use `scripts/sidecar.sh`:

```bash
./scripts/sidecar.sh start     # idempotent, refuses if already running
./scripts/sidecar.sh stop      # graceful, then SIGKILL after 10s
./scripts/sidecar.sh restart   # stop + start
./scripts/sidecar.sh status    # check if running
```

Key env vars (`scripts/.env.example` has the full list):

| Var | Default | Purpose |
|---|---|---|
| `NEURALGENTICS_EMBED_DEVICE` | `cpu` | `cpu` or `cuda` (GPU, 16x faster for batches) |
| `NEURALGENTICS_EMBED_DTYPE` | `fp32` | `fp16` halves VRAM (BGE-Large: 1.3GB → 640MB) |
| `NEURAL_EMBED_ADDR` | `unix:///tmp/neuralgentics-embed.sock` | gRPC listen address |
| `EMBEDDING_MODE` | `auto` | `auto` enables dual-write (384 + 1024 dim) |
| `SIDECAR_AUTO_START` | `false` | Experimental, requires v0.9.0 |

Common issues:

| Symptom | Fix |
|---|---|
| `Failed to connect to sidecar at unix:///tmp/...` | Run `./scripts/sidecar.sh status` or `systemctl --user status neuralgentics-sidecar`. Start if stopped. |
| `connect: connection refused` (TCP) | Check `NEURAL_EMBED_ADDR` matches in both sidecar and Go backend's `MEMINI_EMBEDDING_ADDR`. |
| Slow embeddings (~200ms each) | Switch `NEURALGENTICS_EMBED_DEVICE=cuda NEURALGENTICS_EMBED_DTYPE=fp16` and restart. |
| Out of memory on GPU | Check `nvidia-smi` for VRAM usage. FP16 halves BGE-Large's footprint. |

See the [README](https://github.com/Veedubin/neuralgentics#sidecar-lifecycle) for the full reference.

### Kanban Board -- A Real FSM, Not a TODO List

Tasks are first-class objects with a 7-state finite state machine: `triage → todo → ready ↔ running ↔ blocked → done → archived`. Every transition is a logged event. `failureLimit=2` auto-archives a card that keeps failing. The kanban is the durable source of truth for "what is being worked on" -- agents and humans read the same board, and the orchestrator only dispatches cards in `ready` status.

The board survives session boundaries, so a card you start on Monday is still on the board Friday morning with its full dispatch history attached.

```text
    KANBAN BOARD  ·  neuralgentics/v0.1.2
    ─────────────────────────────────────────────────────────────────
    TRIAGE        TODO          READY         RUNNING       BLOCKED
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐
    │ T-070    │  │ T-068    │  │          │  │ T-069    │  │      │
    │ review   │  │ doc fix  │  │          │  │ features │  │      │
    └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────┘
    DONE                              ARCHIVED
    ┌────────────────────────────────┐  ┌────────────────────────────┐
    │ T-067c  mutex fix       12s    │  │ T-066  stubs (not impl.)   │
    │ T-067b  any cleanup     8s     │  │ T-066b count query         │
    │ T-067a  vnode types     14s    │  │ T-067  (superseded)        │
    │ T-065   scan errors     21s    │  └────────────────────────────┘
    │ T-068   coverage tests  45s    │   auto-archived: failure > 2
    └────────────────────────────────┘
```

See [Kanban System](reference/kanban-system.md) for the FSM transitions, circuit-breaker rules, and dispatch logic.

### Tiered Context Loading -- L0 / L1 / L2

Memory loads in three tiers by trust and recency. **L0** is a ~100-token project summary built from high-trust memories, injected automatically at session start so a new agent can orient. **L1** is a ~2K-token summary of key decisions (trust ≥ 0.8) used during planning. **L2** is the full memory store, queried on demand when the agent needs a specific past decision.

The result: agents start with the same context humans do after skimming a project wiki. They don't have to read 50,000 tokens of history to know the architecture exists.

```text
    CONTEXT TIERS  ·  loaded on demand
    ─────────────────────────────────────────────────────────────────
    L0  ~100 tokens   project summary
        ↳ "Neuralgentics: 23-role MCP broker + pgvector memory.
            Architect designs, coder implements, tester gates.
            Trust-scored, L0/L1/L2 loading. MIT license."
        always-injected at session start (trust ≥ 0.5)

    L1  ~2,000 tokens   key decisions
        ↳ routing matrix, RBAC table, FSM transitions,
          decay formula, release pipeline, zero-error rule
        loaded during planning (trust ≥ 0.8)

    L2  unbounded   full memory store
        ↳ every decision, every dispatch, every wrap-up
        queried semantically per task
    ─────────────────────────────────────────────────────────────────
    Prompt budget: 200 tokens for the agent + 100 L0 + 2K L1 on demand
```

See [Memory System Reference](reference/memory-system.md) for the tier promotion logic and trust thresholds.

### Multi-Agent Routing -- 23 Specialists, One Routing Matrix

The orchestrator owns a single routing matrix that maps task type to specialist agent. "Design a new feature" goes to architect. "Implement this card" goes to coder. "Run the test suite" goes to tester. "Open a PR" goes to git. "Write the release notes" goes to writer. The matrix is enforced at the code level, not by convention -- an agent cannot accidentally call a tool its role doesn't authorize.

Eight concrete agent roles ship in the project: architect, coder, explorer, git, orchestrator, reviewer, tester, writer. The 23 in the broker matrix extend these with finer-grained permission scopes.

```text
    ROUTING MATRIX  ·  intent → agent
    ─────────────────────────────────────────────────────────────────
    INTENT              PRIMARY AGENT     CONTEXT     GATES
    ─────────────────────────────────────────────────────────────────
    design / spec       architect         L0 + L1    --
    implement / fix     coder             L0         lint+tsc+test
    find / locate       explorer          L0         --
    commit / push       git               L1         diff+lint
    test / cover        tester            L0         test only
    review / audit      tester            L1         read-only
    document / write    writer            L0         markdownlint
    web / scrape        scraper           L0         --
    orchestrate         orchestrator      L0 + L1    all gates
    ─────────────────────────────────────────────────────────────────
    Unknown intent → orchestrator self-routes after L1 planning
```

See [Dispatch Flow](architecture/dispatch-flow.md) for the full routing logic and the rule that architect always designs before coder builds.

### Stateless Agent Protocol -- 200-Token Prompts, Durable State

Agents don't receive large inline context packages. They receive a ~200-token seed prompt that says `Task: <verb> the <noun>. Memory ID: <id>. Action: fetch context from memory and execute.` The agent fetches its context from memory, does the work, stores its wrap-up back to memory, and returns a `{memory_id, description}` handle to the orchestrator.

This decoupling means agents can be swapped, scaled, or restarted without losing state. The memory is the source of truth, the prompt is just a delivery envelope. Token overhead per dispatch drops to a few hundred tokens, and a fresh agent picks up exactly where the last one left off.

```text
    ─── ORCHESTRATOR ──→ MEMORY (store context) ──→ AGENT (seed prompt)
    Task: Fix the broken count query in store/queries.go.
    Memory ID: mem-7c3a-4f2e
    Action: Fetch context from memini-core, fix the bug, store wrap-up.

    ─── AGENT ──→ MEMORY (fetch context) ──→ [executes] ──→ wrap-up
    → Reads L0 summary, L1 routing rules, L2 prior count-query bug
    → Edits store/queries.go, simplifies COUNT(*), adds regression test
    → Stores wrap-up: "Fixed CountMemories. Replaces mem-9b1a."

    ─── AGENT ──→ ORCHESTRATOR (return handle)
    { memory_id: "mem-a8f3", description: "count query simplified" }
```

See [Session Lifecycle](reference/session-lifecycle.md) for the full 8-step protocol and the wrap-up trust signal.

---

## Why It's Different

- **Memory is a product, not a side effect** -- trust scoring and decay make the system honest about what worked. Source: [`packages/memini-core/`](https://github.com/Veedubin/neuralgentics/tree/main/packages/memini-core)
- **Permissions are the broker, not a config file** -- 23 roles x 7 restricted server classes, enforced in code. Source: [`access/access.go`](https://github.com/Veedubin/neuralgentics/blob/main/packages/broker-go/src/neuralgentics/broker/access/access.go)
- **State lives in memory, not in prompts** -- ~200-token seed prompts, full context fetched on demand, wrap-ups stored back. See [Session Lifecycle](reference/session-lifecycle.md)
- **A real kanban FSM, not a TODO list** -- 7 states, circuit breaker, audit trail. See [Kanban System](reference/kanban-system.md)

## Comparison Table

| Framework | Year | License | Agent Model | Memory | Permissions |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Neuralgentics** | 2026 | MIT | 23 specialists, role-routed | Trust-scored PostgreSQL + pgvector | RBAC, 23 roles, 7 restricted servers |
| **Hermes** (Nous Research) | 2026 | MIT | Single persistent agent + self-created skills | FTS5 session search + Honcho user modeling | (needs research) |
| **OpenClaw** (P. Steinberger) | 2025 | MIT | Multi-agent heartbeat + message dispatch | Markdown-file memory + vector search | ClawManifest signed declarations + Docker sandbox |
| **LangChain** (LangChain Inc.) | 2022 | MIT | LangGraph agent runtime; create_agent + middleware | Pluggable (vector stores, Redis, LangMem) | (needs research) |
| **AutoGen** (Microsoft) | 2023 | CC-BY-4.0 / MIT (MAF) | Multi-agent conversation; event-driven (v0.4+) | Agent-specific memory + vector store integration | (needs research) |
| **CrewAI** | 2024 | MIT | Role-playing agents + crew orchestration | Unified Memory class | (needs research) |
| **MetaGPT** (Foundation Agents) | 2023 | MIT | SOP-encoded multi-agent (PM, architect, engineer, tester) | Role-specific message lists + experience caching | (needs research) |

Comparison data verified against public sources as of 2026-06. Cells marked `(needs research)` were not citable at time of writing.

## See It In Action

A mockup is a picture of the app, drawn in plain text with Unicode box-drawing characters. Like the dispatch diagram above, but drawn to look like a screenshot of the running terminal UI -- header bar, agent names, footer hints. No PNG files required.

### Mockup 1 -- Kanban on Startup

```text
┌─── neuralgentics v0.1.0 ─── [LLM:online] [DB:6000] ── 12:34 ────────────┐
│                                                                            │
│  ┌─ Kanban ────────────────────────┐  ┌─ Agents ──────────────────────┐  │
│  │ T-041 · Fix GH Pages 404       │  │  ▶ architect      [idle]       │  │
│  │   done  ·  coder (42s)         │  │  ▶ coder         [idle]       │  │
│  │ T-042 · Rewrite install.sh     │  │  ▶ explorer      [idle]       │  │
│  │   running  ·  coder           │  │  ▶ git           [idle]       │  │
│  │ T-043 · Comparison table       │  │  ▶ orchestrator  [running]   │  │
│  │   todo  ·  unassigned          │  │  ▶ tester        [idle]       │  │
│  │ T-044 · Credibility metrics    │  └────────────────────────────────┘  │
│  │   todo  ·  unassigned          │                                      │
│  └────────────────────────────────┘                                      │
│                                                                            │
│  > _                                                                       │
│  [?] help  [n] new  [b] board  [m] memory  [q] quit                       │
└────────────────────────────────────────────────────────────────────────────┘
```

MOCKUP -- not a real screenshot.

### Mockup 2 -- Dispatch View

```text
┌─── neuralgentics v0.1.0 ─── [LLM:online] [DB:6000] ── 12:38 ────────────┐
│                                                                            │
│  ┌─ Kanban ────────────────────────┐  ┌─ Orchestrator Log ─────────────┐  │
│  │ T-041 · Fix GH Pages 404       │  │ [12:34] → Route: code-impl.    │  │
│  │   done  ·  coder (42s)         │  │ [12:34] → Agent: boomerang-   │  │
│  │ T-042 · Rewrite install.sh     │  │           coder                │  │
│  │   running  ·  coder            │  │ [12:34] → Context: L0+L1      │  │
│  │   "Adding prompt_install_      │  │ [12:35] ✓ CODE: 1 line changed │  │
│  │    location validation..."     │  │ [12:35] → Gate: lint ✓        │  │
│  │ T-043 · Comparison table       │  │ [12:35] → Gate: typecheck ✓   │  │
│  │   todo  ·  unassigned          │  │ [12:35] → Gate: test ✓        │  │
│  └────────────────────────────────┘  │ [12:35] → Memory: saved (e7f8) │  │
│                                      │ [12:35] ✓ DONE (1.2s)          │  │
│                                      │ [12:37] → Route: code-impl.    │  │
│                                      │ [12:37] → Agent: boomerang-    │  │
│                                      │           coder                │  │
│                                      └────────────────────────────────┘  │
│                                                                            │
│  > /board           [?] help  [n] new  [q] quit                          │
└────────────────────────────────────────────────────────────────────────────┘
```

MOCKUP -- not a real screenshot.

### Mockup 3 -- Memory Inspector

```text
┌─── neuralgentics v0.1.0 ─── [LLM:online] [DB:6000] ── 12:45 ────────────┐
│                                                                            │
│  ┌─ Memory Inspector ─────────────────────────────────────────────────┐  │
│  │  Query: "dispatch routing matrix"  ·  Results: 3  ·  tiered       │  │
│  │  ─────────────────────────────────────────────────────────────────│  │
│  │  a1b2c3d4...  trust=0.85  decay=0.02/day  used_by=4 agents        │  │
│  │   "Routing Matrix: task type → architect for design, coder for   │  │
│  │    implementation — enforced at code level, no exceptions"        │  │
│  │  e5f6g7h8...  trust=0.78  decay=0.05/day  used_by=3 agents        │  │
│  │   "Context Package: fetch L0/L1 memory, attach to Task() —       │  │
│  │    L0 ~100 tokens, L1 ~2K tokens for planning"                   │  │
│  │  i9j0k1l2...  trust=0.62  decay=0.08/day  used_by=2 agents        │  │
│  │   "404 fix: mkdocs.yml site_url wrong — correct URL is           │  │
│  │    veedubin.github.io/neuralgentics"                              │  │
│  │  ─────────────────────────────────────────────────────────────────│  │
│  │  Trust: ● active  ○ decayed  ∅ archived                          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  > /memory query="routing"   [?] help  [m] memory  [q] quit             │
└────────────────────────────────────────────────────────────────────────────┘
```

MOCKUP -- not a real screenshot. Trust scores and decay rates are illustrative.

## Quickstart

1. Install the CLI:
   ```bash
   uv pip install neuralgentics
   ```
2. Bootstrap your project:
   ```bash
   cd your-project
   neuralgentics init
   ```
3. Launch OpenCode:
   ```bash
   opencode
   ```

## Quick Links

| If you want to... | Go here → |
| :--- | :--- |
| **Get it running** | [Installation Guide](getting-started/installation.md) |
| **Ship your first feature** | [Quickstart Guide](getting-started/quickstart.md) |
| **Understand the architecture** | [System Overview](architecture/overview.md) |
| **See how dispatch works** | [Dispatch Flow](architecture/dispatch-flow.md) |
| **Dive into the memory engine** | [Memory System Reference](reference/memory-system.md) |
| **Review the session lifecycle** | [Session Lifecycle](reference/session-lifecycle.md) |
| **Configure the runtime** | [Environment Variables](reference/env-vars.md) |
| **Fix something that's broken** | [Troubleshooting](troubleshooting.md) |
| **Learn about the CLI** | [Init CLI Bootstrapper](design/init-cli-bootstrapper.md) |

---

[**Get Started →**](getting-started/installation.md)

*Built by humans who got tired of agents that forget.*