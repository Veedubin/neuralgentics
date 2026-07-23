# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.12] - 2026-07-22

### Changed

- **Skills renamed: `boomerang-` prefix dropped from shipped skills.** `boomerang-handoff` → `handoff`, `boomerang-orchestrator` → `orchestrator`. Frontmatter `name:` updated; cross-references in `skill-self-audit` and `update-gh-docs` updated. Both `overlay/packages/opencode/.opencode/skills/` and `.opencode/skills/` updated and kept diff-identical.

### Added

- **Slash commands** — `.opencode/commands/` now ships 7 slash-command files: `handoff.md`, `orchestrator.md`, `kanban-board-manager.md`, `skill-self-audit.md`, `todo-list-updater.md`, `update-gh-docs.md`, `external-skills-fetcher.md`. Users can now type `/handoff`, `/orchestrator`, etc. The installer (`init.ts`) copies the commands directory alongside agents and skills.
- **Shipped AGENTS.md documents the videre-mcp vision tools** — new `## Vision (videre-mcp)` section in `overlay/packages/opencode/.opencode/AGENTS.md` listing the 6 base tools (`take_screenshot`, `describe_screenshot`, `describe_image`, `ocr_image`, `ocr_paddle`, `parse_document`), a "when to reach for vision" mandate, and the optional vision-memory tools gated on `MEMINI_IMAGE_SEARCH_ENABLED`.

### References

- README, AGENTS.md, `routing.ts`, `context_builder.go`, and `improve_test.go` updated to use the plain skill names.

### Housekeeping

- Version sync: root `package.json`, `packages/tui/package.json`, and `scripts/install.sh DEFAULT_VERSION` had drifted to 0.12.2 since v0.12.2 and were not updated by bumpversion (which only tracks the canonical `overlay/packages/opencode/package.json`). All three are now at 0.15.12. `validate-release.sh` previously passed despite this drift because the drift check only ran in `--check` mode; the script's hard fail on version disagreement caught it here.

## [0.15.11] - 2026-07-21

### Changed

- README: removed boomerang-v3 from sibling projects (superseded by this plugin); ecosystem diagram now shows the first-class (memini-ai, registered in opencode.json) vs brokered MCP server split.

## [0.15.10] - 2026-07-21

### Fixed

- Remaining model references: agent `description:` frontmatter, `small_model` in opencode.json (now `ollama/minimax-m3`), and stale config examples in `docs/design/transport-architecture.md`.

## [0.15.9] - 2026-07-21

### Fixed

- **Agent model remap to API-verified Ollama Cloud models** (agents, overlay templates, installer sources, opencode.json). Devstral models were pulled from Ollama Cloud and `qwen3-coder-next` never existed — the installer would have written broken personas to user machines. Remapped: linter → `qwen3.5:397b`, release → `minimax-m3`, explorer → `deepseek-v4-flash`, researcher → `qwen3.5:397b`. Stale `:cloud` suffixes stripped in `orchestrator.ts`; dead `ollama-cloud` provider block removed from opencode.json.

## [0.15.8] - 2026-07-21

Documentation overhaul. No functional changes.

- README: ecosystem mermaid diagram + comprehensive features section + sibling project links.
- docs/: 7 stale planning/cleanup documents moved into `docs/archive/` with an index page; broken internal link fixed.
- mkdocs: `site_name` version suffix dropped; mermaid support added via superfences custom fence.
- Repo hygiene: `site/` build output untracked (120 files); `.gitignore` inline-comment bug fixed so `site/` is actually ignored.

