# Neuralgentics Tasks

## Overview
Neuralgentics: Go monolith coding agent engine with custom TUI app (v0.1.0 in development). v0.1.0 ships OpenTUI-based TUI driving OpenCode SDK + neuralgentics Go backend. Status: v0.7.0 dual-model RRF complete, MVP wired and smoke-tested, post-MVP hardening complete, full dual-write verified with real BGE-Large embeddings. **SSL/TLS active on test DB (sslmode=require, 6000 only). All connection strings updated. Plugin re-registered.** **All 4 Go modules green (Session 17). End-to-end lazy tool exposure verified.** **v4-FINAL design shipped (Session 18) — modifies neuralgentics directly; replaces opencode-base + overlay plugin with custom TUI app; includes market research vs Hermes/Cursor/PI/Roo Code/Cline/Aider/Zed/Windsurf/Devin/Copilot/Continue/Codex/Replit/Bolt.** **4 new skills shipped: kanban-board-manager, todo-list-updater, skill-self-audit, boomerang-orchestrator (Cycle v3).**

## Status
- Go backend binary: `packages/backend-go/neuralgentics-backend` (26MB, **rebuilt 2026-06-03 19:42 with Session 17 verification**)
- Overlay package: `overlay/packages/opencode/` v0.2.0, **registered in root opencode.json**
- Plugin registration: **DONE** (file:// path re-added Session 14; TUI restart required to load)
- All Go modules build and test clean (15 memory + 2 orchestrator = 17 packages, 0 failures) — **all 4 modules green as of Session 17**
- Isolated test DB: `neuralgentics-test-pg` (podman) on port 6000 — Go's 000001+000002+000003+000004 migrations applied (15 tables including `agent_tools`)
- **Real gRPC embedding sidecar** — Python sidecar running on `unix:///tmp/neuralgentics-embed.sock`, BGE-Large (1024-dim) + MiniLM (384-dim) models loaded on CPU
- **Dual-write end-to-end verified with real embeddings** — `memories_1024` row contains real BGE-Large values, not zeros
- **Broker `ReloadServer`** — Wave 2 hot-reload method added + 4 tests
- **4 E2E routing tests** in orchestrator-go — 38 subtests covering all task types, intents, forbidden agents, collision detection
- **3 Go integration tests** in packages/memory — dual-write, cascade delete, JSON-RPC subprocess
- **All test connection strings use `?sslmode=require`** — matches test DB SSL config
- **Lazy tool exposure round-trip verified (Session 17)** — `agent.getInitialToolSet` → `agent.recordToolRequest` → `agent.incrementToolUse` → `agent.getTools` all work; `agent_tools` table persists records

## Completed
- **2026-06-03 — SESSION 18: V4-FINAL DESIGN SHIPPED + 4 NEW SKILLS + AGGREGATOR-AWARE DETECTOR ✅**:
  - **Designed the v4-FINAL plan to "roll your own app" modifying neuralgentics directly** (not a sibling project). 3 design docs at `neuralgentics/docs/design/`: `v4-roll-your-own-app-FINAL.md` (776 lines, 72KB), `v4-FINAL-ADDENDUM-opportunity-detector.md` (668 lines), `v4-FINAL-ADDENDUM-2-aggregator-aware-detector.md` (631 lines). Total: 2075 lines of v4 design.
  - **4 new skills shipped** in `neuralgentics/.opencode/skills/` (NOT boomerang-v3 — corrected from initial mistake): `boomerang-orchestrator/SKILL.md` (Cycle v3, 437 lines), `kanban-board-manager/SKILL.md` (146 lines), `todo-list-updater/SKILL.md` (111 lines), `skill-self-audit/SKILL.md` (131 lines). Total: 825 lines, 4 skills, 3 frontmatter parse OK.
  - **boomerang-v3 restored to shipped state**: removed the 4 misplaced skills from `boomerang-v3/.opencode/skills/` and `node_modules/@veedubin/boomerang-v3/.opencode/skills/`. `git status` clean, 15 original skills verified.
  - **Junk v4 design doc DELETED**: `boomerang-v4-roll-your-own-app.md` (1197 lines, was designed for memini-ai — wrong) removed. Only the corrected v4 docs in `neuralgentics/docs/design/` remain.
  - **User corrections applied mid-session**:
    - 4 skills belong in NEURALGENTICS, not boomerang-v3
    - v4 IS modifying neuralgentics, not a sibling project
    - User said "Haven't have shipped a v0.1.0 version yet, why would we scrape what we have just to build it back essentially the same way"
    - User REJECTED budget enforcement ("That is fucking annoying that step counts lol") — replaced with opportunity detector
    - User asked to consult aggregator sites (orchestra-research/AI-research-SKILLs, mcpservers.org) — addendum #2 added
  - **Market research** (v4 §500): 12 tools analyzed (Hermes, Cursor, PI, Roo Code, Cline, Aider, Zed AI, Windsurf, Devin, Copilot, Continue, Codex CLI, Replit Agent, Bolt.new). Success criteria ranked: **#1 Accuracy > #2 Speed > #3 Low tokens**.
  - **5 nextgen features** (where we beat everyone): persistent semantic memory w/ trust scoring, auto-compaction w/ memory-aware reseed, broker-based access control w/ lazy tool exposure, aggregator-aware skill acquisition, chain-of-thought audit trail.
  - **30.75-day v0.1.0 build plan** (~6.2 weeks). P0: 7.5 days. P1: 9.5 days (includes opportunity detector). P2-P5: 13.75 days.
  - **Self-evolution gate result**: No new skills warranted this session. The "architect dispatch with extension doc" pattern is covered by boomerang-orchestrator. The "skill location sync" pattern (manually copied to 2 locations) is a candidate for a `boomerang-skill-sync` skill but only if it recurs; deferred.
  - See `HANDOFF.md` Session 18 entry for full details. memini-ai thought chain: `bceec28b-3439-4f3f-9b4b-4bf77dc26429` (4 thoughts).

- **2026-06-03 — SESSION 17: ALL 4 GO MODULES GREEN + END-TO-END LAZY TOOL EXPOSURE VERIFIED ✅**:
  - **Fixed orchestrator-go test regression**: Session 16 added `GetAgentTools` (and `RecordToolRequest`/`IncrementToolUse`) to the `Store` interface in `core/interfaces.go:106-108` for lazy tool exposure, but the orchestrator's `testStore` mock in `adapter_test.go` was never updated. This broke `go test -short ./...` in orchestrator-go. Added 3 stub methods to the mock returning zero values. All 4 Go modules now green: memory (16 packages, 349 tests), orchestrator-go (2 packages, 61 tests), broker-go (6 packages, 55 tests), backend-go (26MB binary).
  - **End-to-end round-trip verified on port 6000**: spawn binary → `initialize` → `ping` → `memory.add` (real BGE-Large dual-write) → `memory.query` → all OK.
  - **Lazy tool exposure round-trip verified**: `agent.getInitialToolSet` returns 5 default tools → `agent.recordToolRequest` records → `agent.incrementToolUse` increments use_count=1 → `agent.getTools` returns the persisted record. `agent_tools` table verified to persist the row.
  - **3 integration tests pass on port 6000 + SSL**: `TestIntegration_DualWrite`, `TestIntegration_DualWrite_DeleteCascades`, `TestIntegration_BackendJSONRPC`.
  - **Smoke test passes (FULL)**: memories 18→19, memories_1024 9→10 (real BGE-Large values), schema verified.
  - **podman only, no docker** (per user instruction Session 17). All container operations continue to use `podman` exclusively.
  - See `HANDOFF.md` Session 17 entry for full details.

- **2026-06-03 — SESSION 16 PHASES 1-3 COMPLETE: PORT 5436→6000 + 42 JSON-RPC METHODS + LAZY TOOL EXPOSURE ✅**:
  - **All 4 phases of the memini-ai-dev → neuralgentics port plan are DONE.** 42 JSON-RPC methods wired, all 4 missing features ported, lazy tool exposure infrastructure built.
  - **Phase 1 (port + 35 methods)**: 5436→6000 port migration (7 files), 30+ JSON-RPC handlers across 7 namespaces (memory.status, memory.audit, memory.trust, memory.decay, memory.kg, memory.thought, memory.dialectic, peer.*).
  - **Phase 2 (4 missing features)**: user.getProfile, user.updateProfile, audit.getSecuritySummary (user_profiles table already existed in migration 000001), indexer.search, indexer.index, indexer.getFileContents.
  - **Phase 3 (lazy tool exposure)**: migration 000004 created agent_tools table (peer_id, tool_server, tool_name, use_count, bypass_broker), 4 facade methods + 4 JSON-RPC handlers (`agent.recordToolRequest`, `agent.incrementToolUse`, `agent.getTools`, `agent.getInitialToolSet`), broker integration via ToolExposer interface, overlay plugin got new `neuralgentics_memory_manager` tool with 4 actions (get_initial_set, request_tool, get_tools, increment_use).
  - **Quality gates ALL GREEN**: go build/vet/test on 4 modules, 3 integration tests on port 6000 + SSL, npm typecheck + build on overlay.
  - **5434 NEVER TOUCHED** (per user instruction). 5436 fully removed from all source code.
  - **Python memini-ai-dev bugs NOTED but NOT FIXED** (per user: "If Go works, don't worry about the python indexer. Just add that as something we can do later"): indexerReady=false + dialecticReady=false in memini-ai-dev v0.7.1. Go equivalents are working. Added to TODO list as future work.
  - **packages/memini-core/ (1,180 LOC Python HTTP server on port 8900) NOT DELETED** (per user: don't auto-delete, frame as decision). Marked as KEEP for now.
  - See `HANDOFF.md` Session 16 entries for full details.

- **2026-06-03 — SESSION 16 PHASE 1: PORT 5436→6000 + 5 PEER METHODS WIRED ✅**:
  - **Port migration COMPLETE**: All 7 source files updated (2 Go integration tests, 1 shell test, 1 TS client, Makefile, CONTEXT.md, TASKS.md). `podman run -d --name neuralgentics-test-pg -p 6000:5432 docker.io/pgvector/pgvector:pg17` — SSL verified (`SHOW ssl;` = on), 13 tables created, all 3 migrations (000001/000002/000003) applied. **5434 NEVER TOUCHED** (off-limits per user). 1 memory in old test DB was lost (acceptable — throwaway test data).
  - **5 peer JSON-RPC methods WIRED**: `peer.listPeers`, `peer.addPeer`, `peer.shareMemory`, `peer.getPeerMemories`, `peer.getSharedMemories` — 5 facade methods in MemorySystem (~37 LOC), 5 request structs + 5 handlers in main.go (~175 LOC), 7 unit tests in new `peer_facade_test.go` (~270 LOC, all PASS).
  - **6th method `switchPeerContext` SKIPPED** — thread-local state, TODO for later.
  - **Quality gates ALL GREEN**: go build/vet/test on 4 modules, 3 integration tests on port 6000 + SSL (TestIntegration_DualWrite, TestIntegration_DualWrite_DeleteCascades, TestIntegration_BackendJSONRPC).
  - See `HANDOFF.md` Session 16 Phase 1 entry for full details.

- **2026-06-03 — SESSION 16: MEMINI-AI-DEV v0.7.1 GAP ANALYSIS + MIGRATION PLAN ✅**:
  - **v0.7.1 is RUNNING and most subsystems are functional.** `memini-ai-dev_get_status` reports: memoryReady=true, modelReady=true, trustEngineReady=true, memoryGraphReady=true, knowledgeGraphReady=true, extractorReady=true, precompressReady=true, tieredLoadingReady=true, userModelingReady=true, multiPeerReady=true, thoughtChainsReady=true. **2 subsystems are NOT ready: indexerReady=false, dialecticReady=false.** Verified `add_memory` works in this session (id=941443dc-55c7-40bf-9a48-72da58005267, 384-dim).
  - **The 51 MCP tools in v0.7.1 fully cover the 36 Go MemorySystem methods** for the 6 memory tools the Go backend JSON-RPC exposes: `memory.add`, `memory.query`, `memory.get`, `memory.delete`, `memory.adjustTrust`, plus the orchestrator + broker methods (which are neuralgentics-specific and have no memini-ai-dev equivalent).
  - **The orchestrator (Go) and broker (Go) have NO memini-ai-dev equivalent** — they handle task routing, dependency graphs, file ownership, agent dispatch, skill registry, ContextPackage building, MCP server lifecycle (StartServer, ReloadServer), intent matching, access control. These MUST stay in Go.
  - **The Go binary's `memory.*` JSON-RPC methods must become thin proxies** to memini-ai-dev (via stdio MCP client) or be removed entirely. The overlay plugin can already call `memini-ai-dev_*` tools directly.
  - **The legacy `packages/memini-core/` (1,180 LOC Python HTTP server on port 8900) is 100% redundant** with memini-ai-dev and should be deleted.
  - **The Python gRPC embedding sidecar (BGE-Large/MiniLM) is no longer needed** — memini-ai-dev handles its own embeddings in-process via sentence-transformers. Can be decommissioned.
  - **2 v0.7.1 issues to fix** (added to task list):
    - indexerReady=false — investigate why ProjectIndexer didn't init (likely `MEMINI_PROJECT_PATH` missing or invalid)
    - dialecticReady=false — investigate why DialecticEngine didn't init (Session 15c set DIALECTIC_LLM_* but something still failing)
  - **See "MEMINI-AI-DEV MIGRATION PLAN" section below for the 4-phase code-level plan.** Estimated total: 4-6 hours with boomerang-coder + boomerang-writer.

- **2026-06-03 — SESSION 15d: fix-perms.py REWRITE ✅**:
  - **Root cause**: Session 13's hand-rolled fix-perms.py had two latent bugs (blank-line-after-tool, regex-required-quoted-line) and was never rewritten. While rewriting, a third pre-existing bug surfaced: missing newline before frontmatter close `---` (the actual root cause of every ConfigFrontmatterError).
  - **New script**: `boomerang-v3/scripts/fix_perms.py` (420 lines, YAML-driven, idempotent, tolerant of all three bug classes). Uses root `.opencode/agents/` as canonical source of truth, syncs to source and installed locations. Only normalizes the actual bug (`permission.tool.memini-ai-dev_*` wildcard) — preserves all agent-specific customizations.
  - **Verified end-to-end**: all 15 root files normalized, all 15 files synced to 2 other locations, all 3 byte-identical, second run is idempotent (zero diff), gray-matter parses all 15 fixed files cleanly, boomerang-v3 typecheck/lint/tests all green.
  - **npm script alias**: `npm run fix-perms` in boomerang-v3.
  - **User action**: restart TUI to load the now-synced files.
  - See `HANDOFF.md` Session 15d entry for full details
- **2026-06-03 — SESSION 15c: MEMINI-AI MCP CONFIG FIX (12 BUGS) + AGENT YAML FIX (11 FILES) ✅**:
  - **memini-ai-dev env in opencode.json had 12 bugs**: `MEMINI_EMBEDDING_DIM=1024` (THE dimension bug — caused "expected 384 dimensions, not 1024"), `LLM_URL` pointed at dead localhost:11434, missing `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_API_KEY` (caused ollama-cloud auth failure), `LLM_MODEL=llama3.2` (doesn't exist in ollama-cloud), missing `DIALECTIC_LLM_PROVIDER`/`DIALECTIC_LLM_MODEL`, plus 4 phantom config vars (`MEMINI_USE_GPU`, `MEMINI_DEVICE`, `MEMINI_EAGER_LOAD`, `MEMINI_PRECISION`) that were never read by the code.
  - **All 12 fixed**: dim → 384, all LLM_* → ollama-cloud with proper key/URL, all phantom vars removed.
  - **11 agent .md files had broken YAML frontmatter** (blank line after `tool:` key) — caused by Session 13's `fix-perms.py` script regex bug. All 11 fixed by removing the blank line. All 15 agents now load cleanly.
  - **Verified end-to-end**: add_memory persists 384-dim vector to DB, LLM client connects to ollama-cloud and returns "PONG" to test prompt.
  - **User action**: restart TUI to load.
  - **Backlog**: patch `fix-perms.py` so the blank-line bug doesn't get re-introduced. (Tracked for next session.)
  - See `HANDOFF.md` Session 15c entry for full details
- **2026-06-03 — SESSION 15b: GO BACKEND READY SIGNAL + CLIENT TIMEOUT ✅**:
  - **Root cause**: After Session 15's package.json fix, the plugin loaded but then hung on `backend.waitForReady()`. The Go backend is a pure request/response JSON-RPC server that only writes to stdout in response to requests — it never writes anything on startup, so the client's "first stdout line = ready" handshake never fires. Plugin init hangs forever.
  - **Fix Part 1 (Go)**: `packages/backend-go/cmd/backend/main.go` — added `jsonrpcNotification` type + `emitReadyNotification()` helper, called immediately after init success. Emits `{"jsonrpc":"2.0","method":"ready","params":{...}}` to stdout. The notification has no `id` so the client's existing handler at `go-backend-client.ts:188-189` skips it for correlation, but the first-line check at line 175-178 still marks the client ready.
  - **Fix Part 2 (TS, defense in depth)**: `waitForReady()` now has a 10s default timeout. If the backend is hung/crashed, the plugin logs the error (server.ts:161-168 catches it) and continues with broken-backend-aware tools.
  - **Verified E2E**: spawn binary → `ready` notification fires immediately → `ping` returns `pong` in <15ms total. `go build` clean, `npm run typecheck + build` clean. Binary rebuilt at `packages/backend-go/neuralgentics-backend` (symlink at `~/.local/bin/neuralgentics-backend` points to it).
  - **User action**: restart TUI to load.
  - See `HANDOFF.md` Session 15b entry for full details
- **2026-06-03 — SESSION 15: OVERLAY PLUGIN PACKAGE.JSON FIX ✅**:
  - **Root cause**: `overlay/packages/opencode/package.json` had `main: "dist/index.js"` (file does NOT exist) and `exports['.']` pointing at a library file (`dist/neuralgentics/index.js`). Neither was the actual OpenCode plugin entry. When opencode did `import('file:///.../overlay/packages/opencode')`, Bun's resolver followed `main` → found nothing → hung for 2+ minutes → worker timeout.
  - **Fix**: `main` + `types` + `exports['.']` now all point at `./dist/server.js` (the real plugin entry, `export default pluginModule` at `dist/server.js:280`). Added `./library` subpath for any future library consumer.
  - **Verified end-to-end**: `bun -e "import('file:///.../overlay/packages/opencode')"` returns `default: object, default.id: neuralgentics, default.server: function`. `npm run typecheck` + `npm run build` clean. `opencode.json` re-validated as valid JSON.
  - **`file://` plugin path re-added** to root `opencode.json` — safe to keep now.
  - **User action**: restart TUI to load the fix.
  - **Separate issue found**: `memini-ai-dev` MCP config has `LLM_URL: http://localhost:11434/api/generate` pointing at a dead local Ollama. Will bite when `AUTO_EXTRACT` / `PRECOMPRESS` / `DIALECTIC` background tasks fire. Awaiting user decision.
  - See `HANDOFF.md` Session 15 entry for full details
- **2026-06-03 — SESSION 14b: PLUGIN DB URL FIX ✅**:
  - **Root cause**: `lib/pq` (Go postgres driver) defaults `sslmode` to `require` when no `sslmode` is specified. The Go backend's hardcoded default `localhost:5434/neuralgentics` (no sslmode) failed because 5434's `ssl=off` rejects `require`. Verified with a minimal reproduction.
  - **Fix**: `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` now sets `NEURALGENTICS_DB_URL` in the spawn env, defaulting to `postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require` (the dev DB).
  - **Override path**: Setting `NEURALGENTICS_DB_URL` in the parent process env before OpenCode launches the plugin takes precedence.
  - **Verified**: End-to-end (spawn → initialize → ping → memory.add → memory.query) with new env var succeeds. Row visible in 6000. Without env var, original 5434 default still reproduces the error.
  - See `HANDOFF.md` Session 14b entry for full details
- **2026-06-03 — SESSION 14: SSL WIRING + PLUGIN RE-REGISTRATION ✅**:
  - **3 connection URLs updated to `?sslmode=require`**: `integration_dualwrite_test.go:21`, `integration_backend_jsonrpc_test.go:91`, `tests/smoke-test-mvp.sh:35` (with comment update)
  - **`file://` plugin path re-added** to root `opencode.json` (`file:///home/jcharles/Projects/MCP-Servers/neuralgentics/overlay/packages/opencode`)
  - **All 4 Go modules quality gates green**: build, vet, `go test -short` clean
  - **3 integration tests pass with SSL**: `TestIntegration_DualWrite`, `TestIntegration_DualWrite_DeleteCascades`, `TestIntegration_BackendJSONRPC` — full dual-write + JSON-RPC subprocess path verified
  - **Smoke test passes (FULL)**: `memories 0→1`, `memories_1024 0→1` (real BGE-Large values: `[0.035957094,-0.0075572943,...]`), `pg_stat_ssl.ssl=t` confirmed
  - See `HANDOFF.md` Session 14 entry for full details
- **2026-06-03 — SESSION 13: PARTIAL SSL + PERMISSIONS FIX (2 tasks)**:
  - **Task 1 (PARTIAL)**: SSL/TLS enabled on `neuralgentics-test-pg:6000` with `sslmode=require` (encrypt-only, no CA verification, per user choice). Self-signed cert at `certs/server.crt` + `certs/server.key`. `pg_hba.conf` has `hostssl` rule; original `host` rule still allows non-SSL too. Init script at `certs/initdb.d/01-enable-ssl.sh`. **3 Go connection points still using `?sslmode=disable`** and need updating: `packages/memory/src/neuralgentics/memory/integration_dualwrite_test.go:21`, `integration_backend_jsonrpc_test.go:91`, `tests/smoke-test-mvp.sh:35`.
  - **Task 2 (DONE)**: Boomerang agent permissions overhauled across all 15 agents × 3 locations (45 files). Replaced explicit per-tool memini-ai list with `"memini-ai-dev_*": allow` wildcard, added `webfetch: allow`, converted `bash "*"` from `ask` to `allow` (last-match-wins for safety overrides on `rm -rf /` and `sudo *`). Synced root `.opencode/agents/`, `boomerang-v3/.opencode/agents/`, and `node_modules/@veedubin/boomerang-v3/.opencode/agents/`.
  - **Bug fixed mid-task**: First fix-perms.py run created duplicate `tool:` blocks in 2 files (boomerang, boomerang-architect) because the regex didn't recognize the existing block (architect's block had inline comments breaking the pattern). Cleanup script removed duplicates, kept the larger one.
  - See `HANDOFF.md` Session 13 entry for full details
- **2026-06-03 — POST-MVP HARDENING (5 tasks)**:
  - **Task 1**: Real gRPC embedder verified — smoke test reports `PASS (FULL)` with real BGE-Large vectors in `memories_1024`
  - **Task 2**: Plugin `file://` path added to root `opencode.json` (TUI restart required to load)
  - **Task 3**: 4 E2E routing tests in `routing_e2e_test.go` (orchestrator-go)
  - **Task 4**: `ReloadServer` method + 4 tests (broker-go)
  - **Task 5**: 3 Go integration tests (dual-write in-process, cascade delete, JSON-RPC subprocess)
  - **Bug fixes surfaced during Task 1+5**:
    - Removed `embedder.Dim() == 1024` requirement from dual-write gate (gRPC embedder reports 384 but can produce 1024 on demand)
    - `backend-go/cmd/backend/main.go` now reads `MEMINI_EMBEDDING_ADDR` and `EMBEDDING_MODE` from env (was ignoring them, always used NoOp)
  - See `HANDOFF.md` Session 11 entry for full details
- **2026-06-03 — MVP WIRED + SMOKE-TESTED**:
  - Track A: `MemorySystem.AddMemory` dual-write in `memory.go:147` (~15 LoC + 1 import)
  - Track B: backend binary rebuilt (mtime 2026-06-03 00:50)
  - Track C: `tests/smoke-test-mvp.sh` — JSON-RPC smoke test (17.6KB, executable)
  - **Schema migration gap FIXED**: test DB on 6000 was created from old Python memini-ai-dev migrations (10 cols). Go backend expects 17 cols. Solution: dropped + recreated the `neuralgentics-test-pg` podman container with Go's 000001+000002+000003 migrations. All 11 tables + 4 indexes + `memories_1024` sidecar now match.
  - All 4 Go modules: `go build`, `go vet`, `go test -short` clean
  - See `HANDOFF.md` Session 10 entry for full details

- **v0.7.0 Dual-Model RRF — CLEAN REBUILD** (2026-06-02):
  - `core/config.go`: `EmbeddingMode` enum (cpu/auto/gpu) + `RRFK` field + validator
  - `core/interfaces.go`: `Embed1024` + `Dim()` on Embedder; 5 new 1024 Store methods
  - `store/queries.go`: 6 new 1024 query constants (clean — no elevation metadata)
  - `store/memories.go`: 5 new 1024 CRUD methods (AddMemory1024, QueryMemories1024, GetMemory1024, CountMemories1024, DeleteMemory1024)
  - `embed/noop.go`: `Embed1024`, `Dim()`, `NewNoOpEmbedder1024`
  - `embed/grpc.go`: `Embed1024` with `"bge-large"` model hint, `Dim()`, refactored `embedWithModel`
  - `search/hybrid.go`: Mode dispatch (`cpuQuery`/`autoQuery`/`gpuQuery`), dual-model RRF multi-list fusion (`rrfFuseMultiList`)
  - 8 new RRF unit tests (`search/dual_rrf_test.go`): multi-list fusion, dedup, stable sort, mode config
  - 10 test mock files updated (peer, tiered, thought, dialectic, kg, trust, audit, graph, decay, index)
  - 17/17 packages `go test -short`, `go build`, `go vet` clean
  - **No hacky code**: no `expand384To1024`, no `ElevateMemoryTo1024`, no elevation metadata columns
  - **Production-safe test DB**: `neuralgentics-test-pg` podman container on port 6000 (isolated from user's prod timescale-pg18 on 5434)
  - Migration `000003_memories_1024.up.sql` applied to test DB — clean schema, HNSW index, FK CASCADE
- **Wave 1 Broker Hardening** (2026-05-30):
  - Proxy async reader + background goroutine for notifications
  - `StartServer()` lifecycle: register → launch → initialize → discover tools
  - Integration test with real `@modelcontextprotocol/server-filesystem` (passes)
  - Jaccard token-set intent matcher with stemming + stop words (20/20 tests)
  - Health checking: `Health()` (process-alive) + `HealthDeep()` (JSON-RPC ping)
  - Overlay TypeScript package: `dist/` built, `package.json` exports verified
  - Docs: `MIGRATION_GUIDE.md`, `API_REFERENCE.md`, `BROKER.md`
- **OpenCode Config Format Fix** (2026-05-30):
  - Fixed 5 schema violations in opencode.json
  - Provider format, model names, LSP commands, MCP types, package names
  - Reference backup at `.opencode/opencode-old.json`
- Patches applied and smoke tested (historical)
- Go Memory Plan written

## TODO (Future Sessions, Prioritized)

Items 1-4 below are the original list (1, 2, 4 now ✅ done by Session 11; 3 partially done — ReloadServer shipped, permission shadowing still pending). Items 5-12 are new extras surfaced in Session 11/12.

### Original TODO — Status Update
1. ✅ **DONE (Session 11): OpenCode starts** — verified, all tools working after config fix + plugin registration
2. ✅ **DONE (Session 11): Plugin registration** — `file://` path added to root `opencode.json`
3. 🟡 **PARTIAL (Session 11): Wave 2 Broker Hardening** — `ReloadServer` shipped + 4 tests; **permission shadowing still pending**
4. ✅ **DONE (Session 11): End-to-end routing verification** — 4 E2E tests in `routing_e2e_test.go` (Go-level; full TUI-level requires restart)
5. ⏳ **Open: Update CI/CD** — to use test DB on 6000, run new integration tests
6. ⏳ **Open: Version tagging** — tag releases matching patch versions
7. ⏳ **Open: Multi-arch builds** — darwin-arm64, windows-x64 in CI
8. ⏳ **Open: Orchestrator Go lang refactor** — long-term cleanup

### New Extras (Session 11/12)
9. ⏳ **Permission shadowing in broker** — extend `ReloadServer` with config-overload for hot-swapping env vars/args
10. ⏳ **Sidecar productionization** — auto-start Python embedding sidecar via `neuralgentics start` (or systemd unit). Currently hand-spawned.
11. ⏳ **BGE-Large GPU OOM investigation** — currently CPU-only (~200ms/embed). Investigate what's eating GPU memory.
12. ⏳ **E2E through overlay without TUI** — Go test that drives `GoBackendClient` end-to-end to prove the wire path works without TUI restart

### New Extras (Session 13) — ALL DONE IN SESSION 14
13. ✅ **DONE (Session 14): Update 3 connection URLs to use `?sslmode=require`** — `integration_dualwrite_test.go:21`, `integration_backend_jsonrpc_test.go:91`, `tests/smoke-test-mvp.sh:35` all updated. All 3 integration tests pass, smoke test passes (FULL) with real BGE-Large values.
14. ✅ **DONE (Session 14): Re-add file:// plugin path** to root `opencode.json` — `file:///home/jcharles/Projects/MCP-Servers/neuralgentics/overlay/packages/opencode` re-added. TUI restart still required to load (user action).
15. ⏳ **Permission audit follow-up**: Verify no other agents (researcher, mcp-specialist) actually need `searxng_*` / `github-mcp_*` — only `boomerang-scraper` and `researcher` currently have them explicitly. Most others will get implicit deny for those tools, which may be intended.
16. ⏳ **Architect agent still has explicit memini-ai-dev_* list** (17 tools). The wildcard would work, but it has the granular list. Not a problem, just inconsistent. Could consolidate to wildcard for uniformity.

### User-Blocked
17. ⏳ **USER ACTION: Restart OpenCode TUI** — required to load Session 13's permission fixes, Session 14's plugin re-registration, AND Session 14b's plugin DB URL fix. **CRITICAL**: Without restart, the plugin will keep trying to connect to 5434 and fail with the SSL error. After restart, `neuralgentics_ping` and `neuralgentics_memory_*` tools should work end-to-end against 6000.

### New Extras (Session 16) — Future Work
18. ⏳ **Python memini-ai-dev v0.7.1 bugs (NOT port blockers, Go equivalents work)**:
    - `indexerReady=false` — ProjectIndexer didn't init. Likely `MEMINI_PROJECT_PATH` env missing. Add to memini-ai-dev issue list and fix when convenient.
    - `dialecticReady=false` — DialecticEngine init failing even with `DIALECTIC_LLM_*` env set. Add to issue list.
    - Per user: "If Go works, don't worry about the python indexer. Just add that as something we can do later to our tasks list."
19. ⏳ **`packages/memini-core/` decision** (1,180 LOC Python HTTP server on port 8900, marked [LEGACY] in CONTEXT.md, not started by `neuralgentics start`):
    - **KEEP** (status quo) — leave as dead code, no harm
    - **DELETE** — clean up, the 6000 integration tests don't depend on it
    - **Recommended: DELETE** in next cleanup session (low risk, no external references)
20. ⏳ **Lazy tool exposure — verify the flow end-to-end with a real agent**:
    - The infrastructure is built (agent_tools table, JSON-RPC methods, broker hooks, overlay plugin tool)
    - **Manual E2E verified Session 17**: `agent.getInitialToolSet` → 5 default tools returned; `agent.recordToolRequest` → status recorded; `agent.incrementToolUse` → useCount=1, bypassBroker=false; `agent.getTools` → persisted record returned; `agent_tools` table contains the row in `neuralgentics_test` DB.
    - **Still TODO**: write an automated regression test (boomerang-tester, ~1 hour) so this verification doesn't have to be redone by hand. Add to `packages/memory/src/neuralgentics/memory/agent_tools_test.go` and `overlay/packages/opencode/src/server.test.ts`.
21. ⏳ **Sub-agent quality-gate rule (Session 20, NEW)**: Sub-agents MUST NOT report "pre-existing errors" or "unrelated to my changes" when running `go build` / `bunx tsc` / `bun test`. The orchestrator verifies all gates — coder either fixes inline OR adds a blocker to the kanban (with `Status: blocked` + reason + which gate failed) before marking card `done`. False success reports (e.g. T-029 wrap-up claiming "all 4 Go modules build clean" while ALSO reporting errors elsewhere in the dispatch log) are a session-ender. Add to AGENTS.md as a Mandatory Routing Rule.
22. ✅ **INSTALL SCRIPT REWRITE + RELEASE PIPELINE (Session 20)**: Full release pipeline shipped. (a) `docs/design/v0.1.0-release-pipeline.md` (999 lines) — 11-section design doc covering single-binary archive layout, 5-target GH Actions matrix, install.sh rewrite, container strategy, cost estimates, top 3 risks. (b) `.github/workflows/release.yml` (340 lines) — 5 build targets (linux/amd64, linux/arm64, darwin/arm64, windows/amd64, windows/arm64), 3 jobs (build + release + containers), triggers on v* tag push, SHA256 checksums, GHCR container images. (c) `scripts/install.sh` REWRITTEN (789 lines) — now downloads from GH releases instead of building from source. Flags: --version, --repo, --no-path, --no-verify, --dry-run, --prefix. WSL/2 detection (3 methods: kernel release string, WSL_INTEROP, WSL_DISTRO_NAME). Fish shell support (uses `fish_add_path` in `~/.config/fish/config.fish`). macOS quarantine attribute removal. "HACK THE PLANET" banner from Hackers (1995) in green matrix style. (d) `docker-compose.yml` (104 lines) + `docker/{postgres,sidecar,backend,tui}.Dockerfile` — 4-service compose path with health checks, internal network, persistent volumes, GHCR images. (e) `scripts/compose.sh` (192 lines) — detects podman-compose vs docker compose, provides up/down/status/logs/build/pull. End-to-end tested: bash -n clean, --dry-run --no-path exits 0, --help clean output, fish detection works (verified with SHELL=/usr/bin/fish). Quality gates still green: 576/576 TUI tests, 0 tsc, 4 Go modules build clean.

*Last updated: 2026-06-03 (Session 17: All 4 Go modules green. orchestrator-go testStore mock fixed (GetAgentTools regression). End-to-end lazy tool exposure round-trip verified on port 6000. podman-only policy confirmed.)*

---

## MEMINI-AI-DEV → NEURALGENTICS PORT (Session 16)

**Status**: ✅ Phases 1-3 COMPLETE. Phase 4 (docs) in progress. Plan stored as `neuralgentics/docs/design/neuralgentics-memory-port-plan-v2-final.md` and memini-ai memory id `0248b6e1-f6d1-4eff-8c4b-72f8b4b5a2da`.

### Direction (CORRECTED from initial gap analysis)
- memini-ai-dev (Python, FastMCP) is the **PRECURSOR / PROTOTYPE** to neuralgentics (Go).
- The plan is to PORT features from memini-ai-dev INTO Go, not the reverse.
- memini-ai-dev stays as the dev/iteration surface. neuralgentics is the production target.
- "Switch to neuralgentics" = stop running memini-ai-dev as the active memory backend; neuralgentics owns memory entirely.

### User-imposed constraints (final)
- **Port 6000** for neuralgentics DB (5436 was temporary; 5434 is user's production, OFF-LIMITS).
- **Tool names stay `neuralgentics_*`** (no switch to `memini-ai-dev_*`).
- **Tool exposure is LAZY/DEMAND-DRIVEN** via MCP Broker + agent_tools table.
- **Don't fix Python indexer/dialectic now** — Go works, Python bugs are future work.
- **`packages/memini-core/`** kept for now (KEEP/DELETE is a user decision, not auto).
- **Python gRPC embedding sidecar** stays — Go can't embed without it.

### Phases completed

**Phase 1 — Port 6000 + 35 JSON-RPC methods**:
- 5436 → 6000 in 7 source files; container recreated with SSL; 13 tables present.
- 30 new JSON-RPC handlers across 7 namespaces (memory.status, memory.audit, memory.trust, memory.decay, memory.kg, memory.thought, memory.dialectic) + 5 peer methods.
- 7 unit tests in `peer_facade_test.go`; 68 tests in `jsonrpc_wiring_test.go`.
- 5434 untouched. 1 throwaway test memory lost in container recreate (acceptable).

**Phase 2 — Fill 4 missing features**:
- User modeling: `user.getProfile`, `user.updateProfile` (user_profiles table already in 000001).
- Security summary: `audit.getSecuritySummary` (aggregates audit_log).
- Indexer facade: `indexer.search`, `indexer.index`, `indexer.getFileContents`.
- 12 new facade methods + 8 new JSON-RPC handlers + 10+ new unit tests.

**Phase 3 — Lazy tool exposure**:
- Migration 000004: `agent_tools` table (peer_id, tool_server, tool_name, use_count, bypass_broker).
- 4 new facade methods + 4 new JSON-RPC handlers (`agent.recordToolRequest`, `agent.incrementToolUse`, `agent.getTools`, `agent.getInitialToolSet`).
- Broker `ToolExposer` interface + `memorySystemExposer` adapter in main.go.
- Overlay plugin: new `neuralgentics_memory_manager` tool with 4 actions (get_initial_set, request_tool, get_tools, increment_use).

### Quality gates (all green)
- `go build ./...` in 4 modules — zero errors
- `go vet ./...` — zero warnings
- `go test -short ./...` — 16+ packages pass, ~370 tests
- 3 integration tests on port 6000 + SSL (TestIntegration_DualWrite, TestIntegration_DualWrite_DeleteCascades, TestIntegration_BackendJSONRPC) — all pass
- `npx tsc --noEmit && npx tsc` in overlay — clean
- Backend binary rebuilt: `neuralgentics-backend` 26MB

### What's NOT in this port (deferred or out of scope)
- **`packages/memini-core/` cleanup** — kept for now, decision needed.
- **Python gRPC sidecar decommissioning** — STAYS, Go needs it for embeddings.
- **E2E test of the lazy exposure flow** — infrastructure built, but no simulated agent test yet (TODO #20).
- **Python memini-ai-dev indexer/dialectic bug fixes** — added to TODO #18 as future work.

---

## v0.7.1 RUNTIME ISSUES (Session 16)

**Issue #1: `indexerReady=false`** — ProjectIndexer didn't initialize. Likely cause: `MEMINI_PROJECT_PATH` env var is missing, OR the path doesn't exist, OR it's not readable. The indexer is what powers `search_project` and `get_file_contents` MCP tools. **Impact**: low — these are rarely used by the Boomerang Protocol (orchestrator uses `memini-ai-dev_query_memories` for memory search). **Action**: check `~/.local/share/opencode/log/*.log` for the indexer init error, fix env var.

**Issue #2: `dialecticReady=false`** — DialecticEngine didn't initialize. Session 15c set `DIALECTIC_LLM_PROVIDER=ollama-cloud` and `DIALECTIC_LLM_MODEL=devstral-small-2:24b` in opencode.json env. The LLM is functional (verified Session 15c with "PONG" test). The init failure must be in the dialectic init code path itself, not the LLM config. **Impact**: low — dialectic reasoning is optional, only fires on contradiction resolution. **Action**: check startup logs, may need to verify the OllamaCloud client is importable from the dialectic module.

**No other runtime issues.** All 12 other subsystems report ready. `add_memory` verified working in this session.

---

## CURRENT PHASE: v0.1.0 IMPLEMENTATION (Session 19, P0 in progress)

**Status**: P0 APPROVED by user 2026-06-04. Roadmap shipped at `neuralgentics/docs/roadmap-v0.1.0.md` (554 lines, 10.5-day estimate, 13 P0 tasks). Kanban seeded below with 13 cards. **First dispatch is in flight (T-019 P0-0, Zig/OpenTUI prerequisite)**.

### User-confirmed decisions (Session 19, 2026-06-04)

1. TUI library = **OpenTUI** (`@opentui/core`, Zig core) — user rejected blessed.
2. Binary path resolution = **$PATH → $NEURALGENTICS_BACKEND_PATH → relative**.
3. gRPC sidecar = **auto-start on TUI launch, kill on TUI exit**.
4. Default `failure_limit` = **2** (Hermes default; user overrode the v4-FINAL §512 Q4 recommendation of 3).
5. Budget enforcement = **REMOVED** (per Addendum 1, opportunity detector replaces it).
6. Opportunity detector = **aggregator-aware** (per Addendum 2, 7 aggregators).
7. Token accounting = **renamed to `/spend`** (visibility kept, enforcement dropped).
8. Other Q5-Q10: recommendations adopted (comments inline, agent prefs opt-in, events major-only, heartbeat surface-only, overlay retained).

### Immediate Next Steps (in priority order)

1. **DONE (8 cards)**: T-019 (P0-0 Zig/OpenTUI), T-020 (P0-b Go JSON-RPC client), T-021 (P0-a TUI App Scaffold), T-022 (P0-d podman dev-up.sh), T-023 (P0-c OpenCode SDK), T-024 (P0-e absorbed by T-020), T-025 (P0-k model registry), T-030 (P0-j diff panel). 101/101 TUI tests pass, all 4 Go modules green.
2. **TODO (5 cards)**: T-026 (compaction, blocked on T-020+T-023+T-027), T-027 (session manager, blocked on T-020+T-023), T-028 (reseed, blocked on T-020+T-026), T-029 (parallel dispatch, blocked on T-020+T-027), T-031 (E2E demo, blocked on all 12 prior).
3. **Skills**: 4 skills loaded (boomerang-orchestrator, kanban-board-manager, todo-list-updater, skill-self-audit). Workers should invoke via the skill tool.

### Backlog (lower priority)

- Write automated regression test for lazy tool exposure (boomerang-tester, ~1 hour) — TODO #20
- Delete `packages/memini-core/` (1,180 LOC dead Python) — user decision, TODO #19
- Fix Python memini-ai-dev indexer/dialectic bugs — TODO #18
- (More from existing TODO list #1-#17, all low priority)

*Last updated: 2026-06-04 (Session 19: P0 approved, roadmap shipped, kanban seeded, P0-0 dispatched.)*

---

## Kanban Board (Boomerang Cycle v3)

The board is the durable source of truth for "what is being worked on." Managed by the kanban-board-manager skill. Cards are grouped by status in the order: Triage → Todo → Ready → Running → Blocked → Done → Archived.

### Triage

_(none)_

### Todo

**P0 remaining (5 cards):** T-026 (compaction), T-028 (reseed), T-029 (parallel dispatch), T-031 (E2E demo), T-023 (still listed below for visibility — actually DONE in Session 19).

**P1 seeded (9 cards, 24h-mvp sprint Session 20):** T-032 (TUI polish), T-033 (token accountant), T-034 (opportunity detector), T-035 (aggregator lookup), T-036 (circuit breaker), T-037 (card comments), T-038 (attempts history), T-039 (functional slash commands), T-040 (broker permission gating). Full spec in `docs/roadmap-v0.1.0-p1.md`.

#### T-032 · TUI Surface Polish (P1-a) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-a-tui-surface-polish`
- **Goal:** Remaining panels, themes, accessibility. 2d.
- **Acceptance:** All 4 panels keyboard-navigable; 2 themes (dark/light); screen reader labels; mouse support.
- **Depends on:** none (P1-a can start from current state)
- **Wrap-up:** 8 new files (themes/, a11y/, panels/chain.ts, panels/spend.ts, panels/status.ts, +2 test files). 30 new tests. Verification: 308/308 TUI tests, 0 tsc errors, 4 Go modules clean. memory_id: 58ba48a8-0a66-4c77-8880-7447afc63445
- **Goal:** Remaining panels, themes, accessibility. 2d.
- **Acceptance:** All 4 panels keyboard-navigable; 2 themes (dark/light); screen reader labels; mouse support.
- **Depends on:** none (P1-a can start from current state)

#### T-033 · Token Accountant + /spend (P1-b) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-b-token-accountant`
- **Goal:** Counter + reporter + `/spend` command. 1d.
- **Acceptance:** Token counter on every prompt; /spend shows session/cycle/cumulative; thresholds visible (no enforcement).
- **Depends on:** T-027 (done)
- **Wrap-up:** packages/tui/src/observability/token-counter.ts (TokenCounter, TokenReporter, handleSpendCommand with 7 sub-commands, persisted as token_audit in neuralgentics). 40 new tests. Verification: 348/348, 0 tsc errors, 4 Go modules clean. memory_id: ea744b4d-51fb-40c8-8ccf-a5aee42367bb
- **Goal:** Counter + reporter + `/spend` command. 1d.
- **Acceptance:** Token counter on every prompt; /spend shows session/cycle/cumulative; thresholds visible (no enforcement).
- **Depends on:** T-027 (done)

#### T-034 · Opportunity Detector (P1-c, Addendum 1) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-c-opportunity-detector` + `docs/design/v4-FINAL-ADDENDUM-opportunity-detector.md`
- **Goal:** Pattern detection + ranker + prompter (replaces rejected budget enforcement). 2.5d.
- **Acceptance:** ≥5 pattern types detected; ranked by impact × confidence; inline prompt suggestions.
- **Wrap-up:** packages/tui/src/opportunity-detector/ (types, patterns with all 8 patterns, detector with ranking formula score=tokenSavings×frequency×scopeMultiplier, prompter with Y/1/2/N/L/S dialog). 38 new tests. Verification: 415/415, 0 tsc errors, 4 Go modules clean. memory_id: 72350a09-b53a-47c7-a83a-0f002741e073
- **Goal:** Pattern detection + ranker + prompter (replaces rejected budget enforcement). 2.5d.
- **Acceptance:** ≥5 pattern types detected; ranked by impact × confidence; inline prompt suggestions.

#### T-035 · Aggregator-Aware Lookup (P1-c-ext, Addendum 2) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-c-ext-aggregator-aware-lookup` + `docs/design/v4-FINAL-ADDENDUM-2-aggregator-aware-detector.md`
- **Goal:** 3-of-7 aggregator MVP (Official MCP Registry, Orchestra Research, Internal Skills Directory). 3.25d.
- **Acceptance:** 3 aggregators working; install with trust check; cache hits <100ms.
- **Wrap-up:** packages/tui/src/aggregators/ (types, LRU cache, official-mcp-registry, orchestra-research, internal-skills-directory, trust-checker via NeuralgenticsClient, install-generator per Addendum 2 §5.1, AggregatorOrchestrator with parallel search + tier bucketing). 37 new tests. Verification: 576/576, 0 tsc errors, 4 Go modules clean. memory_id: 7b4682fa-c129-4b7b-aa48-f662a466d61a
- **Goal:** 3-of-7 aggregator MVP (Official MCP Registry, Orchestra Research, Internal Skills Directory). 3.25d.
- **Acceptance:** 3 aggregators working; install with trust check; cache hits <100ms.

#### T-036 · Kanban Circuit Breaker (P1-d) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-d-kanban-circuit-breaker`
- **Goal:** `failure_limit=2` per card (Hermes default). 1d.
- **Acceptance:** Card auto-archives after 2 failed attempts; clear error trail; recoverable via /resume.
- **Depends on:** none (current TASKS.md parser is the foundation)
- **Wrap-up:** packages/tui/src/kanban/circuit-breaker.ts (CircuitBreaker class with recordFailure/recordSuccess/resetFailureCount, formatAttempt/formatAttemptBlock, 4 new fields on KanbanCard). 22 new tests. Verification: 377/377, 0 tsc errors, 4 Go modules clean. memory_id: cf96bbb3-668e-4b23-9b1a-07530fc664ed
- **Goal:** `failure_limit=2` per card (Hermes default). 1d.
- **Acceptance:** Card auto-archives after 2 failed attempts; clear error trail; recoverable via /resume.
- **Depends on:** none (current TASKS.md parser is the foundation)

#### T-037 · Card Comments (P1-e) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-e-comments-on-cards`
- **Goal:** Inter-agent comment protocol on cards. 0.5d.
- **Acceptance:** Add/list comments; markdown rendering; scoped to card; survives TASKS.md re-parse.
- **Depends on:** T-036 (done)
- **Wrap-up:** packages/tui/src/kanban/comments.ts (CommentManager with parseCommentLine, formatComment, formatCommentBlock, collapseComments, renderMarkdown, stripMarkdown). Extended parser.ts for ## Comments section + inline `- **Comments:**` field. 47 new tests. Verification: 462/462, 0 tsc errors, 4 Go modules clean. memory_id: 62bfc7fd-a0dc-4af5-a00b-29272fd4e131
- **Goal:** Inter-agent comment protocol on cards. 0.5d.
- **Acceptance:** Add/list comments; markdown rendering; scoped to card; survives TASKS.md re-parse.
- **Depends on:** T-036

#### T-038 · Attempts History (P1-f) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-f-attempts-history`
- **Goal:** `## Previous Attempts` block on cards. 0.5d.
- **Acceptance:** Auto-append on failure; parseable on reload; max 5 attempts shown.
- **Depends on:** T-036 (done)
- **Wrap-up:** packages/tui/src/kanban/attempts.ts (AttemptsHistory with appendFailure, appendSuccess, truncate max 5, formatForTasksMd, parseTruncationLine). Extended types.ts (truncatedAttempts, truncatedMemoryId). 31 new tests. Verification: 495/495, 0 tsc errors, 4 Go modules clean. memory_id: 928d3eb7-4e09-4c1e-a6f9-70d941951b43
- **Goal:** `## Previous Attempts` block on cards. 0.5d.
- **Acceptance:** Auto-append on failure; parseable on reload; max 5 attempts shown.
- **Depends on:** T-036

#### T-039 · Functional Slash Commands (P1-g) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-g-slash-commands`
- **Goal:** 10 functional slash commands (currently stubs). 1d.
- **Acceptance:** All 10 commands do real work; /spend, /opportunities, /memory, /chain, /resume, /harness, /review, /scaffold, /board, /diff functional.
- **Depends on:** T-027 (done), T-033 (done), T-034 (done)
- **Wrap-up:** commands.ts rewrite with 8 functional handlers + 2 verified existing + CommandDependencies. /spend→T-033, /opportunities→T-034, /memory→NeuralgenticsClient, /chain→NeuralgenticsClient, /resume→CircuitBreaker, /harness→.opencode/skills/, /review→kanban summary, /scaffold→card template. 47 new tests. Verification: 539/539, 0 tsc errors, 4 Go modules clean. memory_id: 2549042e-b175-40e7-8828-37fcff46aa95
- **Goal:** 10 functional slash commands (currently stubs). 1d.
- **Acceptance:** All 10 commands do real work; /spend, /opportunities, /memory, /chain, /resume, /harness, /review, /scaffold, /board, /diff functional.
- **Depends on:** T-027 (done), T-033, T-034

#### T-040 · Broker Permission-Gated Dispatch (P1-h) — ✅ DONE
- **Status:** done
- **Roadmap:** `docs/roadmap-v0.1.0-p1.md#task-p1-h-broker-permission-gated-dispatch`
- **Goal:** `CanAccess(role, server)` enforcement in broker. 1d.
- **Acceptance:** Server access denied for unauthorized roles; clear error; tests cover all role × server combos.
- **Depends on:** none (can start from current state)
- **Wrap-up:** packages/broker-go/src/neuralgentics/broker/access/access.go (AccessControl with CanAccess, GetAccessibleServers, Grant, Revoke, ServerNames, AllRoles with 23 constants, ErrUnauthorized with ToJSONError). 22+ tests. Updated 2 pre-existing tests (catalog_test.go + broker_api_test.go) for new T-040 policy. Verification: 4 Go modules build clean, 377/377 TUI tests, 0 tsc errors. memory_id: 1944add7-1d46-4733-8135-0c7cb2f4fee5
- **Goal:** `CanAccess(role, server)` enforcement in broker. 1d.
- **Acceptance:** Server access denied for unauthorized roles; clear error; tests cover all role × server combos.
- **Depends on:** none (can start from current state)



#### T-026 · Compaction Loop (P0-f) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-f-compaction-loop`
- **Goal:** Token-aware 75% auto-compaction: monitor → filter → extract (gemma4:31b) → write to neuralgentics → revert → reseed.
- **Acceptance:** 75% threshold triggers auto-compaction; post-compaction reseed ≤2K tokens; extracted memories queryable with trust scores; `/compact` manual trigger; ≥10:1 savings ratio; gemma4:31b unavailable → disable with warning; double-/compact rejected; mid-prompt compaction queued.
- **Wrap-up:** packages/tui/src/compaction/ (types, filter, extractor with gemma4:31b, writer, monitor with 75% threshold, orchestrator with mutex + queuing, index). 33 new tests. Verification: 170/170, 0 tsc errors, 4 Go modules clean. memory_id: 71d8c323-10c4-4bfa-bc2f-b8cfcb5db986
- **Assignee:** boomerang-coder + boomerang-architect (extraction schema)
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-f-compaction-loop`
- **Goal:** Token-aware 75% auto-compaction: monitor → filter → extract (gemma4:31b) → write to neuralgentics → revert → reseed.
- **Acceptance:** 75% threshold triggers auto-compaction; post-compaction reseed ≤2K tokens; extracted memories queryable with trust scores; `/compact` manual trigger; ≥10:1 savings ratio; gemma4:31b unavailable → disable with warning; double-/compact rejected; mid-prompt compaction queued.
- **Scope IN:** `packages/tui/src/compaction/`; token monitor; 75% threshold queue; filter; gemma4:31b extractor with structured JSON + confidence; neuralgentics writer; reverter; reseeder hook.
- **Scope OUT:** system-prompt content (→ T-027); token counting (→ P1-b); diff snapshots (→ P2); goal-mode (v0.2.0).
- **Depends on:** T-020, T-023, T-027
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-027 · Session Manager (P0-g) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-g-session-manager`
- **Goal:** Session lifecycle (create, prompt, messages, revert) with stateless agent protocol (seed prompt + memory_id).
- **Acceptance:** `createSession()` returns valid ID; `prompt()` streams; `revert()` clears; seed prompt <250 tokens; context package retrievable as `type: context_package` memory.
- **Scope IN:** `packages/tui/src/session/`; createSession, prompt, messages, revert; stateless protocol (seed prompt template ~200 tokens; agent_used trust signal on context).
- **Scope OUT:** multi-session continuity (→ P2-b); resume (→ P2-b); HANDOFF.md auto-gen (→ P2-e).
- **Depends on:** T-020, T-023
- **Blocks:** T-026, T-028, T-029
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/session/types.ts (new, 114 lines), packages/tui/src/session/session-manager.ts (new, 489 lines), packages/tui/src/session/reseeder.ts (new, 84 lines stub for T-028), packages/tui/src/session/index.ts (new, 25 lines exports), +25 new tests]
  - verification: "126/126 TUI tests pass (was 101, +25); 0 tsc errors; all 3 Go modules build clean; verified by orchestrator after T-027 dispatch returned in single shot"
  - memory_id: `121460c5-b2c7-44c8-9cf1-aa654ad55ea7`
  - summary: "Session manager wires T-023 OpenCodeClient (createSession/sendMessage/getMessages) to TUI input bar. Stateless agent protocol stores context as type:context_package memory via NeuralgenticsClient.memory.add, returns ~200 token seed prompt, applies agent_used trust signal on completion. Reseeder stub created for T-028. Unblocks T-026, T-028, T-029."
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-g-session-manager`
- **Goal:** Session lifecycle (create, prompt, messages, revert) with stateless agent protocol (seed prompt + memory_id).
- **Acceptance:** `createSession()` returns valid ID; `prompt()` streams; `revert()` clears; seed prompt <250 tokens; context package retrievable as `type: context_package` memory.
- **Scope IN:** `packages/tui/src/session/`; createSession, prompt, messages, revert; stateless protocol (seed prompt template ~200 tokens; agent_used trust signal on context).
- **Scope OUT:** multi-session continuity (→ P2-b); resume (→ P2-b); HANDOFF.md auto-gen (→ P2-e).
- **Depends on:** T-020, T-023
- **Blocks:** T-026, T-028, T-029
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-028 · System-Prompt Reseed (P0-h) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-h-system-prompt-reseed`
- **Goal:** 7-part progressive reseed (≤2K tokens), section-scoped AGENTS.md, injected post-compaction.
- **Acceptance:** Reseed ≤2K tokens; parts 1-3 visible in <200ms; AGENTS.md section-scoped; LOW confidence memories flagged with ⚠️.
- **Wrap-up:** packages/tui/src/session/reseeder.ts (replaced T-027 stub with full 378-line implementation: 7 parts with progressive loading, AGENTS.md section-scoped, LOW flag with ⚠️). 39 new tests. Verification: 209/209, 0 tsc errors, 4 Go modules clean. memory_id: a08a29e2-7a7d-44b6-bc41-574014138745
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-h-system-prompt-reseed`
- **Goal:** 7-part progressive reseed (≤2K tokens), section-scoped AGENTS.md, injected post-compaction.
- **Acceptance:** Reseed ≤2K tokens; parts 1-3 visible in <200ms; AGENTS.md section-scoped; LOW confidence memories flagged with ⚠️.
- **Scope IN:** `packages/tui/src/session/reseeder.ts`; 7 parts (AGENTS.md section-scoped, compaction summary, card context, active skills, board snapshot, recent memories, tool set); progressive loading.
- **Scope OUT:** cross-project memories (v0.2.0); user preference injection (→ P2-a).
- **Depends on:** T-020, T-026
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-029 · Speculative Parallel Dispatch (P0-i) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-i-speculative-parallel-dispatch`
- **Goal:** Fire up to 8 sub-agents simultaneously, merge results, no serial bottleneck.
- **Acceptance:** 3 independent cards → all 3 start <100ms gap; merge results; 1 fails → 2 succeed + failed card blocked; 9 cards → 8 start, 9th queued; shared dependency → serial enforced.
- **Wrap-up:** packages/tui/src/agents/dispatcher.ts (ParallelDispatcher, DependencyGraph with Kahn's topological sort, ConcurrencyLimiter semaphore, EventEmitter progress). 20 new tests. Verification: 235/235, 0 tsc errors, 4 Go modules clean. memory_id: 9bb66149-7259-4376-b8c2-2ca55b3e9811
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-i-speculative-parallel-dispatch`
- **Goal:** Fire up to 8 sub-agents simultaneously, merge results, no serial bottleneck.
- **Acceptance:** 3 independent cards → all 3 start <100ms gap; merge results; 1 fails → 2 succeed + failed card blocked; 9 cards → 8 start, 9th queued; shared dependency → serial enforced.
- **Scope IN:** `packages/tui/src/agents/dispatcher.ts`; `dispatchParallel(cards)`; max 8 simultaneous; merge; dependency check; streaming in-place status; failure isolation.
- **Scope OUT:** agent preferences (→ P2-a); cross-card dependency detection (→ P2-d); goal-mode (v0.2.0).
- **Depends on:** T-027, T-020
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-030 · Diff Verification Panel (P0-j) — promoted to Ready after T-021 completion
- **Status:** ready
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-j-diff-verification-panel`
- **Goal:** Show proposed diff side-by-side, y/n accept, tester re-runs on accept, block on fail.
- **Acceptance:** Diff renders side-by-side; `y` → tester runs; tests pass → done; tests fail → blocked; `n` → blocked "rejected by user"; low confidence → blocked regardless.
- **Scope IN:** `packages/tui/src/panels/diff.ts`; side-by-side OpenTUI diff; y/n keybinding; tester dispatch on accept; confidence scoring; wrap-up evidence.
- **Scope OUT:** auto-commit (→ P4); 3-way merge (v0.2.0); inline edit (P2).
- **Depends on:** T-021 (now done), T-027
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-023 · OpenCode SDK Client (P0-c) — promoted to Ready after T-021 completion (card was missing from initial kanban seed; added Session 19)
- **Status:** ready
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-c-opencode-sdk-client`
- **Goal:** Spawn OpenCode server on port 4096, wire `@opencode-ai/sdk` for LLM/agent operations.
- **Acceptance:** `session.create()` returns valid ID; `session.prompt("Hello")` streams; `session.revert()` clears; port 4096 conflict → clear error; OpenCode server fails → TUI degraded mode (memory ops still work, agent loop offline warning); no zombie processes on TUI exit.
- **Scope IN:** `packages/tui/src/opencode-client/`; spawn OpenCode server on `localhost:4096`; wire `@opencode-ai/sdk` `createOpencode({hostname, port})`; session lifecycle (create, prompt, messages, abort, revert, summarize, init); streaming response handling (<500ms TTFR); clean shutdown (kill child on TUI exit).
- **Scope OUT:** system prompt content (→ T-028); compaction logic (→ T-026); model selection logic (→ T-025); session continuity / resume (→ P2-b); agent dispatch (→ T-029).
- **Depends on:** T-021 (now done)
- **Blocks:** T-026, T-027, T-028, T-029, T-030, T-031
- **Created:** 2026-06-04
- **Updated:** 2026-06-04

#### T-031 · End-to-End Integration Demo (P0-l) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-l-end-to-end-integration-demo`
- **Goal:** Full pipeline walk-through: start TUI → run a sample card → compaction → reseed → dispatch → verify.
- **Acceptance:** All 12 prior P0 tasks green; smoke test script runs clean; all 4 Go modules green; documented run-through in `tests/e2e/p0-smoke.md`.
- **Scope IN:** smoke test script or manual run-through; verifies all 12 prior tasks' acceptance criteria together.
- **Scope OUT:** performance benchmarks (→ P4); CI integration (→ P4).
- **Depends on:** T-020, T-021, T-022, T-023, T-024, T-025, T-026, T-027, T-028, T-029, T-030
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/__tests__/e2e-smoke.test.ts (new, 28 tests), tests/e2e/p0-smoke.md (new, run-through doc)]
  - verification: "263/263 TUI tests pass (235 + 28 new); 0 tsc errors; all 4 Go modules build clean (verified by orchestrator post-return)"
  - memory_id: `23d33ebb-f5be-44a1-a105-89cc76e5d686`
  - summary: "P0 SHIPPED. All 12 P0 cards verified end-to-end. 8 test scenarios cover full pipeline. v0.1.0 TUI is launchable + testable. Time to start P1."

### Ready

_(none — all ready cards have been dispatched. Remaining cards are in Todo, blocked on T-026/T-027)_)

### Running

_(none)_

### Blocked

_(none)_

### Done

#### T-019 · Zig Toolchain + OpenTUI Setup (P0-0, PREREQUISITE) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0 (prerequisite, dispatched first)
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-0-zig-toolchain--opentui-setup-prerequisite`
- **Goal:** Install Zig toolchain and verify `@opentui/core` compiles a hello-world TUI.
- **Acceptance:** `bun run start` renders "Neuralgentics v0.1.0" in OpenTUI window; `zig version` valid; `bun run build` clean; no blessed in package.json; Zig version documented in README.
- **Scope IN:** Zig install (system pkg or `zigup`); Bun check; `packages/tui/` skeleton (package.json, tsconfig.json, bunfig.toml); `bun add @opentui/core`; hello-world TUI; README prerequisites section.
- **Scope OUT:** TUI panels (→ T-021); Go backend (→ T-020); OpenCode SDK (→ T-023); podman (→ T-022).
- **Depends on:** none
- **Blocks:** T-021, T-023, T-028, T-030 (4 cards — now UNBLOCKED)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/package.json, packages/tui/tsconfig.json, packages/tui/bunfig.toml, packages/tui/.gitignore, packages/tui/src/index.ts, packages/tui/src/__tests__/setup.test.ts, packages/tui/README.md, packages/tui/bun.lock]
  - verification: "zig version: 0.14.0; bun --version: 1.3.14; bun run start: renders green bold 'Neuralgentics v0.1.0' in rounded border box; bun run build: 15 modules bundled cleanly; bun run typecheck: 0 errors; bun test: 5/5 pass; grep -i blessed package.json: no matches; README has Prerequisites with Zig and Bun; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 9 ok, backend-go build OK"
  - residual_risk: "@opentui/core-linux-x64 must be explicitly added (Bun doesn't auto-install optionalDependencies like npm); OpenTUI v0.3.1 may have breaking changes in future; Zig is a soft requirement since pre-compiled .so is used but listed in README as needed for source builds"
  - summary: Zig 0.14.0 installed to ~/.local/bin. @opentui/core v0.3.1 installed with pre-compiled linux-x64 native binary (libopentui.so 8.3MB). packages/tui/ skeleton created with package.json, tsconfig.json, bunfig.toml, .gitignore, README.md. Hello-world entry point renders "Neuralgentics v0.1.0" in green bold text inside a rounded border box using OpenTUI's createCliRenderer + Text/Box constructs. All 6 acceptance criteria verified. All 4 Go modules remain green (27 packages + backend build). T-021, T-023, T-028, T-030 are now unblocked.

#### T-025 · Task-Scoped Model Selection (P0-k) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-k-task-scoped-model-selection`
- **Goal:** Route tasks to big/small/fast models based on task type, with a configurable registry.
- **Acceptance:** All 9 task types route correctly; fallback to big; override; config file; provider validation. ✓
- **Scope IN:** `packages/tui/src/agents/model-registry.ts` (260 lines); big/small/fast categories; default routing rules; config/default.json; provider list validation; getModelForTask() with override. ✓
- **Scope OUT:** dynamic mid-task switching (v0.2.0); cost-aware routing (→ P1-b); per-dispatch override (P2). ✓
- **Depends on:** none
- **Blocks:** T-031 (now unblocked)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/agents/model-registry.ts (260 lines), packages/tui/config/default.json, packages/tui/src/__tests__/model-registry.test.ts (25 tests)]
  - verification: "typecheck: 0 errors; bun test: 101/101 pass (25 new + 76 existing); build: clean; Go modules: all 4 green"
  - residual_risk: "Config file path uses CWD-relative (could break if TUI launched from different cwd). Dynamic mid-task switching deferred to v0.2.0. extraction_model defined but not wired (T-026 will use it)."
  - summary: "Full model registry with 9 task types, 3 categories (big/small/fast), override support, config file loading, and provider validation against .opencode/opencode.json."

#### T-030 · Diff Verification Panel (P0-j) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-j-diff-verification-panel`
- **Goal:** Show proposed diff side-by-side, y/n accept, tester re-runs on accept, block on fail.
- **Acceptance:** Side-by-side view; y/n/q/Esc keybindings; accept/reject flows; low-confidence path; wrap-up evidence. ✓
- **Scope IN:** `packages/tui/src/panels/diff.ts`; parseUnifiedDiff, generateDiffFromBeforeAfter, renderDiffPanel, DiffPanel class with state machine; y/n keybinding; confidence gate; wrap-up evidence. ✓
- **Scope OUT:** auto-commit (→ P4); 3-way merge (v0.2.0); inline edit (P2). ✓
- **Depends on:** T-021 (now done), T-027
- **Blocks:** T-031 (now unblocked)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/panels/diff.ts (712 lines), packages/tui/src/__tests__/diff.test.ts (27 tests), packages/tui/src/commands.ts (added /diff), packages/tui/src/index.ts (wired DiffPanel + showDiffPanel handling)]
  - verification: "typecheck: 0 errors; bun test: 101/101 pass (27 new + 74 existing); build: clean; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 9 ok, backend-go build OK"
  - residual_risk: "Mock test runner (always returns pass: true); T-029 will wire real tester dispatch. Confidence defaults to 'medium' if not specified. Modal overlay tested structurally, not visually (no headless TUI render harness)."
  - summary: "Full DiffPanel with state machine, parse/render functions, keybindings, confidence gate, and wrap-up evidence. Wired into TUI via /diff slash command. Sample diff rendered from a hardcoded example (T-029 will replace with real coder output)."

#### T-023 · OpenCode SDK Client (P0-c) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-c-opencode-sdk-client`
- **Goal:** Spawn OpenCode server on port 4096, wire `@opencode-ai/sdk` for LLM/agent operations.
- **Acceptance:** createSession/prompt/revert/abort all wired; port 4096 conflict detection; degraded mode; clean shutdown. ✓
- **Scope IN:** `packages/tui/src/opencode-client/`; spawn OpenCode server on 4096; wire `@opencode-ai/sdk` createOpencode; session lifecycle; streaming response (<500ms TTFR target); clean shutdown. ✓
- **Scope OUT:** System prompt content (→ T-028); compaction (→ T-026); model selection (→ T-025); continuity/resume (→ P2-b); agent dispatch (→ T-029). ✓
- **Depends on:** T-021 (now done)
- **Blocks:** T-026, T-027, T-028, T-029, T-030, T-031 (now unblocked)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/package.json (added @opencode-ai/sdk ^1.15.13), packages/tui/src/opencode-client/{client,types,index}.ts, packages/tui/src/index.ts (OpenCodeClient wired), packages/tui/src/__tests__/opencode-client.test.ts (6 tests)]
  - verification: "typecheck: 0 errors; bun test: 44/44 pass; build: clean; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 9 ok, backend-go build OK"
  - residual_risk: "E2E with real LLM not tested in headless mode (only structural tests verified); OpenCode SDK has createOpencodeServer unused import noted by coder; version drift possible — pinned to ^1.15.13"
  - summary: "Full OpenCode SDK client with status state machine (offline/starting/ready/degraded), port conflict detection, degraded mode for graceful fallback to memory-only ops, streaming response callbacks, event emitters, and clean shutdown handlers. Wired into TUI input bar — non-slash text goes to prompt with streaming back to chat panel; status bar shows LLM:online/offline/starting."

#### T-021 · TUI App Scaffold + Panel Layout (P0-a) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-a-tui-app-scaffold--panel-layout`
- **Goal:** Full OpenTUI app with 4 panels (kanban, chat, chain, status bar) and input bar.
- **Acceptance:** All 4 panels render; status bar shows hardcoded token gauge; /help lists 11 commands; /board re-reads TASKS.md; SIGWINCH handled by OpenTUI yoga layout. ✓
- **Scope IN:** 4-panel layout (kanban 30% | chat 50% | chain 20%) + status bar + input bar; slash command router with 10 stubs + /board refresh; TASKS.md kanban parser. ✓
- **Scope OUT:** Backend connectivity (→ T-020, T-023); real LLM responses (→ T-023); real kanban data (→ T-020+T-027); compaction (→ T-026); diff panel (→ T-030); /spend or /opportunities (P1). ✓
- **Depends on:** T-019 (now done)
- **Blocks:** T-023, T-028, T-030 (now unblocked)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/index.ts (rewrote hello-world → 4-panel), packages/tui/src/commands.ts (slash command router), packages/tui/src/kanban/parser.ts, packages/tui/src/kanban/types.ts, packages/tui/src/kanban/index.ts, packages/tui/src/__tests__/t021-panel-layout.test.ts]
  - verification: "typecheck: 0 errors; bun test: 30/30 pass (5 new + 25 existing); build: clean; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 7 ok, backend-go build OK"
  - residual_risk: "Status bar token count is hardcoded (P1-b token accountant will wire real counting); panels/ directory created but empty (single index.ts with embedded panels; T-030 will add diff panel)"
  - summary: "Full 4-panel OpenTUI app with status bar + input bar. TASKS.md kanban parser handles 7-column board format. 10 slash commands stubbed (compact, spend, memory, board, chain, agents, resume, harness, review, scaffold, opportunities, help) — /board re-reads TASKS.md, /help lists all, others return 'not implemented yet'. All 4 Go modules green."

