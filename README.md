<p align="center">
  <img src="assets/neuralgentics-logo.png" alt="Neuralgentics logo" width="600">
</p>

# Neuralgentics

> An open-source agent runtime, built for engineers who ship.

Neuralgentics is the **harness** for AI agents - the execution environment, permission broker, and persistent memory that turns a language model into a reliable, debuggable, and trustworthy agent.

A harness provides the structural scaffolding that a raw model lacks. It wraps the LLM with specific prompts, tools, context, and strict permissions, ensuring the agent operates within defined boundaries and maintains continuity across sessions.

**23 specialist agents, a trust-scored memory engine, and a permissions-based tool broker - all in a 26 MB Go binary.** No cloud account, no telemetry, no vendor lock-in. You run it on your machine; it remembers what your agents did; it stops them from doing things they shouldn't.


📖 **Full documentation: <https://veedubin.github.io/neuralgentics/>**

---

## What it does

- **Memory Engine** — Every decision an agent makes lands in PostgreSQL + pgvector with a **trust score** (default 0.5). Successful patterns get promoted; failed approaches decay and fade. The system is honest about what worked.
- **MCP Broker** — All tool calls go through a broker that enforces role-based permissions: 23 roles, 7 restricted server classes. `github-mcp` is gated to `boomerang-git` only. The broker also cuts the tool list in agent prompts, reducing token overhead by up to 95% per dispatch.
- **Kanban Board** — A real 7-state finite state machine (`triage → todo → ready ↔ running ↔ blocked → done → archived`), not a TODO list. Every transition is logged. `failureLimit=2` auto-archives a card that keeps failing.
- **Tiered Context Loading** — L0 (~100 tokens, always-injected summary) + L1 (~2K tokens, key decisions) + L2 (unbounded, on-demand). New agents start with the same context humans do after skimming a project wiki.
- **Multi-Agent Routing** — One routing matrix maps task type to specialist agent. Architect designs, coder implements, tester gates, git commits. Enforced at the code level, not by convention.
- **Stateless Agent Protocol** — Agents receive ~200-token seed prompts and fetch their own context from memory. Wrap-ups are stored back. Token overhead per dispatch drops to a few hundred tokens, and a fresh agent picks up where the last one left off.

---

## Quick links

