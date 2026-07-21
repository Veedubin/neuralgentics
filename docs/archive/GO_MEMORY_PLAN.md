# Implementation Plan: Neuralgentics Memory System — Python → Go Rewrite

**Authority:** boomerang-architect  
**Date:** 2026-05-28  
**Status:** ✅ **APPROVED** (implementation starting Phase 1)  
**Supersedes:** Neuralgentics Architecture Plan V5 (memory section)  
**Sources analyzed:** memini-ai-dev (78 Python files, ~8,000-10,000 SLOC), neuralgentics/packages/memini-core, neuralgentics/packages/orchestrator, neuralgentics/docs/ARCHITECTURE_PLAN_V5.md

---

## 0. Executive Summary

**Recommendation:** Proceed with Option A (full Go monolith) with a **Python gRPC embedding microservice** as the only Python component. The Go memory module imports directly into the Go orchestrator binary — zero HTTP, zero MCP, zero JSON-RPC between orchestrator and memory.

**Why not pure Go embeddings:** The Go ML ecosystem lacks a production-grade equivalent to sentence-transformers MiniLM-L6-v2. ONNX Runtime Go bindings are immature; alternatives (spago, Gorgonia) cannot match MiniLM quality. The pragmatic path is a thin Python sidecar that does **only** `text → 384-dim vector`, communicating over gRPC with protobuf — sub-millisecond overhead, trivially containerized.

**Estimated effort:** 8-10 weeks for 2 senior Go developers. 5 parallelizable implementation phases.

---

## 1. Module Structure

### 1.1 Top-Level Layout

```
neuralgentics/
├── internal/
│   └── memory/                          # Go memory module (importable library)
│       ├── memory.go                    # Top-level facade: MemorySystem struct
│       ├── core/                        # Core types, interfaces, config
│       │   ├── types.go                 # MemoryEntry, SearchOptions, TrustSignal, etc.
│       │   ├── config.go                # Config struct with env var binding (envconfig)
│       │   └── interfaces.go            # Store, Embedder, LLMClient, Searcher interfaces
│       ├── store/                       # PostgreSQL/pgvector storage layer
│       │   ├── postgres.go              # pgx pool management, init, health
│       │   ├── queries.go               # All SQL query constants
│       │   ├── schema.go                # golang-migrate migrations
│       │   ├── memories.go              # Memory CRUD (add, get, delete, count)
│       │   ├── search.go                # Vector similarity (pgvector cosine distance)
│       │   ├── entities.go              # Entity CRUD (KG entities table)
│       │   ├── peers.go                 # Peer CRUD (peers table)
│       │   ├── relationships.go         # Memory relationships CRUD
│       │   ├── thoughts.go              # Thought chains CRUD (thought_chains + thoughts tables)
│       │   ├── audit.go                 # Audit log writes
│       │   └── vector.go                # pgvector type registration with pgx
│       ├── search/                      # Search logic
│       │   ├── vector.go                # Pure cosine vector search
│       │   ├── bm25.go                  # PostgreSQL full-text search (tsvector)
│       │   └── hybrid.go                # Reciprocal Rank Fusion (RRF)
│       ├── embed/                       # Embedding abstraction layer
│       │   ├── embedder.go              # Embedder interface: Embed(ctx, text) → []float64
│       │   ├── grpc.go                  # gRPC client to Python sidecar
│       │   ├── ollama.go                # Ollama Cloud fallback
│       │   └── noop.go                  # NoOp embedder for testing
│       ├── trust/                       # Trust engine
│       │   └── engine.go                # adjust_trust, get_trust_score, archive/promote
│       ├── graph/                       # Memory relationship graph
│       │   ├── relationships.go         # SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM
│       │   └── traversal.go             # BFS supersession chain traversal
│       ├── kg/                          # Knowledge graph
│       │   ├── entities.go              # Entity extraction (via LLM)
│       │   ├── queries.go               # KGQuery with transitive closure (BFS)
│       │   └── visualization.go         # D3.js HTML template rendering
│       ├── tiered/                      # Tiered loading (L0/L1/L2)
│       │   ├── loader.go                # L0 (~100 tokens), L1 (~2K tokens)
│       │   └── cache.go                 # In-memory cache with TTL
│       ├── decay/                       # Memory decay + consolidation
│       │   ├── engine.go                # Exponential decay with half-life
│       │   ├── scheduler.go             # Background decay goroutine
│       │   └── consolidate.go           # Similarity-based consolidation
│       ├── peer/                        # Multi-peer support
│       │   ├── profiles.go              # Peer CRUD, role management
│       │   ├── sharing.go               # Memory sharing with permissions
│       │   └── context.go               # Peer context switching
│       ├── dialectic/                   # Dialectic contradiction resolution
│       │   ├── engine.go                # Find/resolve contradictions
│       │   ├── arguments.go             # LLM-based pro/con argument generation
│       │   └── challenge.go             # Challenge/response workflow
│       ├── thought/                     # Thought chains
│       │   ├── chains.go                # CRUD: add_thought, get_chain, revise, branch
│       │   └── memory_bridge.go         # Dual storage: thoughts + memories tables
│       ├── index/                       # Project file indexer
│       │   ├── indexer.go               # Main indexer orchestrator
│       │   ├── chunker.go               # Semantic chunking (line-based + AST-aware)
│       │   ├── watcher.go               # fsnotify-based file watcher
│       │   ├── snapshot.go              # Snapshot management
│       │   └── tracker.go               # FileTracker (hash-based change detection)
│       └── audit/                       # Audit logging
│           └── logger.go                # Structured audit log writes
├── cmd/
│   └── embedding-sidecar/               # Python gRPC embedding microservice
│       ├── main.py                      # Entry point
│       ├── server.py                    # gRPC server (grpcio)
│       ├── embed.py                     # sentence-transformers wrapper
│       ├── health.py                    # Health check endpoint
│       ├── requirements.txt            # sentence-transformers, grpcio, grpcio-health
│       └── Dockerfile                   # Container definition
├── proto/
│   └── embedding/
│       └── v1/
│           └── embedding.proto          # gRPC service definition
├── migrations/
│   └── postgres/
│       ├── 000001_initial_schema.up.sql  # All 11 tables + extensions + indexes
│       └── 000001_initial_schema.down.sql
└── go.mod
```