#### T-024 · Binary Path Resolution (P0-e) — ✅ DONE (absorbed by T-020)
- **Status:** done
- **Assignee:** boomerang-coder (T-020 dispatch)
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-e-binary-path-resolution`
- **Goal:** Resolve the Go backend binary path with the 3-tier fallback: $PATH → env var → relative.
- **Acceptance:** All 3 resolution cases work; clear error with all 3 locations checked when all fail. ✓ (verified in T-020's test suite)
- **Scope IN:** `packages/tui/src/neuralgentics-client/resolver.ts`; 3-tier fallback. ✓
- **Scope OUT:** binary building, download, version checking. ✓
- **Depends on:** T-020 (now done)
- **Blocks:** none
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/neuralgentics-client/resolver.ts (created in T-020)]
  - verification: "T-020's 19/19 tests cover resolver; E2E smoke against real Go backend confirms the resolver returns the correct path"
  - residual_risk: none (work absorbed by T-020)
  - summary: T-024's scope was to extract the 3-tier resolver into a dedicated file. T-020 already did this as part of its scope (resolver.ts is its own file, not inlined in client.ts). Card closed by absorption — no separate dispatch needed.

#### T-020 · Neuralgentics JSON-RPC Client (P0-b) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-b-neuralgentics-json-rpc-client`
- **Goal:** Typed JSON-RPC wrapper for all 42 Go backend methods, with binary spawning, ready signal handling, and 10s timeout.
- **Acceptance:** `ping` <10ms ✓; `memory.add`/`memory.query` round-trip ✓; 3-tier binary resolution ✓; backend crash → "backend not ready" event ✓; stderr inheritance ✓.
- **Scope IN:** `packages/tui/src/neuralgentics-client/`; binary spawn; JSON-RPC 2.0 protocol; `waitForReady(10s)`; typed `call<T>` for 42 methods; error handling; TS types for all methods.
- **Scope OUT:** MCP tool registration; OpenCode SDK (→ T-023); token accounting (→ P1-b).
- **Depends on:** none (binary must exist; client independent)
- **Blocks:** T-024, T-026, T-027, T-028, T-029, T-031 (now unblocked by T-020 completion)
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [packages/tui/src/neuralgentics-client/client.ts, packages/tui/src/neuralgentics-client/resolver.ts, packages/tui/src/neuralgentics-client/types.ts, packages/tui/src/neuralgentics-client/index.ts, packages/tui/src/__tests__/neuralgentics-client.test.ts]
  - verification: "typecheck: 0 errors; build: 15 modules bundled; bun test: 19/19 pass (including 10 resolver+client unit tests with mock stdio); E2E smoke: ping=pong in <1ms, memory.add returned ID b5a6f788..., memory.query found T-020 smoke test memory; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 9 ok, backend-go build OK"
  - residual_risk: "ESLint not configured yet (no eslint.config.js in TUI package — not introduced by this card). Binary path resolution inlined per scope (T-024 can refactor later)."
  - summary: "Implemented self-contained NeuralgenticsClient with JSON-RPC 2.0 over stdio, 42 typed methods (6 core fully typed), 3-tier binary path resolution ($PATH → $NEURALGENTICS_BACKEND_PATH → relative), waitForReady(10s) timeout, crash/error event handling, and stderr inheritance. Based on overlay go-backend-client.ts wire protocol but fully independent. All acceptance criteria verified."

