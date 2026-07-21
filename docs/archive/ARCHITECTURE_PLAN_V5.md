# Architecture Plan V5: Neuralgentics

**Date:** 2026-05-21 (Revised 2026-05-22)
**Status:** ✅ IMPLEMENTED (MVP Ready)
**Version:** 5.1
**Supersedes:** ARCHITECTURE_PLAN_V4.md, ARCHITECTURE_PLAN_V3.md

---

## Executive Summary

**Neuralgentics** is a coding agent built on OpenCode's base. It is NOT a fork — we download OpenCode base, build our proprietary layer on top, and track upstream with patch tracking.

**Key Principle:** MCP protocol is BANISHED from internal/native components. Internal systems communicate via direct function calls or plain HTTP JSON. MCP exists ONLY as a broker for external/third-party servers.

**Model:** Google Chrome ↔ Chromium :: Neuralgentics ↔ OpenCode

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenCode Base (v1.15.6+)                     │
│           (lightly patched: TUI rebrand ONLY)                 │
│                     Plugin hooks → tool.execute.before          │
├────────────────────────┬────────────────────────────────────────┤
│                        │ direct import (NO MCP)                 │
├────────────────────────▼────────────────────────────────────────┤
│            Neuralgentics Plugin (TypeScript, @neuralgentics)   │
│  • Orchestrator — routing, context building, protocol           │
│  • Skills loader — markdown files, runtime loaded               │
│  • Memory adapter — HTTP JSON to memini-core                     │
│  • Router — 8-step protocol enforcement                         │
│        ↑                                                        │
│  AGENTS.md — declarative capabilities (not tool descriptions)    │
├────────────────────────┬────────────────────────────────────────┤
│                        │ HTTP JSON / fetch()                  │
├────────────────────────▼────────────────────────────────────────┤
│              memini-core (Python — FastAPI, NO MCP)             │
│  • Memory CRUD + vector search (PostgreSQL/pgvector)            │
│  • Trust engine — agent_used (+0.05), user_confirmed (+0.10) │
│  • Memory graph — relationships + BFS traversal               │
│  • Project indexer — auto-index project files                 │
│  • Embeddings — sentence-transformers (MiniLM, 384-dim)      │
├────────────────────────┬────────────────────────────────────────┤
│                        │ PostgreSQL/pgvector                  │
├────────────────────────┴────────────────────────────────────────┤
│              MCP Broker (Python — EXTERNAL tools ONLY)         │
│  • MCP Registry — dynamic server registration                  │
│  • Proxy Layer — stdio JSON-RPC to MCP servers                 │
│  • Token reduction — tool summaries, not full schemas            │
│        ↓                                                        │
│  External servers: docker-mcp, github-mcp, playwright, etc.    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Principle: No MCP for Native Components

| Component          | Internal Protocol | Why                                |
| -------------------- | ------------------- | ------------------------------------ |
| **Orchestrator ↔ Memory**  | Direct Go/TS `fetch()` to HTTP REST | Native, zero MCP overhead           |
| **Plugin ↔ Skills**        | Go reads markdown at runtime         | Native, zero MCP overhead           |
| **Orchestrator ↔ Router**  | Direct function call / import        | Native, zero MCP overhead           |
| **Broker ↔ External**      | MCP protocol (stdio JSON-RPC)        | **ONLY place MCP lives**             |
| **Agent/Model sees**       | Declarative AGENTS.md capabilities   | Not 35 MCP tool descriptions         |

**Token Overhead Eliminated:**
- Before: 35 MCP tools → ~8,000 tokens in tool descriptions
- After: Declarative AGENTS.md → ~800 tokens in capability declarations
- **Result: 90% token reduction**

---

## Components

### 1. TUI (OpenCode Base + Rebrand)

**Patch:** Single-line change in `footer.tsx`:
```diff
- OpenCode
+ Neuralgentics powered by OpenCode
```

**File:** `patches/rebrand.patch`

---

### 2. memini-core (Python, No MCP)

