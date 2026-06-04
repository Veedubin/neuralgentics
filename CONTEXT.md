# Neuralgentics Context Document

## 0. v0.1.0 Target (Session 18, design phase — NOT YET IMPLEMENTED)

**Goal**: Replace the overlay plugin with a custom TUI app. OpenTUI for the terminal surface, OpenCode SDK for LLM session control, neuralgentics Go backend as the memory/agent/broker engine. End the "we're a plugin in someone else's TUI" era.

**Why**: User identified a specific pain — "I think we run too long in a session and the agent file isn't being reseeded." The plugin can't control OpenCode's compaction loop. v0.1.0 ships our own compaction loop with memini-ai-aware reseed, plus 5 nextgen features no competitor has.

**Where to read the design**:
- `neuralgentics/docs/design/v4-roll-your-own-app-FINAL.md` (776 lines, main design)
- `neuralgentics/docs/design/v4-FINAL-ADDENDUM-opportunity-detector.md` (668 lines)
- `neuralgentics/docs/design/v4-FINAL-ADDENDUM-2-aggregator-aware-detector.md` (631 lines)
- Total: 2075 lines, 30.75-day build plan, awaiting user approval to begin P0.

**Success criteria** (ranked): #1 Accuracy > #2 Speed > #3 Low tokens.

