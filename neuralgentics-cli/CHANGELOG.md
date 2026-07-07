# Changelog

All notable changes to the `neuralgentics` CLI package will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-07-06

### Changed — Breaking

- **Single-flag CLI**: replaced the four-subcommand surface (`init`, `update`,
  `doctor`, `version`) with a single `--init` flag. `neuralgentics init`
  (positional) remains as an alias for `neuralgentics --init`. Bare
  `neuralgentics` (no flags) prints help and exits 0.
- **`--version` dual role**: bare `neuralgentics --version` prints the CLI
  version and exits 0; `neuralgentics --version 0.9.1 --init` installs plugin
  v0.9.1. The flag uses a sentinel `const` to distinguish the two cases.
- **`cli.py` now calls `init_cmd.run_init`**: the v0.1.0 release shipped four
  stub handlers that all raised `NotImplementedError`, making every subcommand
  print "Not yet implemented" and exit 1. The real init logic lived in
  `init_cmd.run_init` but was never wired up.

### Removed — Breaking

- `neuralgentics update` — the subcommand and `update_cmd.py` are gone.
  Re-run `neuralgentics --init` instead (idempotent via the state file).
- `neuralgentics doctor` — the subcommand and `doctor_cmd.py` are gone.
  Diagnostics may return in a future release.
- `neuralgentics version` (subcommand) — replaced by the bare `--version` flag.
  `version_cmd.py` is gone.
- `--with-backend` — was a stub that raised `NotImplementedError`. Removed
  from the CLI surface. (`init_cmd.py` still contains the stub internally; it
  is unreachable from the CLI.)
- `--compose-file`, `--env-file` — were tied to `--with-backend`. Removed.
- `compose.py`, `extract.py` — `compose.py` only served `--with-backend`;
  `extract.py` was a one-line re-export of `download.extract_tarball`. Both
  deleted. (`extract_tarball` is imported from `download` directly.)

### Added

- `tests/test_cli_main.py` — 9 tests covering the `main` entry point: `--init`
  dispatch, positional alias, no-args help, bare `--version`, `--version`
  pass-through, error passthrough, `KeyboardInterrupt` → exit 130, and a
  sanity test that all pass-through flags parse. The v0.1.0 release had zero
  test coverage for `cli.py`, which is why the broken stubs shipped.
- `tests/test_errors.py` — rewritten CLI scaffolding tests to match the new
  single-flag surface (was testing the removed subcommands).
- `tests/test_download.py` — `test_extract_module_reexports` replaced with
  `test_extract_lives_in_download_module` (extract.py is gone).

### Preserved

- `download.py`, `merge.py`, `state.py`, `errors.py` — unchanged. Their tests
  (87 tests) pass unchanged. `init_cmd.py`'s public API (`run_init`) is
  unchanged; its 11 tests pass unchanged. Only the CLI dispatch layer changed.

### Motivation

The user reported that the CLI was overbuilt for its purpose: "I want a
one-command bootstrap, not a separate app." The four-subcommand design was
aspirational — `update`/`doctor`/`version` were never implemented (all four
handlers raised `NotImplementedError`), so shipping them meant every command
except `init` printed "Not yet implemented" and exited 1. Worse, the `init`
handler *also* raised `NotImplementedError` — the real logic in
`init_cmd.run_init` was never wired up. If you ran the v0.1.0 wheel, every
subcommand was broken. v0.1.1 fixes this by collapsing the surface to what
actually works.

## [0.1.0] - 2026-07-05

