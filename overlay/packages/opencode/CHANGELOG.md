# Changelog — `@veedubin/neuralgentics`

All notable changes to the `@veedubin/neuralgentics` OpenCode plugin are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.15.15] — 2026-07-23

### Added
- **`.opencode/overrides/` personalization directory** — users can place
  `.md` files in `.opencode/overrides/` to append custom instructions to
  the corresponding default agent persona file (e.g. an override named
  `coder.md` is appended to the shipped `coder.md`). Frontmatter is
  stripped from overrides; the merge is idempotent on re-runs. The
  `overrides/` directory is never touched by updates.

## [0.15.14] — 2026-07-23

### Fixed
- **Root README team-mode copy** — fix stale install/init instructions in
  the repo-root `README.md` that referenced the old curl-bash installer
  flow. v0.15.13 ships the `npx @veedubin/neuralgentics --init` flow;
  README now matches.

## [0.15.13] — 2026-07-22

### Added
- **Team DB connect-to-existing only** — the team-server database is no
  longer created/managed by neuralgentics. Users bring their own
  PostgreSQL 14+ and connect with `NEURALGENTICS_TEAM_DB_URL` (or accept
  the default bundled compose stack).
- **`--db-start` helper** — one-shot flag that boots a local
  `docker compose up -d` of the bundled Postgres + sidecar + Go backend
  stack for first-time users.
- **Multi-instance compose** — `docker-compose.yml` now supports
  `docker compose --profile team up` to bring up just the team DB
  without the rest of the stack.
- **First-user bootstrap** — when the team server boots with an empty
  users table, it creates a `neuralgentics` admin user and prints the
  generated password once to stderr (and once to `~/.neuralgentics/first-user.log`).

## [0.15.12] — 2026-07-20

### Changed
- **Plain skill names** — `orchestrator`, `coder`, etc. are no longer
  wrapped in `@skill:foo` tokens in the agent persona files. This
  matches the OpenCode skill resolution semantics and removes a class
  of "skill not found" routing errors.
- **Slash commands** — `/boomerang-handoff`, `/boomerang-init`, and the
  other 5 user-facing commands are now registered in
  `.opencode/commands/` and surface in the OpenCode command palette.
- **`videre-mcp` in shipped AGENTS.md** — the vision MCP server is now
  documented in the project `AGENTS.md` so users know to attach a
  screenshot tool by default.

## [0.15.11] — 2026-07-18

### Fixed
- Internal cleanup of stale model references across the agent
  descriptions and the installer. No user-facing behavior change.

## [0.15.10] — 2026-07-17

### Fixed
- **Model reference cleanup** — final pass to ensure every agent
  `model:` field points at an API-verified Ollama Cloud model name
  (e.g. `ollama/kimi-k2.6`, not the legacy `ollama-cloud/...` prefix).

## [0.15.9] — 2026-07-15

### Fixed
- **Agent model remap** — all 12 agent files and the installer remapped
  to API-verified Ollama Cloud model IDs. Resolves the
  `ProviderModelNotFoundError` users hit when the agent fell back to a
  decommissioned model name.

## [0.15.8] — 2026-07-12

### Changed
- **Docs overhaul** — README rewritten around the
  `npx @veedubin/neuralgentics --init` install flow. The old curl-bash
  installer is now marked deprecated and pointed at the npm flow.
