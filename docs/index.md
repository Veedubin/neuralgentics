# Multi-Agent Orchestration, Permissions-based MCP Server Broker, Context Continuity Across Sessions

> An open-source agent runtime, built for engineers who ship.

[**Get Started →**](getting-started/installation/)

---

## The Problem

Generic LLM coding agents have no persistent memory, no concept of role-based authority, and a single bloated context window. They forget Monday on Friday. Every agent sees every tool -- no roles, no scoped permissions, no audit trail. Prompts fight for the same slot, so you re-explain the project every session, or ship bugs the agent invented because it had no record of what failed.

## What Neuralgentics Is

Neuralgentics replaces one "do-it-all" bot with structured, role-based orchestration. Twenty-three specialist agents -- architect, coder, tester, git, and more -- each receive only the tools their role authorizes and only the context their task requires.

Every decision lands in PostgreSQL + pgvector with **trust scoring**. Successful patterns get promoted; failed approaches decay and fade. The MCP broker gates every tool call against the agent's role, cutting token overhead by up to 95%. Context survives sessions through L0/L1/L2 tiered loading -- a new agent picks up where the last one left off.

Agent prompts are ~200 tokens each. State lives in memory, not in the prompt. Ships as a Go binary (26 MB) + podman PostgreSQL + Python gRPC sidecar. Open-source under the [MIT License](https://github.com/Veedubin/neuralgentics/blob/main/LICENSE).

## How It Works

```text
    USER PROMPT
         │
         ▼
  ╔══════════════════╗
  ║   THOUGHT CHAIN  ║ ◄── Logged to memini-ai
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

A task enters the orchestrator, gets routed to a specialist, who calls the broker for tools, who checks RBAC, who executes -- and every decision lands in the trust-scored memory store. Full details at [Dispatch Flow](architecture/dispatch-flow/).

## Why It's Different

- **Persistent, trust-scored memory** -- PostgreSQL + pgvector with trust engine and decay. Source: [`packages/memini-core/`](https://github.com/Veedubin/neuralgentics/tree/main/packages/memini-core)
- **23 permission roles, 7 restricted server classes** -- every tool call passes through the broker. Source: [`access/access.go`](https://github.com/Veedubin/neuralgentics/blob/main/packages/broker-go/src/neuralgentics/broker/access/access.go)
- **Context that survives sessions** -- L0/L1/L2 tiered loading. See [Memory System Reference](reference/memory-system/)
- **Stateless agents, durable state** -- prompts are ~200 tokens; context lives in memory, not in the prompt

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

## Quick Links

| If you want to... | Go here → |
| :--- | :--- |
| **Get it running** | [Installation Guide](getting-started/installation/) |
| **Ship your first feature** | [Quickstart Guide](getting-started/quickstart/) |
| **Understand the architecture** | [System Overview](architecture/overview/) |
| **See how dispatch works** | [Dispatch Flow](architecture/dispatch-flow/) |
| **Dive into the memory engine** | [Memory System Reference](reference/memory-system/) |
| **Review the session lifecycle** | [Session Lifecycle](reference/session-lifecycle/) |
| **Configure the runtime** | [Environment Variables](reference/env-vars/) |
| **Fix something that's broken** | [Troubleshooting](troubleshooting/) |

---

[**Get Started →**](getting-started/installation/)

*Built by humans who got tired of agents that forget.*