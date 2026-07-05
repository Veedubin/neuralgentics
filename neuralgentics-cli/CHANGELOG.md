# Changelog

All notable changes to the `neuralgentics` CLI package will be documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Veedubin/neuralgentics/releases/tag/cli-v0.1.0