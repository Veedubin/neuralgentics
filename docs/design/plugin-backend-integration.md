# OpenCode Plugin ↔ Go Backend Integration

**Status:** Draft  
**Date:** 2026-05-30  
**Author:** Boomerang Architect  
**Version:** 1.0.0  

## 1. Executive Summary

The Neuralgentics TypeScript OpenCode plugin (`neuralgentics/overlay/packages/opencode/src/neuralgentics/`) currently communicates with the Python `memini-core` server via HTTP on port 8900. With the Go backend now complete (memory, orchestrator, broker — all tests passing, zero failures), the plugin must be re-wired to call the Go backend instead.

**Recommended approach:** The TypeScript plugin launches a Go "backend" binary as a child process and communicates over **JSON-RPC via stdio**. This reuses the broker's existing JSON-RPC proxy infrastructure, incurs zero network overhead (same-machine, sub-millisecond latency), requires no port management, and keeps the entire system self-contained within a single process tree.

The Go backend binary will embed the orchestrator (which directly imports the memory module via Go function calls — zero MCP or HTTP between orchestrator and memory) and expose a JSON-RPC API over stdio backed by the broker proxy.

---

## 2. Current Architecture (v0 — Python Backend)

```
OpenCode (Bun runtime)
  └─ Neuralgentics Plugin (TypeScript)
       ├─ MemoryClient ──HTTP──→ memini-core (Python, port 8900)
       ├─ StatelessProtocol ────→ MemoryClient
       └─ NeuralgenticsOrchestrator
            ├─ injectSystemPrompt
            ├─ validateRouting (pure TS, no backend call)
            └─ getAgentList (pure TS, no backend call)
```

**Files involved:**
| File | LOC | Purpose |
|------|-----|---------|
| `overlay/packages/opencode/src/neuralgentics/memory-client.ts` | 153 | HTTP client to Python memini-core |
| `overlay/packages/opencode/src/neuralgentics/stateless.ts` | 105 | Stateless protocol: store context, wrap up |
| `overlay/packages/opencode/src/neuralgentics/orchestrator.ts` | 167 | Plugin orchestrator (inject identity, validate routing) |
| `overlay/packages/opencode/src/neuralgentics/routing.ts` | 100 | Routing matrix (pure TS, stays as-is) |
| `overlay/packages/opencode/src/neuralgentics/types.ts` | 52 | Shared type definitions |
| `overlay/packages/opencode/src/neuralgentics/index.ts` | 21 | Re-exports |
| `overlay/packages/opencode/src/neuralgentics/plugin.ts` | 11 | Plugin lifecycle hook |
| `overlay/packages/opencode/src/neuralgentics/updater.ts` | 37 | Update interceptor |

---

## 3. Go Backend Capabilities

### 3.1 Memory Module (`packages/memory/`)
Full-featured memory system (~7,500 LoC). All tests pass.
- Core: CRUD, deduplication, semantic search
- Trust Engine: Score adjustment, decay, consolidation
- Knowledge Graph: Entities, relationships, inference chains
- Audit: Event logging, security summaries
- Tiered: L0/L1 summaries, caching
- Peer: Multi-peer isolation, context switching
- Index: Project file indexing, chunking, tracking, watching
- Thought Chains: Sequential reasoning with branching
- Dialectic: Challenge/resolution, contradiction detection

### 3.2 Orchestrator (`packages/orchestrator-go/`)
Central routing and protocol enforcement layer. 24/24 tests pass.
- `HandleTask()` — Route + build context + return plan
- `HandleTaskStateless()` — Store context in memory, return seed prompt
- `CompleteTaskCycle()` — Fetch wrap-up, adjust trust, complete protocol
- `Dispatch()` — Parallel dispatch with dependency ordering
- Memory is imported **directly** (Go-to-Go call, zero HTTP/stdio)

### 3.3 Broker (`packages/broker-go/`)
MCP server management. All tests pass.
- JSON-RPC proxy (`proxy/proxy.go`) — Send/receive JSON-RPC 2.0 over stdio
- Registry — Server registration, health tracking
- Launcher — Process lifecycle management
- Access Control — Role-based tool access
- Intent Matching — NLP tool selection
- Catalog/Prompt builder — Token-efficient tool listings for LLM prompts

---

## 4. Target Architecture (v1 — Go Backend via JSON-RPC over stdio)

