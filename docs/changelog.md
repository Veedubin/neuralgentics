# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