### 1.2 Package Dependency Graph

```
memory.go (facade)
├── core/types.go          ← depends on: nothing
├── core/config.go         ← depends on: core/types
├── core/interfaces.go     ← depends on: core/types
├── store/postgres.go      ← depends on: core/types, core/config
├── search/*               ← depends on: core/types, store/postgres
├── embed/grpc.go          ← depends on: core/interfaces, proto
├── trust/engine.go        ← depends on: core/types, store/postgres, audit
├── graph/*                ← depends on: core/types, store/postgres
├── kg/*                   ← depends on: core/types, store/postgres, embed
├── tiered/loader.go       ← depends on: core/types, store/postgres, core/interfaces (LLM)
├── decay/*                ← depends on: core/types, store/postgres
├── peer/*                 ← depends on: core/types, store/postgres
├── dialectic/*            ← depends on: core/types, store/postgres, core/interfaces (LLM)
├── thought/*              ← depends on: core/types, store/postgres, embed
├── index/*                ← depends on: core/types, store/postgres, embed
└── audit/logger.go        ← depends on: core/types, store/postgres
```

**Key design principle:** All subsystems depend on `core/interfaces.go` (Store, Embedder, LLMClient) — never on concrete implementations. This enables:
1. Testing with mock stores and embedders
2. Swapping embedding backends without touching business logic
3. Running subsystems independently

---

## 2. Driver Choice: pgx vs lib/pq

### 2.1 Recommendation: pgx (jackc/pgx v5)

| Criterion                    | pgx                                        | lib/pq                              | Winner |
| ---------------------------- | ------------------------------------------ | ----------------------------------- | ------ |
| Native PostgreSQL protocol   | Yes (no CGO)                               | Yes (no CGO)                        | Tie    |
| Connection pooling           | Built-in (`pgxpool`)                       | External (`sql.DB` pool)            | pgx    |
| pgvector type binding        | Custom type registration via `pgtype`      | Requires manual array serialization | pgx    |
| Prepared statement caching   | Automatic                                  | Via `sql.DB` (less control)         | pgx    |
| Bulk copy (COPY protocol)    | Native support                             | Requires `pq.CopyIn`                | pgx    |
| Goroutine-safe               | Yes                                        | Yes                                 | Tie    |
| Streaming results            | Server-side cursors                        | Via `sql.Rows`                      | Tie    |
| Error handling               | Structured `*pgconn.PgError`                 | Generic string errors               | pgx    |
| JSONB support                | Native `json` encoding                     | Manual marshal/unmarshal            | pgx    |
| Ecosystem maturity           | 10K+ GitHub stars, active                  | 9K+ stars, maintenance mode         | pgx    |
| Performance                  | 2-5x faster for bulk ops                   | Adequate                            | pgx    |

### 2.2 pgvector Integration Strategy

Go has **no direct pgvector Go library**. Strategy:

```go
// store/vector.go — pgvector type registration with pgx

// pgx automatically handles []float64 → PostgreSQL float8[]
// For queries, explicit cast: $1::vector
// For inserts, bind []float64 and cast in SQL: VALUES ($1::vector)
func registerVectorTypes(conn *pgx.Conn) error {
    // No special registration needed — pgx handles arrays natively.
    // The vector type accepts array input with explicit cast.
    return nil
}
```

**For vectorscale (StreamingDiskANN):** No Go changes needed — DiskANN is entirely server-side. Go code sends the same queries; PostgreSQL/vectorscale handles index selection internally.

---

## 3. Embedding Decision

### 3.1 Recommendation: Python gRPC Embedding Microservice

### 3.2 Trade-Offs Table

