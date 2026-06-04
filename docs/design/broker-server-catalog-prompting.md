# Broker Server Catalog + Prompting Strategy

**Design Document**
**Version:** 1.0
**Author:** boomerang-architect
**Date:** 2026-05-29
**Status:** Ready for Implementation

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Server Catalog Format](#2-server-catalog-format)
3. [Prompt Injection Mechanism](#3-prompt-injection-mechanism)
4. [Access Control Design](#4-access-control-design)
5. [Intent Flow](#5-intent-flow)
6. [File Changes Inventory](#6-file-changes-inventory)
7. [Token Budget Analysis](#7-token-budget-analysis)
8. [Sprint Scope](#8-sprint-scope)
9. [Open Questions](#9-open-questions)

---

## 1. Executive Summary

### Problem

An LLM orchestrated by the Neuralgentics broker needs to know what MCP servers are available—without burning thousands of tokens on full `tools/list` JSON schemas for each server. With 8 MCP servers each exposing ~20 tools (160 total), raw tool schemas consume **~12,800 tokens** per session. Repeated across multi-turn conversations, this is prohibitive.

### Solution

A **3-layer architecture** that decouples _awareness_ from _precision_:

```
┌────────────────────────────────────────────────┐
│ LAYER 1: Server Catalog (~50-100 tokens/server)│
│ "I know *what* servers exist"                  │
│ → Injected into system prompt at session start │
└────────────────┬───────────────────────────────┘
                 │ LLM expresses intent
                 ▼
┌────────────────────────────────────────────────┐
│ LAYER 2: Intent Matcher (keyword-based)        │
│ "Match natural language → tool + server"       │
│ → Broker resolves intent to concrete tool      │
└────────────────┬───────────────────────────────┘
                 │ Tool selected
                 ▼
┌────────────────────────────────────────────────┐
│ LAYER 3: Access Control + Proxy                │
│ "Check permissions → execute call"             │
│ → Pre-filter catalog + block unauthorized      │
└────────────────────────────────────────────────┘
```

**Token savings:** ~95% reduction (12,800 tokens → ~640 tokens for 8 servers).

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Catalog format** | Go struct → JSON serialization | Same type system as existing code; no YAML dependency |
| **Prompt injection** | Static at session start + `ExpandServer(name)` on demand | 1-time cost, minimal for 8 servers, model can expand when needed |
| **Access control** | Role-based pre-filtering | `ServerRoles` map filters catalog at build time; `Call()` double-checks |
| **Storage** | In-memory (derived from registry) | No persistence needed; catalog is a live view of registered servers |
| **Populated from** | `types.ServerConfig` metadata + `tools/list` results | Tools discovered via MCP protocol; config provides server-level description |

---

## 2. Server Catalog Format

### 2.1 Go Structs

The catalog is represented by a hierarchy of Go structs in a new `catalog` package:

```go
// catalog/catalog.go

package catalog

// ServerSummary is the minimal, token-efficient representation of
// an available MCP server. Designed to be injected into LLM system
// prompts without burning tokens on full tool schemas.
type ServerSummary struct {
    // Name is the server's unique identifier (e.g., "memini-ai-dev").
    Name string `json:"name"`

    // Description is a concise (30-80 char) human-readable summary of
    // what the server does. This is shown prominently to the LLM.
    // Examples:
    //   "Semantic memory with trust scoring, knowledge graph, tiered loading"
    //   "GitHub operations — repos, issues, PRs, file management"
    Description string `json:"description"`

    // Capabilities are short tags (NOT tool names) representing
    // categories of functionality. LLMs use these for high-level
    // reasoning about what a server can do, then call MatchIntent()
    // for precise tool selection.
    // Examples: ["memory_query", "kg_query", "trust_adjust"]
    Capabilities []string `json:"capabilities"`

    // ToolsCount is the number of tools this server exposes.
    // Useful for the LLM to gauge server complexity.
    ToolsCount int `json:"tools_count"`

    // Status indicates whether the server is currently running.
    Status string `json:"status"` // "running", "stopped", "error"
}

// ServerCatalog is the aggregate view of all available servers.
// This is the primary output of broker.BuildServerCatalog().
type ServerCatalog struct {
    // Servers lists all registered, role-accessible servers.
    Servers []ServerSummary `json:"servers"`

    // TotalTools is the sum of all tools across all servers.
    TotalTools int `json:"total_tools"`

    // Role is the role context this catalog was built for.
    // Null means unrestricted (orchestrator).
    Role string `json:"role,omitempty"`
}

// ToolCatalog is a server-specific expanded tool list, returned
// when the LLM calls broker.ExpandServer(name).
type ToolCatalog struct {
    Server  string `json:"server"`
    Status  string `json:"status"`
    Tools   []ToolSummary `json:"tools"` // Full tool list with descriptions
}

// ToolSummary is a single tool entry (reuses existing pattern).
type ToolSummary struct {
    Name        string `json:"name"`
    Description string `json:"description"`
}
```

### 2.2 ServerConfig Extension

Add optional fields to `types.ServerConfig` for catalog metadata:

```go
// types/types.go — add to ServerConfig
type ServerConfig struct {
    // ... existing fields ...

    // Catalog metadata (optional, used for prompt injection)
    Description  string   `json:"description,omitempty"`  // Human-readable server description
    Capabilities []string `json:"capabilities,omitempty"` // Capability tags
    Roles        []string `json:"roles,omitempty"`         // Allowed roles (empty = all)
}
```

### 2.3 Example Catalog (JSON Serialization)

```json
{
  "servers": [
    {
      "name": "memini-ai-dev",
      "description": "Semantic memory with trust scoring, knowledge graph, tiered loading",
      "capabilities": ["memory_query", "memory_store", "trust_adjust", "kg_query", "project_search"],
      "tools_count": 24,
      "status": "running"
    },
    {
      "name": "github-mcp",
      "description": "GitHub operations — repos, issues, PRs, file management",
      "capabilities": ["repo_read", "issue_create", "pr_review", "file_update", "code_search"],
      "tools_count": 18,
      "status": "running"
    },
    {
      "name": "playwright",
      "description": "Browser automation — click, type, navigate, screenshot",
      "capabilities": ["browser_click", "browser_type", "browser_navigate", "browser_screenshot"],
      "tools_count": 12,
      "status": "running"
    }
  ],
  "total_tools": 54,
  "role": "orchestrator"
}
```

### 2.4 Where It Lives + How It's Populated

| Aspect | Detail |
|--------|--------|
| **Storage** | Live view; no persistent state. Built on-demand from `registry.List()` + cached tools. |
| **Builder** | `catalog.NewBuilder(registry) → Build(role) → ServerCatalog` |
| **Server description** | Preferred: `ServerConfig.Description`. Fallback: derived from tool descriptions (first 80 chars). |
| **Capabilities** | Preferred: `ServerConfig.Capabilities`. Fallback: auto-generated from tool name prefixes (e.g., `browser_*` → `browser`). |
| **Tools count** | `len(entry.Tools)` from registry cache. |
| **Status** | `entry.Process != nil` → "running"; `entry.LastError != ""` → "error"; else "stopped". |

---

## 3. Prompt Injection Mechanism

### 3.1 Strategy: Static Catalog + On-Demand Expansion

We inject the **full server catalog** into the LLM's system prompt at session start. This is a one-time, ~400-800 token cost. If the LLM needs to know what specific tools a server offers, it calls `broker.ExpandServer(name)`.

**Why not dynamic/lazy injection?**

| Approach | Pros | Cons |
|----------|------|------|
| A. Static session-start | Simple, predictable, model always knows what's available | Catalog must be small enough to always include |
| B. Dynamic per-turn | Most token-efficient per turn | Requires turn-type detection; model may ask "what tools do I have?" |
| C. Lazy (model asks) | Minimal initial tokens | Extra round-trip; model must know to ask |
| **D. Hybrid (Static + Expand)** | **Best of both: always-aware, expand-on-demand** | Slightly more implementation complexity |

**Recommendation: Option D** — Static catalog for baseline awareness; `ExpandServer()` for precision.

### 3.2 Prompt Template

The broker's prompt injection produces a section inserted into the system prompt:

```
## Available MCP Servers

You have access to the following MCP servers through the Neuralgentics broker.
Use the broker.MatchIntent() function to select the right tool by describing
what you want to do. You do NOT need to know tool names — the broker's
intent matcher selects the best tool for you.

### Active Servers (3 running, 54 tools total)

| Server | Description | Capabilities | Tools |
|--------|-------------|--------------|-------|
| memini-ai-dev | Semantic memory with trust scoring, knowledge graph, tiered loading | memory_query, memory_store, trust_adjust, kg_query, project_search | 24 |
| github-mcp | GitHub operations — repos, issues, PRs, file management | repo_read, issue_create, pr_review, file_update, code_search | 18 |
| playwright | Browser automation — click, type, navigate, screenshot | browser_click, browser_type, browser_navigate, browser_screenshot | 12 |

### How to Use MCP Tools

1. **Describe your intent:** Call `broker.MatchIntent("search my memories for login bugs")`
2. **The broker finds the tool:** Returns `{server: "memini-ai-dev", tool: "query_memories"}`
3. **The broker calls it:** Returns the result directly

If you need to see all tools on a specific server, call:
  broker.ExpandServer("<server-name>")
```

### 3.3 Text Flow Diagram

```
                  [SESSION START]
                        │
                        ▼
┌───────────────────────────────────────────┐
│ 1. Orchestrator requests system prompt    │
│    from broker.                           │
└────────────────┬──────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────┐
│ 2. broker.BuildServerCatalog(role)        │
│    ├── registry.List() → servers          │
│    ├── Filter by role permissions         │
│    ├── Build ServerSummary for each       │
│    └── Return ServerCatalog               │
└────────────────┬──────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────┐
│ 3. catalog.FormatForPrompt(catalog)       │
│    ├── Template into markdown table       │
│    ├── Add usage instructions             │
│    └── Return prompt section (string)     │
└────────────────┬──────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────┐
│ 4. Orchestrator inserts prompt section    │
│    into LLM's system prompt.              │
└────────────────┬──────────────────────────┘
                 │
                 ▼
            [MODEL RUNS]
                 │
                 ▼
┌───────────────────┐    On-demand:     ┌─────────────────────────┐
│ LLM: "I need to   │──────────────────▶│ broker.ExpandServer("   │
│  query memory"    │                   │  memini-ai-dev")        │
│                   │◀──────────────────│ → ToolCatalog{tools:[]} │
│ → MatchIntent(    │                   └─────────────────────────┘
│   "query memory") │
│ → {memini-ai-dev, │
│    query_memories}│
└───────────────────┘
```

---

## 4. Access Control Design

### 4.1 Design Philosophy

**Principle: Defense in Depth**

1. **Filter at catalog build time** → LLM never sees servers it can't use
2. **Check at call time** → Broker double-checks before proxying
3. **Fail closed** → Unknown roles get minimal access

### 4.2 Role Model

Roles map to agent types in the Boomerang / Neuralgentics ecosystem:

```go
// access/access.go

// Role represents an agent role with specific MCP server access.
type Role string

const (
    RoleOrchestrator Role = "orchestrator"  // Full access to all servers
    RoleArchitect    Role = "architect"     // Memory, search, research tools
    RoleCoder        Role = "coder"         // Code tools, git, linter
    RoleTester       Role = "tester"        // Test tools, browser, debug
    RoleResearcher   Role = "researcher"    // Web search, scraping
    RoleWriter       Role = "writer"        // Docs, memory read-only
    RoleGit          Role = "git"           // GitHub operations only
    RoleReviewer     Role = "reviewer"      // Code review tools
)
```

### 4.3 Server Role Mapping

```go
// DefaultServerRoles maps server names to allowed roles.
// An empty/absent roles list means "all roles allowed."
var DefaultServerRoles = map[string][]Role{
    "memini-ai-dev":        {RoleOrchestrator, RoleArchitect, RoleCoder, RoleTester, RoleWriter},
    "github-mcp":           {RoleOrchestrator, RoleCoder, RoleGit, RoleReviewer},
    "playwright":           {RoleOrchestrator, RoleTester, RoleResearcher},
    "searxng":              {RoleOrchestrator, RoleResearcher, RoleArchitect},
    "webfetch":             {RoleOrchestrator, RoleResearcher},
    "markitdown":           {RoleOrchestrator, RoleArchitect},
}
```

### 4.4 Catalog Filtering

`BuildServerCatalog(role)` filters server visibility:

```
┌──────────────────────────────────────────────┐
│ BuildServerCatalog(role="coder")             │
│                                              │
│  All servers:                                │
│  ┌──────────────┬──────────────┬───────────┐ │
│  │ memini-ai-dev│ github-mcp   │ playwright│ │
│  │ [coder ✓]    │ [coder ✓]    │ [coder ✗] │ │
│  │ INCLUDE      │ INCLUDE      │ EXCLUDE   │ │
│  └──────────────┴──────────────┴───────────┘ │
│                                              │
│  Result: 2 servers in catalog for coder      │
└──────────────────────────────────────────────┘
```

### 4.5 Call-Time Enforcement

`Broker.Call()` rejects unauthorized calls:

```go
func (b *Broker) Call(role string, serverName string, toolName string, args map[string]any) (map[string]any, error) {
    // 1. Check access
    if !b.access.CanAccess(role, serverName) {
        return nil, ErrUnauthorized{
            Role:   role,
            Server: serverName,
            Reason: fmt.Sprintf("role %q cannot access server %q", role, serverName),
        }
    }
    // 2. Proceed with existing call logic
    // ...
}

// ErrUnauthorized signals that the caller does not have permission.
type ErrUnauthorized struct {
    Role   string
    Server string
    Reason string
}

func (e ErrUnauthorized) Error() string {
    return fmt.Sprintf("unauthorized: %s", e.Reason)
}
```

### 4.6 Unauthorized Response Signaling to LLM

When the model tries to call a forbidden server, the broker returns a structured error that includes **a hint about what IS available**:

```json
{
  "error": {
    "code": -32001,
    "message": "Unauthorized: role 'coder' cannot access server 'playwright'",
    "data": {
      "available_servers": ["memini-ai-dev", "github-mcp"],
      "suggestion": "coder can access: memini-ai-dev (memory), github-mcp (git). Try MatchIntent() for these servers."
    }
  }
}
```

This is friendlier than a raw 403 and helps the LLM recover autonomously.

---

## 5. Intent Flow

### 5.1 Complete Step-by-Step Flow

```
╔══════════════════════════════════════════════════════════════════╗
║ STEP 1: Session Start — Catalog Injection                       ║
╠══════════════════════════════════════════════════════════════════╣
║ Orchestrator: broker.BuildServerCatalog("orchestrator")         ║
║ Broker:      Returns ServerCatalog{Servers:[...], TotalTools:54}║
║ Orchestrator: catalog.FormatForPrompt(catalog) → prompt section ║
║ Orchestrator: Injects section into LLM system prompt            ║
╚══════════════════════════════════════════════════════════════════╝
                          │
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 2: LLM Processes Task                                     ║
╠══════════════════════════════════════════════════════════════════╣
║ LLM: "I need to query memory for previous architecture          ║
║       decisions about the broker."                              ║
║                                                                ║
║ LLM Reasons:                                                   ║
║   → Server: memini-ai-dev (memory query)                       ║
║   → Intent: "search memory for broker architecture decisions"  ║
╚══════════════════════════════════════════════════════════════════╝
                          │
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 3: Model Calls MatchIntent()                              ║
╠══════════════════════════════════════════════════════════════════╣
║ LLM → broker.MatchIntent("search memory for broker decisions") ║
║                                                                ║
║ Broker internals:                                              ║
║   1. GetAllTools() → [query_memories, add_memory, ...]         ║
║   2. Tokenize: [search, memory, broker, decisions]             ║
║   3. Score: query_memories score=0.75 (matched: search,memory) ║
║   4. Best match: {Server:"memini-ai-dev", Tool:"query_memories"}║
╚══════════════════════════════════════════════════════════════════╝
                          │
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 4: Broker Checks Access                                   ║
╠══════════════════════════════════════════════════════════════════╣
║ access.CanAccess("architect", "memini-ai-dev")                  ║
║   → memini-ai-dev allows architect                             ║
║   → Result: ALLOWED                                            ║
║                                                                ║
║ ALTERNATE: access.CanAccess("researcher", "github-mcp")        ║
║   → github-mcp does not allow researcher                       ║
║   → Result: FORBIDDEN → return ErrUnauthorized with hints       ║
╚══════════════════════════════════════════════════════════════════╝
                          │ (ALLOWED)
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 5: Broker Proxies Call                                    ║
╠══════════════════════════════════════════════════════════════════╣
║ broker.Call(role, "memini-ai-dev", "query_memories", args)     ║
║   1. Get entry.Stdin/Stdout from registry                      ║
║   2. Build JSON-RPC: {method:"tools/call", params:{...}}       ║
║   3. Write to stdin pipe                                       ║
║   4. Read response from stdout pipe                            ║
║   5. Parse JSON-RPC response                                   ║
║   6. Return result map[string]any                              ║
╚══════════════════════════════════════════════════════════════════╝
                          │
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 6: Result Returned to LLM                                 ║
╠══════════════════════════════════════════════════════════════════╣
║ Broker → LLM:                                                  ║
║ {                                                              ║
║   "memories": [                                                ║
║     {"content": "Broker v0.1.0 uses keyword-based intent..."}, ║
║     {"content": "Server catalog design pending..."}            ║
║   ],                                                           ║
║   "count": 2                                                   ║
║ }                                                              ║
╚══════════════════════════════════════════════════════════════════╝
                          │
                          ▼
╔══════════════════════════════════════════════════════════════════╗
║ STEP 7: Optional — Expand Server Details                       ║
╠══════════════════════════════════════════════════════════════════╣
║ LLM: "I want to see all tools on memini-ai-dev"                ║
║ LLM → broker.ExpandServer("memini-ai-dev")                     ║
║ Broker → {Server:"memini-ai-dev", Status:"running",            ║
║           Tools:[{Name:"query_memories", Description:"..."},   ║
║                  {Name:"add_memory", Description:"..."}, ...]} ║
╚══════════════════════════════════════════════════════════════════╝
```

### 5.2 Sequence Diagram (Mermaid-like)

```
Orchestrator    Broker          Registry     Access    IntentM    Proxy     MCP Srv
    │              │                │            │         │         │          │
    │──BuildCat───▶│                │            │         │         │          │
    │              │──List()──────▶│            │         │         │          │
    │              │◀──servers─────│            │         │         │          │
    │              │──CanAccess───▶│            │         │         │          │
    │              │◀──allowed─────│            │         │         │          │
    │◀──catalog────│                │            │         │         │          │
    │              │                │            │         │         │          │
    │  [ inject catalog into system prompt ]    │         │         │          │
    │              │                │            │         │         │          │
    │  [ LLM thinks "I need to query memory" ]  │         │         │          │
    │              │                │            │         │         │          │
    │──Match──────▶│                │            │         │         │          │
    │              │──GetAllTools()─▶            │         │         │          │
    │              │◀──tools────────│            │         │         │          │
    │              │───Match(intent)─────────────────────▶│         │          │
    │              │◀──ToolMatch──────────────────────────│         │          │
    │◀──match──────│                │            │         │         │          │
    │              │                │            │         │         │          │
    │──Call───────▶│                │            │         │         │          │
    │              │──CanAccess────────────────▶│         │         │          │
    │              │◀──allowed──────────────────│         │         │          │
    │              │────────Call(tools/call)─────────────────────────▶│          │
    │              │───────────────sendRPC(stdin,stdout)──────────────▶│─────────▶│
    │              │◀──────────────────resp───────────────────────────│◀─────────│
    │◀──result─────│                │            │         │         │          │
```

### 5.3 Error Recovery Pattern

```
LLM calls broker.MatchIntent("fly a rocket")
  → "No matching tool found (threshold 0.30)"

LLM recovers:
  1. Checks catalog for relevant server capabilities
  2. If no server matches, acknowledges limitation to user
  3. If potentially relevant server exists, tries:
     broker.ExpandServer("relevant-server-name")
     → Gets full tool list, retries with better intent

LLM calls broker.Call(coder, "playwright", "browser_click", args)
  → "Unauthorized: role 'coder' cannot access server 'playwright'"
  → Error includes available_servers hint

LLM recovers:
  → Sees "coder can access: memini-ai-dev, github-mcp"
  → Redirects intent to github-mcp or asks orchestrator to handle browser
```

---

## 6. File Changes Inventory

### 6.1 New Files

| File | Package | Purpose | Tests |
|------|---------|---------|-------|
| `src/neuralgentics/broker/catalog/catalog.go` | `catalog` | `ServerCatalog`, `ServerSummary`, `ToolCatalog` types + `Builder` struct | `catalog_test.go` |
| `src/neuralgentics/broker/catalog/prompt.go` | `catalog` | `FormatForPrompt(catalog)` → system prompt string (markdown table) | `prompt_test.go` |
| `src/neuralgentics/broker/access/access.go` | `access` | `Role` constants, `AccessControl`, `CanAccess()`, `DefaultServerRoles`, `ErrUnauthorized` | `access_test.go` |

### 6.2 Modified Files

| File | Changes |
|------|---------|
| `src/neuralgentics/broker/types/types.go` | Add `Description`, `Capabilities`, `Roles` fields to `ServerConfig`. Add `LastError` field to `ServerStatus` (already exists — verify). |
| `src/neuralgentics/broker/registry/registry.go` | Add `GetCapabilitySummary(serverName) ServerSummary` method. |
| `src/neuralgentics/broker/broker.go` | Change signature: `NewBroker(role)` or `NewBroker()` + `SetRole()`. Add `BuildServerCatalog()`, `InjectPrompt()`, `ExpandServer()`. Modify `Call()` to accept `role` parameter + access check. Modify `MatchIntent()` to optionally filter by role. |
| `src/neuralgentics/broker/proxy/proxy.go` | No changes (already provides `ListTools` and `Call`). |
| `src/neuralgentics/broker/intent/matcher.go` | No changes (already works with `ToolSummary`). |
| `cmd/broker/main.go` | Update demo to exercise catalog + access control. |

### 6.3 Dependency Graph

```
types/types.go          ← foundation types (modified)
       │
       ├── catalog/catalog.go    ← new package (read-only from types)
       ├── catalog/prompt.go     ← format catalog → string
       ├── access/access.go      ← new package (read-only from types)
       │
registry/registry.go     ← already depends on types (modified)
       │
       └── broker.go     ← depends on registry, catalog, access, proxy, intent
              │
              └── main.go  ← demo usage
```

### 6.4 Implementation Order (dependency-respecting)

1. **types/types.go** — Add `Description`, `Capabilities`, `Roles` to `ServerConfig`
2. **catalog/catalog.go** — Define `ServerCatalog`, `ServerSummary`, `ToolCatalog`, `Builder`
3. **catalog/catalog_test.go** — Test catalog building
4. **access/access.go** — Define `Role`, `AccessControl`, `CanAccess`, `DefaultServerRoles`
5. **access/access_test.go** — Test role permissions
6. **registry/registry.go** — Add `GetCapabilitySummary()`
7. **catalog/prompt.go** — `FormatForPrompt()` markdown generation
8. **catalog/prompt_test.go** — Test prompt formatting
9. **broker.go** — Integrate all: `BuildServerCatalog()`, `InjectPrompt()`, `ExpandServer()`, modified `Call()` with access check
10. **main.go** — Update demo

---

## 7. Token Budget Analysis

### 7.1 Full Tool Definitions (Current Worst Case)

For 8 servers with average 20 tools each (160 total tools), assuming each tool definition is ~80 tokens (name + description + inputSchema):

```
160 tools × 80 tokens = 12,800 tokens
```

Repeated across 10 turns in a conversation:
```
12,800 tokens × 10 turns = 128,000 tokens wasted
```

### 7.2 Server Catalog (Proposed)

Each `ServerSummary`:
```
name (5-15 tokens) + description (8-15 tokens) +
capabilities (10-20 tokens) + metadata (5-10 tokens) = ~50 tokens/server
```

For 8 servers:
```
8 servers × 50 tokens = ~400 tokens (catalog structs)
```

Plus prompt framing (~200 tokens for instructions, table header, usage guide):
```
400 + 200 = ~600 tokens total
```

### 7.3 Comparison

| Scenario | Tokens | Reduction |
|----------|--------|-----------|
| Full tool definitions (1×) | 12,800 | — |
| Full tool definitions (10 turns) | 128,000 | — |
| **Server catalog (1×) + ExpandServer on demand** | **600 + (80 × expanded servers)** | **89-95%** |
| Server catalog with 2 ExpandServer calls | 600 + 160 + 160 = 920 | 93% |
| Server catalog with 0 ExpandServer calls | 600 | 95% |

### 7.4 ExpandServer Token Cost

When LLM calls `broker.ExpandServer("memini-ai-dev")`:
```
24 tools × 80 tokens/tool = 1,920 tokens
```

But this is **on-demand** — only when the model actually needs tool-level detail, which should be rare if the intent matcher works well.

---

## 8. Sprint Scope

### 8.1 IN Scope (This Sprint)

| Item | Description | Complexity |
|------|-------------|------------|
| **Catalog types** | `ServerCatalog`, `ServerSummary`, `ToolCatalog` structs | Low |
| **Catalog builder** | `Builder.Build(role)` creates catalog from registry | Medium |
| **ServerConfig extension** | Add `Description`, `Capabilities`, `Roles` fields | Low |
| **Prompt formatter** | `FormatForPrompt()` → markdown table string | Low |
| **Prompt injection API** | `Broker.BuildServerCatalog()` + `Broker.GetPromptSection()` | Low |
| **ExpandServer API** | `Broker.ExpandServer(name)` → full tool list | Low |
| **Access control types** | `Role` constants, `AccessControl` struct, `CanAccess()` | Medium |
| **Default role mapping** | `DefaultServerRoles` map | Low |
| **Access-checked Call()** | Modify `Broker.Call()` to accept role + check access | Medium |
| **ErrUnauthorized hints** | Include available servers in error response | Low |
| **Unit tests** | Tests for catalog, prompt, access (≥85% coverage) | Medium |
| **Integration test** | End-to-end: register → catalog → prompt → match → call | Medium |
| **Demo update** | Show catalog + access in main.go | Low |
| **Design doc** | This document | Done |

**Estimated effort:** ~150 development steps, ~200k tokens.

### 8.2 OUT Scope (Future Sprints)

| Item | Sprint |
|------|--------|
| **Dynamic MCP server discovery** (mDNS/DNS-SD) | Sprint 2 |
| **LLM-based semantic intent matching** (replace keyword matcher with embedding-based) | Sprint 3 |
| **Full ACL system** (per-tool permissions, audit logs) | Sprint 3 |
| **Role inheritance** (agent roles → sub-roles) | Sprint 3 |
| **HTTP/SSE server support** in proxy layer | Sprint 4 |
| **Persistent catalog storage** (SQLite for offline catalogs) | Sprint 4 |
| **Catalog diffing / change notifications** (LLM notified when servers appear/disappear) | Sprint 4 |
| **Token usage telemetry** (measure actual token savings) | Sprint 5 |

### 8.3 Success Criteria

- [ ] `broker.BuildServerCatalog("coder")` returns catalog filtered to coder-accessible servers only
- [ ] `catalog.FormatForPrompt(catalog)` produces valid markdown ≤ 800 tokens for 8 servers
- [ ] `broker.ExpandServer("memini-ai-dev")` returns full `ToolCatalog` with all 24 tools
- [ ] `broker.Call("coder", "playwright", ...)` returns `ErrUnauthorized` with hints
- [ ] `broker.Call("coder", "github-mcp", ...)` succeeds with existing proxy behavior
- [ ] `broker.MatchIntent("query memory")` returns `{memini-ai-dev, query_memories}` (works unchanged)
- [ ] 100% unit test pass rate on new packages
- [ ] `main.go` demo shows full catalog + access flow

---

## 9. Open Questions

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Should `ServerConfig.Description` and `Capabilities` be hardcoded (set at registration) or derived from `tools/list` results? | A) Hardcoded in config B) Auto-generated from tool names/descriptions | **A + B fallback**: Prefer hardcoded for accuracy, auto-generate as fallback when not set. Hardcoded descriptions are more human-friendly. |
| 2 | Should `ExpandServer()` return full tool schemas (`inputSchema`) or just names + descriptions? | A) Full schemas B) Names + descriptions only | **B (names + descriptions).** Full schemas defeat the purpose. If the model needs inputSchema, it should request a specific tool's schema via a separate API. |
| 3 | Where does the broker run relative to the LLM? Same process? Separate process? | A) In-process (Go library) B) Separate process (gRPC/HTTP server) | **Out of scope for this sprint.** Current architecture is in-process. gRPC is a future concern. |
| 4 | Should `DefaultServerRoles` be in code or a config file? | A) Hardcoded Go map B) YAML/JSON config file | **A for now.** Hardcoded is simpler. Move to config when we have >20 servers or dynamic registration. |
| 5 | How does the broker know the LLM's role at session start? | A) Orchestrator passes it B) Inferred from tool usage pattern | **A.** Explicit role parameter in `BuildServerCatalog(role)` and `Call(role, ...)`. |
| 6 | Should `MatchIntent` filter tools by role (so coder only matches coder-accessible tools)? | A) Yes, filter B) No, match all | **A (yes).** Pre-filtered catalog means pre-filtered intent matching. Less confusion for the LLM. |
| 7 | When a server is "stopped," should it still appear in the catalog? | A) Yes (with "stopped" status) B) No (remove from catalog) | **A (show stopped).** The LLM should know a server exists even if it's offline, so it can request it be started. |
| 8 | Should there be a `broker.DescribeServer(name)` that's lighter than `ExpandServer()`? | A) Yes (capabilities only) B) No (ExpandServer is enough) | **B for now.** `ExpandServer` with tool list is the right granularity. If needed later, add a `capabilities_only` flag. |

