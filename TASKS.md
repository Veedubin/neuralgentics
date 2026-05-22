# Neuralgentics Tasks

## Project Overview
Neuralgentics is a specialized coding agent built on OpenCode. It follows a hybrid TypeScript/Python architecture and is implemented as a set of plugins and patches applied to the OpenCode base, rather than a fork.

## Component Status

| Component | Language | Status | Files |
|-----------|----------|--------|-------|
| memini-core | Python | Built | server.py, database.py, trust.py, graph.py, embeddings.py, indexer.py, models.py |
| Plugin | TypeScript | Built | index.ts, memory adapter |
| Orchestrator | TypeScript | Built | index.ts, routing.ts, skills.ts, context.ts, types.ts |
| MCP Broker | Python | Built | server.py, registry.py, proxy.py, launcher.py |
| Skills | Markdown | Built | architect.md, coder.md, reviewer.md |
| TUI Patch | .patch file | Written | rebrand.patch |
| Build Scripts | Bash | Built | install.sh, build.sh, serve.sh, update.sh, release.sh, verify.sh |

## Completed Tasks (2026-05-21/22)
- Architect review (corrected: no MCP for native, hybrid TS/Python)
- memini-core Python server (FastAPI, HTTP REST, NO MCP)
- TypeScript plugin + orchestrator
- MCP broker for EXTERNAL tools only
- Skill files
- Build/install/release/update scripts
- File structure verification passes (7/7)
- Wire plugin to OpenCode hooks (COMPLETED)
- Rebrand patch tracking (COMPLETED)
- Port verification (COMPLETED)

## Completed Today (2026-05-22)
- **Started memini-core server** on port 8900
- **Created dedicated PostgreSQL database 'neuralgentics'** to avoid schema conflicts
- **Verified HTTP endpoints**: health, add_memory, query_memories all working
- **Fixed port mismatch**: serve.sh and server.py both now use port 8900
- **Fixed plugin default URL**: 8123 → 8900
- **Added MEMINI_DB_URL to serve.sh**: defaults to neuralgentics database

## Next Steps
- Test orchestrator routing logic
- Add more skill files
- Test auto-updater against GitHub
- Write PostgreSQL schema initialization
- Wire test suite (tests exist but need Python deps in venv)