| Option                 | Latency             | Quality                 | Complexity                                     | Risk                                | Verdict            |
| ---------------------- | ------------------- | ----------------------- | ---------------------------------------------- | ----------------------------------- | ------------------ |
| 1. ONNX Runtime Go     | <1ms (in-process)   | Unknown                 | HIGH — bindings immature, model export fragile | HIGH — production failures likely   | REJECTED        |
| 2. Python gRPC sidecar | ~2-5ms (gRPC)       | Identical to current    | MEDIUM — thin sidecar, simple proto            | LOW — battle-tested code            | **RECOMMENDED**     |
| 3. Ollama Cloud API    | ~50-200ms (network) | Different model         | LOW                                            | MEDIUM — latency, cost, rate limits | REJECTED (core) |
| 4. Go ML libraries     | <1ms (in-process)   | Unknown/poor            | HIGH — immature ecosystem                      | HIGH — quality unknown              | REJECTED        |

### 3.3 gRPC Microservice Design

```protobuf
// proto/embedding/v1/embedding.proto

service EmbeddingService {
    rpc Embed(EmbedRequest) returns (EmbedResponse);
    rpc EmbedBatch(stream EmbedRequest) returns (stream EmbedResponse);
    rpc Health(HealthRequest) returns (HealthResponse);
}

message EmbedRequest {
    string text = 1;
    string model = 2;
}

message EmbedResponse {
    repeated float vector = 1;
    int32 dimensions = 2;
    string model = 3;
    int64 latency_us = 4;
}
```

**Go embedder interface:**

```go
type Embedder interface {
    Embed(ctx context.Context, text string) ([]float64, error)
    EmbedBatch(ctx context.Context, texts []string) ([][]float64, error)
    Health(ctx context.Context) error
    Close() error
}
```

### 3.4 Operational Model

- Python sidecar runs as a **child process** of the Go orchestrator binary (managed via `os/exec`)
- gRPC on Unix domain socket (`/tmp/neuralgentics-embed.sock`) for zero network overhead
- Auto-restart on crash with exponential backoff
- Graceful shutdown: Go sends SIGTERM, Python drains in-flight requests
- Memory pool: Python process stays resident; no cold start after initial load
- Containerized: Dockerfile with `python:3.12-slim` + `sentence-transformers` (~500MB image)

---

## 4. Schema Strategy

### 4.1 Recommendation: golang-migrate with existing SQL

### 4.2 Rationale

| Approach         | Pros                                                           | Cons                               | Verdict        |
| ---------------- | -------------------------------------------------------------- | ---------------------------------- | -------------- |
| golang-migrate   | Battle-tested, simple SQL files, embedded migrations, CLI tool | No ORM features (not needed)       | RECOMMENDED |
| Go-native (GORM) | Auto-migration, Go structs → SQL                               | Loss of control, hidden behavior   | REJECTED    |
| Manual SQL       | Full control                                                   | No version tracking                  | REJECTED    |
| atlas/ariga      | Declarative, diff-based                                        | Newer tool, less community         | Alternative |

### 4.3 Migration File

The `.up.sql` file is a **direct port** of `memini-ai-dev/src/memini_ai/postgres/schema.py` (~463 lines). All 11 tables, all indexes, all CHECK constraints preserved. No structural changes.

### 4.4 Schema Guarantees

- Same table names, column names, data types, CHECK constraints
- Same vector(384) dimension for MiniLM-L6-v2
- Same DiskANN/HNSW index selection logic
- Backward compatible with existing neuralgentics PostgreSQL database

### 4.5 Go Migration Code

```go
import (
    "embed"
    "github.com/golang-migrate/migrate/v4"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed migrations/postgres/*.sql
var migrationsFS embed.FS

func RunMigrations(dbURL string) error {
    source, err := iofs.New(migrationsFS, "migrations/postgres")
    m, err := migrate.NewWithSourceInstance("iofs", source, dbURL)
    return m.Up()
}
```

---

## 5. API Design

### 5.1 Go Public Interface (Top-Level Facade)

The orchestrator imports this directly:

```go
import "neuralgentics/internal/memory"

mem, err := memory.New(ctx, memory.Config{
    DatabaseURL:    "postgresql://localhost:5434/neuralgentics",
    EmbeddingAddr: "unix:///tmp/neuralgentics-embed.sock",
    LLMBaseURL:     "http://localhost:8903/v1",
})

// Foundation
results, err := mem.QueryMemories(ctx, "search query", nil)
id, err := mem.AddMemory(ctx, memory.MemoryEntry{Content: "dark mode", SourceType: "session"})

// Trust Engine
adj, err := mem.AdjustTrust(ctx, memoryID, memory.SignalAgentUsed)

// Knowledge Graph
entities, err := mem.ExecuteKGQuery(ctx, memory.KGQuery{EntityA: "boomerang-v3", InferenceDepth: 2})
```

### 5.2 Complete API Surface (35+ Operations)

