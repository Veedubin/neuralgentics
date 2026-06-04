# Neuralgentics Memory Port Plan — FINAL v2

**Status: FINAL — APPROVED BY USER, READY FOR EXECUTION**
**Date: 2026-06-03 (Session 16)**
**Author: boomerang-architect (deepseek-v4-pro)**

> **Supersedes**: Architect report `ad232ad4-4439-434a-ad77-80f4fcb17c95` — 5 user corrections baked in.
> **Thought chain**: `b137d0c0-604e-40b3-9263-9500ef8b3f4c` (6/6 complete)

---

## 1. Executive Summary

**What**: Port the memory backend from Python `memini-ai-dev` (FastMCP, 53 tools, PostgreSQL on port 5434) into the Go `neuralgentics-backend` binary (JSON-RPC over stdio, port 6000). The Go backend already wraps memory, orchestrator, and broker subsystems as a single 26MB binary — the memory subsystem has ~90% feature parity with memini-ai-dev but is missing 8 tools across 4 features + 6 peer methods that exist in the Store interface but lack MemorySystem wrappers.

**Architecture**: `memini-ai-dev` (Python) is the PRECURSOR/PROTOTYPE. `neuralgentics` (Go) is the PRODUCTION TARGET. Features flow Python→Go. The Go binary already has 37/45+ memory features working — the port closes the remaining gap and swaps the database.

**Key numbers**:
- JSON-RPC methods in Go backend: **16** (3 lifecycle, 5 memory, 5 orchestrator, 3 broker)
- memini-ai-dev MCP tools: **53** (from `src/memini_ai/server.py` async methods)
- Go MemorySystem public methods: **37**
- Missing from Go: **8 tools** across 4 features + **6 peer methods** (Store has them, MemorySystem needs wrappers)
- DB port change: `5436` → `6000` external (podman `-p 6000:5432`), 5434 is UNTOUCHABLE

---

## 2. Corrected Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        OpenCode TUI (Bun)                             │
│  Agents (boomerang-architect, boomerang-coder, ...)                  │
│                                                                       │
│  Tools: neuralgentics_memory_*  ← same names, same params             │
│         neuralgentics_orchestrator_*                                   │
│         neuralgentics_broker_*                                        │
│         memini-ai-dev_*            ← eventually sunset, not now        │
└──────────────────┬───────────────────────────────────────────────────┘
                   │ stdio JSON-RPC (16 methods)
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Go Backend Binary (neuralgentics-backend, 26MB)          │
│              packages/backend-go/cmd/backend/main.go                  │
│                                                                       │
│   ┌─────────────┐  ┌───────────────┐  ┌───────────────────┐          │
│   │  memory/     │  │ orchestrator/ │  │    broker/        │          │
│   │  (37 methods)│  │  (5 handlers) │  │  (3 handlers)     │          │
│   │  +8 to add  │  │  Go-only      │  │  Go-only          │          │
│   └──────┬──────┘  └───────────────┘  └────────┬──────────┘          │
│          │                                      │                     │
│          │  ┌───────────────────────────────────┘                     │
│          │  │ lazy-demand tool exposure                              │
│          ▼  ▼                                                        │
│   ┌──────────────────────────────────────────┐                       │
│   │  memoryManager (registered as MCP server  │                       │
│   │  BUT in-process — no subprocess)          │                       │
│   │                                           │                       │
│   │  Initial tool set: 5 core memory tools    │                       │
│   │  On-demand expansion via broker catalog    │                       │
│   │  agent_tools table tracks exposure         │                       │
│   │  Known tools → direct handler path         │                       │
│   └──────────────────────────────────────────┘                       │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
    ┌─────────────────────────────────────────┐
    │  PostgreSQL :6000 (neuralgentics-test-pg) │
    │  podman: -p 6000:5432                     │
    │  sslmode=require, self-signed cert        │
    │                                           │
    │  5434 = PROD — NEVER TOUCH                │
    │  5436 = OLD DEV — deprecate after cutover │
    └─────────────────────────────────────────┘
