# Changelog — `@veedubin/neuralgentics`

All notable changes to the `@veedubin/neuralgentics` OpenCode plugin are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## v0.15.21 (2026-07-27)

**Fixed:**
- **Plugin auto-promotion of `MEMINI_DB_URL` now actually works** — the v0.15.19 fix was a no-op because the Go backend child process was spawned inside `server()` BEFORE the `config` hook ever fired. `GoBackendClient` now supports a `{ lazy: true }` mode that defers the spawn until the config hook calls `setLoadedConfig(cfg)` then `backend.start()`. The Go backend now correctly picks up `NEURALGENTICS_DB_URL` from the loaded opencode config, eliminating the `main.go:771: failed to initialize` error when running against a non-default PostgreSQL DSN. See HANDOFF.md Session 60.

## v0.15.20 (2026-07-27)

**Fixed:**
- **`--init-project` re-run corruption** — re-running the installer with new interactive input no longer silently overwrites your working config. The installer now detects existing `.neuralgentics-state.json` and exits cleanly with a clear message unless `--force` is passed. Port input is validated (1-65535), `.env` files are backed up before overwrite, and host/db name inputs get basic sanity checks. See HANDOFF.md Session 60.

**Changed:**
- New helper `env-file.ts` provides a single `updateEnvFile()` function with backup support. Both `promptTeamConnection` and `promptOllamaApiKey` now use it.

## [0.15.19] — 2026-07-27

### Fixed
- **`NEURALGENTICS_DB_URL` env loading** — the Go backend now reads
  `NEURALGENTICS_DB_URL` from `.env` (or `$NEURALGENTICS_ENV_FILE`), and
  the OpenCode plugin auto-injects it from
  `opencode.json → mcp.memini-ai-dev.env.MEMINI_DB_URL` if no env var is
  set. Fixes `--init-project --team` silently falling back to the
  hardcoded `localhost:6000/neuralgentics` default DSN when the user
  pointed memini-ai at a different DB (e.g. `localhost:5434/memini`).
  Precedence: explicit shell env > `.env` > `opencode.json` MCP env
  block > Go binary hardcoded default.

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