| Category         | Operation                  | Go Method                                                      |
| ---------------- | -------------------------- | -------------------------------------------------------------- |
| **Foundation**       | `query_memories`             | `QueryMemories(ctx, query string, opts *SearchOptions) []MemoryEntry` |
|                  | `add_memory`                 | `AddMemory(ctx, entry MemoryEntry) string`                       |
|                  | `search_project`             | `SearchProject(ctx, query string, opts *SearchProjectOptions) []ChunkResult` |
|                  | `index_project`              | `IndexProject(ctx, path string, opts *IndexOptions) string`      |
|                  | `get_file_contents`          | `GetFileContents(ctx, filePath string) *FileContentsResult`      |
|                  | `get_status`                 | `GetStatus(ctx) *StatusResult`                                   |
| **Trust Engine**     | `get_trust_score`            | `GetTrustScore(ctx, memoryID string) *TrustResult`               |
|                  | `adjust_trust`               | `AdjustTrust(ctx, memoryID string, signal TrustSignal) *TrustAdjustment` |
|                  | `list_archived`              | `ListArchived(ctx, limit int) []MemoryEntry`                     |
| **Memory Graph**     | `find_related_memories`      | `FindRelatedMemories(ctx, memoryID, relType string, limit int) []MemoryEntry` |
|                  | `create_relationship`        | `CreateRelationship(ctx, sourceID, targetID, relType string, confidence float64) error` |
|                  | `get_relationship_summary`   | `GetRelationshipSummary(ctx, memoryID string) *RelationshipSummary` |
| **Tiered Loading**   | `get_tier0_summary`          | `GetTier0Summary(ctx, forceRefresh bool) *Summary`               |
|                  | `get_tier1_summary`          | `GetTier1Summary(ctx, forceRefresh bool) *Summary`               |
|                  | `trigger_extraction`         | `TriggerExtraction(ctx, conversation string) *ExtractionResult`    |
|                  | `precompress_extraction`     | `PrecompressExtraction(ctx, contextContent string) *PrecompressResult` |
| **Knowledge Graph**  | `query_kg`                   | `ExecuteKGQuery(ctx, query KGQuery) *KGResult`                   |
|                  | `extract_entities`           | `ExtractEntities(ctx, memoryID string) []Entity`                 |
|                  | `get_entity_graph`           | `GetEntityGraph(ctx, entityID string, depth int) *EntityGraph`   |
|                  | `get_inference_chain`        | `GetInferenceChain(ctx, startEntity, endEntity string, maxDepth int) *InferenceChain` |
|                  | `search_entities`            | `SearchEntities(ctx, name string, limit int) []Entity`           |
|                  | `get_graph_visualization`    | `GetGraphVisualization(ctx, limit int) string`                  |
| **Decay**            | `get_decay_status`           | `GetDecayStatus(ctx) *DecayStatus`                                 |
|                  | `trigger_consolidation`      | `TriggerConsolidation(ctx, force bool) *ConsolidationStats`      |
|                  | `list_fading_memories`       | `ListFadingMemories(ctx, limit int) []MemoryEntry`               |
|                  | `adjust_decay_rate`          | `AdjustDecayRate(ctx, memoryID string, rate float64) error`     |
| **Multi-Peer**       | `list_peers`                 | `ListPeers(ctx) []PeerProfile`                                   |
|                  | `add_peer`                   | `AddPeer(ctx, peer PeerProfile) error`                           |
|                  | `switch_peer_context`        | `SwitchPeerContext(ctx, peerID string) error`                    |
|                  | `share_memory`               | `ShareMemory(ctx, memoryID, targetPeerID, permission string) error` |
|                  | `get_peer_memories`          | `GetPeerMemories(ctx, peerID, query string, limit int) []MemoryEntry` |
|                  | `get_shared_memories`        | `GetSharedMemories(ctx, limit int) []MemoryEntry`                |
| **Dialectic**        | `find_contradictions`        | `FindContradictions(ctx, query string, limit int) []Contradiction` |
|                  | `resolve_contradiction`      | `ResolveContradiction(ctx, memoryIDA, memoryIDB string) *Resolution` |
|                  | `get_dialectic_history`      | `GetDialecticHistory(ctx, memoryID string) []DialecticEvent`     |
|                  | `challenge_memory`           | `ChallengeMemory(ctx, memoryID, challengeText string) *ChallengeResult` |
| **Thought Chains**   | `add_thought`                | `AddThought(ctx, thought ThoughtInput) *Thought`                  |
|                  | `start_thought_chain`        | `StartThoughtChain(ctx, sessionID string) *ThoughtChain`         |
|                  | `get_thought_chain`          | `GetThoughtChain(ctx, chainID string) *ChainWithThoughts`         |
|                  | `get_related_chains`         | `GetRelatedChains(ctx, query string, limit int) []ThoughtChain` |
|                  | `revise_thought`             | `ReviseThought(ctx, chainID string, thoughtNumber int, revisedText string) *Thought` |
|                  | `branch_thought`             | `BranchThought(ctx, chainID string, fromThoughtNumber int, branchID, text string) *Thought` |
|                  | `pause/resume/abandon`       | `PauseThoughtChain`, `ResumeThoughtChain`, `AbandonThoughtChain` |

### 5.3 Key Type Definitions