```

**Key corrections from prior plan**:
1. DB port: 6000 external for neuralgentics. 5434 is untouchable. 5436 is transitional.
2. Tool names: `neuralgentics_*` stay. No switch to `memini-ai-dev_*`.
3. `packages/memini-core/`: Still exists at `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memini-core/` (80,918 LOC Python). Not deleted yet — user decision pending.
4. Python bugs (indexer/dialectic): future work. Go indexer + dialectic work → port those.
5. Tool exposure: LAZY/DEMAND-DRIVEN via MCP Broker. Agents start with 5 core tools, expand on demand.

---

## 3. Feature Inventory

### Legend
- ✅ = Implemented in Go (MemorySystem method exists)
- 🟡 = Store interface has it, MemorySystem facade missing
- ❌ = Not yet implemented in Go
- ⊘ = Intentionally excluded (architecture decision)

### Memory Core (6 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `add_memory` | `AddMemory()` | ✅ |
| `query_memories` | `QueryMemories()` | ✅ |
| (get by id) | `GetMemory()` | ✅ |
| (delete) | `DeleteMemory()` | ✅ |
| (count) | `CountMemories()` | ✅ |
| `get_status` | `GetStatus()` | ✅ |

### Trust Engine (4 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `get_trust_score` | `GetTrustScore()` | ✅ |
| `adjust_trust` | `AdjustTrust()` | ✅ |
| `list_archived` | `ListArchived()` | ✅ |
| `elevate_memory_to_1024` | N/A | ⊘ Intentionally excluded — user directive: no expand384To1024 |

### Decay Engine (4 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `get_decay_status` | `GetDecayStatus()` | ✅ |
| `adjust_decay_rate` | `AdjustDecayRate()` | ✅ |
| `trigger_consolidation` | `TriggerConsolidation()` | ✅ |
| `list_fading_memories` | `ListFadingMemories()` | ✅ |

### Knowledge Graph (7 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `extract_entities` | `ExtractEntities()` | ✅ |
| `query_kg` | `QueryKnowledgeGraph()` | ✅ |
| `search_entities` | `SearchEntities()` | ✅ |
| `get_entity_graph` | `GetEntityGraph()` + `RenderGraphHTML()` | ✅ |
| `get_inference_chain` | `GetEntityGraph()` with depth | ✅ |
| `get_graph_visualization` | `RenderGraphHTML()` | ✅ |
| `create_relationship` | `CreateEntityRelationship()` + `CreateRelationship()` | ✅ |

### Thought Chains (9 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `start_thought_chain` | `StartThoughtChain()` | ✅ |
| `add_thought` | `AddThought()` | ✅ |
| `get_thought_chain` | `GetThoughtChain()` | ✅ |
| `get_related_chains` | `GetRelatedThoughtChains()` | ✅ |
| `revise_thought` | `ReviseThought()` | ✅ |
| `branch_thought` | `BranchThought()` | ✅ |
| `pause_thought_chain` | `PauseThoughtChain()` | ✅ |
| `resume_thought_chain` | `ResumeThoughtChain()` | ✅ |
| `abandon_thought_chain` | `AbandonThoughtChain()` | ✅ |

### Dialectic (4 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `find_contradictions` | `FindContradictions()` | ✅ |
| `resolve_contradiction` | `ResolveContradiction()` | ✅ |
| `challenge_memory` | `ChallengeMemory()` | ✅ |
| `get_dialectic_history` | `GetDialecticHistory()` | ✅ |

### Relationships (3 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `find_related_memories` | `FindRelated` (via Store.GetRelationships) | ✅ |
| `create_relationship` | `CreateRelationship()` | ✅ |
| `get_relationship_summary` | `GetRelationshipSummary()` | ✅ |

### Audit (3 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `log_audit_event` | `LogAuditEvent()` | ✅ |
| `get_audit_log` | `GetAuditEvents()` | ✅ |
| `get_security_summary` | N/A | ❌ Missing |

### Peer/Multi-Peer (6 tools)
| memini-ai-dev tool | Go core.Store | MemorySystem wrapper? | Status |
|---|---|---|---|
| `list_peers` | `ListPeers()` | ❌ | 🟡 Store has it, needs MemorySystem method + JSON-RPC handler |
| `add_peer` | `AddPeer()` | ❌ | 🟡 |
| `switch_peer_context` | `UpdatePeerLastActive()` | ❌ | 🟡 |
| `share_memory` | `ShareMemory()` | ❌ | 🟡 |
| `get_peer_memories` | `GetPeerMemories()` | ❌ | 🟡 |
| `get_shared_memories` | `GetSharedMemories()` | ❌ | 🟡 |

### User Modeling (2 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `get_user_profile` | N/A | ❌ Missing |
| `update_user_profile` | N/A | ❌ Missing |

### Tiered Loading (2 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `get_tier0_summary` | N/A | ❌ Missing |
| `get_tier1_summary` | N/A | ❌ Missing |

### Project Indexer (3 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `search_project` | N/A (core.Indexer has Search) | ❌ Missing |
| `index_project` | N/A (core.Indexer has Index) | ❌ Missing |
| `get_file_contents` | N/A (core.Indexer + Store) | ❌ Missing |

### Auto-Extract (2 tools)
| memini-ai-dev tool | Go MemorySystem | Status |
|---|---|---|
| `trigger_extraction` | `ExtractEntities()` (reusable) | ✅ |
| `preconpress_extraction` | N/A | ❌ Missing (Python-specific pipeline) |

### Summary
| Category | Count |
|---|---|
| ✅ Fully implemented | 37 tools |
| 🟡 Store has it, needs MemorySystem facade + JSON-RPC wiring | 6 tools |
| ❌ Missing (4 features × 2-3 tools each) | 8 tools |
| ⊘ Intentionally excluded | 1 tool |
| ⊘ Out of scope (internal Python methods) | 3 tools |
| **Total memini-ai-dev tools mapped** | **~55** |

---

## 4. The 4 Missing Pieces

### 4.1 Peer/Multi-Peer Facade (`🟡` → `✅`)
**Scope**: 6 JSON-RPC methods to wire
**Why not ❌**: The `core.Store` interface already has all 6 methods (`ListPeers`, `AddPeer`, `ShareMemory`, `RevokeShareMemory`, `GetSharedMemories`, `GetPeerMemories` at `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memory/src/neuralgentics/memory/core/interfaces.go:51-60`). The PostgresStore implements them. What's missing: thin `MemorySystem` facade methods + JSON-RPC handler registration in `main.go`.
**Target files**:
1. `packages/memory/src/neuralgentics/memory/memory.go` — Add ~6 methods (lines ~416+, after existing methods)
2. `packages/backend-go/cmd/backend/main.go` — Add 6 new `case "memory.listPeers":` handlers (after line 291)
**LOC estimate**: ~120 lines (20 per method × 6)

### 4.2 Tiered Loading (❌)
**Scope**: 2 JSON-RPC methods: `memory.getTier0Summary`, `memory.getTier1Summary`
**Go equivalent**: `packages/memory/src/neuralgentics/memory/tiered/loader.go` exists and has the tiered cache, but there's no MemorySystem facade for summary generation.
**Target files**:
1. `packages/memory/src/neuralgentics/memory/memory.go` — Add `GetTier0Summary()` and `GetTier1Summary()` methods
2. `packages/memory/src/neuralgentics/memory/tiered/loader.go` — Review existing Loader for summary generation (may have it)
3. `packages/backend-go/cmd/backend/main.go` — 2 new handlers
**LOC estimate**: ~150 lines (loader logic + facade methods + handlers)

### 4.3 Project Indexer Facade (❌)
**Scope**: 3 JSON-RPC methods: `memory.searchProject`, `memory.indexProject`, `memory.getFileContents`
**Go equivalent**: `packages/memory/src/neuralgentics/memory/index/indexer.go` has `Indexer` struct with `Index()`, `Search()`, `Watch()`. Store has `AddProjectChunk()`, `SearchChunks()`, `GetFileChunksByPath()`. MemorySystem does NOT expose these.
**Target files**:
1. `packages/memory/src/neuralgentics/memory/memory.go` — Add `SearchProject()`, `IndexProject()`, `GetFileContents()` methods
2. `packages/backend-go/cmd/backend/main.go` — 3 new handlers
**LOC estimate**: ~200 lines (indexer wiring + facade + handlers)

### 4.4 User Modeling + Security Summary (❌)
**Scope**: 3 JSON-RPC methods: `memory.getUserProfile`, `memory.updateUserProfile`, `memory.getSecuritySummary`
**Go equivalent**: None yet. User profile requires LLM analysis of conversation history (has `llm/client.go`). Security summary queries audit log (`audit/logger.go` has event queries).
**Target files**:
1. `packages/memory/src/neuralgentics/memory/memory.go` — Add 3 facade methods
2. **NEW**: `packages/memory/src/neuralgentics/memory/user/profile.go` — User modeling engine (~100 LOC)
3. `packages/memory/src/neuralgentics/memory/audit/logger.go` — Add `GetSecuritySummary()` (~30 LOC)
4. `packages/backend-go/cmd/backend/main.go` — 3 new handlers
**LOC estimate**: ~250 lines (new file + audit method + facade + handlers)

### Total LOC for all 4 missing pieces: ~720 lines
**Impact**: After Phase 2, the Go binary covers 45 / 53 memini-ai-dev tools (85%). Remaining 8 are out-of-scope Python-specific (preconpress_extraction, _shutdown, _watch_stdio_eof, etc.)

---

## 5. The 5 Critical Infrastructure Pieces

### 5.1 Port 6000 — External-Facing Neuralgentics DB

**Design**: The podman container `neuralgentics-test-pg` currently maps `-p 5436:5432`. Change to `-p 6000:5432`. Internal container port 5432 stays the same. External port 6000 is visually distinct from 5434 (prod) and 5436 (legacy dev).

**No compose file** — container is run via `podman run` documented in `CONTEXT.md:73-80`.

**Files requiring port number update**:

| File | Line(s) | Current Value | New Value |
|---|---|---|---|
| `packages/memory/src/neuralgentics/memory/integration_dualwrite_test.go` | 21 | `localhost:5436` | `localhost:6000` |
| `packages/memory/src/neuralgentics/memory/integration_backend_jsonrpc_test.go` | 91 | `localhost:5436` | `localhost:6000` |
| `tests/smoke-test-mvp.sh` | 35 (local mode URL), 54 | `localhost:5436` | `localhost:6000` |
| `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` | 29 | `localhost:5436` | `localhost:6000` |
| `CONTEXT.md` | 39, 48, 63, 73-88, 210 (multiple references) | 5436 | 6000 |
| `TASKS.md` | 11, 12, 50, 63, 74, 94, 108, 136, 176 (multiple) | 5436 | 6000 |
| `Makefile` | 69, 101 | `:5436` | `:6000` |

**Change command** (single sed, no data loss):
```bash
# Stop old container
podman stop neuralgentics-test-pg
podman rm neuralgentics-test-pg