```
┌──────────────────────────────────────────────────────────────────┐
│ OpenCode (Bun runtime)                                           │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Neuralgentics Plugin (TypeScript)                            ││
│  │  ┌──────────────────────────┐  ┌────────────────────────────┐││
│  │  │ GoBackendClient (NEW)    │  │ Routing + Orchestrator     │││
│  │  │  - JSON-RPC over stdio   │  │ (stays pure TS, local)    │││
│  │  │  - Spawns Go binary      │  └────────────────────────────┘││
│  │  │  - Request/response MUX  │                                ││
│  │  └──────────┬───────────────┘                                ││
│  └─────────────┼────────────────────────────────────────────────┘│
└────────────────┼────────────────────────────────────────────────┘
                 │ JSON-RPC 2.0 over stdin/stdout
                 │ (same machine, sub-ms latency)
┌────────────────┼────────────────────────────────────────────────┐
│ Go Backend Binary (neuralgentics-backend)                        │
│  ┌─────────────┴───────────────────────────────────────────────┐│
│  │ JSON-RPC Server (NEW — wraps broker proxy + orchestrator)   ││
│  │  Methods:                                                    ││
│  │    memory.add        → orchestrator.MemoryProvider.AddMemory ││
│  │    memory.query      → orchestrator.MemoryProvider.QueryMem. ││
│  │    memory.get        → orchestrator.MemoryProvider.GetMemory ││
│  │    memory.delete     → orchestrator.MemoryProvider.DeleteMem ││
│  │    memory.adjustTrust→ orchestrator.MemoryProvider.AdjustTr. ││
│  │    orchestrator.handleTask  → orchestrator.HandleTask        ││
│  │    orchestrator.handleStateless → .HandleTaskStateless       ││
│  │    orchestrator.completeCycle  → .CompleteTaskCycle          ││
│  │    orchestrator.dispatch       → .Dispatch                   ││
│  │    orchestrator.route          → .Route                      ││
│  └──────────────┬───────────────────────────────────────────────┘│
│  ┌──────────────┴───────────────────────────────────────────────┐│
│  │ Orchestrator (direct Go import — zero overhead)              ││
│  │  MemoryProvider interface → concrete *memory.MemorySystem    ││
│  └──────────────┬───────────────────────────────────────────────┘│
│  ┌──────────────┴───────────────────────────────────────────────┐│
│  │ Memory Module (Go)                                           ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Transport Decision

### Options Evaluated

| Transport | Latency | Complexity | Port Mgmt | Reuses Broker | Verdict |
|-----------|---------|------------|-----------|---------------|---------|
| **JSON-RPC stdio** | Sub-ms | Low | None | ✅ Yes | **RECOMMENDED** |
| HTTP REST | ~1-2ms | Medium | Yes | Partial | Overkill |
| gRPC | Sub-ms | High (protobuf) | Yes | No | Overengineered |
| Unix socket | Sub-ms | Medium | Socket file | No | Extra infra |
| WebSocket | ~1-2ms | High | Yes | No | Unnecessary |

### Recommendation: **JSON-RPC over stdio**

**Rationale:**
1. **Broker reuse** — The broker's `proxy/proxy.go` already handles JSON-RPC 2.0 request/response cycles over stdio. We can wrap it directly.
2. **Zero network overhead** — Sub-millisecond round-trips on the same machine.
3. **No port management** — No need to find free ports, configure firewalls, or handle port conflicts.
4. **Process lifecycle** — The Go binary starts/stops with OpenCode. If OpenCode crashes, the Go process dies with it (zombie protection via OS).
5. **Simple TS implementation** — Node.js/Bun `child_process.spawn()` with `stdin.write()` / `stdout.read()` is trivial.
6. **Testable** — Integration tests can spawn the Go binary and send JSON-RPC requests directly.

---

## 6. API Surface

### 6.1 Memory Methods (delegated to MemoryProvider)

These are thin passthroughs from JSON-RPC to the orchestrator's `MemoryProvider` interface:

| Method | Params | Returns | Maps to |
|--------|--------|---------|---------|
| `memory.add` | `{content, sourceType?, metadata?}` | `{id: string}` | `MemoryProvider.AddMemory()` |
| `memory.query` | `{query, limit?, strategy?}` | `[{id, content, metadata, trustScore}]` | `MemoryProvider.QueryMemories()` |
| `memory.get` | `{id}` | `{id, content, metadata, trustScore}` | `MemoryProvider.GetMemory()` |
| `memory.delete` | `{id}` | `{}` | `MemoryProvider.DeleteMemory()` |
| `memory.adjustTrust` | `{memoryId, signal}` | `{oldScore, newScore, adjustmentAmount}` | `MemoryProvider.AdjustTrust()` |

### 6.2 Orchestrator Methods

| Method | Params | Returns | Maps to |
|--------|--------|---------|---------|
| `orchestrator.handleTask` | `{task}` | `{agent, contextPackage, executionPlan}` | `Orchestrator.HandleTask()` |
| `orchestrator.handleStateless` | `{task}` | `{agent, contextMemoryId, seedPrompt, executionPlan}` | `Orchestrator.HandleTaskStateless()` |
| `orchestrator.completeCycle` | `{taskId, result, contextMemoryId}` | `{summary, filesModified, trustSignals}` | `Orchestrator.CompleteTaskCycle()` |
| `orchestrator.dispatch` | `{tasks, dependencies}` | `[{taskId, agent, success, duration}]` | `Orchestrator.Dispatch()` |
| `orchestrator.route` | `{taskType}` | `{agent}` | `Orchestrator.Route()` |

### 6.3 Lifecycle Methods

| Method | Params | Returns | Maps to |
|--------|--------|---------|---------|
| `initialize` | `{clientInfo}` | `{serverInfo, capabilities}` | MCP initialize handshake |
| `shutdown` | `{}` | `{}` | Graceful shutdown |

---

## 7. TypeScript Client Design

### 7.1 New File: `go-backend-client.ts`

```typescript
/**
 * GoBackendClient — JSON-RPC 2.0 client over stdio to the Go backend.
 *
 * Spawns the Go binary as a child process and multiplexes
 * concurrent requests over a single stdin/stdout pair.
 */