---

## Appendix A: File Stubs

### A.1 catalog/catalog.go (skeleton)

```go
package catalog

import (
    "neuralgentics-broker/src/neuralgentics/broker/registry"
    "neuralgentics-broker/src/neuralgentics/broker/types"
)

// ServerSummary is ... (see section 2.1 for full definition)
type ServerSummary struct { ... }

// ServerCatalog is ... (see section 2.1 for full definition)
type ServerCatalog struct { ... }

// ToolCatalog is ... (see section 2.1 for full definition)
type ToolCatalog struct { ... }

// ToolSummary is ... (see section 2.1 for full definition)
type ToolSummary struct { ... }

// Builder constructs ServerCatalogs from the registry.
type Builder struct {
    registry *registry.Registry
}

func NewBuilder(reg *registry.Registry) *Builder {
    return &Builder{registry: reg}
}

// Build creates a ServerCatalog filtered by role.
// If role is empty string, all servers are included.
func (b *Builder) Build(role string) *ServerCatalog {
    // Implementation ...
}
```

### A.2 access/access.go (skeleton)

```go
package access

import (
    "fmt"
)

type Role string

const (
    RoleOrchestrator Role = "orchestrator"
    RoleArchitect    Role = "architect"
    RoleCoder        Role = "coder"
    RoleTester       Role = "tester"
    RoleResearcher   Role = "researcher"
    RoleWriter       Role = "writer"
    RoleGit          Role = "git"
    RoleReviewer     Role = "reviewer"
)

// AccessControl manages role-based server access.
type AccessControl struct {
    allowed map[string][]Role // server → allowed roles
}

func NewAccessControl(serverRoles map[string][]Role) *AccessControl {
    return &AccessControl{allowed: serverRoles}
}

// CanAccess returns true if the role can access the server.
func (ac *AccessControl) CanAccess(role string, serverName string) bool {
    // Empty roles list → all allowed
    roles, exists := ac.allowed[serverName]
    if !exists || len(roles) == 0 {
        return true
    }
    for _, r := range roles {
        if string(r) == role {
            return true
        }
    }
    return false
}

// GetAccessibleServers returns all server names accessible to the role.
func (ac *AccessControl) GetAccessibleServers(role string) []string { ... }

// DefaultServerRoles is the built-in role mapping.
var DefaultServerRoles = map[string][]Role{
    "memini-ai-dev": {RoleOrchestrator, RoleArchitect, RoleCoder, RoleTester, RoleWriter},
    "github-mcp":    {RoleOrchestrator, RoleCoder, RoleGit, RoleReviewer},
    "playwright":    {RoleOrchestrator, RoleTester, RoleResearcher},
    "searxng":       {RoleOrchestrator, RoleResearcher, RoleArchitect},
    "webfetch":      {RoleOrchestrator, RoleResearcher},
    "markitdown":    {RoleOrchestrator, RoleArchitect},
}

// ErrUnauthorized is returned when a role cannot access a server.
type ErrUnauthorized struct {
    Role             string
    Server           string
    Reason           string
    AvailableServers []string
}

func (e ErrUnauthorized) Error() string {
    return fmt.Sprintf("unauthorized: %s", e.Reason)
}
```