**Language:** Python (keep battle-tested code, don't rewrite)
**Transport:** FastAPI HTTP server on port 8900
**Database:** PostgreSQL/pgvector (same schema as memini-ai-dev)

**What it does:**
- Semantic memory with MiniLM embeddings (384-dim)
- Trust scoring engine
- Memory graph (SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM)
- Project file indexing
- Pure HTTP REST — zero MCP

**Schema:** Same as memini-ai-dev:
```sql
CREATE TABLE memories (
    id UUID PRIMARY KEY,
    content TEXT,
    embedding vector(384),
    trust_score FLOAT DEFAULT 0.5,
    source_type VARCHAR(50),
    created_at TIMESTAMP,
    metadata JSONB
);

CREATE TABLE memory_relationships (
    source_id UUID,
    target_id UUID,
    relationship_type VARCHAR(50),
    confidence FLOAT
);

CREATE TABLE project_chunks (
    id UUID PRIMARY KEY,
    file_path TEXT,
    content TEXT,
    embedding vector(384),
    metadata JSONB
);
```

**Routes:**
- `POST /memory/query` — semantic search
- `POST /memory/add` — store with auto-embedding
- `GET /memory/{id}` — retrieve by ID
- `POST /memory/{id}/trust` — adjust trust score
- `GET /memory/related/{id}` — get relationships
- `POST /memory/relationship` — create relationship
- `GET /project/index` — trigger indexing
- `GET /health` — liveness probe

---

### 3. TypeScript Plugin + Orchestrator

**Language:** TypeScript (same runtime as OpenCode, no build complexity)
**Transport:** Direct imports + HTTP JSON to memini-core

**What it does:**
- **Orchestrator** — routes tasks to agents, builds context packages
- **Memory Adapter** — calls memini-core via `fetch()`, no MCP
- **Skills Loader** — parses markdown files, injects into system prompt
- **Protocol Enforcer** — 8-step Boomerang Protocol

**Key files:**
- `packages/plugin/src/index.ts` — OpenCode plugin entry, registers hooks
- `packages/orchestrator/src/index.ts` — task routing, context packages
- `packages/orchestrator/src/routing.ts` — agent routing matrix
- `packages/orchestrator/src/skills.ts` — markdown skill loader
- `packages/orchestrator/src/context.ts` — context package builder

**Hooks (OpenCode plugin system):**
- `experimental.session.compacting` → backup memory before compaction
- `tool.execute.before` → validate routing (block if task → wrong agent)
- `tool.execute.after` → save context to memory
- `experimental.chat.system.transform` → inject AGENTS.md content

---

### 4. MCP Broker (External Tools Only)

**Language:** Python
**Status:** Implemented (basic)
**Transport:** FastAPI HTTP on port 8901

**What it does:**
- Registers external MCP servers (Docker, NPX, direct)
- Returns tool summaries (not full JSON schemas) for token reduction
- Proxies calls to external MCP servers over stdio JSON-RPC

**Agent sees:**
- `get_tool_list` — currently registered tool summaries
- `mcp-router-call` — unified endpoint for all MCP operations

---

### 5. Skills System

**Format:** Markdown files with YAML frontmatter

**Example (`skills/architect.md`):**
```markdown
# skill: architect
name: Architecture Review
model: primary
description: Reviews system design and provides actionable feedback.

---
You are a senior software architect. When asked about architecture:
1. Identify trade-offs explicitly
2. Consider first-order and second-order effects
3. Recommend the simplest viable option first
```

**Loading:** Runtime markdown parse → Skill objects → Injected into system prompt

---

## Directory Structure (Actual)

```
neuralgentics/
├── packages/
│   ├── memini-core/          # Python HTTP memory server (NO MCP)
│   │   ├── src/memini_core/
│   │   │   ├── server.py     # FastAPI routes
│   │   │   ├── database.py   # PostgreSQL/pgvector
│   │   │   ├── embeddings.py # sentence-transformers MiniLM
│   │   │   ├── trust.py      # Trust engine
│   │   │   ├── graph.py      # Memory relationships
│   │   │   ├── indexer.py    # Project file indexer
│   │   │   └── models.py     # Pydantic schemas
│   │   ├── pyproject.toml    # Dependencies
│   │   └── .env.example
│   ├── plugin/               # TypeScript OpenCode plugin
│   │   ├── src/
│   │   │   ├── index.ts      # Plugin entry, hook registration
│   │   │   └── adapters/
│   │   │       ├── memory.ts # HTTP adapter to memini-core
│   │   │       └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── orchestrator/          # TypeScript orchestrator
│   │   ├── src/
│   │   │   ├── index.ts      # Task handler, protocol enforcer
│   │   │   ├── routing.ts    # Routing matrix
│   │   │   ├── skills.ts     # Markdown skill loader
│   │   │   ├── context.ts    # Context package builder
│   │   │   └── types.ts      # Shared types
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── broker/               # Python MCP broker (EXTERNAL only)
│       └── src/broker/
│           ├── server.py     # FastAPI routes
│           ├── registry.py   # MCP server registry
│           ├── proxy.py     # stdio JSON-RPC proxy
│           └── launcher.py   # MCP server launcher
├── skills/                   # Markdown skill files
│   ├── architect.md
│   ├── coder.md
│   └── reviewer.md
├── patches/                  # OpenCode patches
│   └── rebrand.patch        # TUI rebrand
├── scripts/
│   ├── install.sh            # Master install
│   ├── build.sh             # Build all packages
│   ├── serve.sh             # Start all services
│   ├── update.sh            # Auto-updater from GitHub releases
│   ├── release.sh           # Create GitHub release + tag
│   └── apply-patches.sh    # Apply patches to OpenCode
├── tests/
│   ├── test-memini-core.py   # memini-core integration tests
│   ├── test-plugin.ts        # TypeScript plugin tests
│   └── test-structure.sh     # File structure verification
├── docs/
│   ├── ARCHITECTURE_PLAN_V3.md  # MCP Router concept (superseded)
│   ├── ARCHITECTURE_PLAN_V4.md  # Boomerang on OpenCode (superseded)
│   ├── NEURALGENTICS_PATCHES.md # Patch tracking
│   └── ARCHITECTURE.md          # This doc
├── AGENTS.md                 # Declarative agent guidance (NO MCP tools)
├── CONTEXT.md                # Neuralgentics-specific context
├── TASKS.md                  # Task tracking
├── package.json             # Root node workspace
├── pyproject.toml           # Root Python config
└── tsconfig.json            # Root TypeScript config
```

---

## Build Pipeline

### Prerequisites
- Bun ≥1.1.0
- Python ≥3.11 (with uv)
- PostgreSQL 15+ with pgvector
- Git

### Install
```bash
# One-command install
git clone <neuralgentics-repo>
cd neuralgentics
./scripts/install.sh
```

### Build
```bash
./scripts/build.sh
```

### Run
```bash
# Start all services (memini-core + broker)
./scripts/serve.sh

# Or manually:
cd packages/memini-core && uv run python -m memini_core.server
# In another terminal:
bun run dev:plugin
```

### Update
```bash
# Pull latest release from GitHub
./scripts/update.sh --check   # Check for updates
./scripts/update.sh           # Apply update
```

---

## Patch Tracking

All OpenCode modifications tracked in `docs/NEURALGENTICS_PATCHES.md`:

| Patch | File | Change | Applied |
|-------|------|--------|---------|
| TUI Rebranding | `packages/app/src/components/footer.tsx` | "OpenCode" → "Neuralgentics powered by OpenCode" | 2026-05-21 |

**Reapply after upstream sync:**
```bash
./scripts/apply-patches.sh
./scripts/verify.sh
```

---

## OpenCode Plugin Hook Integration

### Available Hooks (verified in v1.15.6)
- `experimental.session.compacting` — Backup memory before compaction
- `tool.execute.before` — Validate routing, block if wrong agent
- `tool.execute.after` — Save context to memory
- `experimental.chat.system.transform` — Inject AGENTS.md content

### Integration Pattern
```typescript
// packages/plugin/src/index.ts
export default {
  hooks: {
    'experimental.session.compacting': async (ctx) => {
      await memoryAdapter.compact(ctx.session);
    },
    'tool.execute.before': async (task) => {
      const agent = orchestrator.selectAgent(task);
      if (!orchestrator.isAllowed(task, agent)) {
        throw new Error(`Task type "${task.type}" cannot be handled by ${agent}`);
      }
    },
  },
};
```

---

## Agent Roster

| Role | Model | Purpose |
| :--- | :--- | :--- |
| Orchestrator | Primary | Task decomposition, routing, protocol enforcement |
| Architect | Primary | System design, trade-off analysis, and research |
| Coder | Secondary | High-speed implementation and bug fixing |
| Reviewer | Primary | Code quality, security audit, and logic verification |
| Explorer | Secondary | File finding and codebase mapping |
| Tester | Secondary | Unit, integration, and E2E test generation |

### Routing Matrix (Simplified)

| Task Type | Primary | Forbidden |
|-----------|---------|-----------|
| Code implementation | coder | general |
| Architecture/design | architect | general, coder |
| File finding | explorer | general |
| Testing | tester | general, coder |
| Linting/formatting | linter | general |
| Git operations | git | general |
| Documentation | writer | general |

---

## MCP Broker (External Tools)

The MCP Broker handles ONLY external MCP servers. Internal systems bypass it completely.

### Agent Sees
```
get_tool_list()          → returns filtered summaries
mcp_router_call()        → unified endpoint for all external tools
```

### Flow
1. Agent describes need: "I need to search GitHub for issues"
2. Orchestrator calls `mcp_router_call("github", "search_issues", {q: "bug"})`
3. Broker finds registered `github-mcp` server
4. Broker proxies call via stdio JSON-RPC
5. Result returned to orchestrator

---

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| Bun | ≥1.1.0 | TypeScript runtime, build |
| Python | ≥3.11 | memini-core, broker |
| PostgreSQL | 15+ | Database |
| pgvector | latest | Vector storage |
| fastapi | ≥0.110 | HTTP server (memini-core + broker) |
| uvicorn | ≥0.29 | ASGI server |
| sentence-transformers | ≥2.6 | Embeddings |
| pydantic | ≥2.6 | Request/response models |
| psycopg2-binary | ≥2.9 | PostgreSQL driver |

---

## Status

| Component | Status | Tests |
|-----------|--------|-------|
| memini-core | ✅ Built | Integration tests written |
| Plugin | ✅ Built | TypeScript tests written |
| Orchestrator | ✅ Built | Structure verified |
| Skills | ✅ Built | 3 skill files |
| MCP Broker | ✅ Built | Basic |
| TUI Patch | ✅ Written | Patch file ready |
| Install scripts | ✅ Written | — |
| Build scripts | ✅ Written | — |
| Auto-updater | ✅ Written | — |

---

## Success Metrics

1. **Build:** `./scripts/build.sh` completes without errors
2. **TUI:** Shows "Neuralgentics powered by OpenCode"
3. **Memory:** Can add/query memories via HTTP REST
4. **Skills:** Can load markdown skills at runtime
5. **Token reduction:** Tool descriptions < 1K tokens (vs ~8K before)
6. **Sync:** Can pull OpenCode upstream and reapply patches
7. **No MCP:** Native components use direct HTTP, not MCP tool schemas

---

## Reference

- Architecture V3: `docs/ARCHITECTURE_PLAN_V3.md` (MCP Router concept)
- Architecture V4: `docs/ARCHITECTURE_PLAN_V4.md` (Boomerang on OpenCode)
- Patch tracking: `docs/NEURALGENTICS_PATCHES.md`
- Context: `CONTEXT.md`
- Tasks: `TASKS.md`

*Last Updated: 2026-05-22*