interface PendingCall {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class GoBackendClient {
  private process: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private ready: Promise<void>;

  constructor(binaryPath: string) {
    this.process = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"], // stderr → parent
    });
    this.ready = this.waitForReady();
  }

  // Send a JSON-RPC request and await the response.
  async call(method: string, params: Record<string, unknown>): Promise<any>;

  // Close the stdio pipes and kill the process.
  async shut down(): Promise<void>;
}
```

**Key design choices:**
- **Single process, multiplexed requests** — One Go binary, one stdin/stdout pair, multiple concurrent TS callers. The client tags each request with a monotonically increasing `id` and routes responses back via a `pending` map.
- **Readline-based** — Responses are newline-delimited JSON (matching the broker proxy's write format).
- **Timeout** — Each request has a configurable timeout (default 30s). On timeout, the pending entry is removed and the caller gets an error.
- **Process restart** — If the Go binary crashes, the client detects it via `process.on("exit")` and rejects all pending calls. The plugin can then attempt restart.

### 7.2 Modified File: `memory-client.ts` → wraps `GoBackendClient`

The existing `MemoryClient` class becomes a thin wrapper around `GoBackendClient`:

```typescript
export class MemoryClient {
  constructor(private backend: GoBackendClient) {}

  async addMemory(content: string, metadata?: Record<string, unknown>): Promise<string> {
    const result = await this.backend.call("memory.add", { content, metadata });
    return result.id;
  }

  async queryMemories(query: string, limit: number = 10): Promise<MemoryRecord[]> {
    const result = await this.backend.call("memory.query", { query, limit });
    return result;
  }

  // ... addThought, startThoughtChain via backend.call("memory.add", ...)
}
```

### 7.3 Modified File: `orchestrator.ts` — pass `GoBackendClient`

```typescript
export class NeuralgenticsOrchestrator {
  constructor(private backend: GoBackendClient) {
    this.memoryClient = new MemoryClient(backend);
    this.stateless = new StatelessProtocol(this.memoryClient);
  }

  async handleTask(task: Task): Promise<OrchestrationResult> {
    return this.backend.call("orchestrator.handleTask", { task });
  }
}
```

---

## 8. Go Backend Binary Design

### 8.1 New File: `packages/backend-go/cmd/backend/main.go`

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "io"
    "os"

    "neuralgentics-memory/src/neuralgentics/memory"
    "neuralgentics-orchestrator/src/neuralgentics/orchestrator"
)

func main() {
    // 1. Initialize memory system
    memSystem, err := memory.NewMemorySystem(cfg)
    if err != nil { /* ... */ }

    // 2. Create orchestrator with memory injected directly (no HTTP)
    orch, err := orchestrator.New(&orchestrator.OrchestratorConfig{
        Memory:             memSystem,          // direct Go call
        ProtocolStrictness: orchestrator.StrictnessStandard,
        MaxConcurrent:      5,
        UseStatelessAgents: true,
    })

    // 3. Read/write JSON-RPC via stdin/stdout
    scanner := bufio.NewScanner(os.Stdin)
    writer  := os.Stdout

    for scanner.Scan() {
        var req jsonrpcRequest
        json.Unmarshal(scanner.Bytes(), &req)

        var result interface{}
        var rpcErr *jsonrpcError

        switch req.Method {
        case "memory.add":
            result, rpcErr = handleMemoryAdd(memSystem, req.Params)
        case "memory.query":
            result, rpcErr = handleMemoryQuery(memSystem, req.Params)
        // ... etc
        case "orchestrator.handleTask":
            result, rpcErr = handleOrchTask(orch, req.Params)
        // ... etc
        }

        response := jsonrpcResponse{
            JSONRPC: "2.0",
            ID:      req.ID,
            Result:  result,
            Error:   rpcErr,
        }
        data, _ := json.Marshal(response)
        fmt.Fprintf(writer, "%s\n", data)
    }
}
```