```go
// core/types.go

type MemoryEntry struct {
    ID               string
    Content          string
    Vector           []float64
    SourceType       string         // session, file, web, boomerang, project, thought
    SourcePath       string
    ContentHash      string
    TrustScore       float64        // 0.0 - 1.0
    RetrievalCount   int
    IsArchived       bool
    LastAccessedAt   *time.Time
    PeerID           string
    Metadata         map[string]any
    Score            *float64        // search relevance
    SupersedesID     string
    StructuredFields map[string]any
    ChangeRatio      float64
    CreatedAtMs      int64
    Relationships    []Relationship
}

type SearchOptions struct {
    TopK        int          // default 10
    Threshold   float64      // default 0.7
    Strategy    string       // tiered, vector_only, text_only, parallel
    ExactSearch bool         // disable DiskANN
}

type TrustSignal string
const (
    SignalAgentUsed     TrustSignal = "agent_used"      // +0.05
    SignalAgentIgnored  TrustSignal = "agent_ignored"    // -0.05
    SignalUserConfirmed TrustSignal = "user_confirmed"   // +0.10
    SignalUserCorrected TrustSignal = "user_corrected"   // -0.10
)
```

---

## 6. Implementation Phases

### 6.1 Phase Overview

| Phase                              | Duration | Dependencies | Parallel Work                             |
| ---------------------------------- | -------- | ------------ | ----------------------------------------- |
| **Phase 1: Foundation**                | 2 weeks  | None         | —                                         |
| **Phase 2: Core Subsystems**           | 2 weeks  | Phase 1      | Trust, Graph, Decay, Audit (all parallel) |
| **Phase 3: Advanced Subsystems**       | 2 weeks  | Phase 1-2    | KG, Tiered, Peer, Index (all parallel)    |
| **Phase 4: Complex Subsystems**        | 2 weeks  | Phase 1-3    | Thought + Dialectic (parallel)            |
| **Phase 5: Integration + Migration**   | 2 weeks  | Phase 1-4    | —                                         |
| **Total**                              | **10 weeks** |          |                                           |

### 6.2 Phase 1: Foundation (Weeks 1-2)

**Goal:** Working memory CRUD with vector search and embeddings.

| Task                                                              | Engineer | Files            |
| ----------------------------------------------------------------- | -------- | ---------------- |
| 1.1 Initialize Go module + project structure                      | Eng A    | `go.mod`, all dirs |
| 1.2 Implement `core/types.go`, `core/config.go`, `core/interfaces.go`   | Eng A    | 3 files          |
| 1.3 Implement `store/postgres.go` (pgx pool, init, health)          | Eng B    | 1 file           |
| 1.4 Port SQL schema to `migrations/`                                | Eng B    | 2 files          |
| 1.5 Implement `store/memories.go` (CRUD)                            | Eng B    | 1 file           |
| 1.6 Implement `store/search.go` (vector similarity)                 | Eng B    | 1 file           |
| 1.7 Implement `store/vector.go` (pgvector type registration)        | Eng B    | 1 file           |
| 1.8 Implement `embed/embedder.go` (interface) + `embed/grpc.go`       | Eng A    | 2 files          |
| 1.9 Implement `embed/noop.go` (for testing)                         | Eng A    | 1 file           |
| 1.10 Create Python gRPC sidecar (`cmd/embedding-sidecar/`)          | Eng A    | 5 files          |
| 1.11 Create `proto/embedding/v1/embedding.proto`                    | Eng A    | 1 file           |
| 1.12 Generate Go protobuf code                                    | Eng A    | `go generate`      |
| 1.13 Implement `search/vector.go`, `search/bm25.go`, `search/hybrid.go` | Eng B    | 3 files          |
| 1.14 Implement `memory.go` (top-level facade, Phase 1 methods only) | Eng A    | 1 file           |
| 1.15 Write Phase 1 test suite                                     | Both     | `*_test.go` files  |

**Milestone:** `QueryMemories`, `AddMemory`, `GetStatus` working end-to-end against real PostgreSQL with gRPC embeddings.

### 6.3 Phase 2: Core Subsystems (Weeks 3-4) — ALL PARALLEL

**Goal:** Trust engine, memory graph, decay, audit logging.

| Task                                                                                      | Engineer | Files           |
| ----------------------------------------------------------------------------------------- | -------- | --------------- |
| 2.1 Implement `trust/engine.go` (adjust_trust, get_trust_score, archive/promote thresholds) | Eng A    | 1 file          |
| 2.2 Implement `graph/relationships.go` (SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM)  | Eng B    | 1 file          |
| 2.3 Implement `graph/traversal.go` (BFS supersession chain)                                 | Eng B    | 1 file          |
| 2.4 Implement `decay/engine.go` (exponential decay with half-life)                          | Eng A    | 1 file          |
| 2.5 Implement `decay/scheduler.go` (background goroutine, configurable interval)             | Eng A    | 1 file          |
| 2.6 Implement `decay/consolidate.go` (similarity-based consolidation)                       | Eng B    | 1 file          |
| 2.7 Implement `audit/logger.go` (structured audit log writes)                               | Eng B    | 1 file          |
| 2.8 Implement `store/relationships.go` (relationship CRUD)                                  | Eng B    | 1 file          |
| 2.9 Implement `store/audit.go` (audit log CRUD)                                             | Eng B    | 1 file          |
| 2.10 Wire Phase 2 subsystems into `memory.go` facade                                        | Eng A    | 1 file          |
| 2.11 Write Phase 2 test suite                                                             | Both     | `*_test.go` files |