**5 nextgen features** (where we beat everyone):
1. Persistent semantic memory with trust scoring + dual-model RRF
2. Auto-compaction with memory-aware reseed (fixes the user's bug)
3. Broker-based access control with lazy tool exposure
4. Aggregator-aware skill acquisition (consults 7 external registries: mcpservers.org, orchestra-research, etc.)
5. Chain-of-thought audit trail

**Status**: Design complete. P0 (7.5 days) blocked on user approval + 10 open questions.

---

## 1. What Neuralgentics Is
- Coding-agent layer on OpenCode, NOT a fork.
- **Note**: Pre-Session 11 architecture used direct HTTP to memini-core. Post-Session 11, all memory goes through the Go backend (JSON-RPC stdio). The `memini-core` HTTP service on :8900 is now legacy and not started by `neuralgentics start`.
- **Language split**: Go for memory and backend (performance, distribution), TypeScript for the overlay plugin (OpenCode-native runtime), Python for the embedding sidecar (model compatibility), Bash for automation.
- **Session 18 update**: v0.1.0 will replace the overlay plugin with a custom TUI app (see §0 above). The overlay remains for vanilla OpenCode users who don't want to migrate.

## 2. Current Architecture

```
                Vanilla OpenCode Binary
                          │
                          │ loads
                          ▼
              ┌──────────────────────┐
              │ TypeScript Overlay   │  ← file:// plugin (Session 14)
              │ Plugin               │     (overlay/packages/opencode)
              │ (server.ts)          │
              └──────────┬───────────┘
                         │ stdio JSON-RPC
                         ▼
              ┌──────────────────────┐
              │ Go Backend Binary    │  ← packages/backend-go
              │ (neuralgentics-      │     (14 JSON-RPC handlers,
              │  backend, 26MB)      │      emits 'ready' notification)
              └──────────┬───────────┘
                         │
       ┌─────────┬───────┴───────┬──────────┐
       ▼         ▼               ▼          ▼
   ┌────────┐ ┌────────┐  ┌──────────┐ ┌──────────────┐
   │ memory │ │ orchestr│  │ broker  │ │ gRPC sidecar │
   │   -go  │ │  -ator- │  │  -go    │ │  (Python)    │
   │ 384+   │ │   go    │  │ (MCP    │ │  BGE-Large   │
   │ 1024   │ │ routing │  │  mgmt)  │ │  MiniLM      │
   │ RRF    │ │         │  │         │ │  unix socket │
   └───┬────┘ └────────┘  └────────┘ └──────────────┘
       │
       ▼
  PostgreSQL :6000 (SSL, sslmode=require)
  (neuralgentics-test-pg podman container)
```

### 2a. Go Module Responsibilities

| Module                   | Package                    | Purpose                                                                                                                                    | Test status                       |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `packages/memory`          | `neuralgentics/memory`       | Core memory system: dual-model RRF (384+1024), embeddings, thought chains, knowledge graph, trust engine, tiered loading, project indexing | 17/17 packages, ~349 tests        |
| `packages/orchestrator-go` | `neuralgentics/orchestrator` | Task routing, protocol enforcement, context building, agent dispatch, file ownership, skill registry                                       | 2/2 packages, ~61 tests           |
| `packages/broker-go`       | `neuralgentics/broker`       | MCP server lifecycle management, hot-reload, intent matching, access control, catalog building, proxy                                      | 6/6 packages, ~55 tests (Session 7) |
| `packages/backend-go`      | `neuralgentics/backend`      | JSON-RPC stdio server (main binary entry point), connects all modules, exposes 14 endpoints to the overlay                                 | 0 tests (TODO: Session 7)         |


### How It Differs From boomerang-v3
| Feature | boomerang-v3 | Neuralgentics |
|---------|-------------|----------------|
| Memory interface | 35 MCP tools (~8K tokens) | Direct HTTP calls (~800 tokens) |
| Memory server | `memini-ai-dev` (Python MCP) | `memini-core` (Python HTTP REST) |
| Agent registry | Filesystem `.opencode/agents/*.md` (boomerang-v3) / Baked into OpenCode source via patch 001-agent-registry.patch (neuralgentics, but DEPRECATED post-Session 14 — now loaded as overlay plugin) |
| Update model | Manual upstream sync via `./scripts/update-opencode.sh` (DEPRECATED post-Session 14 — now `npm update @neuralgentics/overlay`) |

## 3. Environment
- **PostgreSQL (prod)**: `localhost:5434` (timescale-pg18 podman container, database: `postgres`) — used by user's memini-ai-dev. **No SSL** (Session 13 user choice: leave as-is).
- **PostgreSQL (test)**: `localhost:6000` (neuralgentics-test-pg podman container, database: `neuralgentics_test`) — **SSL enabled** (Session 13+). Use `?sslmode=require` in connection strings. Self-signed cert at `certs/server.crt`.
- **memini-core**: `localhost:8900` (HTTP) [LEGACY]
- **MCP Broker**: `localhost:8901` (HTTP — built but NOT started by `serve.sh`)
- **neuralgentics-core**: `localhost:8902` (HTTP — intent broker + session log extractor)
- **Tooling**: `bun` for TS build, `uv` for Python, `podman` for containers, `git` for patch management

### Test Database (2026-06-03 — SSL enabled)
```bash
# Test PG container (isolated, pgvector/pgvector:pg17, port 6000)
# NOW WITH SSL — must use ?sslmode=require (or require/verify-full) in connection strings
podman run -d --name neuralgentics-test-pg \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=testpassword \
  -e POSTGRES_DB=neuralgentics_test \
  -v /home/jcharles/Projects/MCP-Servers/neuralgentics/certs:/certs-source:ro \
  -v /home/jcharles/Projects/MCP-Servers/neuralgentics/certs/initdb.d:/docker-entrypoint-initdb.d:ro \
  -p 6000:5432 \
  docker.io/pgvector/pgvector:pg17

# Apply migrations (use ?sslmode=require)
podman exec -i neuralgentics-test-pg psql "postgresql://postgres:testpassword@localhost:5432/neuralgentics_test?sslmode=require" \
  < packages/memory/src/neuralgentics/memory/store/migrations/postgres/000001_initial_schema.up.sql
podman exec -i neuralgentics-test-pg psql "postgresql://postgres:testpassword@localhost:5432/neuralgentics_test?sslmode=require" \
  < packages/memory/src/neuralgentics/memory/store/migrations/postgres/000002_project_chunks.up.sql
podman exec -i neuralgentics-test-pg psql "postgresql://postgres:testpassword@localhost:5432/neuralgentics_test?sslmode=require" \
  < packages/memory/src/neuralgentics/memory/store/migrations/postgres/000003_memories_1024.up.sql
```
**Do NOT run migrations against 5434 — that's the prod DB.**
**Note:** `sslmode=disable` still works (both `host` and `hostssl` rules in pg_hba.conf), but the project convention is now `sslmode=require` for all new connection strings.

## 4. Service Commands
```bash
./scripts/update-opencode.sh    # Clone/update OpenCode, apply patches, build binary
./scripts/regen-patches.sh      # Regenerate patches from modified source
./scripts/build-binary.sh       # Build standalone binary after patches applied
./scripts/serve.sh             # Start memini-core service
./scripts/install.sh             # Install deps and build initial dev setup
./scripts/verify.sh              # Verify installation

./neuralgentics start           # Start memini-core + launch Neuralgentics binary
./neuralgentics serve             # Start memini-core only
./neuralgentics stop              # Stop all services
./neuralgentics status            # Service health check
```

## 5. Service Verification
```bash
curl http://localhost:8900/health
curl http://localhost:8902/health
```

## 6. Agent Registration — RESOLVED
Agents are now **baked directly into OpenCode source** via patch `001-agent-registry.patch`. No `.md` files needed.
- 8 Neuralgentics agents are registered in `src/agent/agent.ts` alongside built-ins
- No filesystem discovery, no `.opencode/agents/` directory needed
- No git worktree boundary issues

## 7. Distribution

### CRITICAL: Do NOT Use OpenCode's Built-in Updater
OpenCode's native updater downloads **vanilla upstream binaries** from GitHub. This will **destroy all Neuralgentics patches** (agents, routing, memory client, rebranding).

**Always use:**
```bash
./scripts/update-opencode.sh    # Fetches upstream, re-applies all 7 patches, rebuilds
```

### Binary Build
```bash
./scripts/update-opencode.sh    # Clone, patch, build
./neuralgentics                # Launch the built binary
```
Build output: `neuralgentics-v<version>-<platform>.tar.gz` (~49MB)

### Launcher (`./neuralgentics`)
Searches for binary in order:
1. `./bin/neuralgentics` (distribution mode)
2. `opencode-base/packages/opencode/dist/opencode-<platform>/bin/opencode` (dev mode)
3. Fails if neither found, suggests running `./scripts/update-opencode.sh`

### Services Started on `neuralgentics start`
- memini-core (port 8900)
- Neuralgentics binary (OpenCode with patches)

### Shutdown on `neuralgentics stop`
- Kills all `memini_core.server` processes

## 8. Updater Interceptor (Patch 007)
When OpenCode detects an upstream update:
1. `upgrade()` in `src/cli/upgrade.ts` runs
2. `NeuralgenticsUpdater.isActive()` returns `true`
3. Custom `UpdateAvailable` event emitted with message: "Neuralgentics update available. Run ./scripts/update-opencode.sh to apply."
4. Vanilla `Installation.upgrade()` is **never called**
5. Binary is protected from overwrite

## 9. Already-Implemented Decisions (Remove from Planning)
- Memory via direct HTTP (not MCP)
- Stateless agent protocol (ContextPackages in memini-core)
- Task state machine (BLOCKED → RESOLVED → COMPLETE)
- FileOwnershipRegistry (non-overlapping task files)
- Dependency graph (Kahn's topological sort)
- Agent ordering: Architect always before Coder
- TUI rebrand: footer + splash to "NEURALGENTICS"
- Port numbers finalized (8900, 8901, 8902)
- Updater intercepted: vanilla updater blocked, custom message shown

## 10. What's Next
**MVP is shipped and hardened (Sessions 10-11)** — dual-write verified with real BGE-Large embeddings, plugin registered, 4 E2E routing tests, broker `ReloadServer` shipped, 3 Go integration tests (dual-write, cascade delete, JSON-RPC subprocess). All 4 Go modules: `go build`, `go vet`, `go test -short` clean.

**Session 12**: clean wrap-up, refreshed docs.

**Session 15d — fix-perms.py REWRITE (DONE)**: Session 13's hand-rolled fix-perms.py had two latent bugs (blank-line-after-tool, regex-required-quoted-line) that re-introduced ConfigFrontmatterError if anyone ran it again. While rewriting, found a third pre-existing bug: missing newline before frontmatter close `---` (the actual root cause of every ConfigFrontmatterError). New script at `boomerang-v3/scripts/fix_perms.py` is YAML-driven, tolerant of all three bug classes, idempotent, and syncs all 3 agent locations to byte-identical content via md5. Only normalizes the actual bug (ensures `permission.tool.memini-ai-dev_*` wildcard is present) — preserves all agent-specific customizations (researcher's webfetch, coder's bash commands, boomerang.md's full task whitelist). Verified: all 15 fixed, all 3 locations synced, second run is zero-diff, gray-matter parses all 15 cleanly, boomerang-v3 quality gates green (typecheck/lint/131 tests). Available as `npm run fix-perms` from boomerang-v3. **User must restart TUI to load the now-synced files.**

**Session 15c — MEMINI-AI MCP CONFIG + AGENT YAML FIX (DONE)**: 12 bugs in the memini-ai-dev MCP env in `opencode.json`. The headline: `MEMINI_EMBEDDING_DIM=1024` was the root cause of the "expected 384 dimensions, not 1024" error that had been blocking `add_memory` for multiple sessions. Plus `LLM_URL` pointing at dead localhost:11434, missing `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_API_KEY` (would have caused ollama-cloud auth failure), `LLM_MODEL=llama3.2` (doesn't exist in ollama-cloud), 4 phantom config vars (`MEMINI_USE_GPU`, `MEMINI_DEVICE`, `MEMINI_EAGER_LOAD`, `MEMINI_PRECISION`) that were never read by any code in `src/`. Also: 11 of 15 agent .md files had broken YAML frontmatter (blank line after `tool:` key, caused by Session 13's `fix-perms.py` regex bug) — silently preventing those agents from loading. All fixed. E2E verified: add_memory persists 384-dim to DB, LLM client works against ollama-cloud. **User must restart TUI to load.**

**Session 15b — GO BACKEND READY SIGNAL + CLIENT TIMEOUT (DONE)**: After Session 15's `package.json` fix unblocked plugin loading, a SECOND hang appeared: the plugin's `waitForReady()` blocks on first stdout line, but the Go backend is a pure request/response JSON-RPC server that only writes to stdout in response to requests. Fix: (1) Go backend now emits a `{"jsonrpc":"2.0","method":"ready"}` notification (no `id`) to stdout immediately after init — the client's existing first-line handler picks it up. (2) Client's `waitForReady()` now has a 10s default timeout so a crashed backend can't hang the plugin forever. E2E verified: ready in 11ms, ping in 0ms. Binary rebuilt, overlay rebuilt. **User must restart TUI to load.**

**Session 15 — OVERLAY PLUGIN PACKAGE.JSON FIX (DONE)**: Root cause of the "opencode hangs on launch when file:// plugin is in config" issue was the overlay's `package.json` having `main: "dist/index.js"` (file doesn't exist) and `exports['.']` pointing at a library file, neither of which was the actual OpenCode plugin entry. Fix: `main` + `types` + `exports['.']` now all point at `./dist/server.js` (the real plugin entry, verified `export default pluginModule` at `dist/server.js:280`). Added `./library` subpath for any future consumer of the library exports. `file://` plugin path re-added to root `opencode.json` — now safe to keep. `npm run typecheck` + `npm run build` clean. Bun-level smoke test passes: `default.id: neuralgentics, default.server: function`. **User must restart TUI to load the fix.** Separate `LLM_URL` bug identified in `memini-ai-dev` MCP config (points at dead localhost:11434) — awaiting user decision.

