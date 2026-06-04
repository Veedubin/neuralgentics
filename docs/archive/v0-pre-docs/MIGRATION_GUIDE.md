!!! WARNING

    **THIS DOCUMENT IS ARCHIVED AS OF 2026-06-04.**
    It describes an older version of Neuralgentics and may reference
    APIs, install paths, or env vars that no longer exist.

    For current documentation, see:
    <https://neuralgentics.github.io/neuralgentics/>
    or the source under `docs/` in the `main` branch.

---

# Neuralgentics Migration Guide

This guide covers installing and configuring Neuralgentics from source.

## Prerequisites

| Component        | Version | Purpose                           |
|------------------|---------|-----------------------------------|
| Go               | 1.23+   | Build the backend binary          |
| PostgreSQL       | 15+     | Database with pgvector extension  |
| pgvector         | latest  | Vector storage / similarity search |
| Node.js / Bun    | 20+ / 1.3+ | Build the TypeScript overlay   |
| OpenCode         | 1.15.6+ | Host TUI and plugin runtime        |

## Installation Steps

### 1. Build the Go Backend

```bash
cd /home/jcharles/Projects/MCP-Servers/neuralgentics/packages/backend-go
go build -o neuralgentics-backend ./cmd/backend/main.go
```

Place the binary on your `PATH`:
```bash
sudo ln -s $(pwd)/neuralgentics-backend /usr/local/bin/neuralgentics-backend
```

### 2. Configure PostgreSQL

Create the `neuralgentics` database and enable extensions:
```sql
CREATE DATABASE neuralgentics;
\c neuralgentics
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale;  -- PG 18 only
```

Set `NEURALGENTICS_DB_URL`:
```bash
export NEURALGENTICS_DB_URL="postgresql://postgres:password@localhost:5434/neuralgentics"
```

### 3. Build the OpenCode Plugin

```bash
cd /home/jcharles/Projects/MCP-Servers/neuralgentics/overlay/packages/opencode
npm run build
```

Verify `dist/server.js` and `dist/server.d.ts` exist.

### 4. Register the Plugin in OpenCode

Edit `.opencode/opencode.json` and add the plugin path:
```json
{
  "plugin": [
    "@veedubin/boomerang-v3",
    "file:///home/jcharles/Projects/MCP-Servers/neuralgentics/overlay/packages/opencode"
  ]
}
```

Restart OpenCode:
```bash
# macOS
pkill -f "Neuralgentics " && open -a "Neuralgentics "

# Linux / generic
# Quit OpenCode via UI or CLI, then relaunch
```

### 5. Verify Installation

Run in OpenCode chat:
```
/neuralgentics_ping
```

Expected response:
```json
{"ok": true, "result": "pong"}
```

Test memory write and read:
```
/neuralgentics_memory_add{"text":"Test memory entry","sourceType":"session"}
```

Then query it back:
```
/neuralgentics_memory_query{"query":"test entry","limit":5}
```

## Environment Variables

| Variable                  | Default                        | Required | Description                    |
|---------------------------|--------------------------------|----------|--------------------------------|
| `NEURALGENTICS_DB_URL`    | none                           | Yes      | PostgreSQL connection string     |
| `NEURALGENTICS_BACKEND_PATH` | `neuralgentics-backend`    | No       | Path to Go backend binary        |
| `MEMINI_DB_URL`           | none                           | Yes      | Used by legacy Python memini-core |
| `OLLAMA_API_KEY`          | none                           | Yes      | Ollama Cloud API key             |

## Troubleshooting

| Symptom                                  | Cause                         | Fix                                  |
|------------------------------------------|-------------------------------|--------------------------------------|
| "Go backend not initialised"             | Binary not on PATH            | Set `NEURALGENTICS_BACKEND_PATH`     |
| Plugin not appearing in tool list        | `file://` path wrong          | Check absolute path in `opencode.json` |
| Memory query returns empty               | DB not migrated               | Run `go run ./cmd/migrate/main.go`   |
| Broker catalog is empty                  | No MCP servers registered     | Use `neuralgentics_broker_buildCatalog` |

---
*Last updated: 2026-05-30*