**Milestone:** All trust operations, relationship traversal, decay ticking, audit logging functional.

### 6.4 Phase 3: Advanced Subsystems (Weeks 5-6) — ALL PARALLEL

**Goal:** Knowledge graph, tiered loading, multi-peer, project indexer.

| Task                                                              | Engineer | Files           |
| ----------------------------------------------------------------- | -------- | --------------- |
| 3.1 Implement `kg/entities.go` (entity extraction via LLM)          | Eng A    | 1 file          |
| 3.2 Implement `kg/queries.go` (KGQuery, transitive closure BFS)     | Eng A    | 1 file          |
| 3.3 Implement `kg/visualization.go` (D3.js HTML template)           | Eng B    | 1 file          |
| 3.4 Implement `store/entities.go` (entity CRUD in PostgreSQL)       | Eng B    | 1 file          |
| 3.5 Implement `tiered/loader.go` (L0/L1 summary generation via LLM) | Eng A    | 1 file          |
| 3.6 Implement `tiered/cache.go` (in-memory TTL cache for summaries) | Eng A    | 1 file          |
| 3.7 Implement `peer/profiles.go` (peer CRUD, role management)       | Eng B    | 1 file          |
| 3.8 Implement `peer/sharing.go` (memory sharing with permissions)   | Eng B    | 1 file          |
| 3.9 Implement `peer/context.go` (peer context switching)            | Eng B    | 1 file          |
| 3.10 Implement `store/peers.go` (peer CRUD in PostgreSQL)           | Eng B    | 1 file          |
| 3.11 Implement `index/indexer.go` (main indexer orchestrator)       | Eng A    | 1 file          |
| 3.12 Implement `index/chunker.go` (semantic chunking)               | Eng B    | 1 file          |
| 3.13 Implement `index/watcher.go` (fsnotify file watcher)           | Eng B    | 1 file          |
| 3.14 Implement `index/snapshot.go` + `index/tracker.go`               | Eng B    | 2 files         |
| 3.15 Wire Phase 3 subsystems into `memory.go` facade                | Eng A    | 1 file          |
| 3.16 Write Phase 3 test suite                                     | Both     | `*_test.go` files |

**Milestone:** Full knowledge graph, tiered summaries, multi-peer sharing, project file search working.

### 6.5 Phase 4: Complex Subsystems (Weeks 7-8) — PARALLEL

**Goal:** Thought chains and dialectic engine.

| Task                                                                       | Engineer | Files           |
| -------------------------------------------------------------------------- | -------- | --------------- |
| 4.1 Implement `thought/chains.go` (CRUD for thought chains)                  | Eng A    | 1 file          |
| 4.2 Implement `thought/memory_bridge.go` (dual storage: thoughts + memories) | Eng A    | 1 file          |
| 4.3 Implement `store/thoughts.go` (thought chain/thought CRUD in PostgreSQL) | Eng A    | 1 file          |
| 4.4 Implement `dialectic/engine.go` (contradiction detection)                | Eng B    | 1 file          |
| 4.5 Implement `dialectic/arguments.go` (LLM-based pro/con arguments)         | Eng B    | 1 file          |
| 4.6 Implement `dialectic/challenge.go` (challenge/response workflow)         | Eng B    | 1 file          |
| 4.7 Implement `dialectic/resolution.go` (resolution synthesis)               | Eng B    | 1 file          |
| 4.8 Wire Phase 4 subsystems into `memory.go` facade                          | Eng A    | 1 file          |
| 4.9 Write Phase 4 test suite                                               | Both     | `*_test.go` files |

**Milestone:** Full thought chain CRUD with branching/revision, dialectic contradiction resolution working.

### 6.6 Phase 5: Integration + Migration (Weeks 9-10)

**Goal:** Production readiness, migration tooling, orchestrator integration.

| Task                                                                                 | Engineer |
| ------------------------------------------------------------------------------------ | -------- |
| 5.1 Write `cmd/migrate/main.go` — CLI tool for data migration from Python memini-core  | Eng A    |
| 5.2 Implement data integrity verification (counts, sample checks, vector dimension)  | Eng B    |
| 5.3 Performance benchmarking (pgvector search latency, batch insert throughput)      | Eng B    |
| 5.4 Write integration test: Go memory ↔ real PostgreSQL (testcontainers-go)          | Both     |
| 5.5 Write integration test: Go memory ↔ gRPC sidecar (real sentence-transformers)    | Both     |
| 5.6 Wire Go memory into Go orchestrator (`import "neuralgentics/internal/memory"`)     | Eng A    |
| 5.7 End-to-end test: orchestrator → memory → PostgreSQL → search result              | Both     |
| 5.8 Performance tuning (connection pooling, prepared statement caching, batch sizes) | Eng B    |
| 5.9 Documentation: README, architecture docs, API reference                          | Eng A    |
| 5.10 Deprecation plan for Python memini-core                                         | Both     |

