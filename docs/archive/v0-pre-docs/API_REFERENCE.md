!!! WARNING

    **THIS DOCUMENT IS ARCHIVED AS OF 2026-06-04.**
    It describes an older version of Neuralgentics and may reference
    APIs, install paths, or env vars that no longer exist.

    For current documentation, see:
    <https://neuralgentics.github.io/neuralgentics/>
    or the source under `docs/` in the `main` branch.

---

# Neuralgentics API Reference

The `neuralgentics-backend` binary exposes a JSON-RPC 2.0 API over stdio. All methods use the standard JSON-RPC envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "memory.add",
  "params": { "text": "hello world", "sourceType": "session" }
}
```

---

## Error Codes

| Code   | Meaning              | When                                    |
|--------|----------------------|-----------------------------------------|
| -32700 | Parse error          | Invalid JSON in request                 |
| -32600 | Invalid request      | Missing `method` or `jsonrpc` field     |
| -32601 | Method not found     | Unknown method name                     |
| -32602 | Invalid params       | Parameter validation failed             |
| -32603 | Internal error       | Server panic / unhandled error          |

---

## Memory Methods

### `memory.add`

Store a new memory entry.

| Param        | Type   | Required | Description                        |
|--------------|--------|----------|------------------------------------|
| `text`       | string | Yes      | Memory content text                |
| `sourceType` | string | No       | `session`, `file`, `web`, `project`, `thought` |
| `sourcePath` | string | No       | Optional source file path or URL   |
| `metadata`   | object | No       | Key-value metadata (JSON)            |

**Response:** `{ "id": "uuid-string" }`

### `memory.query`

Search memories with semantic or full-text search.

| Param      | Type   | Required | Default    | Description                                    |
|------------|--------|----------|------------|------------------------------------------------|
| `query`    | string | Yes      | —          | Search query text                              |
| `limit`    | number | No       | 10         | Max results                                    |
| `strategy` | string | No       | `tiered`   | `tiered`, `vector_only`, `text_only`, `parallel` |

**Response:** `{ "memories": [...], "total": 42 }`

### `memory.get`

Retrieve a single memory by ID.

| Param | Type   | Required | Description |
|-------|--------|----------|-------------|
| `id`  | string | Yes      | Memory UUID |

### `memory.delete`

Delete a memory by ID.

| Param | Type   | Required | Description |
|-------|--------|----------|-------------|
| `id`  | string | Yes      | Memory UUID |

### `memory.adjustTrust`

Adjust the trust score of a memory entry.

| Param     | Type   | Required | Description                                          |
|-----------|--------|----------|------------------------------------------------------|
| `memoryID`| string | Yes      | Memory UUID                                          |
| `signal`  | string | Yes      | `agent_used`, `agent_ignored`, `user_confirmed`, `user_corrected` |

**Trust adjustments:** `agent_used` +0.05, `user_confirmed` +0.10, `agent_ignored` -0.05, `user_corrected` -0.10

---

## Orchestrator Methods

### `orchestrator.route`

Route a task to the correct agent role.

| Param         | Type   | Required | Description            |
|---------------|--------|----------|------------------------|
| `taskType`    | string | Yes      | Task type string       |
| `description` | string | No       | Task description       |

**Response:** `{ "role": "coder", "confidence": 0.92 }`

### `orchestrator.dispatch`

Dispatch one or more tasks.

| Param   | Type   | Required | Description                   |
|---------|--------|----------|-------------------------------|
| `tasks` | array  | Yes      | Array of `Task` objects       |

### `orchestrator.handleTask`

Synchronous task handler.

| Param         | Type   | Required | Description         |
|---------------|--------|----------|---------------------|
| `task`        | object | Yes      | Task specification  |

### `orchestrator.completeCycle`

Finalize a task cycle — save result to memory, adjust trust.

| Param    | Type   | Required | Description           |
|----------|--------|----------|-----------------------|
| `taskID` | string | Yes      | Task identifier       |
| `result` | object | Yes      | Task result data        |

---

## Broker Methods

### `broker.buildCatalog`

Build a token-reduced server catalog for the current role.

| Param  | Type   | Required | Default       | Description        |
|--------|--------|----------|---------------|--------------------|
| `role` | string | No       | `orchestrator`| Agent role         |

**Response:** `{ "servers": [...], "totalTools": 12 }`

The catalog is formatted as a markdown table (~600 tokens vs ~12,800 for full schemas).

### `broker.call`

Call a tool on a specific MCP server.

| Param        | Type   | Required | Description         |
|--------------|--------|----------|---------------------|
| `serverName` | string | Yes      | MCP server name     |
| `toolName`   | string | Yes      | Tool name           |
| `args`       | object | No       | Tool arguments      |

**Response:** `{ "result": ... }`

### `broker.matchIntent`

Match an intent to the best available tool.

| Param    | Type   | Required | Description            |
|----------|--------|----------|------------------------|
| `intent` | string | Yes      | User intent text       |
| `role`   | string | No       | Agent role (for filtering) |

**Response:** `{ "server": "filesystem", "tool": "read_file", "score": 0.87 }`

Uses Jaccard token-set similarity for matching.

---

## Lifecycle Methods

### `initialize`

Handshake called by the plugin on connection. Prepares the backend.

| Param           | Type   | Required | Description                 |
|-----------------|--------|----------|-----------------------------|
| `dbUrl`         | string | No       | Override database URL       |
| `projectID`     | string | No       | Project namespace           |

### `shutdown`

Graceful shutdown. Closes PostgreSQL pool, flushes logs.

### `ping`

Health check. Returns `"pong"`.

---

## Example Session

```json
// 1. Initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}

// 2. Add memory
{"jsonrpc":"2.0","id":2,"method":"memory.add","params":{"text":"Important design decision: use Go for backend","sourceType":"session"}}

// 3. Query memory
{"jsonrpc":"2.0","id":3,"method":"memory.query","params":{"query":"design decision Go backend","limit":5}}

// 4. Build broker catalog
{"jsonrpc":"2.0","id":4,"method":"broker.buildCatalog","params":{"role":"orchestrator"}}

// 5. Shutdown
{"jsonrpc":"2.0","id":5,"method":"shutdown","params":{}}
```

---
*Last updated: 2026-05-30*