**Session 14b — PLUGIN DB URL FIX (DONE)**:
- ✅ **Root cause identified**: Go backend's hardcoded default `localhost:5434/neuralgentics` (no sslmode) — `lib/pq` implicitly defaults to `sslmode=require`, which 5434's `ssl=off` rejects. The `pq: SSL is not enabled on the server` error is the migrator dying on first connection.
- ✅ **Plugin fix**: `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` now passes `NEURALGENTICS_DB_URL` in the spawn env, defaulting to `postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require` (the dev DB).
- ✅ **End-to-end verified**: Manually spawned backend with new env → `memory.add` wrote row to 6000 → `memory.query` retrieved it.
- ✅ **Negative case verified**: Without env var → original 5434 default → same `SSL is not enabled` error reproduced.

**Session 14 — SSL WIRING + PLUGIN RE-REGISTRATION (DONE)**:
- ✅ **3 connection URLs updated to `?sslmode=require`**: integration_dualwrite_test.go:21, integration_backend_jsonrpc_test.go:91, smoke-test-mvp.sh:35
- ✅ **`file://` plugin path re-added** to root `opencode.json` (TUI restart required to load)
- ✅ **All 4 Go modules pass quality gates**: build, vet, `go test -short` clean
- ✅ **All 3 integration tests pass with SSL**: dual-write, cascade delete, JSON-RPC subprocess
- ✅ **Smoke test passes (FULL)** with real BGE-Large embeddings, `pg_stat_ssl.ssl=t` confirmed