**Milestone:** Production-ready. Python memini-core can be shut down. Orchestrator imports `neuralgentics/internal/memory` directly.

---

## 7. Testing Strategy

### 7.1 Test Pyramid

- **E2E (5%):** Full orchestrator → memory → PostgreSQL → embedding
- **Integration (15%):** Go + real PostgreSQL via testcontainers-go
- **Unit (80%):** Mock store + embedder per subsystem

### 7.2 Unit Testing

Every subsystem tested with mock `Store` and mock `Embedder` via `core/interfaces.go`.

| Subsystem              | What to test                                           |
| ---------------------- | ------------------------------------------------------ |
| `trust/engine.go`        | All 4 trust signals, clamp, archive/promote thresholds |
| `graph/relationships.go` | Create, traverse, BFS chain depth limits               |
| `decay/engine.go`        | Exponential decay math, half-life calculation          |
| `decay/consolidate.go`   | Similarity threshold, merge logic                      |
| `kg/queries.go`          | Transitive closure BFS, depth limits, cycle detection  |
| `tiered/loader.go`       | L0/L1 prompt construction, caching TTL                 |
| `peer/sharing.go`        | Permission checks, sharing/unsharing                   |
| `thought/chains.go`      | Branch creation, revision, dual storage                |
| `dialectic/engine.go`    | Contradiction detection, argument generation           |

### 7.3 Integration Testing with testcontainers-go

```go
func TestIntegration_SearchVector(t *testing.T) {
    ctx := context.Background()
    pgContainer, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image: "pgvector/pgvector:pg16",
            Env:   map[string]string{"POSTGRES_PASSWORD": "test"},
            WaitingFor: wait.ForListeningPort("5432/tcp"),
        },
        Started: true,
    })
    require.NoError(t, err)
    defer pgContainer.Terminate(ctx)

    connStr, _ := pgContainer.ConnectionString(ctx, "sslmode=disable")
    mem, err := memory.New(ctx, memory.Config{
        DatabaseURL: connStr,
        EmbeddingAddr: "noop://",
    })
    require.NoError(t, err)

    id, err := mem.AddMemory(ctx, memory.MemoryEntry{
        Content: "test memory",
        Vector:  make([]float64, 384),
    })
    require.NoError(t, err)

    results, err := mem.QueryMemories(ctx, "test", nil)
    require.NoError(t, err)
    assert.Len(t, results, 1)
    assert.Equal(t, id, results[0].ID)
}
```

---

## 8. Migration Path

### 8.1 Zero-Downtime Migration

```
Phase 1: Dual-write (Week 1-2 of Phase 5)
  ┌──────────────┐     ┌──────────────┐
  │ Orchestrator │────▶│ Python Core  │────▶ PostgreSQL
  │   (TS)       │     │  (port 8900) │
  └──────────────┘     └──────────────┘

Phase 2: Shadow read (Week 3-4 of Phase 5)
  ┌──────────────┐     ┌──────────────┐
  │ Orchestrator │────▶│  Go Memory   │────▶ PostgreSQL (same DB!)
  │   (Go)       │     │  (library)   │
  └──────────────┘     └──────────────┘

Phase 3: Cutover (Week 5)
  ┌──────────────┐     ┌──────────────┐
  │ Orchestrator │────▶│  Go Memory   │────▶ PostgreSQL
  │   (Go)       │     │  (library)   │
  └──────────────┘     └──────────────┘
  Python memini-core: SHUT DOWN
```

### 8.2 Key Insight

The Go module uses the **same PostgreSQL schema** — same tables, same columns, same vector(384) dimensions. **No data migration needed.** Go reads/writes to the same tables Python uses.

### 8.3 Rollback Plan

Stop Go orchestrator → Start Python memini-core on :8900 (same database) → Point orchestrator back to HTTP `localhost:8900`. No data loss.

### 8.4 Cutover Checklist

- [ ] Schema verification: Go migrations produce identical tables to Python
- [ ] Vector dimension check: all rows have 384-dim vectors
- [ ] Trust score range check: all scores in [0.0, 1.0]
- [ ] Relationship integrity: no dangling foreign keys
- [ ] Search parity: top-10 results from Go match Python's top-10 within 95% overlap
- [ ] Embedding parity: Go gRPC → Python sidecar produces identical vectors to Python direct
- [ ] Performance: Go p99 latency ≤ Python p99 latency
- [ ] Rollback tested: Python memini-core can restart against same database

---

## 9. Risk Assessment

### 9.1 Top 5 Risks