---

## Appendix B: Registry Extension

### B.1 registry.go additions

```go
// GetCapabilitySummary returns a catalog ServerSummary for a registered server.
// Used by catalog.Builder.Build().
func (r *Registry) GetCapabilitySummary(name string, roles []string) (catalog.ServerSummary, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    entry, ok := r.servers[name]
    if !ok {
        return catalog.ServerSummary{}, ErrServerNotFound{name: name}
    }

    summary := catalog.ServerSummary{
        Name:        name,
        Description: entry.Config.Description,
        Capabilities: entry.Config.Capabilities,
        ToolsCount:  len(entry.Tools),
    }

    // Fallback: generate description from first tool if not set
    if summary.Description == "" && len(entry.Tools) > 0 {
        summary.Description = entry.Tools[0].Description
        if len(summary.Description) > 80 {
            summary.Description = summary.Description[:80] + "..."
        }
    }

    // Fallback: generate capabilities from tool name prefixes
    if len(summary.Capabilities) == 0 {
        summary.Capabilities = inferCapabilities(entry.Tools)
    }

    // Status
    if entry.Process != nil {
        summary.Status = "running"
    } else if entry.Config.Command != "" {
        summary.Status = "stopped"
    } else {
        summary.Status = "registered"
    }

    return summary, nil
}

// inferCapabilities extracts capability tags from tool name prefixes.
// e.g., "browser_click" → "browser", "memory_query" → "memory"
func inferCapabilities(tools []types.ToolSummary) []string {
    seen := make(map[string]bool)
    var caps []string
    for _, t := range tools {
        parts := strings.SplitN(t.Name, "_", 2)
        if len(parts) > 0 && !seen[parts[0]] {
            seen[parts[0]] = true
            caps = append(caps, parts[0])
        }
    }
    return caps
}
```

---

## Appendix C: Token Calculation Methodology

Tokens are estimated using the OpenAI tokenizer approximation:

- **1 token ≈ 4 characters** (English text)
- **1 token ≈ 0.75 words**
- **Go struct JSON serialization** + markdown framing ≈ token count * 1.3x (overhead)

**Catalog entry example breakdown:**
```
server: memini-ai-dev                                    (5 tokens)
description: Semantic memory with trust scoring...        (12 tokens)
capabilities: [memory_query, kg_query, trust_adjust]     (10 tokens)
tools_count: 24                                           (3 tokens)
status: running                                           (2 tokens)
markdown table row padding (~40 chars)                    (10 tokens)
────────────────────────────────────────────────────────
Per-server total: ~42 tokens (rounded up to 50 for safety)
```

Full table with 8 servers + header + instructions:
```
8 × 50 = 400 (server rows)
1 header row = 30
instructions/intro text = ~200
────────────────────────────────────────────────────────
Total: ~630 tokens
```

This is the **one-time cost** at session start. Compare to `ExpandServer()` which returns full tool names (not schemas) at ~30 tokens/tool, or ~600 tokens for a 20-tool server — but this is **never injected into the system prompt** and is only consumed when the LLM explicitly requests it.
