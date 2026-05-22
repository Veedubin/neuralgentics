# Neuralgentics Context Document

## 1. Neuralgentics Context
- **What it is**: Coding agent built on OpenCode, NOT a fork.
- **Key Principle**: MCP is banished from native components to reduce overhead and complexity.
- **Language Stack**: 
  - **Python**: Used for memory components (proven, battle-tested).
  - **TypeScript**: Used for the orchestrator (aligns with OpenCode runtime).
  - **Bash**: Used for automation scripts.
- **Rationale**: Retains stable Python memory logic while avoiding the build complexity of a Go-based monolith.

## 2. Repository Structure
- **Schema**: Inherits the same schema as legacy `memini-ai-dev` (PostgreSQL/pgvector, 384-dim MiniLM).
- **Communication**: Direct HTTP JSON between TypeScript (orchestrator) and Python (memory) — eliminates MCP framing overhead.
- **MCP Usage**: Reserved exclusively for EXTERNAL servers via a broker.

## 3. How It Differs From boomerang-v3
| Feature | boomerang-v3 | Neuralgentics |
|----------|-------------|----------------|
| **Memory Interface** | MCP tools (35 tools, ~8K tokens) | Direct HTTP calls (0 MCP tools, ~800 tokens in AGENTS.md) |
| **Memory Implementation** | `memini-ai-dev` (Python MCP Server) | `memini-core` (Python HTTP REST Server) |
| **Overhead** | High (MCP serialization/descriptions) | Low (Simple JSON over HTTP) |

## 4. memini-ai-dev Status
- **Status**: FROZEN. No active development.
- **Purpose**: Kept in the repository for reference and critical bug fixes only.
- **Relation**: `memini-core` (Neuralgentics) is the architectural evolution, NOT a complete rewrite.

## 5. Key Decisions
- **Memory Language**: Python is retained (704 tests, proven stability).
- **Orchestrator Language**: TypeScript (native to OpenCode runtime).
- **Inter-process Comm**: HTTP JSON (simple, inspectable, zero serialization overhead).
- **MCP Boundary**: Only used at the edge for external tools.
- **TUI**: Single patch to OpenCode for rebranding.
- **Distribution**: No npm publishing — installation via git clone + scripts.

## 6. Environment
- **Database**: PostgreSQL at `localhost:5434` (standard setup).
- **memini-core**: Port `8900` (HTTP).
- **MCP Broker**: Port `8901` (HTTP).
- **Tooling**: `Bun` for TypeScript, `uv` for Python.

## 7. Build Commands
```bash
./scripts/install.sh    # Install all dependencies
./scripts/build.sh      # Build all packages
./scripts/serve.sh      # Start services (memini-core on 8900, broker on 8901)
./scripts/verify.sh     # Verify installation
```

## 8. Service Verification
To verify memini-core is running:
```bash
curl http://localhost:8900/health
```

To test memory operations:
```bash
# Add a memory
curl -X POST http://localhost:8900/memory/add \
  -H "Content-Type: application/json" \
  -d '{"content":"Test memory","source_type":"test"}'

# Query memories
curl -X POST http://localhost:8900/memory/query \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
```
