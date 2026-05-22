# MCP Broker — External Tools Only

The MCP Broker is a Python FastAPI server that brokers access to **external third-party MCP servers**. It does NOT handle internal native components (orchestrator, memory). Those are handled by the TypeScript plugin directly.

## Architecture

```text
Agent/Model
    │
    ▼
┌──────────────────┐
│  MCP Broker API  │   ← FastAPI routes
│  /register       │
│  /tools          │   ← Token-reduced: NAME + DESCRIPTION only
│  /call           │   ← Unified proxy endpoint
│  /deregister     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│    Registry       │   ← In-memory server tracking
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│    Launcher       │   ← Manages subprocess lifecycles
│  (Docker/NPX/    │
│   Direct)        │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│    MCP Proxy      │   ← JSON-RPC over stdio
└──────────────────┘
```

## Token Reduction Strategy

The agent/model sees only two logical operations:

1. **`get_tool_list`** — Returns tool NAME + DESCRIPTION only (no full JSON schemas)
2. **`mcp_router_call`** — Unified endpoint: `{ server, tool, arguments }`

This drastically reduces token consumption compared to exposing full MCP schemas for every tool.

## Installation

```bash
cd packages/broker
pip install -e ".[dev]"
```

## Running

```bash
uvicorn broker.server:app --host 0.0.0.0 --port 8900 --reload
```

## Example Usage

### Register a Docker MCP server

```bash
curl -X POST http://localhost:8900/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "docker",
    "type": "docker",
    "command": "docker run -i mcp/docker-mcp-server",
    "summary": "Manages Docker containers and images"
  }'
```

### Register an NPX MCP server

```bash
curl -X POST http://localhost:8900/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "type": "npx",
    "command": "@modelcontextprotocol/server-github",
    "summary": "GitHub API integration"
  }'
```

### List available tools (token-reduced)

```bash
curl http://localhost:8900/tools
# Returns: [{"server": "docker", "name": "docker_run", "description": "Run a container"}, ...]
```

### List tools for a specific server

```bash
curl "http://localhost:8900/tools?server=docker"
```

### Call a tool

```bash
curl -X POST http://localhost:8900/call \
  -H "Content-Type: application/json" \
  -d '{
    "server": "docker",
    "tool": "docker_run",
    "arguments": {"image": "nginx", "ports": "80:80"}
  }'
```

### Deregister a server

```bash
curl -X POST http://localhost:8900/deregister \
  -H "Content-Type: application/json" \
  -d '{"name": "docker"}'
```

### Health check

```bash
curl http://localhost:8900/health
# Returns: {"status": "ok"}
```

## Server Types

| Type   | Command Format                    | Example                                      |
|--------|-----------------------------------|----------------------------------------------|
| docker | `docker run -i <image>`          | `docker run -i mcp/docker-mcp-server`        |
| npx    | `npx <package>`                   | `@modelcontextprotocol/server-github`        |
| direct | Any executable with args          | `/usr/local/bin/my-mcp-server --flag`        |

## Protocol

The broker communicates with MCP servers over **stdio using JSON-RPC 2.0**. Each request is a single JSON line on stdin; each response is a single JSON line on stdout.

Initialization is lazy — the broker performs the MCP handshake (`initialize` + `tools/list`) on the first tool call to a server.