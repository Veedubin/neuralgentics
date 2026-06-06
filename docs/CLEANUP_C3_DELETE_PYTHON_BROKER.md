# C.3 — packages/broker/ (Python) deletion (v0.2.0 cleanup)

## What was deleted
- `packages/broker/` — Python package "mcp-broker" v0.1.0
- Description: "MCP Broker — External Tools Only. Brokers access to third-party MCP servers."
- Files: src/broker/{__init__.py, server.py, registry.py, launcher.py, proxy.py, models.py}
- pyproject.toml with FastAPI, uvicorn, pydantic, httpx deps
- 28 files total (including uv.lock, .ruff_cache, .venv)

## Why it was dead code
- Not imported anywhere in the project (verified via grep for `from broker`, `import broker`, `from mcp_broker`, `import mcp_broker`, `packages/broker`)
- Not in go.work (Python package, not Go)
- Not in Makefile (only Go modules + overlay are tested)
- Not in docker-compose.yml (no mcp-broker service)
- Not in CI workflows (.github/workflows/ci.yml references packages/broker-go, not packages/broker)
- Not in package.json (workspaces glob would match but nothing depends on it)
- All functional references point to `packages/broker-go/` as the canonical Go implementation
- scripts/serve.sh references it in `start_broker()` but gracefully skips when missing ("Broker package not found — skipping")
- README.md install command referenced it (fixed: removed `-e packages/broker` from install line)

## Functionality preserved
- RBAC broker: fully re-implemented in `packages/broker-go/` (canonical Go implementation)
- Tool routing / proxy: in `packages/broker-go/src/neuralgentics/broker/proxy/`
- MCP server registry: in `packages/broker-go/src/neuralgentics/broker/registry/`
- Server launcher: in `packages/broker-go/src/neuralgentics/broker/launcher/`

## Backup location
- Local backup: /tmp/opencode/neuralgentics-broker-python-backup-20260606-120930/broker/
- Backup retained for 30 days minimum