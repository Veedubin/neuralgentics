# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