### 8.2 Binary Location

Built binary: `neuralgentics/packages/backend-go/neuralgentics-backend` (or `bin/neuralgentics-backend`)

The TypeScript plugin discovers it via:
1. Environment variable: `NEURALGENTICS_BACKEND_PATH`
2. Fallback: `./bin/neuralgentics-backend` relative to plugin install
3. Fallback: `PATH` search for `neuralgentics-backend`

---

## 9. Files to Create/Modify

### 9.1 New Files

| File | Purpose |
|------|---------|
| `packages/backend-go/cmd/backend/main.go` | Go backend binary entry point |
| `packages/backend-go/go.mod` | Go module definition |
| `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` | TS JSON-RPC stdio client |
| `packages/backend-go/cmd/backend/main_test.go` | Integration tests for the backend binary |

### 9.2 Modified Files

| File | Change |
|------|--------|
| `overlay/packages/opencode/src/neuralgentics/memory-client.ts` | Replace HTTP with GoBackendClient wrapper |
| `overlay/packages/opencode/src/neuralgentics/orchestrator.ts` | Accept GoBackendClient, add handleTask/dispatch methods |
| `overlay/packages/opencode/src/neuralgentics/stateless.ts` | No changes needed (already uses MemoryClient interface) |
| `overlay/packages/opencode/src/neuralgentics/index.ts` | Export GoBackendClient |
| `overlay/packages/opencode/src/neuralgentics/types.ts` | Add JSON-RPC request/response types if needed |

### 9.3 Unchanged Files

| File | Reason |
|------|--------|
| `routing.ts` | Pure TS, no backend dependency |
| `plugin.ts` | Lifecycle hook stays minimal |
| `updater.ts` | No change needed |

---

## 10. Error Handling & Resilience

### 10.1 Connection Management

| Scenario | Behavior |
|----------|----------|
| Go binary fails to start | `GoBackendClient` constructor throws with diagnostic (stderr captured) |
| Go binary crashes mid-session | All pending calls rejected with "backend terminated" error; client auto-restarts |
| Request timeout (30s) | Pending call rejected with timeout error; Go process continues (orphaned response dropped) |
| Malformed response | Call rejected with parse error; connection continues |
| Go binary exits cleanly | All pending calls rejected; new calls fail immediately until restart |

### 10.2 Retry Policy

- **No automatic retry** on the TypeScript side for individual requests
- **Process restart**: If the Go binary exits unexpectedly and there are active pending calls, the client attempts a single restart before failing permanently
- The orchestrator layer (Go side) handles its own retries and error recovery

### 10.3 Health Check

The `initialize` handshake acts as a health check. The Go backend returns its version and capabilities. The TS client can also send a `ping` method for lightweight liveness checks.

---

## 11. Testing Strategy

### 11.1 Go Backend Unit Tests

File: `packages/backend-go/cmd/backend/main_test.go`

```go
func TestBackendJSONRPC_MemoryAdd(t *testing.T) {
    // Spawn the binary, send {"method":"memory.add","params":{...}}
    // Verify response contains valid id
}

func TestBackendJSONRPC_MemoryQuery(t *testing.T) {
    // Add a memory, then query it
}

func TestBackendJSONRPC_OrchestratorHandleTask(t *testing.T) {
    // Send a task, verify routing and context package
}
```

### 11.2 TypeScript Integration Tests

File: `overlay/packages/opencode/test/go-backend-client.test.ts`

```typescript
describe("GoBackendClient", () => {
  it("spawns the Go binary and completes initialize handshake");
  it("calls memory.add and returns an id");
  it("calls memory.query and returns results");
  it("handles concurrent requests correctly");
  it("rejects pending calls on process exit");
  it("handles timeout correctly");
});
```