# Recreate with port 6000 (SAME volume → no data loss)
podman run -d --name neuralgentics-test-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=testpassword \
  -e POSTGRES_DB=neuralgentics_test \
  -v /home/jcharles/Projects/MCP-Servers/neuralgentics/certs:/certs-source:ro \
  -v /home/jcharles/Projects/MCP-Servers/neuralgentics/certs/initdb.d:/docker-entrypoint-initdb.d:ro \
  -p 6000:5432 \
  docker.io/pgvector/pgvector:pg17
```

**Verification**: `psql "postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require" -c "SELECT count(*) FROM memories;"` should return the pre-migration count.

**Goal**: Port 6000 is visually distinct from 5434 (prod, UNTOUCHABLE). No chance of confusion.

---

### 5.2 `packages/memini-core/` — KEEP or DELETE

**Full absolute path**: `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memini-core/`

**Current status**: 80,918 LOC Python. Marked `[LEGACY]` in `CONTEXT.md:64`. Not started by `neuralgentics start`. Was on delete list in prior architect report because it's redundant with memini-ai-dev.

**Evidence of size** (not 1,180 LOC as TASKS.md claimed):
```bash
$ find packages/memini-core -name '*.py' | xargs wc -l | tail -1
  80918 total
```

**RECOMMENDATION: DELETE in Phase 1 cleanup, BUT make it explicit user decision.**

**OPTION A — KEEP (status quo)**:
- Keep at `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memini-core/`
- Still not started by `neuralgentics start`
- Dead code that costs nothing to keep on disk
- Risk: someone tries to use it, wastes time debugging a legacy system

**OPTION B — DELETE (recommended, Phase 1 cleanup)**:
- Remove `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memini-core/` entirely
- Remove references from `CONTEXT.md:64`, `CONTEXT.md:106`, `scripts/serve.sh`, `neuralgentics` CLI
- Remove `localhost:8900` from health check docs
- Verify: `go build ./...` still passes (memini-core is Python, no Go imports)
- Risk: zero — it's not started, not referenced by any Go code or TypeScript code

**Decision required from user.** Neither option blocks the port plan — this is cleanup, not a dependency. Default to OPTION A (keep) for Phase 1, reconsider at cutover.

---

### 5.3 Python Indexer/Dialectic Bugs — Future Work

**User directive**: "Don't fix the Python indexer bug now. Go indexer works → port the Go code. Add Python indexer fix to task list as future work."

**Current state**:
- `memini-ai-dev_get_status` reports: `indexerReady=false`, `dialecticReady=false` (Session 16)
- Go indexer: `packages/memory/src/neuralgentics/memory/index/indexer.go` — has `Index()`, `Search()`, `Watch()`, tests pass (`go test -short`)
- Go dialectic: `packages/memory/src/neuralgentics/memory/dialectic/engine.go` — has `FindContradictions()`, `ResolveContradiction()`, `ChallengeMemory()`, `GetDialecticHistory()`, tests pass

**Plan**: Phase 2 adds Go MemorySystem facades for the indexer (Section 4.3) and the dialectic already works — these replace the broken Python equivalents. Python indexing/dialectic fixes go to backlog, zero urgency.

---

### 5.4 Lazy Tool Exposure via MCP Broker

**User directive**: "TOOL EXPOSURE IS A TOKEN PROBLEM — LAZY/DEMAND-DRIVEN. Agents start with a small initial set of tools. Tools exposed on demand as agent requests them. Track in postgres what each agent has requested → re-expose consistently."

**This is the most complex piece.** See Section 6 for full concrete design.

---

### 5.5 `neuralgentics_*` Naming Convention

**User directive**: "Tool names in neuralgentics codebase STAY `neuralgentics_*`. Non-negotiable. No switch to `memini-ai-dev_*` names."

**No discussion needed.** The overlay plugin already exposes tools as `neuralgentics_memory_add`, `neuralgentics_memory_query`, etc. via `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts`. These stay. The Go backend's JSON-RPC method names (`memory.add`, `memory.query`) are internal wire protocol — they don't change either. The mapping `neuralgentics_memory_add → memory.add` is handled by the overlay plugin.

---

## 6. Lazy Tool Exposure — Concrete Design

### 6.1 Architecture Overview

```
Agent (boomerang-coder)                        Go Backend
     │                                              │
     │  1. "I need to query memory"                  │
     │──────────────────────────────────────────────>│ broker.matchIntent("query memory")
     │                                              │     → returns: memory.query
     │  2. broker.call("memoryManager",              │
     │     "memory.query", {query:"..."})             │
     │──────────────────────────────────────────────>│ broker.Call(role, server, tool, args)
     │                                              │     → access check: OK for coder?
     │                                              │     → lookup agent_tools: already exposed?
     │                                              │     → proxy to MemorySystem.QueryMemories()
     │  3. result                                    │
     │<──────────────────────────────────────────────│
     │                                              │
     │  4. "I need adjust_decay_rate"                │
     │──────────────────────────────────────────────>│ broker.matchIntent("decay")
     │                                              │     → returns: memory.adjustDecayRate
     │  5. broker.call("memoryManager",              │
     │     "memory.adjustDecayRate", {...})           │
     │──────────────────────────────────────────────>│ → access: coder can't access "decay" role tools
     │                                              │ → returns error: "not accessible, available: [...]"
     │  6. Agent sees available list,                 │
     │     requests expansion:                        │
     │     broker.expandServer("memoryManager")       │
     │──────────────────────────────────────────────>│ → returns all 45+ tool names + descriptions
     │                                              │
     │  7. Agent explicitly requests access           │
     │     broker.call("memoryManager",               │
     │     "memory.adjustDecayRate", {...})           │
     │──────────────────────────────────────────────>│ → second attempt: tool IS accessible (access control
     │                                              │   allows explicit request)
     │                                              │ → INSERT INTO agent_tools (peer_id, tool_name)
     │                                              │ → proxy to MemorySystem.AdjustDecayRate()
     │  8. result                                    │
     │<──────────────────────────────────────────────│
     │                                              │
     │  9. Next time agent builds catalog:            │
     │     broker.buildCatalog("coder")               │
     │──────────────────────────────────────────────>│ → includes 5 core + adjustDecayRate = 6 tools