**Session 13 — PARTIAL SSL + PERMISSIONS**:
- ✅ **SSL on test DB (6000)**: self-signed cert + `hostssl` rule + `ssl = on` in `postgresql.conf`. `pg_stat_ssl.ssl = t` verified for `sslmode=require` connections.
- ✅ **3 connection URLs updated to `?sslmode=require`** (DONE in Session 14)
- ✅ **Agent permissions overhauled**: 15 agents × 3 locations (45 files). `memini-ai-dev_*` wildcard, `webfetch: allow`, `bash "*": allow` (last-match-wins with safety overrides).
- ✅ **`file://` plugin path re-added** to root `opencode.json` (DONE in Session 14)
- ⏳ **User must restart OpenCode TUI** for permission fixes to take effect

**Completed in Session 11 (post-MVP hardening):**
1. ✅ **Wired dual-embed into `MemorySystem.AddMemory`** — calls `embedder.Embed1024()` + `store.AddMemory1024()` when `cfg.EmbeddingMode == auto`. Failure of 1024 write logs warning, does NOT fail 384 write.
2. ✅ **Integration tests for dual RRF** — `integration_dualwrite_test.go` (2 tests, in-process) + `integration_backend_jsonrpc_test.go` (1 test, subprocess + JSON-RPC)
3. 🟡 **Wave 2 Broker Hardening** — `ReloadServer` method + 4 tests shipped; **permission shadowing still pending** (next-session work)
4. ✅ **End-to-end routing verification** — 4 E2E tests in `routing_e2e_test.go` (Go-level, 38 subtests)
5. ✅ **Plugin registered** — `file://` path added to root `opencode.json` (TUI restart required to load)
6. ✅ **Real gRPC embedder verified** — Python sidecar on `unix:///tmp/neuralgentics-embed.sock`, BGE-Large (1024-dim) + MiniLM (384-dim) on CPU. Smoke test reports `PASS (FULL)`.