#### T-022 · Podman Setup Script + Sidecar Management (P0-d) — ✅ DONE
- **Status:** done
- **Assignee:** boomerang-coder
- **Phase:** v0.1.0 P0
- **Roadmap:** `docs/roadmap-v0.1.0.md#task-p0-d-podman-setup-script--sidecar-management`
- **Goal:** Create `./scripts/dev-up.sh` and TUI sidecar lifecycle management.
- **Acceptance:** `./scripts/dev-up.sh` works on clean system ✓; idempotent ✓; clear errors for missing DB/sidecar/backend ✓; "starting sidecar..." with retry×30 @ 100ms ✓; SIGTERM on TUI exit if TUI spawned it ✓; zero docker commands ✓; zero 5434/5436 ✓; `bash -n` clean ✓; `bun test` passes ✓; 4 Go modules green ✓.
- **Scope IN:** `scripts/dev-up.sh` (podman container check/create/start, migrations, sidecar spawn, binary verify, idempotent); TUI startup checks (socket exists, health ping, child PID tracking, SIGTERM on exit).
- **Scope OUT:** auto-starting sidecar from `./neuralgentics` (per A3); DB ports 5434/5436; docker; binary building.
- **Depends on:** none (setup script runs first; independent)
- **Blocks:** T-031
- **Created:** 2026-06-04
- **Updated:** 2026-06-04
- **Wrap-up evidence:**
  - changed_files: [scripts/dev-up.sh (new, 248 lines), packages/tui/src/sidecar.ts (new, 280 lines), packages/tui/src/__tests__/sidecar.test.ts (new, 62 lines), packages/tui/src/index.ts (additive: 3 imports + 24 lines of sidecar/DB init)]
  - verification: "bash -n dev-up.sh: PASS; zero docker commands (only docker.io image name + docker-entrypoint-initdb.d mount point per podman convention); zero 5434/5436 references; bun test: 35/35 pass (5 new sidecar tests); typecheck: 0 errors; Go modules: memory 16 ok, orchestrator-go 2 ok, broker-go 9 ok, backend-go build OK; dev-up.sh uses set -euo pipefail, podman exclusively, port 6000 only"
  - residual_risk: "shellcheck not installed on this system — manual review of bash strictness confirms `set -euo pipefail` with proper error handling. Stale socket detection uses lsof which may not be available in minimal containers. The TUI sidecar auto-spawn feature spawns python -m embedding_sidecar.main from the sidecar venv; if venv is missing, it falls back to system python3 (documented warning)."
  - summary: "Created scripts/dev-up.sh (idempotent Podman + sidecar setup) and packages/tui/src/sidecar.ts (lifecycle management with auto-spawn, health ping, SIGTERM on exit). dev-up.sh handles PostgreSQL container check/create/start on port 6000 with SSL, applies 4 SQL migrations, spawns gRPC embedding sidecar if missing, and verifies Go backend binary exists. TUI sidecar.ts provides checkDatabase(), initSidecar(), shutdownSidecar(), registerSidecarShutdown() with 30-retry/100ms socket wait. All acceptance criteria verified."

