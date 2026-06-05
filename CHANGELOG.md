# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