> Releases 0.12.1 through 0.15.7 are documented on the
> [GitHub Releases page](https://github.com/Veedubin/neuralgentics/releases).

## [0.12.0] - 2026-07-10

Minor release: Multi-model embedding support with RRF (Reciprocal Rank Fusion). Queries can now merge results from memories embedded with different models (MiniLM, BGE-M3, BGE-Large).

### Added

- **Multi-model RRF search**: New `memory.search_rrf` JSON-RPC method (Go backend) and `search_memories_rrf()` (memini-ai). When memories are stored in different embedding models, RRF runs a top-k search in each model's vector space and merges the results using `score = sum(1 / (k + rank))`.
- **Schema columns**: `embedding_model VARCHAR(100)` column added to track which model produced each memory's vector. `embedding_bge_m3 vector(1024)` and `embedding_bge_large vector(1024)` columns added (parallel to existing `embedding` column for BGE-Large).
- **Per-model search queries**: Three new search queries — `SEARCH_MEMORIES_MINILM`, `SEARCH_MEMORIES_BGE_M3`, `SEARCH_MEMORIES_BGE_LARGE` — each queries a single model's column.
- **RRF config**: New `RRFConfig` struct with `k` (default 60), `top_k_per_model` (default 20), `final_top_k` (default 10), `enabled_columns` (which model spaces to search).
- **Migration 000006**: Idempotent migration adding the new columns. Safe to re-run. Backfills existing rows with `embedding_model = 'BAAI/bge-large-en-v1.5'`.

### Changed

- **Default RRF enabled**: Both memini-ai and neuralgentics Go backend now default to `enable_rrf: true` for queries. Set `MEMINI_ENABLE_RRF=false` or `ENABLE_RRF=false` to fall back to single-model search.
- **New memories write to model-specific column**: When adding a memory, the embedder picks the right column based on the active model's dimensionality. MiniLM → `embedding` (384-dim), BGE-M3 → `embedding_bge_m3` (1024-dim), BGE-Large → `embedding_bge_large` (1024-dim).

### Notes

- **Backwards compatible**: Existing single-model queries still work. The new `search_rrf` method is opt-in via the JSON-RPC interface.
- **Multi-user support**: Designed for the case where different users/peers on the same DB have memories embedded with different models. RRF finds matches across all of them.
- **No model retraining**: Existing BGE-Large embeddings stay valid. New BGE-M3 embeddings populate the new column. Queries can use either or both.

### Quality gates

- TypeScript: `npx tsc --noEmit` clean
- Go build + vet: clean
- Python mypy: clean
- memini-ai pytest: 778+ tests pass (1 pre-existing env-dependent test skipped)
- neuralgentics Go test: 7+ new RRF tests pass

---

## [0.11.0] - 2026-07-10

Minor release: BGE-M3 is now the default embedding model, with a new `migrate-embeddings` command for upgrading existing installs.

### Changed

- **Default embedding model**: BGE-M3 (`bge-m3`) replaces BGE-Large (`bge-large-en-v1.5`) as the default. BGE-M3 supports 100+ languages, 8192 token context (vs 512), and produces more accurate embeddings for code and long documents. BGE-Large is still available via `--embed-model bge-large` for backwards compat.
- **Embedding dimensions**: 1024 (was 1024 for BGE-Large too — no change in storage, but the vector geometry is different so existing memories need re-embedding).
- **CLI flag**: New `--embed-model {bge-m3|bge-large|all-MiniLM-L6-v2}` flag, default `bge-m3`. Env: `NEURALGENTICS_EMBED_MODEL`.
- **Quantize auto-default**: BGE-M3 + CUDA → fp16, BGE-M3 + CPU → int8 (unchanged from v0.10.0).

### Added

- **`memory.migrate_embeddings` JSON-RPC method**: Re-embeds all memories in the database with a new model. Safe to interrupt (writes happen after embed succeeds). Reports progress.
- **`migrate-embeddings` CLI command**: Thin wrapper that calls the JSON-RPC method. Usage: `npx @veedubin/neuralgentics migrate-embeddings --from bge-large --to bge-m3 --batch 10`. Old vectors preserved in `embedding_legacy` column by default for safe rollback.
- **`embedding_model` column on memories table**: New migration `000005_add_embedding_model.up.sql` tracks which model produced each memory's vector. Additive — existing rows default to `bge-large-en-v1.5`.
- **`embedding_legacy` + `embedding_model_legacy` columns**: Added by the migration tool when `--backup` is on (default). Can be dropped after verifying the migration.

### Migration

If you have existing memories embedded with BGE-Large, run the migration to re-embed them with BGE-M3:

```bash
# Preview what will be migrated
npx @veedubin/neuralgentics migrate-embeddings --dry-run

# Run the migration (safe — old vectors backed up)
npx @veedubin/neuralgentics migrate-embeddings --from bge-large --to bge-m3

# Rollback if needed (SQL)
psql ... -c "UPDATE memories SET embedding = embedding_legacy, embedding_model = embedding_model_legacy WHERE embedding_legacy IS NOT NULL;"

# Drop backup columns after verifying
psql ... -c "ALTER TABLE memories DROP COLUMN embedding_legacy, DROP COLUMN embedding_model_legacy;"
```

For ~80 memories, the migration takes ~2-5 minutes (includes a 2-15s cold model load on first embed call).

### Quality gates

- TypeScript: `npx tsc --noEmit` clean
- Go build + vet: clean in `packages/memory` and `packages/backend-go`
- Migration tested: column added to running `neuralgentics-postgres` on port 6200 (or 6000 if user kept the old container)

---

## [0.10.0] - 2026-07-09

Patch release: Lazy-load + quantize support for the embedding sidecar, and sidecar lifecycle management via the Go memory server.

### Added

- **Quantization support**: The embedding sidecar now supports `int8` (in addition to `fp32` and `fp16`) via the new `NEURALGENTICS_EMBED_DTYPE=int8` env var or `--quantize int8` flag. INT8 reduces VRAM ~4x vs FP32 and ~2x vs FP16, with ~1% quality loss. Uses `bitsandbytes` on CUDA, falls back to PyTorch dynamic quantization on CPU.
- **Lazy load + idle unload**: The sidecar no longer loads the model at startup. The model loads on first request (2-15s cold load) and unloads automatically after 5 minutes of inactivity (configurable via `IDLE_MIN` env var or `--idle-min` flag). This means zero idle memory cost when you're not using neuralgentics.
- **--no-lazy-load (eager) mode**: New flag/env (`EAGER=true`) loads the model at startup and keeps it loaded while clients are connected. Use this if cold-load latency is unacceptable (e.g., on slow hardware or when you want instant first response).
- **Sidecar status endpoint**: New HTTP `/status` endpoint on port 50052 exposes `{loaded_models, last_used, dtype, device, idle_min, eager}`. The plugin checks this before embedding calls and shows a one-time "warming up" message when the model needs to load.
- **Sidecar lifecycle JSON-RPC methods**: The Go memory server now exposes `sidecar.start` and `sidecar.stop` methods that shell out to podman/docker to manage the local sidecar container. Local-only — returns clear error if sidecar is on a remote host.
- **Auto-detect quantization**: When `--quantize` is not specified, the init CLI picks `fp16` for CUDA and `int8` for CPU. No more 1.3GB FP32 model on a CPU-only box.
- **CLI flags**: `--quantize {fp32|fp16|int8}`, `--no-lazy-load`, `--idle-min N`, `--status-port N`, `--device {cpu|cuda}`

### Changed

- **Default quantization**: The default for new installs is now `int8` on CPU and `fp16` on GPU (was `fp32` for both). Existing installs continue using whatever their `.env` specifies.
- **Sidecar MCP timeout**: Bumped to 60000ms (60s) to accommodate cold model loads. Without this, the first embedding call after a restart would time out before the model finished loading.

### Notes

- **Memory cost when idle**: With lazy-load (default), the sidecar process consumes ~80MB RAM when no model is loaded. With eager mode (`--no-lazy-load`), it consumes ~1.3GB (FP32) or ~640MB (FP16) or ~340MB (INT8).
- **GPU support**: INT8 quantization uses `bitsandbytes` for best performance on CUDA. If not installed, falls back to PyTorch dynamic quantization (works everywhere but slower).
- **First-request latency**: Cold load takes 2-15s depending on hardware. Subsequent requests are ~10ms (CPU) or ~2ms (GPU) for BGE-Large.
- **Local-only sidecar lifecycle**: `sidecar.start`/`sidecar.stop` only work when the sidecar is on the same host. For remote sidecars, use your container orchestrator or SSH.

### Quality gates

- TypeScript: `npx tsc --noEmit` clean
- Python: `py_compile` clean, `ruff check` clean
- Go build: clean
- Lazy load smoke test: passing

---

## [0.9.6] - 2026-07-09

Patch release: Default host port changed from 6000 to 6200 so neuralgentics and memini-ai can run side-by-side. memini-ai remains on port 5434 and is untouched by this change. All connection strings, scripts, tests, and documentation updated.

### Changed

- **Default host port**: 6000 → 6200. The container port (5432) is unchanged — only the host-side mapping in `docker-compose.yml`, `podman-compose.yml`, and `compose.example.env`.
- **Go backend default URL**: `packages/backend-go/cmd/backend/main.go` now defaults to `postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics` (was 6000).
- **Dev test DB default URL**: `packages/tui/src/neuralgentics-client/resolver.ts` and `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` now default to port 6200.
- **Shell scripts and tests**: `scripts/dev-up.sh`, `scripts/compose.sh`, `scripts/smoke-test.sh`, `scripts/.env.example`, `tests/smoke-test-mvp.sh`, `.neuralgentics/install.sh` all updated.
- **Container port mapping**: `docker-compose.yml` and `podman-compose.yml` now use `${NEURALGENTICS_DB_PORT:-6200}:5432`.
- **Local configs**: `/home/jcharles/Projects/MCP-Servers/.env` and `/home/jcharles/Projects/reverse_engineering/.env` updated to point at port 6200.

### Notes

- **Container recreation required**: The existing `neuralgentics-postgres` podman container still maps 6000 → 5432. After upgrading, recreate it with `-p 6200:5432`. The init CLI's container-setup step will do this automatically if the user deletes the old container first (or runs the init in a new project).
- **memini-ai untouched**: `memini-postgres` on port 5434 is unchanged. The two systems can now run simultaneously for side-by-side testing.
- **Historical references preserved**: HANDOFF.md and TASKS.md historical session entries still mention port 6000 (because that's what was true at the time). Only current-state references were updated.

### Quality gates

- TypeScript: `npx tsc --noEmit` clean
- Go build: `go build ./...` clean in `packages/backend-go` and `packages/memory`
- Go vet: clean
- Grep verification: 0 source/config files contain port 6000

## [0.9.5] - 2026-07-09

Patch release: Documentation overhaul. All docs aligned with the v0.9.4 reality — the plugin-only architecture, the npm `npx --init` flow, and the removal of the v0.6.x TUI/curl-bash paths. The deleted PyPI `neuralgentics-cli` package is documented as a v0.9.3 mistake that was reverted. New files: npm package README and v0.6.x → v0.7.0+ migration guide.

### Added

- `overlay/packages/opencode/README.md` — the npm package README (visible on npmjs.com).
- `docs/migrating-from-v0.6.md` — guide for users on the old TUI/sidecar install.
- v0.9.1, v0.9.2, v0.9.3, v0.9.4 changelog entries (changelog was previously stopping at v0.9.0).

### Changed

- `README.md` — complete rewrite for v0.9.4 reality.
- `AGENTS.md` — version references updated, `neuralgentics-postgres` purpose documented.
- `docs/index.md` — TUI/sidecar references removed, install command fixed.
- `package.json` version: 0.9.4 → 0.9.5.

### Notes

- This release contains no code changes — only documentation, README, changelog, and version bump.
- Git cleanup: deleted 2 merged remote branches (`feature/pypi-bootstrapper`, `feature/npm-publish`), dropped stale WIP stash on AGENTS.md.

## [0.9.4] - 2026-07-09

Patch release: Safe container setup in the npm init CLI. The installer now:
- Skips container setup if `neuralgentics-postgres` is already running
- Never overwrites an existing `.env` file
- When `.env` is absent, copies `compose.example.env` and stops (lets user edit credentials before starting)
- Prints DB connection info after successful start
- Updated prompt text to clarify containers won't be recreated

### Changed
- The `npx @veedubin/neuralgentics --init` flow is now idempotent and safe for re-runs.
- Container setup is skipped if `neuralgentics-postgres` is already running on port 6000.
- The `.env` file is preserved if it exists; only copied from `compose.example.env` if missing.

### Notes
- This release removes the PyPI `neuralgentics-cli` package, which was mistakenly published in v0.9.3.
- The Go backend continues as a containerized sibling of memini-ai, sharing the same PostgreSQL schema for consistency.

## [0.9.3] - 2026-07-07

Patch release: Init/bootstrap CLI in the npm package. Added `npx @veedubin/neuralgentics --init` flow, which:
- Downloads the release tarball
- Backs up existing `.opencode/`
- Deep-merges `opencode.json`
- Offers container setup (PostgreSQL + sidecar + backend)

### Added
- `npx @veedubin/neuralgentics --init` command for bootstrapping projects.
- Backup of existing `.opencode/` before overwrite.
- Deep-merge of `opencode.json` to preserve user customizations.
- Container setup for `neuralgentics-postgres`, `neuralgentics-sidecar`, and `neuralgentics-backend`.

### Removed
- The `neuralgentics-cli` PyPI package (mistake, never should have been published).

### Notes
- The init CLI is the new recommended way to install Neuralgentics. The old curl-bash installer is deprecated.

## [0.9.2] - 2026-07-05

Patch release: TUI bleed fix. Routed `session.created` through `app.log` to stop TUI bleed.

### Fixed
- TUI bleed when `session.created` events were emitted before the TUI was fully initialized.
- Plugin-only architecture stabilized; no more standalone TUI binary.

### Notes
- This release marks the transition to a pure OpenCode plugin architecture. The `neuralgentics` command no longer exists.

## [0.9.1] - 2026-07-05

Patch release: First npm publish. Initial `@veedubin/neuralgentics` release on npm.

### Added
- `@veedubin/neuralgentics` npm package for OpenCode plugin integration.
- Self-contained install flow via `npx @veedubin/neuralgentics --init`.
- Plugin tarball includes:
  - 8 agent personas (architect, coder, explorer, git, orchestrator, reviewer, tester, writer)
  - 5 skills (boomerang-orchestrator, kanban-board-manager, skill-self-audit, todo-list-updater, update-gh-docs)
  - MCP tools for memory, routing, and lifecycle hooks
  - Config merger for `opencode.json`

### Changed
- Neuralgentics is now an OpenCode plugin, not a standalone TUI.
- The Go backend runs as a container, not a downloaded binary.
- Install flow: `npx @veedubin/neuralgentics --init` instead of curl-bash.

### Removed
- Standalone TUI binary (`neuralgentics` command).
- Go backend binary from the release tarball.
- PATH setup (no binary to put on PATH).
- GPU detection (handled by container runtime).
- 5-platform build matrix (single platform-independent npm package).

### Quality Gates
- `npx tsc --noEmit` clean across all TypeScript sources.
- `go vet` and `go test -short` clean for all Go modules.
- `bun test` passes for TUI and SDK.

## [0.9.0] - 2026-06-24

Minor release: Skills Brokering + Auto-Evolution (Phases 1-3, 13 cards T-SB-001 through T-SB-013). The Go MCP broker is now ALSO a skills broker — agents can browse a role-filtered SkillCatalog and reuse existing skills instead of recomputing work. Auto-evolution creates new SKILL.md files from repeated session patterns. Total: 14 commits, 37 files, +8062/-180 lines, 99 plugin tests + 50+ broker tests passing.

### Added

- **Phase 1 — Skills Brokering wire-up (T-SB-001 through T-SB-007)**:
  - Default `auto_create=true` in `SelfEvolutionGate`; `gate.run({autoCreate: true})` is invoked BEFORE `handleCompaction` in the compaction hook so newly-created SKILL.md files are captured in backups.
  - `/handoff` skill (NEW) — runs the self-evolution gate, then updates HANDOFF.md + TASKS.md, then commits new SKILL.md files.
  - Go `SkillCatalog` (in `packages/broker-go/src/neuralgentics/broker/catalog/skills.go`) — mirrors `ServerCatalog` shape. `Builder.BuildSkills(role, workspaceRoot)` walks `.opencode/skills/*/SKILL.md`, parses front-matter, merges tags via hybrid YAML baseline + front-matter override. Orchestrator sees all; missing YAML = allow-all.
  - `broker.listSkills(role)` JSON-RPC method (parallel to `broker.buildCatalog`).
  - `agent-skill-scope.yaml` at repo root — per-role allow-list of skill tags. 23 role entries matching the Role constants in `access.go`.
  - `skill_lookup.ts` — orchestrator pre-dispatch hook. Embeds task context, picks top-1 skill from `ListSkills(orchestrator)` by word-overlap cosine (threshold 0.6), loads body from LRU cache.
  - LRU skill body cache: Go `SkillBodyCache` (container/list + sync.Mutex) + TS `SkillBodyCache` (Map-based), 100 entries × 5MB cap, modTime-invalidated, race-tested.

- **Phase 2 — External skills (T-SB-008 through T-SB-011)**:
  - NEW `external-skills-fetcher` skill with offline-safe `git clone`/`git pull --ff-only` logic into `~/.neuralgentics/external_skills/`. Injectable `ExecFn` for testability. 9 network error patterns caught.
  - `MANIFEST.json` written with provenance metadata (repo, commit_sha, license, attribution).
  - `ExternalSkillsFetcher` TypeScript helper (363 lines, 27 tests).
  - SkillCatalog extended to read `external_skills/*` — two per-repo walkers: `walkAIResearchSkills` (numbered-category-dir pattern `^[0-9]+-.*/`) and `walkUIUXProMaxSkill` (`.claude/skills/*/SKILL.md`).
  - `ExternalProvenance` struct stamped on every external skill; both repos are MIT-licensed with proper attribution.
  - Dedup rule: local skills win over external skills with the same name.
  - Release script bundles external skills into the tarball (`--skip-external-skills` flag for lean builds). Tarball weight increase: ~10MB.

- **Phase 3 — Polish (T-SB-012 + T-SB-013)**:
  - `recordSkillReuse` — tracks token savings and bumps trust (+0.05 agent_used) on the skill's provenance memory. Never throws; all errors caught and logged.
  - `saved_tokens` formula: `max(0, 3000 - ceil(len(body+name)/4))` — rough char/4 heuristic.
  - `capSkillBody` (4000 char cap with `[... truncated]` marker) prevents large external skills from blowing up the seed prompt.
  - `pickSkill` wired into `neuralgentics_dispatch_task` — the orchestrator auto-attaches matching skills to the seed prompt (best-effort, never blocks dispatch).
  - `skill_attached` field added to dispatch response JSON.
  - Full-cycle integration test (5 tests including edge cases) — provenance memory → orchestrator picks skill → body loaded → seed prompt augmented → reuse recorded → trust bumped → cache hit on second call.

- **External skill repos** (both MIT-licensed, attribution preserved):
  - `https://github.com/Orchestra-Research/AI-Research-SKILLs` (778 files, ~22 categories)
  - `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill` (387 files, 19 platform configs)

### Changed

- The Go broker is now BOTH an MCP tool router AND a skills broker. The same role-filtered JSON-RPC surface (`broker.buildCatalog` for tools, `broker.listSkills` for skills) means one permission model for "what can this agent reach?".
- Release process now invokes `scripts/external-skills-fetcher.sh` before `build_dist`. The fetcher is offline-safe and a no-op when `external_skills.enabled` is unset or `false`.
- The plugin's `tsconfig.json` now has `types: ["node"]` so `tsc --noEmit` can find `@types/node` (pre-existing gap fixed in this release).

### Notes

- Per the original Session 29 design, the "skills broker" framing is now LEGITIMATE post-Phase 1. The plan was 13 cards across 3 phases — all delivered.
- The dispatch_task wiring (T-SB-012) is best-effort: if `pickSkill` fails, the dispatch proceeds with the original seed prompt. Skill reuse is opportunistic, not a hard requirement.
- Pre-existing issues NOT addressed in this release (out of scope): (a) no `eslint.config.*` file in the project (root `bun run lint` fails), (b) broker-go proxy test hangs in `readLoop` (pre-existing on baseline commit 2089083).

### Quality gates

- packages/sdk: `npx vitest run` 72/72 + `npx tsc --noEmit` clean
- packages/plugin: `bun test` 99/99 (was 0 before this release) + `tsc --noEmit` clean
- packages/broker-go: `go vet ./...` clean, `go test -race ./src/neuralgentics/broker/catalog/` 50+/50+ pass in 1.114s, `go build ./...` clean
- packages/backend-go: `go vet ./...` + `go build ./...` clean
- 4 modified shell scripts: `bash -n` clean


Minor release: Embedding sidecar productionization (systemd user unit + PID-file fallback) + BGE-Large FP16 GPU inference + integration test fixes + end-to-end JSON-RPC smoke test (12 assertions across 7 methods).

### Added

- **Embedding sidecar productionization (T-IMPL-SIDECAR-002 through 009, 9 cards)** — the gRPC embedding sidecar can now be managed two ways:
  - **systemd user unit** (`~/.config/systemd/user/neuralgentics-sidecar.service`, auto-generated by `install.sh` on systemd systems): `Restart=on-failure`, `RestartSec=5s`, `WatchdogSec=30`, `MemoryHigh=4G`, `MemoryMax=6G`. Auto-restart on crash, journald logging, watchdog detects hangs, `loginctl enable-linger` prompt during install.
  - **PID-file wrapper** (`scripts/sidecar.sh`, always available as fallback): atomic PID write via temp+rename+fsync, `flock` locking on `/tmp/neuralgentics-embed.lock` so concurrent starts can't race, 3-level env-file cascade (`$HOME/.neuralgentics/.env` → `$PROJECT_ROOT/.env` → `./.env`), logrotate hint comment + runtime >100MB check.
  - **systemd watchdog support** (`main.py`): `sd_notify WATCHDOG=1` in a 10-second background thread, `READY=1` after server starts. Uses stdlib only (`socket.AF_UNIX/SOCK_DGRAM`) — no `python-systemd` dep.
  - **`--log-format={text,json}`** argparse flag on the sidecar entry point; `_JsonFormatter` uses stdlib `json` (no `python-json-logger` dep).
  - **Go gRPC client periodic health check** (`embed/grpc.go`): `StartHealthCheck(ctx, 30*time.Second)` returns a `*time.Ticker`, `IsHealthy()` uses `atomic.Bool`, `Close()` stops the ticker. Improved error messages include `(hint: run scripts/sidecar.sh status)` suffix.
  - **New Go config fields** (`core/config.go`): `SidecarAutoStart bool` (env `SIDECAR_AUTO_START`, default `false`, experimental — logs warning when true), `SidecarEnvFile string` (env `SIDECAR_ENV_FILE`).
  - **`scripts/.env.example`** updated with all 7 sidecar env vars documented (`NEURALGENTICS_EMBED_DEVICE`, `NEURALGENTICS_EMBED_DTYPE`, `NEURAL_EMBED_ADDR`, `EMBEDDING_MODE`, `MEMINI_EMBEDDING_ADDR`, `SIDECAR_AUTO_START`, `SIDECAR_ENV_FILE`).
  - **README "Sidecar Lifecycle" section** with 4 subsections (Systemd, PID-file wrapper, Configuration table, Troubleshooting table).
  - Full design doc at `docs/design/sidecar-productionization.md` (647 lines) — Option D (hybrid) recommended, scored 45/60 vs 50/60 (A=systemd-only) on 6 criteria.

- **BGE-Large FP16 inference on GPU (T-IMPL-BGE-FP16-001)** — new `NEURALGENTICS_EMBED_DTYPE={fp32,fp16}` env var. When `device=cuda` AND `dtype=fp16`, the model loads with `torch_dtype=torch.float16` (with `.half()` fallback for ST 5.x compatibility). Measured: BGE-Large FP16 GPU = **639.63 MiB VRAM** (50% reduction from FP32's 1,280 MiB), cosine similarity 0.6953 on test pair. Invalid dtype raises `ValueError` at import time (fail-fast). Quality gates clean (py_compile + ruff check + ruff format).

- **JSON-RPC smoke test** (`scripts/smoke-test.sh`, 192 lines, bash + jq) — covers 12 assertions across 7 JSON-RPC methods: `initialize`, `ping`, `memory.add ×2`, `memory.count`, `memory.query`, `memory.get` (round-trip content match), `memory.delete` (returns `{}`), `orchestrator.route` (resolves `code-implementation` → `coder`), `broker.buildCatalog` (non-empty), `memory.count-after-delete` (delta check), `shutdown`. Verifies dual-write end-to-end via direct DB row counts. **12/12 PASS** against the live recovered `neuralgentics_test` DB on port 6000.

### Fixed

- **3 integration test bugs** (T-ITEST-FIX-001) in `packages/memory/src/neuralgentics/memory/integration_backend_jsonrpc_test.go` + `integration_dualwrite_test.go`:
  - `findBackendBinary()` couldn't locate the binary (looked in `packages/backend-go/neuralgentics-backend`; actual is `.neuralgentics/bin/neuralgentics-backend`). Added lookup at `../../../../../.neuralgentics/bin/`.
  - Hardcoded DB credentials `postgres:testpassword` → `neuralgentics:neuralgentics` (matches Session 12 recovered DB); `sslmode=require` → `sslmode=disable`.
  - Testcontainers fallback panicked on podman-only host (`failed to create Docker provider`). Replaced `connectWithFallback` with `connectSharedDBOrSkip` — skips when shared DB unreachable or missing `memories_1024` schema.
  - All 3 integration tests now PASS against live DB: `TestIntegration_DualWrite`, `TestIntegration_DualWrite_DeleteCascades` (ON DELETE CASCADE verified), `TestIntegration_BackendJSONRPC`.

- **Pre-existing `set -u` crash in `scripts/sidecar.sh`**: `NEURAL_EMBED_ADDR` unbound variable on a clean install. Now properly guarded with `${NEURAL_EMBED_ADDR:-}`.

### Quality gates

- 4 Go modules: `go build` + `go vet` + `go test -short` clean (memory 17/17 packages, orchestrator 2/2, broker 9/9, backend 2/2).
- Python sidecar: `py_compile` + `ruff check` + `ruff format --check` clean (fixed 1 pre-existing F401 unused-import).
- 3 shell scripts: `bash -n` clean.
- JSON-RPC smoke test: **12/12 PASS** (zero regression).
- Integration tests: **3/3 PASS** against live DB.

### Container Deletion Policy compliance

This release introduces no new containers. The sidecar's lifecycle is managed by systemd (user instance) or a PID-file wrapper — fully compliant with the AGENTS.md Container Deletion Policy.

### Notes

- `SIDECAR_AUTO_START=true` is logged as experimental; the actual Go-backend-spawns-sidecar logic is deferred to v0.9.0.
- The 4 architect-recommended defaults were used for unresolved design questions (auto-start on login = on-demand, log format = plain text, socket activation = deferred, Go backend auto-start = false). Override via `~/.neuralgentics/.env` or the systemd unit.
- Pre-existing dirty working tree (mkdocs-built `site/`, `docs/architecture/*.md`) is intentionally **not** included in this commit.

## [0.6.7] - 2026-06-12

Patch release: curl|bash one-liner now works end-to-end + docker support.

### Fixed

- **`curl ... | bash` one-liner was broken on a clean re-install** — v0.6.3 fixed the broken-symlink and TTY detection bugs but the TTY guard still fired before the `.env` and container-credential-recovery checks. A user with NO `.env` file and a running `neuralgentics-pg` container would hit the TTY guard and get an error instead of having their existing setup auto-detected. Reordered `prompt_database()` to: (1) check `.env` first, (2) try to recover creds from an existing running container via `$CONTAINER_CMD exec ... printenv`, (3) auto-start a fresh container if needed, (4) only bail with the TTY error as a last resort.
- **Stopped container would create a duplicate** — When `neuralgentics-pg` existed but was stopped, the installer would try to auto-start a new container on port 6000, fail with a port conflict, and leave the user in a broken state. Now: detect stopped container → try `docker start` (or `podman start`) first → only auto-create if no container exists at all.
- **TTY error message was misleading** — The old message said "needs to ask for the PostgreSQL password" even when the actual problem was a stopped container or a credential-recovery failure. Reworded to be accurate and to suggest `docker start neuralgentics-pg` for the stopped-container case.

### Added

- **Docker support** — The installer previously hardcoded `podman`. Now uses `_detect_container_runtime()` to pick `docker` (preferred — broader install base) or fall back to `podman`. Both produce identical container behavior. Users with only docker installed no longer need to install podman. Podman-compose and docker-compose both still work for the full-stack deploy path.
- **Auto-recover creds from any container** — The `printenv` recovery path works for containers created by THIS installer OR by any other means (docker run, podman run, compose file) as long as `POSTGRES_PASSWORD` was passed via `-e`. Verified end-to-end on the user's existing `neuralgentics-pg` container (pg18) — recovered password matches what `psql` accepts.

### Verification

The canonical `curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash` now works for all three common cases: (a) existing `.env` (re-install / upgrade — returns immediately), (b) existing running container with no `.env` (auto-recovers creds, writes `.env`, continues), (c) fresh install (auto-starts a fresh container, writes `.env` with a generated password). The only failure mode is a genuinely broken environment (no docker/podman, or a stopped container that can't be started) — the error message now explains both cases and how to fix them.

## [0.6.3] - 2026-06-12

Patch release: 3 install-script critical fixes (broken symlink, curl|bash stdin trap, container credential recovery) + multi-project registry feature.

### Fixed

- **CRITICAL: Tarball archive prefix bug** — The release pipeline always wraps artifacts in a top-level `neuralgentics/` directory. The install script extracted straight to `$PREFIX`, so binaries landed at `$PREFIX/neuralgentics/bin/...` and the symlink at `~/.local/bin/neuralgentics` was dangling. The published v0.6.0/v0.6.1/v0.6.2 installers all had this bug — every fresh install had a non-functional CLI. Fix: `tar --strip-components=1` so binaries land at `$PREFIX/bin/` directly. The fragile glob-`mv` workaround that was added in v0.6.1 but never shipped is removed.
- **CRITICAL: `curl | bash` made stdin a pipe, killing the password prompt** — The PostgreSQL password prompt (`read -r db_password`) returned 1 on EOF (curl pipe), set `db_password=""`, and the installer bailed with "Password cannot be empty" before ever asking the user a question. Add a `[[ ! -t 0 ]]` guard that emits a clear "save and re-run" error explaining the workaround.
- **Container credential recovery** — When a `neuralgentics-pg` container already exists but no `.env` file does, the installer used to either ask for the password (which fails under curl pipe — see above) or give up. Now does 3-tier recovery: `podman exec ... printenv | grep POSTGRES_*` → search backup `.env` paths → interactive prompt (TTY only). Port extraction uses `podman inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}'` instead of the broken HostPort regex.

### Added

- **Multi-project registration** — The installer now writes `~/.neuralgentics/projects.toml` on first run, registering the install directory with name (basename of `$PWD`), path, timestamp, and a `default` flag. Idempotent re-runs update the existing entry instead of duplicating. First registration is marked `default = true`; re-registering a project that was already default preserves its default status. Future: `neuralgentics projects` CLI command and `/projects` TUI slash command will read this file.
- **`make lint-shell` quality gate** — Runs `bash -n` on all `scripts/*.sh` to catch syntax errors before they hit users. Wired into the `make` aggregate target.

### Verification

Tested end-to-end with the v0.6.0 tarball: `tar --strip-components=1` places binaries correctly, non-TTY stdin exits with helpful error, `--yes` mode auto-detects existing `.env` and registers the project, and 5 sequential register/re-register cycles leave the registry with exactly 1 `default = true` and 0 orphan lines.

## [0.6.2] - 2026-06-09

Patch release: 1 install-script follow-up fix + CI workflow modernization.

### Fixed

- **SSL cert permission in rootless podman (Bug #10)** — The v0.6.0/v0.6.1 SSL setup mounted the certs as `:ro` and tried to `chown` them to UID 999 on the host (Bug #8 fix), which silently fails for non-root users in rootless podman. The certs ended up as `root:root` inside the container, and the postgres user (which the entrypoint drops to via gosu) couldn't read them. Fix: use `:z` mount (no `:ro`) and chown inside a bash wrapper before exec'ing the entrypoint. This is the canonical rootless-podman pattern.

### CI Modernization

- **Bump all actions to Node.js 24 majors** (silences GitHub's Node 20 deprecation warnings; required by September 16, 2026 when Node 20 is removed from runners)
  - `actions/checkout` v4 → v5
  - `actions/setup-go` v5 → v6
  - `actions/setup-node` v4 → v5
  - `actions/cache` v4 → v5
  - `actions/upload-artifact` v4 → v5
  - `actions/download-artifact` v4 → v5
  - `softprops/action-gh-release` v2 → v3
  - `docker/login-action` v3 → v4
  - `docker/setup-buildx-action` v3 → v4
  - `docker/build-push-action` v6 → v7
  - Plus `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` env var in all 3 workflows to force any third-party actions onto Node 24
- **Fix `go.sum` cache restore bug** — `hashFiles('**/go.sum')` at repo root never matches because `go.sum` lives in `packages/*/`. Changed to `hashFiles('packages/*/go.sum')` so the Go module cache actually restores between CI runs.
- **Pin `windows-latest` to `windows-2022`** — `windows-latest` is being redirected to `windows-2025-vs2026` on June 15, 2026. Pin explicitly to avoid surprises.

## [0.6.1] - 2026-06-09

Patch release: 3 install-script follow-up fixes found when re-testing the v0.6.0 install.

### Fixed

- **DEFAULT_VERSION not bumped in v0.6.0 install.sh (Bug #1-again)** — The T-DOCS-V060 card bumped package.json to 0.6.0 but missed install.sh's DEFAULT_VERSION, which still said 0.5.0. Result: the v0.6.0 install.sh downloaded the v0.5.0 binaries (without the 5 fixes). Bump to 0.6.0.
- **SSL cert :ro mount chown failure (Bug #8)** — The v0.6.0 SSL setup mounted certs as :ro then tried to chown inside the entrypoint, which fails with "Read-only file system" and kills the container. Fix: chown 999:999 on the host before mounting :ro, drop the chown from the entrypoint.
- **mktemp failed when data dir didn't exist (Bug #9)** — The SSL cert mktemp needed the data dir to exist. Add mkdir -p before mktemp.

## [0.6.0] - 2026-06-09

Minor release: 5 install-script and TUI-runtime bug fixes for a complete 100% working install. The canonical `curl -fsSL .../install.sh | bash` one-liner now works for the first time since v0.1.0.

### Added

- **TUI graceful sidecar fallback (Bug #4)** — The TUI no longer hangs or logs warnings when the Python embedding sidecar isn't available. New `docs/sidecar-setup.md` covers manual setup for users who want real BGE-Large embeddings. Memory operations work fine with noop embeddings by default.

### Fixed

- **Install script archive name 'v' prefix bug (Bug #2, CRITICAL)** — `scripts/install.sh` constructed `neuralgentics-v0.5.0-...` but GH release assets are `neuralgentics-0.5.0-...` (no v). The canonical one-liner has been broken since v0.1.0.
- **DEFAULT_VERSION hardcoded to 0.1.0** — Install script was hardcoded to install v0.1.0 unless the user passed `--version`. Bumped to v0.5.0.
- **TUI backend path resolver didn't know install prefix (Bug #3)** — `resolveBackendPath()` only checked $PATH, $NEURALGENTICS_BACKEND_PATH, and a source-tree relative path. Added 2 new steps: `$NEURALGENTICS_INSTALL_PREFIX/bin/...` and `$HOME/.neuralgentics/bin/...` as fallback.
- **Backend env var drift MEMINI_DB_URL → NEURALGENTICS_DB_URL (Bug #5)** — Go binary was reading `MEMINI_DB_URL` (legacy from Session 25's rename) but TUI sets `NEURALGENTICS_DB_URL`. Backend fell back to hardcoded localhost:5434 (off-limits prod). Now reads both with NEURALGENTICS_DB_URL taking precedence.
- **Install verify_install TUI version check hung (Bug #6)** — `neuralgentics --version` opened a TUI render (no --version mode), hanging the install script forever. Replaced with a size+executable check.
- **Install-spawned pg18 container had no SSL (Bug #7)** — Backend defaulted to `sslmode=require` and warned "SSL is not enabled on the server" on every startup. Now generates a self-signed cert at install time, mounts it into the container, and starts postgres with `-c ssl=on`.

### Discovery

This release was the result of a real-world install test in session 2026-06-09. The 5 install-script bugs had been shipping since v0.1.0 because Session 20's release-pipeline tests only ran `bash -n`, `--dry-run`, `--help`, and fish detection — never an actual download. **Lesson:** test scripts MUST exercise the real I/O path.

### Verification

After installing v0.6.0, `neuralgentics` should:
- Launch without hanging
- Show the install banner with env hint
- Connect to the install-spawned pg18 container on 6000 with SSL
- Work with noop embeddings (sidecar optional)



Post-release pin fix. v0.5.0 release artifacts (Dockerfile, GHCR images) already used `pgvector/pgvector:pg18`, but a handful of install/CI/bench references were still on `pg17`. This hotfix pins everything to `pg18` so a fresh install gets the same version the release artifacts expect.

### Fixed

- `scripts/install.sh` (line 987 dry-run, line 1001 install payload) — `pg17` → `pg18`
- `scripts/dev-up.sh` (line 24 `CONTAINER_IMAGE`) — `pg17` → `pg18`
- `.github/workflows/ci.yml` (lines 19, 82, 178 service containers) — `pg17` → `pg18`
- `packages/memory/src/neuralgentics/memory/bench/pgvector_test.go` (line 34 testcontainers) — `pg17` → `pg18`
- `docs/getting-started/quickstart.md` Verification Checklist row 2 — `Returns v0.1.0` → `Returns v0.5.0 (or whatever you installed)`

### Notes

- `docker/postgres.Dockerfile` was already `pg18` (this is what the v0.5.0 release images bake from). No change there.
- Historical design docs (`docs/design/session-22-*`, `docs/design/session-29-*`) retain `pg17` references because they describe the planning process and the rationale for the pg17→pg18 migration. Not retroactively edited.
- All 9 active `pg18` references are now consistent: install payload, dev script, CI, bench, and Dockerfile.
- No code logic changed. No new tests. No new features. Pure pinning + doc correction.

## [0.5.0] - 2026-06-07

Minor release: HTTP/SSE transport for hosted MCPs, OCI-shareable profile export/import, provider-aware small_model, and CI short-test fix.

### Added

- **HTTP/SSE transport for hosted MCPs (T-HTTP-TRANSPORT)** — `TransportType = "http"` and `"sse"` now work end-to-end. New `HTTPClient` in `packages/broker-go/src/neuralgentics/broker/proxy/http_client.go` implements `Initialize`, `ListTools`, `Call`, and `CallSSE` over HTTP POST + Server-Sent Events. Session tracking via `Mcp-Session-Id` response header. Auth via `Authorization` header from `TransportConfig.Env["NEURALGENTICS_MCP_AUTH"]`. SSE parsing via `bufio.Scanner` over `text/event-stream` responses. New `Client` interface in `proxy.go` and `NewClientForConfig` dispatch — `stdioClientAdapter` wraps the existing `MCPProxy` so stdio and HTTP use one code path. The `broker.activateMCPServer` handler now accepts an optional `url` field to auto-create an HTTP transport config. Activating a hosted MCP is as simple as `/mcp activate cloudflare-mcp` (assuming catalog has it) or `/catalog add <name>` with an `http` transport in the catalog.

- **OCI-shareable profile export/import (T-PROFILE-OCI)** — New `tar.gz` profile format for sharing active broker state across machines. New `packages/broker-go/src/neuralgentics/broker/profile/profile.go` with `Profile` struct, `Manifest` (version+exported_at+exported_by+broker_version+file_count), `Export(w, passphrase)` and `Import(r, passphrase)` functions. Profile contents: `profile.json`, `provider-pref.json`, `catalog.lock.json`, `permissions.json`, `opencode.snapshot.json`, `provider.json`, `manifest.json`, plus optional `signature.bin` (HMAC-SHA256 over the archive). 2 new Broker methods `ExportProfile(w, passphrase, brokerVersion)` and `ImportProfile(r, passphrase)`. 2 new JSON-RPC handlers (broker.exportProfile, broker.importProfile). TUI `/profile` slash command with sub-commands `export`, `import <path>`, `list`, `help`. Default export path: `~/Downloads/neuralgentics-profile-{timestamp}.tar.gz`. Export history tracked in `~/.config/neuralgentics/profile-history.json` (last 5). OCI registry push/pull deferred to v0.5.1.

- **Provider-aware small_model (T-SMALL-MODEL)** — TUI `/provider` command now writes the equivalent small model from the chosen provider to `provider-pref.json`. New `SMALL_MODEL_BY_PROVIDER` map: ollama-cloud → devstral-small-2:24b-cloud, dmr-local → ai/devstral-small-2:24b, openrouter → meta-llama/llama-3.1-8b-instruct. New `ProviderPref` interface fields `smallModel?` and `smallModelProvider?` (optional, backward compatible with v0.4.0 prefs). `readProviderPref` defaults to ollama-cloud's small model when prefs are missing or v0.4.0-shaped. Note: opencode itself reads `small_model` from `.opencode/opencode.json` (not from provider-pref.json) — that's documented as a design trade-off, will be unified in v0.6.0.

- **CI short-test fix (T-CI-FIX)** — Added `testing.Short()` guard to `TestStartReader_ConcurrentRequests` in `proxy_test.go`. The test exercises concurrent JSON-RPC requests over a mock stdio subprocess and takes ~30s — it's now skipped under `-short` (which is already in `ci.yml` line 73). Full test suite (no `-short`) still runs locally for verification.

### Quality gates (v0.5.0)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- 24 new Go tests (9 profile + 6 http_client + 6 wireup + 3 misc): 6 in `http_client_test.go`, 9 in `profile_test.go`, 9 elsewhere
- `tsc --noEmit` — TUI clean
- `bun test` — TUI 780 pass / 0 fail (was 766 in v0.4.0; +14: 5 small-model + 9 profile)
- `mkdocs build --strict` — 0 warnings
- Pre-existing: `TestBroker` integration test was the 30s slow test — now guarded with `t.Short()` so it skips under `-short` (CI) and runs locally with `go test -count=1 ./...`

## [0.4.0] - 2026-06-07

Minor release: multi-transport MCP support, curated catalog of 20 popular MCP servers, runtime LLM provider picker (3 providers: Ollama Cloud, Docker Model Runner, OpenRouter), and Docker Compose v2.38+ model integration.

### Added

- **Multi-transport MCP support (T-TRANSPORT-ABSTRACTION)** — Each MCP server can now declare multiple transport options (npx, uvx, local binary, docker, http). The broker auto-falls-back through the list if the chosen transport fails to launch. New types: `TransportType` enum, `TransportConfig`, `MCPServerConfig` (the multi-transport form of the legacy `ServerConfig`). Legacy `ServerConfig` configs continue to work unchanged. New methods: `Broker.RegisterMCPServer`, `Broker.ActivateMCPServerWithTransport(name, config, transportIndex)`. New JSON-RPC handlers: `broker.registerMCPServer`, `broker.activateMCPServer`.

- **Curated MCP catalog (T-CATALOG-001)** — New `mcp_catalog.json` (embedded into the broker binary via `//go:embed`) declares 20 popular MCP servers (github-mcp, gitlab-mcp, filesystem, postgres, sqlite, puppeteer, playwright, fetch, brave-search, google-maps, slack, discord, notion, linear, airtable, google-drive, memory, sequential-thinking, everything, markitdown), each with all available transports. New methods: `Broker.DiscoverCatalog(role)`, `Broker.ActivateFromCatalog(role, name, transportIndex)`, `Broker.DeactivateMCPServer(name)`, `Broker.ListTransports(name)`. `CheckTransportAvailability()` uses `exec.LookPath` to detect whether npx/uvx/docker/podman are on PATH. Permission matrix enforced on `ActivateFromCatalog`.

- **TUI /catalog and /mcp commands (T-CATALOG-001)** — New slash commands. `/catalog list|add <name>|info <name>` for browsing and adding from the catalog. `/mcp list|activate <name>|deactivate <name>` for runtime MCP lifecycle.

- **TUI /provider command (T-DUAL-PROVIDER)** — New slash command for runtime LLM provider switching. `/provider` shows current, `/provider list` pings all 3 providers with 3-second timeout, `/provider <name>` writes `~/.config/neuralgentics/provider-pref.json` (XDG_CONFIG_HOME aware). New broker method `provider.status` returns `{name, url, status, latencyMs, error}` for each provider. Note: switching is client-side and requires a TUI session restart to take effect on agent dispatch.

- **3rd and 4th LLM providers (T-OPENROUTER-PROVIDER, T-DMR-PROVIDER)** — `dmr-local` (Docker Model Runner on `localhost:12434/engines/v1`, 3 models: qwen2.5-coder:7b, llama3.2:3b, devstral-small-2:24b) and `openrouter` (5 models: claude-3.5-sonnet, gpt-4o, gemini-pro-1.5, llama-3.1-405b, mistral-large) added to `.opencode/opencode.json`. `ollama-cloud` remains the default and `small_model` remains hardcoded to it (provider-aware `small_model` deferred to v0.5.0). All use `@ai-sdk/openai-compatible` for drop-in compatibility.

- **Docker Compose v2.38+ models: block (T-COMPOSE-MODELS)** — `docker-compose.yml` now declares a top-level `models:` block with `llm: ai/qwen2.5-coder:7b`. Wired into `neuralgentics-backend` and `neuralgentics-tui` services via `models: [llm]`. Env vars `LLM_URL` and `LLM_MODEL` auto-injected by Compose. podman-compose ignores the `models:` block (graceful fallback to explicit env vars). DMR is a host-level Docker Desktop component — it is NOT a containerized service.

### Quality gates (v0.4.0)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- 65 Go tests added/modified in v0.4.0 (13 transport + 12 catalog wiring + 20 broker core + 20 improvements)
- `tsc --noEmit` — TUI clean
- `bun test` — TUI 766 pass / 0 fail (was 744 in v0.3.1; +22 new tests: 12 catalog + 10 provider)
- `mkdocs build --strict` — 0 warnings
- JSON validation — `.opencode/opencode.json` and `mcp_catalog.json` both parse cleanly
- YAML validation — `docker-compose.yml` parses via `python3 yaml.safe_load`
- Pre-existing: store + orchestrator E2E tests fail with "no Docker provider" (testcontainers init issue, not a regression)

## [0.3.1] - 2026-06-07


Patch release: backward-compatible internal IMPROVE handler enhancements.

### Added

- **AGENTS.md fingerprinting (T-IMPROVE-003)** — `ImproveResult.ConfigFingerprint` now contains SHA-256 hashes of `AGENTS.md`, `opencode.json`, the 5 `SKILL.md` files, and the 8 `agents/*.md` persona files. If two consecutive IMPROVE calls return different hashes, the user edited config mid-session and a restart is needed. Surfaces the "I forgot to restart" problem that bit us in Sessions 14 and 30.
- **Token budget tracking (T-IMPROVE-004)** — `ImproveResult.ContextBudget` now includes `TaskInputTokens`, `TaskOutputTokens`, `ContextWindowTokens` (default 200K, override via `SetContextWindow()`), and `RecommendPrecompress` (true if session budget >= 70%). Lets the orchestrator trigger `memini-ai-dev_precompress_extraction` before compaction hits.

### Quality gates (v0.3.1)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- 21 IMPROVE-related unit tests pass (6 original + 6 fingerprint + 9 token budget)
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — TUI 744 pass / 0 fail + SDK pass / 0 fail
- `mkdocs build --strict` — 0 warnings
- Pre-existing: store + orchestrator E2E tests fail with "no Docker provider" (testcontainers init issue, not a regression)

## [0.3.0] - 2026-06-07

Minor release: TUI command coverage, IMPROVE phase implementation, broker exposure fixes, dual-model memory elevation.

### Added

- **IMPROVE phase runner (T-IMPROVE-002)** — Step 7 of the 9-step Boomerang Protocol is now executable, not just documented. `packages/orchestrator-go/improve.go` provides `ImproveHandler` that calls `memory.triggerExtraction` and `memory.getTier1Summary` after quality gates pass. 6 unit tests cover success, partial failure, and edge cases.
- **7 new TUI slash commands (T-WIRE-001)** — closes the gap where 5 broker methods were exposed at the protocol layer but had no UI. New commands: `/tier0 [force]`, `/tier1 [force]`, `/peer list`, `/peer switch <id>`, `/relationships <memoryId>`, `/decay`, `/extract [convo]`. 29 new tests in `t063-slash-commands.test.ts`.
- **`elevate_memory_to_1024` Go implementation (T-ELEVATE-001)** — the last of the 6 methods from the Session 30 broker-exposure audit. Promotes a 384-dim memory to the 1024-dim table, with zero-pad + L2-normalize fallback, trust clamping to [0, 1], and idempotent inserts. 5 unit tests + 2 handler tests.

### Changed

- **4 JSON-RPC param signatures aligned with memini-ai source-of-truth (T-ALIGN-PARAMS)** — `extract_entities` now takes `memoryId` (fetches memory first), `resolve_contradiction` takes `memoryIdA + memoryIdB` (was `contradictionId`), `challenge_memory` dropped the extra `challengerId` param, `get_inference_chain` is now a standalone handler (was folded into `queryKG`).
- **TUI MethodRegistry: 43 entries marked as not-yet-wired (T-CLEANUP-DEAD-49)** — comment-only refactor. No deletions. 25 entries preserved for active use + reserved for T-WIRE-001 / T-ALIGN-PARAMS. Doc header count updated from 46 to 68 to reflect total entries.

### Fixed

- **`setup.test.ts` no longer hardcodes the version literal (T-VERS-DISK)** — reads expected version from root `package.json` at test time. Prevents the v0.1.1 / v0.1.2 / v0.1.3 / v0.2.0 release-day scramble where this test had to be manually bumped every release.

### Quality gates (v0.3.0)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — TUI 744 pass / 0 fail + SDK pass / 0 fail
- `mkdocs build --strict` — 0 warnings
- Pre-existing: store + orchestrator E2E tests fail with "no Docker provider" (testcontainers can't init in this environment). Not a regression from this release; documented in v0.2.0 quality gates section as well.

## [0.2.0] - 2026-06-06

Minor release: first-class container support + complete store/ coverage push.

### Added

- **Container support (T-FOLLOWUP-CONTAINERS-ENABLE)** — 4 images on `pgvector/pgvector:pg18` multi-stage builds. `docker-compose up` and `podman-compose up` both work end-to-end.
  - `ghcr.io/veedubin/neuralgentics-postgres:v0.2.0` — PostgreSQL 18 + pgvector, schema baked in
  - `ghcr.io/veedubin/neuralgentics-sidecar:v0.2.0` — Python gRPC embedding service
  - `ghcr.io/veedubin/neuralgentics-backend:v0.2.0` — Go JSON-RPC backend, distroless
  - `ghcr.io/veedubin/neuralgentics-tui:v0.2.0` — TUI binary, distroless
- **NEW `podman-compose.yml`** — Podman-specific tweaks (SELinux `:Z` labels, `userns_mode: keep-id`, `pids_limit`).
- **NEW `compose.example.env`** — Template `.env` for compose-based installs.

### Changed

- **`packages/memory/src/neuralgentics/memory/store/memories.go` reduced from 1,773 to 213 lines** (T-COV-001..012). Now pure CRUD on the `memories` table. Coverage in `store/` lifted from 5.5% to ≥80%.

### Cleanup

- **Deleted `packages/core/`** (Python) — vestigial code, zero imports. Backup at `/tmp/opencode/neuralgentics-core-backup-*.`
- **Deleted `packages/broker/`** (Python) — vestigial code, zero imports. Backup at `/tmp/opencode/neuralgentics-broker-python-backup-*.`
- **Documented SDK + Plugin boundary** — `packages/sdk/README.md` and `packages/plugin/README.md` clarify which is which.

### Quality gates (v0.2.0)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — TUI pass / 0 fail + SDK pass / 0 fail
- `mkdocs build --strict` — 0 warnings
- `podman build` — all 4 images build cleanly on pg18 base

## [0.1.3] - 2026-06-06

Patch release: closes the 4 deferred items from v0.1.2 plus 6 follow-up fixes from Session 27.

### Added

- **MIT LICENSE** at repo root (T-072) — `LICENSE` file with Copyright 2026 neuralgentics contributors.
- **`--version`/`-v` CLI flag** on the Go backend (T-VERS) — `neuralgentics-backend --version` prints version and exits. No DB needed.
- **JSON-RPC `initialize` returns real version** (T-VERS) — replaces hardcoded "0.1.0".
- **`docs/changelog.md` in mkdocs nav** (T-DOCS-CHANGELOG) — `/changelog/` route.
- **Release assets now ship install.sh + Dockerfiles** (T-073) — v0.1.3 release has 11 assets (was 6).
- **Checkpoint persistence** (T-079) — compaction cycles now write `compaction_checkpoint` memories, enabling future session resume (P2).
- **God-file split: `memories_1024.go`** (T-COV-001) — 1024-dim dual-model operations extracted from the 1773-line `store/memories.go` god-file. First step in the 11-card coverage push.

### Fixed

- **release.yml `body_path` bug** (T-RELEASE-CHANGELOG-PATH) — pointed at `CHANGELOG.md` which was moved to `docs/changelog.md` in T-DOCS-CHANGELOG. v0.1.3 release notes now actually populate.
- **19 trailing-slash relative links in docs/index.md** (T-LINKS-INDEX) — all 18 link patterns now use `.md` extension.
- **2 broken `v0.1.0-release-pipeline.md` links** in docs/design/docs-site-architecture.md — references removed (the parent doc was never created).
- **Quickstart troubleshooting link** (T-077) — `../troubleshooting/` → `../troubleshooting.md`.

### Quality gates (v0.1.3)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — **595 pass / 0 fail** (TUI, was 578 + 17 from T-079) + **72 pass / 0 fail** (SDK) = 667 total
- `mkdocs build --strict` — 0 warnings

## [0.1.2] - 2026-06-05

Patch release: closes the T-067b wrap-up gap from v0.1.1. The T-067b
coder dispatch reported "no changes needed" but had actually written
the `any` type cleanup to 5 panel files + `client.ts` + `sidecar.ts`
locally without committing. v0.1.2 finishes that work and fixes a
test that broke when v0.1.1 bumped the version.

### Fixed

- **`@neuralgentics/tui setup verification > package.json has correct
  name and version` was failing** in v0.1.1. The test hardcoded
  `expect(pkg.version).toBe("0.1.0")` but the package.json was
  bumped to `0.1.1`. Updated the assertion to `0.1.1`.

### Completed (deferred from v0.1.1 T-067b)

The 5 TUI panel files + 2 socket files had their `any` type
escapes replaced with the proper `TextVNode`, `BoxVNode`,
`InputVNode`, `ScrollBoxVNode` types from `packages/tui/src/vnode-types.ts`.
This was the intended scope of T-067b but was never committed.

Files:
- `packages/tui/src/panels/chain.ts` — 3 `any` → interface types
- `packages/tui/src/panels/diff.ts` — 4 `any` → interface types
- `packages/tui/src/panels/spend.ts` — 2 `any` → interface types
- `packages/tui/src/panels/status.ts` — 2 `any` → interface types
- `packages/tui/src/sidecar.ts` — 2 `any` cleanup
- `packages/tui/src/opencode-client/client.ts` — 1 `any` cleanup

Combined with the T-067/9918798 and T-067a/3dd6867 work, this
completes the architect's #7 finding: all `any` type escapes
in TUI production source have been replaced. Only 1 `any` remains
in production, in a JSDoc comment in `model-registry.ts:259`
(an example string, not actual type usage).

### Quality gates (v0.1.2 closeout)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — **578 pass / 0 fail**

## [0.1.1] - 2026-06-05

Patch release: 12 test failures discovered during Session 23's full code
review, plus several refactors and process improvements. All 578 TUI
tests pass; all 4 Go modules build and test clean.

### Fixed

- **CRITICAL: `Broker.DeregisterServer` killed the shared MCP proxy for ALL
  servers.** Removing one server from the registry would silently break
  every other running server's MCP communication. The proxy is now
  correctly treated as broker-level, not server-level. Regression test
  `TestDeregisterServer_DoesNotKillSharedProxy` added. (Commit `6cfc0ee`)
- **`TestProjectIndexer_Index_ConcurrentIndexing` was flaky** (3/3
  deterministic runs failed pre-fix). The mock store completed before
  the test's 50ms sleep, so the second concurrent call never saw the
  "already running" guard. Added `blockAddChunk`/`unblockAddChunk`
  channels to make the test deterministic. (Commit `57d06cd`)
- **11 TUI test failures** in `neuralgentics-client.test.ts` (10) and
  `setup.test.ts` (2). Root cause: `NeuralgenticsClient` constructor
  called `resolveBackendPath()` unconditionally, throwing when the
  binary wasn't installed even with `spawn:false`. Defer the path
  resolution until the binary is actually needed. (Commit `e98ac53`)
- **`CountMemories` had a broken primary query** — `Scan(nil, &active,
  nil)` for a 3-column SQL was invalid pgx. Simplified to a single
  `COUNT(*) WHERE is_archived = FALSE` with a matching single-column
  Scan. Removed the broken fallback query that was masking the bug.
  Regression test added. (Commits `803f4d9`, `4f8f668`)
- **13 silent `rows.Scan` error swallows** in `packages/memory/.../store/`
  (memories.go, search.go, agent_tools.go). All now use `slog.Warn`
  before `continue` so failures are visible. (Commit `23cd7e8`)
- **2 nil,nil stub methods** (`GetTrustAdjustments`,
  `ListFadingMemories`) replaced with explicit "not implemented"
  errors so callers can distinguish "feature unavailable" from
  "no results." (Commit `f764ac8`)

### Added

- **3 regression tests** for previously untested or thinly-tested
  areas: `TestBroker_Call_HasTimeout` (characterization test, broker
  has 30s proxy timeout but Call has no `context.Context` param),
  `TestGetMemory_IncludeArchived` (locks in correct bool handling),
  and 10 unit tests in `context_builder_test.go` for the previously
  0% coverage `context_builder.go`. (Commits `d18b646`, `c4ef87b`,
  `b11c6a8`)
- **`packages/tui/src/vnode-types.ts`** — type interfaces for
  OpenTUI VNode refs that capture write-side property shapes
  (ProxiedVNode's mapped type only captures getter return types).
  Used to replace 14 `any` type escapes across `index.ts` and 4 panel
  files. (Commit `9918798`)
- **Promise-based mutex** in `CompactionOrchestrator` replacing the
  boolean-flag anti-pattern. Includes 2 new regression tests for
  sequential and error-recovery paths. (Commit `5f4657c`)
- **Certs directory regenerated** (`certs/server.crt`,
  `certs/server.key`, `certs/initdb.d/01-enable-ssl.sh`) — was
  deleted in the Session 21 bloat cleanup and silently broke
  `neuralgentics-test-pg` startup. SSL is back on, port 6000.
- **New skill: `update-gh-docs`** — checklist + neuralgentics
  tailoring for updating GitHub-flavored docs (README, CHANGELOG,
  release notes, mkdocs) before a release tag. (Commit `3f59c81`)

### Changed

- **AGENTS.md: 3 new mandatory rules.**
  - **R4:** One task per coder per dispatch. Coder context windows
    degrade after ~60% utilization; combined dispatches (T-065+T-066)
    produce sloppy second-half output.
  - **R5:** Coders launch a `boomerang-linter` sub-agent (read-only
    scan) and apply the fixes themselves. Coder owns the diff;
    linter is an advisor, not a writer.
  - **R6:** Every release card spawns a child T-DOCS card that
    invokes `update-gh-docs` before the tag is pushed. The release
    card is not "done" until the docs card is "done." Motivated by
    the v0.1.0 install-URL pointing to a non-existent release asset
    (fixed post-tag in commit `afdc89d`).
- **Kanban skill: 4 new granularity rules (G1-G4)** — one logical
  change per card, lint work is a separate `T-LINT-NNN` card,
  refactor of N files is at least N cards.
- **Orchestrator skill: dispatch granularity rules** added as
  section 4.1.

### Quality gates (Session 23 closeout)

- `go vet` — 4/4 Go modules clean
- `go test -short` — 4/4 Go modules PASS
- `tsc --noEmit` — TUI + overlay both clean
- `bun test` — **578 pass / 0 fail** (up from 565/11 in v0.1.0)
- All 5 platform builds still green in the release workflow

## [0.1.0] - 2026-06-04

The first public release of Neuralgentics. Multi-agent orchestration with
trust-weighted memory, a permissions-based MCP broker, and context that
survives sessions.

### Added

- **Multi-platform binary builds.** 5-target release matrix in
  `.github/workflows/release.yml`: `linux-amd64`, `linux-arm64`,
  `darwin-arm64`, `windows-amd64`, `windows-arm64`. Tag-triggered
  (`v*`) with automatic SHA256 aggregation and GitHub Release
  publication via `softprops/action-gh-release@v2`.
- **GHCR container images.** `neuralgentics-postgres`, `neuralgentics-sidecar`,
  `neuralgentics-backend`, and `neuralgentics-tui` published to
  `ghcr.io/veedubin/neuralgentics-*` on every release.
- **Interactive install script.** `scripts/install.sh` now prompts for:
  - Install location: local to project, home directory, or custom path
    (with WSL detection, sudo fallback, writable-path validation)
  - Database setup: start fresh podman container, connect to existing
    server (with `.env` file option), or skip
  - Non-interactive mode via `--yes` / `--non-interactive`
  - Dry-run via `--dry-run` (does not mutate podman state)
  - WSL detection warns when paths would escape the Linux distro
- **Documentation site** at `https://veedubin.github.io/neuralgentics/`,
  built with `mkdocs-material`. 13 user-facing pages plus 8 design docs
  and 4 archived pre-v0 pages.
  - Home page: hero, problem statement, what-it-is, dispatch diagram,
    why-different, 6-framework comparison table, 3 ASCII/Unicode
    terminal mockups, quicklinks, CTA
  - Getting Started: installation + quickstart
  - Architecture: system overview, broker flow, dispatch flow, permission model
  - Reference: environment variables, memory system, kanban system, session lifecycle
  - Troubleshooting + Development
- **23-agent routing matrix** with permissions-based MCP broker.
  See `docs/architecture/permission-model.md` and
  `packages/broker-go/src/neuralgentics/broker/access/access.go`.
- **Trust-weighted memory** with PostgreSQL + pgvector. See
  `docs/reference/memory-system.md`.
- **Tiered memory loading** (L0/L1/L2) for context continuity across sessions.

### Changed

- Repo URL references updated from the non-existent `neuralgentics` org to
  the active `Veedubin/neuralgentics` user. Single `sed` pass to reverse
  when the org is created.
- Docs site `site_url` corrected to point at the live GH Pages URL
  (`https://veedubin.github.io/neuralgentics/`).
- Markdown quicklinks across all docs rewritten to folder-form URLs
  (mkdocs-material does not auto-resolve `.md` paths in markdown links).
- `.gitignore` hardened: excludes `opencode-base/`, `certs/`, build
  artifacts, caches, and internal session artifacts (`HANDOFF.md`,
  `CONTEXT.md`, `TASKS.md`, internal design notes, session planning
  docs).

### Fixed

- **404 bug on the docs site home page.** mkdocs.yml `site_url` pointed
  at the non-existent `neuralgentics.github.io`; corrected to
  `veedubin.github.io`. All quicklinks rewritten to folder-form URLs.
- **Critical CI fix: `packages/broker-go/.gitignore`** had a bare `broker`
  line that silently excluded 24 source files / 5,614 lines. Scoped to
  `/cmd/broker/broker` binary only.
- **CI Go version:** bumped from 1.24 to 1.25 to match the `go 1.25.0`
  directive in module `go.mod` files.
- **`go.sum` regeneration** for `memory` and `backend-go` modules; added
  `GOWORK=off` to all CI build commands to force pure replace-directive
  resolution.

### Notes

- **First-time public release.** Pre-release tag is `v0.1.0`; the
  SemVer patch line will increment for backward-compatible fixes.
- **Comparison table** at the bottom of the home page lists
  Neuralgentics, Hermes, OpenClaw, LangChain, AutoGen, CrewAI, and
  MetaGPT. 5 permission-model cells are honestly marked `(needs
  research)` — the comparison research notes
  (`docs/design/session-22-comparison-research.md`) document the
  sources and the reasons those cells could not be citable at time
  of writing.
- **ASCII/Unicode mockups** on the home page are explicitly labeled
  `MOCKUP — not a real screenshot`. Real PNG screenshots will be
  captured in a follow-up once a maintainer runs the TUI.
- **The `latest` tag** is a mutable alias that the release workflow
  updates on every release. Pin to `vX.Y.Z` for reproducible installs.

[0.1.0]: https://github.com/Veedubin/neuralgentics/releases/tag/v0.1.0