| #   | Risk                                                                                                                                        | Prob | Impact | Mitigation                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **pgvector + pgx integration issues** — Go lacks a pgvector library; vector column binding may have edge cases                                  | Med  | High   | Comprehensive integration tests with testcontainers. Fallback: use `lib/pq` with explicit array casting if pgx fails. Both drivers support PostgreSQL arrays natively.                                                                                                         |
| 2   | **Embedding quality degradation** — Python gRPC sidecar adds serialization; MiniLM ONNX export may differ from Python `sentence-transformers`     | Low  | High   | gRPC sidecar runs the **exact same** `sentence-transformers` library. Quality is **identical** to current. Verification: generate 1,000 embeddings in both, assert cosine similarity > 0.9999 between them.                                                                         |
| 3   | **Feature parity gaps** — 35+ operations across 8 subsystems; risk of missing edge cases from Python implementation                             | Med  | Med    | Systematic audit of all Python code paths against Go implementation. Write parity tests for each subsystem. Prioritize: Foundation > Trust > Graph > KG > Tiered > Peer > Decay > Dialectic > Thought.                                                                       |
| 4   | **LLM dependency stability** — Tiered loading and dialectic engine depend on LLM calls. If LLM endpoint changes API, Go client needs update.    | Low  | Med    | Go LLM client uses the same OpenAI-compatible API as Python. LLM features are **opt-in** via feature flags — system works without them.                                                                                                                                       |
| 5   | **Concurrency bugs** — Go's goroutine model differs from Python's asyncio. Race conditions possible in decay scheduler, indexer, thought chains | Med  | Med    | Go's race detector (`go test -race`) catches data races. All shared state uses `sync.RWMutex`. Decay/consolidation/indexer use single-goroutine patterns with channels. Extensive race-condition tests.                                                                           |

### 9.2 Success Criteria

1. All 35+ operations work against the same PostgreSQL database
2. Search results match Python within 95% overlap (top-10)
3. p99 latency ≤ Python for all operations
4. Zero data migration — same schema, same data
5. Orchestrator imports `neuralgentics/internal/memory` — no HTTP between them
6. All tests pass with `go test -race` (no data races)
7. Python memini-core can be shut down — Go handles all memory operations

---

## Appendix A: Python → Go Mapping Reference

| Python File          | Go Package                                                             | SLOC (Python) | Key Classes          |
| -------------------- | ---------------------------------------------------------------------- | ------------- | -------------------- |
| `postgres/database.py` | `store/postgres.go` + `store/memories.go` + `store/search.go`                | 1,114         | `PostgresDatabase`     |
| `postgres/schema.py`   | `migrations/`                                                          | 463           | (SQL only)           |
| `postgres/queries.py`  | `store/queries.go`                                                       | ~200          | (SQL constants)      |
| `memory/system.py`     | `memory.go` (facade)                                                     | 647           | `MemorySystem`         |
| `memory/search.py`     | `search/vector.go` + `search/hybrid.go`                                    | ~300          | `MemorySearch`         |
| `trust_engine.py`      | `trust/engine.go`                                                        | 307           | `TrustEngine`          |
| `thought_chains.py`    | `thought/chains.go` + `thought/memory_bridge.go`                           | 865           | `ThoughtChains`        |
| `decay.py`             | `decay/engine.go` + `decay/scheduler.go` + `decay/consolidate.go`            | 801           | `DecayEngine`          |
| `multi_peer.py`        | `peer/profiles.go` + `peer/sharing.go` + `peer/context.go`                   | 897           | `MultiPeer`            |
| `dialectic.py`         | `dialectic/engine.go` + `dialectic/arguments.go` + `dialectic/resolution.go` | 1,110         | `DialecticEngine`      |
| `knowledge_graph.py`   | `kg/entities.go` + `kg/queries.go` + `kg/visualization.go`                   | 1,512         | `KnowledgeGraph`       |
| `tiered_loader.py`     | `tiered/loader.go` + `tiered/cache.go`                                     | 557           | `TieredLoader`         |
| `indexer/indexer.py`   | `index/indexer.go`                                                       | 402           | `ProjectIndexer`       |
| `model/embeddings.py`  | `embed/grpc.go` (Go client) + `cmd/embedding-sidecar/` (Python server)     | 106           | `generate_embedding`   |
| **Total Python**         | **~8,000-10,000 SLOC**                                                    |               |                      |
| **Estimated Go**         | **~10,000-12,000 SLOC**                                                   |               |                      |

**Go verbosity note:** Go is more verbose than Python (types, explicit error handling), but eliminates async/await boilerplate. Net result is ~20% more SLOC for equivalent logic.

---

## Appendix B: Go Dependencies

```
github.com/jackc/pgx/v5              // PostgreSQL driver
github.com/golang-migrate/migrate/v4   // Schema migrations
github.com/testcontainers/testcontainers-go  // Integration testing
github.com/stretchr/testify          // Assertions + mocking
github.com/kelseyhightower/envconfig  // Env var binding
github.com/fsnotify/fsnotify         // File watcher (indexer)
google.golang.org/grpc               // gRPC client (embedding)
google.golang.org/protobuf           // Protobuf runtime
golang.org/x/sync/errgroup           // Concurrent operations
```

---

## Appendix C: Python Sidecar Dependencies

```
sentence-transformers>=2.6  // MiniLM-L6-v2 embeddings
grpcio>=1.60                // gRPC server
grpcio-health-checking      // Health check service
protobuf>=4.25              // Protobuf runtime
```

---

*Plan prepared by boomerang-architect. Approved by user on 2026-05-28. Implementation Phase 1 beginning.*