### 11.3 End-to-End Test

```bash
# Build the Go backend
cd packages/backend-go && go build -o ../../bin/neuralgentics-backend ./cmd/backend

# Run TS integration tests
cd overlay/packages/opencode && bun test test/go-backend-client.test.ts
```

---

## 12. Migration Plan

### Phase 1: Go Backend Binary (2-3 files, ~300 LoC)
1. Create `packages/backend-go/` with `cmd/backend/main.go`
2. Wire up JSON-RPC → orchestrator → memory dispatch
3. Build + test the binary manually with `echo '{"jsonrpc":"2.0","id":1,"method":"memory.add"...}' | ./neuralgentics-backend`

### Phase 2: TypeScript Client (2-3 files, ~200 LoC)
4. Create `go-backend-client.ts` with stdio spawn + multiplexing
5. Modify `memory-client.ts` to wrap GoBackendClient
6. Modify `orchestrator.ts` to accept GoBackendClient

### Phase 3: Integration Tests
7. Write Go integration tests for the backend binary
8. Write TS integration tests for GoBackendClient
9. Run the full test suite

### Phase 4: Feature Parity
10. Wire up thought chain methods (currently: `/thoughts/` HTTP → `memory.add` for thought storage)
11. Wire up tiered summary methods (L0/L1)
12. Wire up knowledge graph methods

---

## 13. Open Questions & Trade-offs

### 13.1 Open Questions

1. **Binary distribution**: How does the Go binary get onto the user's machine?
   - **Option A**: Pre-built binary in npm package (platform-specific)
   - **Option B**: Build from source during plugin install (requires Go toolchain)
   - **Option C**: Download from GitHub Releases at plugin init time
   - **Recommendation**: Option C for development, A for production

2. **Thought chain storage**: Currently, the TS `MemoryClient` has `addThought()` and `startThoughtChain()` methods that hit `/thoughts/` HTTP endpoints. The Go memory module has `thought/chains.go` — we need to expose these as JSON-RPC methods. **Decision**: Add `thought.add`, `thought.startChain`, `thought.getChain` methods.

3. **L0/L1 tiered summaries**: `MemoryClient` doesn't currently expose these. The orchestrator uses them. The Go backend should expose them. **Decision**: Add `summary.l0` and `summary.l1` methods.

4. **Project indexing**: `MemoryClient` doesn't expose `index_project` or `get_file_contents`. Should the plugin expose these? **Decision**: Yes, as `project.index` and `project.getFile` methods.

5. **Broker features**: The Go broker has catalog, access control, intent matching. Should the plugin expose these? **Decision**: Not yet — these are internal to the Go orchestrator. The plugin doesn't need broker UI features.

### 13.2 Trade-offs

| Trade-off | Chosen | Alternative | Why |
|-----------|--------|-------------|-----|
| Transport | JSON-RPC stdio | HTTP REST | Zero latency overhead, no port management, reuses broker proxy |
| Concurrency | Multiplexed single process | Pool of processes | Simpler, fewer resources, Go handles concurrency well |
| Error handling | Call-level timeout + process restart | Circuit breaker | Sufficient for same-machine; circuit breaker adds complexity |
| Binary mgmt | Separate binary | Embedded WASM | WASM can't access PostgreSQL; Go binary is the right choice |
| Routing | TS-side routing matrix stays | Move routing to Go | Routing is fast, pure logic — no need for backend round-trip |

---

## 14. Performance Estimates

| Operation | Current (HTTP → Python) | Target (stdio → Go) | Improvement |
|-----------|------------------------|---------------------|-------------|
| Memory add | ~5-15ms | ~0.5-2ms | 5-15x faster |
| Memory query | ~10-30ms | ~1-5ms | 5-30x faster |
| Orchestrator route | ~5ms (HTTP) | ~0.2ms (local TS) or ~0.5ms (stdio) | ~10x faster |
| Context build | ~20-50ms (multiple HTTP calls) | ~2-10ms (single JSON-RPC call) | 5-25x faster |

---

## 15. References

- [Broker design doc](../broker-server-catalog-prompting.md)
- [Go memory module source](../../packages/memory/src/neuralgentics/memory/)
- [Go orchestrator source](../../packages/orchestrator-go/src/neuralgentics/orchestrator/)
- [Go broker source](../../packages/broker-go/src/neuralgentics/broker/)
- [TS plugin source](../../overlay/packages/opencode/src/neuralgentics/)
