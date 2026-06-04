!!! WARNING

    **THIS DOCUMENT IS ARCHIVED AS OF 2026-06-04.**
    It describes an older version of Neuralgentics and may reference
    APIs, install paths, or env vars that no longer exist.

    For current documentation, see:
    <https://neuralgentics.github.io/neuralgentics/>
    or the source under `docs/` in the `main` branch.

---

# Neuralgentics MCP Broker

The broker manages external MCP servers, reducing tool description token overhead by ~95% and enforcing role-based access control.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (coder / orchestrator / architect)                   │
│  Calls: broker.BuildServerCatalog(role)                     │
│  Sees: ~600 token markdown table (not ~12,800 schemas)       │
└──────────────┬────────────────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────────────────┐
│  Catalog Builder                                              │
│  • Filters servers by role (e.g. coder can't see playwright)│
│  • Formats as markdown table                                 │
└──────────────┬────────────────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────────────────┐
│  Intent Matcher                                               │
│  • Jaccard token-set similarity                               │
│  • Stop word removal + simple stemming                         │
└──────────────┬────────────────────────────────────────────────┘
               │ intent matched → server + tool
┌──────────────▼────────────────────────────────────────────────┐
│  Access Control                                               │
│  • Role → allowed servers mapping (8 roles)                  │
│  • Returns ErrUnauthorized with available servers hint         │
└──────────────┬────────────────────────────────────────────────┘
               │ authorized call
┌──────────────▼────────────────────────────────────────────────┐
│  Proxy                                                        │
│  • Async JSON-RPC reader goroutine                            │
│  • Multiplexes concurrent requests                            │
│  • Routes notifications separately                             │
└──────────────┬────────────────────────────────────────────────┘
               │ stdin/stdout pipes
┌──────────────▼────────────────────────────────────────────────┐
│  Launcher                                                     │
│  • Spawns MCP server child processes via stdio                 │
│  • SIGINT → 5s graceful → SIGKILL                            │
│  • Process health checks via syscall.Signal(0)               │
└───────────────────────────────────────────────────────────────┘
```

---

## Token Reduction

| Approach          | Token Count | Reduction |
|-------------------|-------------|-----------|
| Full tool schemas | ~12,800     | —         |
| Broker catalog    | ~600        | **95%**   |

The broker `FormatForPrompt()` renders a markdown table:

```markdown
| Server     | Description                          | Capabilities    | Tools |
|------------|--------------------------------------|-----------------|-------|
| filesystem | File system operations               | file, io        | 2     |
| memory     | Persistent knowledge graph storage   | memory, search  | 4     |
| playwright | Browser automation                   | browser, scrape | 3     |
```

When the agent needs a specific server, `ExpandServer(name)` returns full tool schemas for that server only.

---

## Role-Based Access Control

```go
DefaultServerRoles = map[string][]string{
    "orchestrator": {"filesystem", "memory", "playwright", "github", "searxng"},
    "coder":        {"filesystem", "memory", "github"},
    "architect":    {"filesystem", "memory", "github", "searxng"},
    "reviewer":     {"filesystem", "memory", "github"},
    "explorer":     {"filesystem", "memory"},
    "tester":       {"filesystem", "memory"},
    "writer":       {"filesystem", "memory"},
    "git":          {"github", "filesystem"},
}
```

If `coder` calls `broker.call("playwright", ...)`:
```json
{
  "error": "role coder cannot access server playwright",
  "available_servers": ["filesystem", "memory", "github"]
}
```

---

## Starting MCP Servers

```go
b := broker.NewBroker()

// 1. Register configuration
b.RegisterServer(types.ServerConfig{
    Name:        "filesystem",
    Command:     "npx",
    Args:        []string{"-y", "@modelcontextprotocol/server-filesystem", "/tmp"},
    Type:        "stdio",
    Description: "File system operations for reading and writing files",
    Capabilities: []string{"file", "io"},
})

// 2. Start lifecycle
err := b.StartServer("filesystem")
//   → launcher spawns child process
//   → proxy starts async reader on stdout
//   → MCP initialize handshake (JSON-RPC 2.0)
//   → tools/list discovery
//   → stores discovered tools in registry

// 3. Use the server
tools := b.ListTools()           // now includes real tools
b.Call("coder", "filesystem", "read_file", args)

// 4. Cleanup on exit
b.DeregisterServer("filesystem")
```

---

## Intent Matching

The matcher uses **Jaccard token-set similarity** with stemming and stop-word removal.

| Intent                  | Top Match            | Score |
|-------------------------|----------------------|-------|
| "delete file"             | `remove_file`          | 0.50  |
| "search my memories"      | `search_memories`      | 0.67  |
| "write data to disk"      | `write_file`           | 0.50  |
| "create new entity"       | `create_entity`        | 0.67  |

Jaccard is a strict improvement over the previous naive substring matcher.

---

## Health Checking

Two levels:

| Method       | What it checks                              | Speed   |
|--------------|---------------------------------------------|---------|
| `Health()`     | Process alive (syscall.Signal(0)) + pipes   | Instant |
| `HealthDeep()` | `Health()` + JSON-RPC `initialize` ping      | ~50ms   |

When queried, returns per-server status maps:
```json
{
  "filesystem": "healthy",
  "memory": "stopped",
  "playwright": "initializing"
}
```

---
*Last updated: 2026-05-30*
