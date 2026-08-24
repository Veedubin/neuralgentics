# Changelog — `@veedubin/neuralgentics`

All notable changes to the `@veedubin/neuralgentics` OpenCode plugin are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## v0.16.14 (2026-08-24)

**Added:**
- **Governance thesis** (`docs/design/governance-thesis.md`) — the unifying product story: agent governance for homes & small teams across memini (ledger), broker/tool-groups (permissions, v1.6.0 gating upstream), gateway (egress). Includes wedge sequencing and pre-agreed kill criteria.

## v0.16.13 (2026-08-24)

**Added:**
- **README: "Cleaning Up Polluted MCP Configs" section** documenting `--reset-mcp` for users installed via pre-v0.16.7 tarballs (#3 of the post-review follow-ups).

**Removed:**
- **Dead TS packages: `packages/orchestrator` + `packages/sdk`** — orchestrator's only consumer was sdk; sdk had zero consumers anywhere (overlay, scripts, CI). Neither is imported by the shipped plugin. Completes the dead-code sweep started in v0.16.9 (tui/plugin). Go modules, memory, memini-core, and web are untouched (`web` has a dedicated extraction script for its planned standalone-repo future). `release.sh` no longer runs the deleted package's vitest suite.

## v0.16.12 (2026-08-24)

**Changed:**
- **All 12 agent personas slimmed 114KB → 96KB on disk / −37KB in the 11 non-orchestrator personas (T-AGENTS-SLIM-001 COMPLETE)** — every persona's "Built-in Tools Reference" section (per-tool signature/example tables duplicating MCP tool schemas that already arrive with each request) replaced with a compact WHEN-to-use category summary; `coder.md`'s verbatim-duplicated TypeScript Styling Guide deduplicated. Largest cuts: coder −5.3KB, architect/explorer/git/reviewer/tester/writer −4.7KB each. All load-bearing protocol content (mandatory checklists, stateless protocol, git isolation, escalation triggers, output formats, 8-step protocol) preserved verbatim. Both distribution copies synced. Combined with v0.16.11's orchestrator slice: **~53KB ≈ 13K tokens removed from the full agent-set surface**.

## v0.16.11 (2026-08-24)

**Changed:**
- **`orchestrator.md` persona slimmed 18.6KB → 14.9KB (T-AGENTS-SLIM-001, slice 1)** — the ~93-line "Built-in Tools Reference" duplicated every memini-ai-dev tool's signature and example, but MCP tool schemas already arrive with every request; the duplication was pure per-dispatch token cost (~930 tokens saved on every orchestrator invocation). Replaced with a compact WHEN-to-use category summary (memory / KG / tiered / thought chains / project index / dialectic / multi-peer / backend wrappers). All load-bearing protocol content (mandatory checklist, stateless protocol, execution-ordering rules, agent roster, 8-step protocol) preserved verbatim. Both distribution copies kept in sync (repo-root `.opencode/agents/` for the release tarball + `overlay/packages/opencode/.opencode/agents/` for npm). Remaining personas still carry similar tables — tracked on the card.

## v0.16.10 (2026-08-24)

**Added:**
- **`neuralgentics --reset-mcp` — opt-in cleanup for polluted configs (T-CFG-MERGE-PRUNE-001)** — v0.16.7 stopped NEW config pollution at the source, but installs updated before that release still carry the maintainer's personal MCP entries (13 servers, 6 enabled) that the add-only merge can never remove. The new standalone command rewrites `<target>/.opencode/opencode.json`: known neuralgentics server entries are replaced with the current minimal templates (project configs keep only `memini-ai-dev`, pgembed), homedir-only names are dropped, legacy personal plugins (`@franlol/*`) are stripped — while **unknown user-added servers are preserved untouched**. A timestamped `.bak` backup is written before any modification; `--dry-run` reports without writing. 5 new tests (reset/preserve/backup/dry-run/missing-file).

## v0.16.9 (2026-08-24)

**Removed:**
- **`packages/tui` deleted (T-TUI-REMOVE-001)** — the TUI was declared removed in v0.9.0 but the package lingered in the monorepo at 0.16.x, forcing every release validation to sync and typecheck it. `validate-release.sh` now typechecks the shipped artifact (overlay plugin) instead.
- **`packages/plugin` deleted (T-PLUGIN-DEDUP-001)** — the 919-line old-API plugin implementation superseded by `overlay/packages/opencode/src/server.ts`; it still imported `@neuralgentics/orchestrator`, drifted to VERSION 0.1.0, and its compaction hook contained the same `text:`/`content:` bug fixed in v0.16.6. Its dedicated test file (`tests/test-plugin.test.ts`) removed with it.

**Changed:**
- Reference cleanup across the toolchain: root `package.json` scripts (`build:ts`, `test`, `typecheck` now target `packages/orchestrator`; `dev:plugin` dropped — orchestrator tests run under vitest), `scripts/release.sh`, `tests/test-structure.sh` (now asserts the overlay entry point), `tests/e2e-launch.test.sh`, and all `packages/tui` checks in `scripts/validate-release.sh`. Residual-reference scan: clean. `packages/orchestrator` retained (82 vitest tests green; standalone-useful).
- Note: `@neuralgentics/orchestrator` remains a workspace package but is no longer consumed by any shipped artifact; candidate for future extraction or archival.

## v0.16.8 (2026-08-24)

**Changed:**
- **`videre-mcp` ships disabled by default (T-MCP-OPTIN-001)** — every enabled MCP server's tool schemas are injected into every LLM request, and videre's `[vision]` extra pulls heavy model deps (Florence-2 / CLIP / MiniLM). New homedir installs now enable exactly one MCP server (`memini-ai-dev`); videre's env block stays pre-wired so enabling vision is a one-line `enabled: true` flip in `~/.config/opencode/opencode.json`. Three new template assertions pin the policy.

## v0.16.7 (2026-08-24)

**Fixed:**
- **Release tarball no longer ships the maintainer's personal opencode.json (T-CFG-SHIP-001 — primary token-bloat root cause)** — `release.yml` copied the repo-root `.opencode/opencode.json` (13 MCP servers, 6 enabled incl. `github-mcp`/`playwright`/`searxng`/`markitdown`/`videre-mcp`, plus personal plugins) into every release archive; the add-only updater (`placeFiles` → `mergeOpencodeJsonFile`) then merged those into every user project, injecting ~100+ tool schemas ≈ 10–20K tokens of per-request overhead that no update could ever remove. The archive now generates its config via a new `scripts/gen-template-config.mjs`, which calls the same `buildProjectOpencodeJson()` builder the interactive installer uses: plugin ref + `instructions: ["AGENTS.md"]` + exactly one enabled MCP server (`memini-ai-dev`, pgembed). The maintainer's live config is untouched.
- **Regression guard for the Session 33 cache killer (T-CFG-PRUNE-001)** — new `template-guard.test.ts` asserts (a) neither builder can emit `compaction.prune: true` (the setting that broke the TUI token counter and destroyed provider prompt caching in Session 33), (b) the project template ships zero personal plugins and exactly one enabled MCP server, (c) the repo-root dev config keeps `prune: false`.

## v0.16.6 (2026-08-24)

**Fixed:**
- **`session.compacting` AGENTS.md backup never worked (T-COMPACT-FIX-001)** — the event handler sent `{ text: content }` to `memory.add`, but the Go backend declares `json:"content"` (`main.go:224`); every compaction backup failed with `-32602 "content is required"` and the error was swallowed by the catch block. The `makeProxyTool` text→content aliasing does not apply to direct `backend.call()`s. Fixed to send `content`; regression test intercepts the JSON-RPC layer and pins the wire format.
- **AGENTS.md loader cache leaked across projects and ignored edits (T-AGENTSCACHE-001)** — `loadAgentsMd()` cached one module-global string from the first directory that ever called it: a second project sharing the process got the first project's instructions, and mid-session edits were invisible forever. The cache is now keyed by resolved file path with mtime revalidation on every call. Config reporting (`agentsMdLoaded`) updated to match.
- **Updater ran git against a hardcoded developer path on every npm user's machine (T-UPDATER-PATH-001)** — `OPENCODE_BASE_DIR` defaulted to `/home/jcharles/...`; `checkLatest()` executed a doomed `execSync git fetch` (15s timeout) against a non-existent dir for anyone outside the original dev box. The base dir is now strictly opt-in via `NEURALGENTICS_OPENCODE_BASE_DIR` and update checking silently skips unless the path is a real `.git` checkout.
- **Plugin version drift (T-VERSIONS-001)** — overlay `server.ts` reported `VERSION = "0.2.0"` while the shipped package was 0.16.x. Now pinned to the package version with a mechanical consistency test that fails any future bump that forgets `server.ts`. Root/package/tui/install.sh all aligned at 0.16.6.

**Known issues opened as kanban cards (not yet fixed):** T-CFG-SHIP-001 (shipped tarball merges the maintainer's personal opencode.json — primary token-bloat source), T-CFG-PRUNE-001 (no regression guard against `compaction.prune:true`), T-MCP-OPTIN-001 (optional MCP servers enabled by default), T-AGENTS-SLIM-001 (114KB of agent personas), T-CFG-MERGE-PRUNE-001 (no cleanup path for already-polluted user configs), T-BACKEND-REUSE-001 (backend spawns per session), T-PLUGIN-DEDUP-001 + T-TUI-REMOVE-001 (dead code removal).

## v0.16.1 (2026-07-28)

**Fixed:**
- **Go backend migrator no longer warns "SSL is not enabled on the server" on plaintext DSNs** — `PostgresStore.Initialize()` now normalizes the migrator DSN to `sslmode=disable` ONLY when no `sslmode` query param is present. The golang-migrate postgres driver (lib/pq) defaults to attempting TLS and has no plaintext fallback, so DSNs without an explicit `sslmode` against non-TLS servers failed every migration attempt — cosmetically a red WARN toast in the OpenCode TUI at startup, but latently a correctness hazard: new SQL migrations would have silently never applied. Explicit-TLS DSNs (`require` / `verify-full` / etc.) are untouched and never silently downgraded. 2 new test functions covering the has/with-sslmode edge cases (13 sub-cases including `?sslmode=verify-full`, `?sslmode=require`, `?sslrootcert=...&sslmode=disable`, plain key=value DSNs, and the bug repro: bare DSN with no sslmode param). `go vet` clean, `go test -short` all 18 packages pass; `backend-go` (the dependent module) also builds clean against the patched `packages/memory`.

**Distribution note:**
- The Go backend (`neuralgentics-backend`) is **not** a downloadable binary in the GitHub release. It ships as a container image: `ghcr.io/veedubin/neuralgentics-backend:v0.16.1`, rebuilt by the `containers` job in `.github/workflows/release.yml` from `docker/backend.Dockerfile` (multi-stage build, distroless static final image). The CI build graph compiles `packages/backend-go` against the patched `packages/memory` via the `go.work` replace directive, so the fix is in the v0.16.1 image without any extra wiring. The npm `@veedubin/neuralgentics@0.16.1` and the `neuralgentics-0.16.1.tar.gz` release assets are unchanged in shape from v0.16.0 (same overlay plugin + .opencode/ config); the Go fix is invisible from those artifacts by design.

## v0.16.0 (2026-07-28)

**Added:**
- **`--db-start` stacks are now TLS-by-default** — the bundled PostgreSQL stack generated by `neuralgentics --db-start` now ships with TLS enabled out of the box. On first start, the plugin generates a self-signed CA + server certificate pair (`~/.memini-ai/certs/{ca.crt, ca.key, server.crt, server.key}`, keys 0600) using the system `openssl` CLI. The server certificate includes Subject Alternative Names (SANs) for `localhost`, `127.0.0.1`, and the host's detected primary LAN IP, so `sslmode=verify-full` works via the default DSN host (`localhost`) with no certificate mismatch errors. Postgres runs with `ssl=on` plus `ssl_cert_file` / `ssl_key_file` / `ssl_ca_file` pointed at the mounted certs (via the new `docker-compose.tls.yml`).
- **New `--db-no-tls` opt-out flag** — pass `--db-no-tls` alongside `--db-start` to generate the legacy plaintext stack (`docker-compose.yml`) instead of the TLS variant. Useful for offline dev environments, CI runners, or any context where generating / verifying a self-signed cert is unwanted friction.
- **`docker-compose.tls.yml` shipped in the npm tarball** — the TLS compose file is added to `package.json`'s `files` array, so it lands in the published package alongside the existing `docker-compose.yml`. Without this, every `--db-start` invocation on a fresh install would fail with "Bundled TLS docker-compose.yml not found".

**Changed:**
- **Cert generation is idempotent** — re-running `--db-start` on a stack that already has certs is a no-op. The CA + server cert pair is never regenerated or clobbered, so existing stacks never see a cert swap.
- **Existing plaintext stacks are never retrofitted** — if a user already has `~/.memini-ai/docker-compose.yml` on disk, `--db-start` does NOT silently swap it for the TLS variant. Migration to TLS is an explicit user choice (delete the old stack dir or pass `--db-no-tls` to keep plaintext).
- **`db-stack.ts` DSN writer now emits `sslmode=verify-full&sslrootcert=...`** when the stack is TLS-enabled. The DSN host stays `localhost` (always in the cert SAN list), so `verify-full` works out of the box with no client-side workarounds.

**Tests:**
- New `src/neuralgentics/tls.ts` (280 lines) — `generateCerts()`, `certPaths()`, `certsDir()`, `detectLanIp()`, plus 0600-perm chmod for private keys. Uses `execFileSync('openssl', ...)` with no Node-side crypto deps; `openssl` is the only external requirement.
- New `src/neuralgentics/tls.test.ts` (19 tests) — covers cert generation with real `openssl`, chain verification (`openssl verify -CAfile ca.crt server.crt`), SANs, key permissions, idempotency, and the `~/.memini-ai/certs/` layout. All tests run with a temp stack dir.
- New tests in `src/neuralgentics/db-stack.test.ts` (10 added) — cover `ensureStackFiles()` TLS vs plaintext source selection, backup-then-overwrite behavior, missing-bundled-file error, and the `noTls` flag passthrough. Test count: 54 total.
- Full suite: **218 pass** (1 pre-existing flaky `prompts.test.ts` interactive-timeout failure observed in one run, unrelated to this change — re-runs pass cleanly). `tsc --noEmit` clean.

**Out of scope (explicitly NOT touched):**
- The currently-running `memini-postgres` container (port 5434) — no podman / docker commands were issued, no container state was modified. TLS only applies to NEW stacks generated by `--db-start` on a fresh machine.
- memini-ai-dev v1.2.0's client-side `sslmode` support was already in place — this change closes the server-side gap (the bundled `--db-start` stack now actually serves TLS that clients can verify against).

## v0.15.24 (2026-07-28)

**Fixed:**
- **`--init-project` AGENTS.md bootstrap now lands where OpenCode looks for it** — `init.ts copyStaticAssets` was writing the shipped `AGENTS.md` to `<project>/.opencode/AGENTS.md`, but the generated `opencode.json` declared `instructions: ["AGENTS.md"]` (project-root-relative). The file OpenCode actually loaded never existed, so fresh installs got the literal default doc and never saw the agent roster, mandatory memini-ai protocol, or first-session quickstart. AGENTS.md now writes to the project root, never overwrites an existing user `AGENTS.md`, and `--update` stays idempotent.
- **Shipped `.opencode/AGENTS.md` content reset to a proper generic bootstrap** — the file shipped since v0.15.18 was the "--remodel" WIP doc (remodel documentation already lives in the README). Replaced with a self-contained generic bootstrap (project intro, mandatory memini-ai protocol, 12-agent roster, 7 slash commands, house rules, first-session quickstart) that is correct for every fresh install.

**Tests:**
- New `src/neuralgentics/init-assets.test.ts` — 7 `bun:test` cases asserting path resolution (root, not `.opencode/`), no-overwrite guard, idempotent `--update`, and content correctness.
- New `e2e_init_assets.mjs` — temp-dir end-to-end run of the bootstrap pipeline to catch any drift between the unit tests and the real `init.ts` codepath.
- Full suite: **188 pass** (1 pre-existing flaky `prompts.test.ts` interactive-timeout failure, unrelated to this change). `tsc --noEmit` clean.

## v0.15.23 (2026-07-28)

**Fixed:**
- **memini-ai-dev MCP template missing `--stdio`** — `mcp-templates.ts` generated `command: ["uvx","--from","memini-ai-dev","memini-ai"]` for both `HOMEDIR_MCP_TEMPLATES` and `PROJECT_MCP_TEMPLATES`. Since memini-ai v1.0.0, bare `memini-ai` defaults to streamable-http transport; OpenCode local MCP speaks stdio JSON-RPC, so every project installed via `neuralgentics --init-project` got `"server unavailable"` for `memini-ai-dev`. Fixed by appending `"--stdio"` to both templates. Added `timeout?: number` to the `McpServerEntry` interface and set `timeout: 120000` on the memini-ai-dev entries (first-ever launch downloads the embedding model — MiniLM ~100MB or BGE-M3 ~2.3GB — and blows past OpenCode's default MCP probe timeout). Comment in `install-packages.ts` updated to match the new command shape. New `mcp-templates.test.ts` (12 tests) asserts the `--stdio` regression can never recur.

## v0.15.22 (2026-07-28)

**Changed:**
- **memini-ai is now the canonical DB identity** — the PostgreSQL database, user, container, stack directory, and env vars are all named after memini-ai (the memory server), not neuralgentics (the orchestrator). `MEMINI_DB_URL` is the canonical env var; `NEURALGENTICS_DB_URL` is kept as a silent legacy fallback. The hardcoded Go backend default is now `postgresql://memini:memini@localhost:5434/memini` (matching the user's existing `memini-postgres` container). Installer prompts say "memini-ai server" instead of "Team server". Stack directory is `~/.memini-ai/` instead of `~/.neuralgentics/`. See HANDOFF.md Session 60e and design doc `docs/design/rename-neuralgentics-db-to-memini.md`.

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