Initial release of the `neuralgentics` bootstrapper CLI for the neuralgentics
OpenCode plugin. Distributed on [PyPI](https://pypi.org/project/neuralgentics/)
as a single wheel (`neuralgentics-0.1.0-py3-none-any.whl`).

### Added — Commands

- **`neuralgentics init`** — Bootstraps a project directory with the neuralgentics
  OpenCode plugin. Resolves the latest GitHub release, downloads the tarball,
  verifies the SHA-256 checksum, extracts it into `.opencode/`, deep-merges
  `opencode.json`, runs `npm install`, and writes a state file. Flags:
  `--version/-v`, `--target/-t`, `--with-backend`, `--compose-file`,
  `--env-file`, `--yes/-y`, `--offline`, `--dry-run`, `--force`, `--repo`.
  See the [design doc §1.1](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#11-neuralgentics-init)
  for the full file placement table.
- **`neuralgentics update`** — Updates an existing installation to a newer
  plugin version. Reads the state file, compares versions, downloads the new
  tarball, and applies the new release. **User-modified files are preserved
  by default** — pass `--force` to overwrite them. Flags: `--version/-v`,
  `--target/-t`, `--force`, `--yes/-y`, `--dry-run`, `--repo`.
- **`neuralgentics doctor`** — Diagnoses the current project's installation
  with 15 health checks covering: OpenCode on PATH, `.opencode/` existence,
  state file validity, plugin entry in `opencode.json`, AGENTS.md in
  instructions array, agents directory, skills directory, npm dependencies
  installed, backend reachability, compose availability, git repo cleanliness,
  and more. Exit codes: `0` clean, `1` warnings, `2` errors. `--json` for
  scripting. See the [design doc §1.3](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#13-neuralgentics-doctor)
  for the full check table.
- **`neuralgentics version`** — Prints the CLI version, the installed plugin
  version (from the state file), and the latest available plugin version
  (queried from the GitHub API). `--json` for scripting.

### Added — Features

- **`--with-backend` flag** on `init` — Brings up the container stack
  (PostgreSQL + pgvector + embedding sidecar + Go memory backend) via
  `docker compose` or `podman compose` (auto-detected). Copies
  `compose.example.env` to `.env` and prompts the user to edit it.
- **State file at `.opencode/.neuralgentics-state.json`** — Records the
  installed plugin version, the SHA-256 hash of every shipped file, and the
  manifest used to detect user modifications. This is the source of truth for
  idempotent re-runs and the `update` command's preservation logic.
- **Idempotent design** — Re-running `neuralgentics init` in a project that's
  already bootstrapped detects the existing state file, compares versions, and
  either no-ops (same version), upgrades (`update`), or refuses (downgrade
  without `--force`). No file is written twice unless `--force` is passed.
- **Deep merge of `opencode.json`** — Additive only. Injects the neuralgentics
  plugin, agent personas, skills, MCP servers, and instructions into the
  existing config. Never overwrites `provider`, `model`, MCP server URLs, or
  any field the user has set. User customizations survive every `update`.
- **Container Deletion Policy compliance** — The CLI never calls
  `podman rm`, `docker rm`, `podman system prune`, or any destructive
  container command. `--with-backend` only brings containers up; it never
  tears them down. Teardown is left to the user.

### Packaging

- Published to [PyPI](https://pypi.org/project/neuralgentics/) as
  `neuralgentics` (no namespace — distinct from the npm package
  `@veedubin/neuralgentics`).
- Build backend: `hatchling`. Single wheel + sdist.
- Entry point: `neuralgentics = "neuralgentics.cli:main"`.
- Python support: 3.10, 3.11, 3.12, 3.13.
- Dependencies: `httpx>=0.28,<1`, `pydantic>=2,<3`.
- PyPI publishing uses **OIDC trusted publishing** (PEP 740) — no API tokens.
  See `.github/workflows/pypi-publish.yml` and the one-time setup instructions
  in its header comment.

### Out of scope (explicit, v0.1.0)

- `neuralgentics remove` (uninstaller) — v0.2.0
- Home-dir / system-wide install (`~/.neuralgentics`) — maybe v0.3.0
- Systemd unit generation — maybe v0.3.0 (use `install.sh --home-dir` for now)
- Offline mode with bundled tarball — v0.2.0
- GPG signature verification — v0.3.0
- Shell completion generation — v0.1.1

`install.sh` remains the curl-bash path for users who want a system-wide
install or systemd units. The CLI and `install.sh` coexist; the CLI does not
replace it.

[0.1.1]: https://github.com/Veedubin/neuralgentics/releases/tag/cli-v0.1.1
[0.1.0]: https://github.com/Veedubin/neuralgentics/releases/tag/cli-v0.1.0