# C.1 — packages/core/ deletion (v0.2.0 cleanup)

## What was deleted
- `packages/core/` — Python package "neuralgentics-core" v0.1.0
- Description: "Intent-to-Tool Broker and Session Log Context Extractor for Neuralgentics"
- Files: src/neuralgentics_core/{__init__.py, config.py, models.py, llm.py, broker.py, extractor.py, server.py, capabilities.json}
- pyproject.toml with FastAPI, uvicorn, pydantic, httpx deps
- 14 files total (including uv.lock and .ruff_cache)

## Why it was dead code
- Not imported anywhere in the project (verified via grep for neuralgentics_core and neuralgentics-core)
- Not in go.work (Go workspace — it's a Python package)
- Not in Makefile (only Go modules + overlay are tested)
- Not in docker-compose.yml (no neuralgentics-core service)
- Not in scripts/install.sh (packages/broker reference exists but not packages/core)
- Not in .opencode/opencode.json
- package.json workspaces glob `packages/*` matches it but nothing depends on it
- README documents `packages/memini-core/` as the canonical memory server, not `packages/core/`
- scripts/serve.sh references it in `start_core()` function but gracefully skips when missing

## Cleanup changes alongside deletion
- scripts/serve.sh: Removed `start_core` function and its invocation from `main()` (lines 162-195)
- scripts/serve.sh: Removed `neuralgentics-core: http://localhost:8902` from status output (line 226)

## Backup location
- Local backup: /tmp/opencode/neuralgentics-core-backup-20260606-120738/core/
- Backup retained for 30 days minimum

## Functionality preserved
- Intent-to-Tool broker: re-implemented in `packages/broker-go/` (canonical Go implementation)
- Session log context extractor: re-implemented in `packages/memini-core/src/memini_core/extractor.py`
- Context extraction: `memini-core` has `precompact_extraction` and `trigger_extraction` MCP tools