**Remaining work (prioritized for next session):**
- **User-blocked**: Restart OpenCode TUI to load Session 13's permission fixes + Session 14's plugin re-registration. There are 2 OpenCode sessions running (Jun 01 PID 250631 + Jun 03 08:52 PID 831000) — kill the older one.
- **Autonomous (small)**: Permission shadowing in broker (~30 min)
- **Autonomous (medium)**: Sidecar productionization (auto-start via `neuralgentics start`), BGE-Large GPU OOM investigation, E2E test through overlay without TUI
- **Release engineering** (user decisions): CI/CD, version tagging, multi-arch builds
- See `TASKS.md` TODO list and `HANDOFF.md` Session 14 for full extras.

**Architecture** (from `docs/GO_MEMORY_PLAN.md`):
- **Option A**: Go monolith + gRPC embedding sidecar (recommended)
- Test PostgreSQL on port 6000 (isolated podman container)
- HTTP API from orchestrator → Go server (localhost:8900)
- gRPC for embedding computation (localhost:8903)
- Python embedding sidecar for model compatibility

**Why Go**: Single binary distribution, better performance, native compilation, eliminates Python runtime dependency for the memory layer.

**Files to read first**:
- `docs/GO_MEMORY_PLAN.md` — full architecture plan (approved, awaiting Phase 1)
- `packages/memory/src/neuralgentics/memory/search/hybrid.go` — dual-model RRF mode dispatch
- `packages/memory/src/neuralgentics/memory/memory.go:147` — `AddMemory` dual-write logic (Session 11)
- `packages/memory/src/neuralgentics/memory/integration_dualwrite_test.go` — dual-write test pattern (Session 11)
- `packages/memory/src/neuralgentics/memory/store/migrations/postgres/000003_memories_1024.up.sql` — clean migration

## 9. Files That Exist (Do Not Recreate)
- `packages/orchestrator/` — index.ts, types.ts, context.ts, dependency-graph.ts, task-state-machine.ts, stateless-protocol.ts, stateless.test.ts
- `packages/plugin/` — index.ts, adapters/memory.ts, types.ts
- `packages/core/` — neuralgentics-core service (intent broker + session log)
- `packages/broker/` — MCP broker (server.py, registry.py, proxy.py, launcher.py)
- `packages/memini-core/` — Python memory server
- `.opencode/agents/*.md` — 8 agent definition files (orchestrator, architect, coder, reviewer, explorer, tester, git, writer)
- `.opencode/opencode.json` — provider config, MCP servers, plugin array
- `docs/AGENT_REGISTRATION_RESEARCH.md` — full OpenCode agent discovery research
- `docs/ARCHITECTURE.md` — high-level architecture
- `docs/DESIGN_fine_grained_scoping_v1.md` — latest design doc (keep)