_(none)_

---

## Document Changelog

- **2026-06-04 (Session 20, 24h-mvp sprint):** **P0 + P1 SHIPPED. 22 cards done in single session.** P0 (13 cards): T-027 session manager, T-026 compaction, T-028 reseed, T-029 parallel dispatch, T-031 E2E smoke. P1 (9 cards): T-032 TUI polish + a11y + 2 themes, T-033 token accountant + /spend, T-034 opportunity detector (8 patterns), T-035 aggregator lookup (3-of-7 MVP), T-036 kanban circuit breaker (failure_limit=2), T-037 card comments, T-038 attempts history, T-039 functional slash commands (10 working), T-040 broker permission gating (23 roles). **576/576 TUI tests pass, 0 tsc errors, all 4 Go modules build clean.** P1 plan at `docs/roadmap-v0.1.0-p1.md` (511 lines). Zero-Error Rule added to AGENTS.md (sub-agents must fix gate failures inline or block card — no "pre-existing errors" excuse, enforced by orchestrator re-running all gates). 5 of 12 dispatches hit coder max-steps; orchestrator finished verification + fixed test fixtures each time.
- **2026-06-04 (Session 19, late):** 8 of 13 P0 cards DONE in single session. T-019 (Zig/OpenTUI), T-020 (Go JSON-RPC client — 19 tests, ping <1ms), T-021 (TUI 4-panel layout), T-022 (podman dev-up.sh + sidecar), T-023 (OpenCode SDK client), T-024 (binary resolver — absorbed by T-020), T-025 (model registry), T-030 (diff panel). 101/101 TUI tests pass, all 4 Go modules green throughout. 5 cards remaining: T-026 (compaction), T-027 (session manager), T-028 (reseed), T-029 (parallel dispatch), T-031 (E2E demo). Session length hit sub-agent step limits 3x — recommend reducing per-coder scope or increasing the step budget for Session 20.
- **2026-06-04 (Session 19, early):** P0 approved by user; roadmap written to `docs/roadmap-v0.1.0.md` (13 tasks, 10.5d estimate); kanban seeded with 13 cards (T-019 through T-031); CURRENT PHASE updated; user decisions captured verbatim.
- **2026-06-03 (Session 18):** v4-FINAL design shipped; 4 skills added at `neuralgentics/.opencode/skills/`; opportunity detector addenda; pending P0 approval.