- [Installation](https://veedubin.github.io/neuralgentics/getting-started/installation/)
- [Quickstart](https://veedubin.github.io/neuralgentics/getting-started/quickstart/)
- [System overview](https://veedubin.github.io/neuralgentics/architecture/overview/)
- [Dispatch flow](https://veedubin.github.io/neuralgentics/architecture/dispatch-flow/)
- [Permission model](https://veedubin.github.io/neuralgentics/architecture/permission-model/)
- [Environment variables](https://veedubin.github.io/neuralgentics/reference/env-vars/)
- [Memory system](https://veedubin.github.io/neuralgentics/reference/memory-system/)
- [Kanban system](https://veedubin.github.io/neuralgentics/reference/kanban-system/)
- [Troubleshooting](https://veedubin.github.io/neuralgentics/troubleshooting/)
- [Development](https://veedubin.github.io/neuralgentics/development/)

---

## Install

```bash
# One-line install (Linux, macOS, WSL2)
curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
```

The install script handles Go, Node, container runtimes (docker or podman), and SSL certs. It detects WSL2, prompts for the install prefix, and supports `--dry-run` and `--yes` flags. The one-liner above works end-to-end: it auto-detects an existing `neuralgentics-pg` container and recovers its credentials, or auto-starts a fresh one. See the [installation guide](https://veedubin.github.io/neuralgentics/getting-started/installation/) for the full option list.

---

## Architecture at a glance

```text
    USER PROMPT
         │
         ▼
   ╔══════════════════╗
   ║   ORCHESTRATOR   ║ ◄── Routes by intent to specialist agent
   ╚══════════════════╝
         │
         ├─→ MEMORY (PostgreSQL + pgvector, trust-scored)
         │     L0 summary  ·  L1 decisions  ·  L2 full history
         │
         ├─→ KANBAN (FSM: triage→todo→ready→running→done)
         │     Cards persist across sessions
         │
         └─→ MCP BROKER (RBAC: 23 roles × 7 restricted servers)
               ✓ if role authorized  ·  ✗ → audit log + reject
```

A task enters the orchestrator, gets routed to a specialist, who calls the broker for tools, who checks RBAC, who executes — and every decision lands in the trust-scored memory store.

---

## What ships

| Component | Size | Purpose |
| :--- | :--- | :--- |
| `packages/backend-go/` | 26 MB binary | JSON-RPC server, 42 methods, stdio transport |
| `packages/memini-core/` | Python | pgvector memory + trust engine + decay scheduler |
| `packages/broker-go/` | Go | RBAC enforcement + tool call routing + audit log |
| `packages/orchestrator-go/` | Go | Routing matrix + card lifecycle + dispatch |
| `packages/sdk/` | TypeScript | Typed client library for sub-agents and external consumers. Framework-agnostic — does not depend on OpenCode. Used by `.opencode/agents/neuralgentics-*.md` agent prompts. |
| `packages/plugin/` | TypeScript | OpenCode integration plugin. Wires the runtime into the OpenCode IDE via the OpenCode plugin API. Depends on SDK. |
| `packages/tui/` | TypeScript | Terminal UI (OpenTUI-based, mockups in docs) |
| `overlay/packages/opencode/` | TypeScript | Plugin that wires the runtime into OpenCode |
| `docker-compose.yml` | - | Docker Compose configuration for full-stack deployment |
| `podman-compose.yml` | - | Podman Compose configuration with SELinux and user namespace tweaks |

**SDK vs Plugin boundary**: `packages/sdk/` is a framework-agnostic typed client (no OpenCode imports). `packages/plugin/` is the OpenCode-specific integration (MCP tools, lifecycle hooks, stateless agent protocol). Plugin MAY use SDK; SDK MUST NOT use Plugin.

Eight concrete agent roles ship in the project: **architect, coder, explorer, git, orchestrator, reviewer, tester, writer**. The 23 in the broker matrix extend these with finer-grained permission scopes.

---

## 30-second pitch

Neuralgentics is a coding-agent runtime that:

1. **Routes tasks to specialist sub-agents** (architect, coder, tester, git, ...) via a typed routing matrix
2. **Stores everything in a trust-weighted memory engine** (PostgreSQL + pgvector) — successful patterns get promoted, failed ones decay
3. **Mediates all external tool access through an MCP broker** that enforces role-based permissions and reduces tool-catalog tokens by 95%
4. **Speaks MCP to the world** — 42 JSON-RPC methods, stdio transport, broker-gated
5. **Installs in one command** (`./scripts/install.sh`) or one `podman-compose up`
6. **Container support** — 4 images on `pgvector/pgvector:pg18` multi-stage builds: PostgreSQL 18 + pgvector, Python gRPC embedding sidecar, Go JSON-RPC backend (distroless), and TUI (distroless)

Agent prompts are ~200 tokens each. State lives in memory, not in the prompt. Open-source under the [MIT License](https://github.com/Veedubin/neuralgentics/blob/main/LICENSE).

HACK THE PLANET. See the [docs](https://veedubin.github.io/neuralgentics/) for everything else.

---

## Development setup

Neuralgentics uses [`uv`](https://docs.astral.sh/uv/) to manage Python dependencies from the `pyproject.toml` files in each Python package, and `npm` for the TypeScript overlay. **There are no vendored dependencies in the repo** — all build artifacts, virtualenvs, and the vendored OpenCode source are excluded by `.gitignore` and re-created locally on first run.

```bash
# 1. Install uv (one-time)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Install each Python package in editable mode (creates .venv automatically)
uv pip install --system -e packages/memini-core
uv pip install --system -e packages/memory/cmd/embedding-sidecar

# 3. Install the TypeScript overlay
cd overlay/packages/opencode && npm install && cd -

# 4. Verify the install
make lint
```

To run the full quality-gate suite:

```bash
make all          # lint + typecheck + build + test + smoke
make docs-serve   # serve the documentation site locally
```

The [Makefile](./Makefile) documents every target.

---

## License

MIT.