```

### 6.2 Postgres Schema: `agent_tools`

```sql
-- Migration: 000004_agent_tools.up.sql
CREATE TABLE IF NOT EXISTS agent_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    peer_id VARCHAR(255) NOT NULL,
    tool_name VARCHAR(255) NOT NULL,
    tool_server VARCHAR(255) NOT NULL DEFAULT 'memoryManager',
    exposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    call_count INTEGER NOT NULL DEFAULT 0,
    exposed_by VARCHAR(50) NOT NULL DEFAULT 'demand', -- 'demand' | 'manual' | 'role_default'
    UNIQUE(peer_id, tool_server, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_peer ON agent_tools(peer_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_server ON agent_tools(tool_server, tool_name);

COMMENT ON TABLE agent_tools IS 'Tracks which tools each agent/peer has been exposed to via lazy-demand expansion. Used by the broker catalog builder to include previously-requested tools in future catalog builds for the same agent.';
```

**Why unique on `(peer_id, tool_server, tool_name)`**: An agent can be exposed to the same tool name from different servers (e.g., `memory.query` from memoryManager vs. `memory.query` from a hypothetical second memory server). The triple key prevents duplicate tracking rows.

### 6.3 memoryManager Initial Tool Set

When the Go backend starts, it registers `memoryManager` as an in-process server with these **5 core tools** (every agent gets):

| Tool Name | Description | Access Level |
|---|---|---|
| `memory.add` | Add a memory entry | all |
| `memory.query` | Search memories | all |
| `memory.get` | Get memory by ID | all |
| `memory.adjustTrust` | Adjust trust score | all |
| `memory.getStatus` | Check memory system health | all |

**Role-specific defaults** (added at catalog build time, not tracked in agent_tools):

| Role | Extra Default Tools |
|---|---|
| `architect` | + `memory.extractEntities`, `memory.queryKG`, `memory.getTier1Summary`, `memory.searchEntities`, `memory.getEntityGraph` |
| `orchestrator` | + `memory.logAuditEvent`, `memory.getAuditLog`, `memory.getDecayStatus`, `memory.addPeer`, `memory.listPeers` |
| `coder` | (none beyond core 5) |
| `tester` | + `memory.findContradictions`, `memory.getRelatedChains` |

**The rest** (~35 tools) are discoverable via `expandServer("memoryManager")` and demand-driven. Once an agent calls one, it's tracked in `agent_tools` and included in future `buildCatalog()` calls for that agent.

### 6.4 Broker Flow — Concrete Steps

**Step 1 — Catalog Build**:
```go
func (b *Broker) BuildServerCatalog(role string) *catalog.ServerCatalog {
    // 1. Get base catalog (role-filtered servers)
    base := b.builder.Build(role)
    
    // 2. For the memoryManager server, check agent_tools for expanded tools
    if entry, ok := b.registry.Get("memoryManager"); ok {
        expandedTools := b.getDemandExpandedTools(role) // query agent_tools
        if len(expandedTools) > 0 {
            // Merge expanded tools into the memoryManager entry
            entry.Tools = append(baseMemoryTools, expandedTools...)
        }
    }
    
    return &base
}
```

**Step 2 — Tool Call with Demand Tracking**:
```go
func (b *Broker) Call(role, serverName, toolName string, args map[string]any) (map[string]any, error) {
    // 1. Access control check
    if !b.access.CanAccess(role, serverName) && !b.isDemandTool(role, serverName, toolName) {
        // First call for a non-role-default tool → record demand
        b.recordDemand(role, serverName, toolName) // INSERT into agent_tools
        // Allow the call through (demand-driven access)
    }
    
    // 2. If server is memoryManager → direct handler path (no serialization)
    if serverName == "memoryManager" {
        return b.handleMemoryToolDirect(role, toolName, args)
    }
    
    // 3. Otherwise → stdio proxy path (existing code)
    entry := b.registry.Get(serverName)
    return b.proxy.Call(serverName, "tools/call", params, entry.Stdin, entry.Stdout)
}
```

**Step 3 — Direct Handler Path** (bypasses broker serialization):
```go
// handleMemoryToolDirect routes memoryManager tool calls directly to
// the in-process MemorySystem, skipping JSON-RPC serialization entirely.
// This is the "known tool → direct socket" path — since memoryManager IS
// the Go process, there's no socket, just a method dispatch table.
func (b *Broker) handleMemoryToolDirect(role, toolName string, args map[string]any) (map[string]any, error) {
    switch toolName {
    case "memory.add":
        return b.memorySystem.AddMemory(args)
    case "memory.query":
        return b.memorySystem.QueryMemories(args)
    // ... 40+ more cases (auto-generated from tool registry)
    default:
        return nil, fmt.Errorf("unknown memory tool: %s", toolName)
    }
}
```

### 6.5 Known-Tool Direct Path

Since the memoryManager IS the Go process (not a subprocess), there's no need for JSON-RPC serialization on known tool calls. The broker's `Call()` method has a fast path for `serverName == "memoryManager"`:

```
broker.Call("memoryManager", "memory.query", args)
    │
    ├─ access check → PASS
    ├─ demand tracking → INSERT agent_tools if new for this peer
    └─ direct dispatch → MemorySystem.QueryMemories(args) [NO JSON-RPC, NO stdio]
```

For external MCP servers (like filesystem, GitHub), the existing proxy path over stdio stays.

---

## 7. 4-Phase Execution Plan

### Phase 1 — Wire JSON-RPC + Port 6000 (~2 hours, 1 boomerang-coder)

**Goal**: Change the DB port, add all JSON-RPC handlers for methods that already exist in Go but aren't wired.

**Tasks**:

| # | Task | File(s) | LOC |
|---|---|---|---|
| P1.1 | Recreate podman container on port 6000 | Shell command | — |
| P1.2 | Update 7 source files from 5436 → 6000 | See Section 5.1 table | ~15 |
| P1.3 | Add 6 peer JSON-RPC handlers to main.go | `packages/backend-go/cmd/backend/main.go` | ~120 |
| P1.4 | Add 6 peer MemorySystem facade methods | `packages/memory/src/neuralgentics/memory/memory.go` | ~80 |
| P1.5 | Rebuild binary + overlay | `make build` | — |
| P1.6 | Verify: `make test` (tests use new port) | All modules | — |
| P1.7 | Verify: `make smoke` (smoke test uses new port) | `tests/smoke-test-mvp.sh` | — |

**Quality gates**: `make lint && make test && make smoke`

### Phase 2 — Fill 4 Missing Features (~4 hours, 2 boomerang-coders in parallel)

**Goal**: Implement the 4 missing features (8 tools), add JSON-RPC handlers.

**Tasks** (all independent → run in parallel):

| # | Task | Coder | File(s) | LOC |
|---|---|---|---|---|
| P2.1 | Tiered loading facade + handlers | Coder A | `memory.go` + `tiered/loader.go` + `main.go` | ~150 |
| P2.2 | Indexer facade + handlers | Coder A | `memory.go` + `index/indexer.go` + `main.go` | ~200 |
| P2.3 | User modeling + security summary | Coder B | NEW `user/profile.go` + `audit/logger.go` + `memory.go` + `main.go` | ~250 |
| P2.4 | Add 11 new JSON-RPC request/response types | Coder B | `main.go` (params + response structs) | ~120 |

**Quality gates**: `make lint && make test && make build`

### Phase 3 — Lazy Tool Exposure Infrastructure (~4 hours, dedicated session)

**Goal**: Build the demand-driven tool catalog with Postgres tracking.

**Tasks**:

| # | Task | File(s) | LOC |
|---|---|---|---|
| P3.1 | Create `000004_agent_tools.up.sql` migration | `packages/memory/src/neuralgentics/memory/store/migrations/postgres/` | ~20 |
| P3.2 | Add `AgentToolStore` to PostgresStore | `store/postgres.go` | ~60 |
| P3.3 | Register memoryManager as in-process server | `broker-go/src/neuralgentics/broker/broker.go` | ~30 |
| P3.4 | Implement `getDemandExpandedTools()` | `broker-go/src/neuralgentics/broker/broker.go` | ~40 |
| P3.5 | Implement `recordDemand()` | `broker-go/src/neuralgentics/broker/broker.go` | ~30 |
| P3.6 | Implement `handleMemoryToolDirect()` dispatch | NEW `broker-go/src/neuralgentics/broker/memory_handler.go` | ~150 |
| P3.7 | Add `ExpandServer()` JSON-RPC handler to main.go | `packages/backend-go/cmd/backend/main.go` | ~30 |
| P3.8 | Wire broker into GoBackendClient (TS side) | `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` | ~20 |
| P3.9 | Integration test: demand-driven tool exposure | `broker-go/src/neuralgentics/broker/broker_integration_test.go` | ~100 |

**Quality gates**: `make lint && make test && make build`

### Phase 4 — Documentation (~1 hour, boomerang-writer)

**Tasks**:

| # | Task |
|---|---|
| P4.1 | Update `CONTEXT.md` — new architecture diagram, port 6000, lazy tool exposure |
| P4.2 | Update `TASKS.md` — mark Phase 1-3 complete, add Python backlog items |
| P4.3 | Create `docs/design/lazy-tool-exposure.md` — design doc from Section 6 |
| P4.4 | Update `HANDOFF.md` — Session 16+ entries |
| P4.5 | Update broker prompt template at `catalog/prompt.go` — include demand-driven instructions |

---

## 8. Cutover Path

**The actual switch from memini-ai-dev to neuralgentics:**

### Current State
- OpenCode agents use `memini-ai-dev_*` tools (51 tools exposed to all agents)
- Go backend runs but only exposes `neuralgentics_*` tools (16 tools)
- Both connect to different DBs: memini-ai-dev → 5434, neuralgentics → 5436/6000

### Cutover Steps (once Phase 3 is complete)

1. **Stop writing to memini-ai-dev's DB (5434)**:
   - Disable `memini-ai-dev` MCP server in `opencode.json`
   - Agents can no longer call `memini-ai-dev_*` tools

2. **Enable neuralgentics memory tools**:
   - `neuralgentics_memory_*` tools already exist in the overlay plugin
   - After Phase 3, the 5 core tools are exposed to all agents
   - Additional tools available on demand

3. **Migration window** (if user wants to preserve memini-ai-dev data):
   - Option A: `pg_dump` from 5434, selective `pg_restore` to 6000
   - Option B: Fresh start on 6000 (the Go memory system is the source of truth going forward)
   - **RECOMMENDATION: Option B** — memini-ai-dev's DB has 83+ memories from development sessions. These are development artifacts, not production data. The Go system's DB on 6000 already has test data from integration tests. Start clean.

4. **Verification checklist**:
   - [ ] `neuralgentics_memory_add` writes to port 6000
   - [ ] `neuralgentics_memory_query` returns results from port 6000
   - [ ] Agent can expand tools via `neuralgentics_broker_expandServer`
   - [ ] Agent's tool list includes previously-requested tools on next catalog build
   - [ ] `make smoke` passes against port 6000

5. **Sunset memini-ai-dev**: Remove from `opencode.json` MCP servers list after 1 session of verification.

---

## 9. Open Questions for User

1. **`packages/memini-core/` DELETE or KEEP?** (Section 5.2). 80,918 LOC Python. Not started, not referenced by Go/TS code. RECOMMEND: DELETE. But defer to user decision.

2. **Fresh start on port 6000 or migrate data from 5434?** The 5434 DB has 83+ dev memories. The 5436/6000 DB has test data. RECOMMEND: fresh start (6000 DB is the production target from this point forward).

3. **Role-based tool defaults** (Section 6.3): The proposed architect/orchestrator/coder defaults are reasonable but need user confirmation. Too many? Too few?

4. **Phase ordering**: Phase 1 (port + peer wiring) is non-controversial. Phase 2 (4 missing features) can run before Phase 3 (lazy exposure) or after. RECOMMEND: Phase 2 first (all tools exist before building the lazy layer on top).

5. **When to cut over from memini-ai-dev?** After Phase 3 (all tools + lazy exposure = production-ready). Phases 1-2 are prep; Phase 3 is the switch-flip.

---

## 10. Risks and Unknowns

| Risk | Severity | Mitigation |
|---|---|---|
| Port collision on 6000 | LOW | Check `ss -tlnp | grep 6000` before starting container. 6000 is uncommon. |
| Test breakage after port change | MEDIUM | All 7 files updated atomically in single commit. `make test` + `make smoke` verify. |
| Lazy tool exposure complexity | HIGH | Phase 3 is the biggest piece. broker-go already has catalog/proxy/access — reuse existing patterns. |
| Role defaults too restrictive | MEDIUM | Agents can request expansion. Defaults are a starting point, not a hard limit. |
| User modeling LLM cost | LOW | Same LLM client (`llm/client.go`) already used by knowledge graph extraction. Token cost is minimal for profile analysis. |
| Python indexer/dialectic bugs | LOW | Not blocking — Go equivalents work. Python fixes go to backlog. |
| `agent_tools` table bloat | LOW | 1 row per (peer, tool) pair. Even with 10 peers × 45 tools = 450 rows. Negligible. |
| Cutover breakage | MEDIUM | Keep memini-ai-dev running for 1 session of parallel verification before removing from opencode.json. |

---

## Appendix: File Index

### Files to CREATE
| File | LOC | Phase |
|---|---|---|
| `packages/memory/src/neuralgentics/memory/user/profile.go` | ~100 | P2 |
| `packages/memory/src/neuralgentics/memory/store/migrations/postgres/000004_agent_tools.up.sql` | ~20 | P3 |
| `packages/broker-go/src/neuralgentics/broker/memory_handler.go` | ~150 | P3 |
| `docs/design/lazy-tool-exposure.md` | ~200 | P4 |

### Files to MODIFY (ordered by phase)
| File | Changes | Phase | LOC delta |
|---|---|---|---|
| 7 files from Section 5.1 table | 5436 → 6000 | P1 | ~15 |
| `packages/memory/src/neuralgentics/memory/memory.go` | +6 peer methods | P1 | ~80 |
| `packages/backend-go/cmd/backend/main.go` | +6 peer handlers + structs | P1 | ~120 |
| `packages/memory/src/neuralgentics/memory/memory.go` | +8 missing feature methods | P2 | ~200 |
| `packages/memory/src/neuralgentics/memory/tiered/loader.go` | Summary generation | P2 | ~80 |
| `packages/memory/src/neuralgentics/memory/index/indexer.go` | Facade methods | P2 | ~60 |
| `packages/memory/src/neuralgentics/memory/audit/logger.go` | Security summary | P2 | ~30 |
| `packages/backend-go/cmd/backend/main.go` | +11 new handlers + structs | P2 | ~250 |
| `packages/memory/src/neuralgentics/memory/store/postgres.go` | AgentToolStore methods | P3 | ~60 |
| `packages/broker-go/src/neuralgentics/broker/broker.go` | Demand tracking + memoryManager registration | P3 | ~100 |
| `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` | Broker catalog methods | P3 | ~20 |
| `CONTEXT.md` | Architecture + port update | P4 | ~50 |
| `TASKS.md` | Status updates | P4 | ~30 |

### Files NEVER to touch
| File | Reason |
|---|---|
| `packages/orchestrator-go/` | Go-only, no memini-ai-dev equivalent |
| `packages/broker/` (Python broker) | Legacy, will deprecate naturally |
| `memini-ai-dev/` (entire directory) | Python precursor — operates independently |
| `certs/`, `patches/` | Infrastructure, unrelated |
| `.opencode/opencode.json` | OpenCode config that references memini-ai-dev — remove ONLY at cutover |

### Files for FUTURE deletion (not this plan)
| File | Reason | When |
|---|---|---|
| `/home/jcharles/Projects/MCP-Servers/neuralgentics/packages/memini-core/` | 80,918 LOC legacy Python | User decision → Phase 1 cleanup |
| Python gRPC sidecar scripts | memini-ai-dev handles embeddings in-process | After cutover |
| 5436 connection references | Deprecated after 6000 cutover | After Phase 1 verified |

---

**Plan complete. Ready for execution.**
**Estimated total: 11 hours (2h P1 + 4h P2 + 4h P3 + 1h P4)**
**Next step: boomerang dispatches Phase 1 to boomerang-coder.**
