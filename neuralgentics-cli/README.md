# neuralgentics

The fastest way to bootstrap a project with the neuralgentics OpenCode plugin.

[![PyPI version](https://img.shields.io/pypi/v/neuralgentics.svg)](https://pypi.org/project/neuralgentics/)
[![Python versions](https://img.shields.io/pypi/pyversions/neuralgentics.svg)](https://pypi.org/project/neuralgentics/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A bootstrapper CLI for the [neuralgentics](https://github.com/Veedubin/neuralgentics)
OpenCode plugin. It downloads the GitHub release tarball, extracts it into your
project's `.opencode/` directory, and deep-merges `opencode.json` — preserving
your existing configuration instead of clobbering it.

## Why this exists

The `install.sh` curl-bash installer works, but it requires a shell pipeline
from the internet and targets a system-wide (`~/.neuralgentics`) install. The
npm-only path requires Node at install time. This CLI gives Python users a
single `uv pip install` — no curl, no Node prerequisite — with a deep-merge of
`opencode.json` that protects user customizations on every `update`.

## Install

```bash
# Preferred (fast, isolated)
uv pip install neuralgentics
# or
pip install neuralgentics
# or — install as a standalone tool (no venv juggling)
uv tool install neuralgentics
```

## Quickstart

```bash
uv pip install neuralgentics   # 1. install the CLI
cd your-project                 # 2. enter the project you want to bootstrap
neuralgentics init              # 3. download the plugin + merge opencode.json
opencode                        # 4. launch OpenCode with the plugin loaded
```

## Commands

| Command | Description |
|---------|-------------|
| [`neuralgentics init`](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#11-neuralgentics-init) | Download the latest release tarball and bootstrap `.opencode/` in the target directory. Supports `--with-backend`, `--dry-run`, `--force`, `--version`, `--target`. |
| [`neuralgentics update`](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#12-neuralgentics-update) | Update an existing installation to a newer plugin version. Preserves user-modified files unless `--force` is passed. |
| [`neuralgentics doctor`](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#13-neuralgentics-doctor) | Diagnose the current installation with 15 health checks. Exit codes: 0 = clean, 1 = warnings, 2 = errors. `--json` for scripting. |
| [`neuralgentics version`](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#14-neuralgentics-version) | Show CLI version, installed plugin version, and latest available (queries GitHub API). `--json` for scripting. |

> Full flag tables and edge cases are in the [design doc](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#1-command-surface).

## Configuration

The CLI writes a state file to `.opencode/.neuralgentics-state.json` inside your
project. It records the installed plugin version, the SHA-256 hashes of every
shipped file, and the manifest used to detect user modifications on `update`.

The `opencode.json` merge is **additive only** — it injects the neuralgentics
plugin, agent personas, skills, MCP servers, and instructions into your
existing config. It never overwrites your `provider`, `model`, `mcp` server
URLs, or any field you've set. This means **running `neuralgentics update` will
not clobber your customizations** — user-modified files are preserved by
default, and you must pass `--force` to overwrite them.

## Comparison with `install.sh`

| Feature | `install.sh` | `neuralgentics` CLI |
|---------|-------------|---------------------|
| Install method | `curl \| bash` | `uv pip install` |
| Project-local install | Yes (default) | Yes (default) |
| Home-dir / system-wide install | Yes (`--home-dir`) | No (v0.1.0) |
| `opencode.json` merge | No (symlinks entire `.opencode/`) | Yes (deep merge, preserves user config) |
| Idempotent re-run | Partially | Fully (state file tracks every file) |
| Update in-place | No (re-run install) | Yes (`neuralgentics update`) |
| Diagnostics | No | Yes (`neuralgentics doctor`) |
| Dry-run | Yes (`--dry-run`) | Yes (`--dry-run`) |
| Backend bring-up | Manual (prints command) | Semi-automated (`--with-backend`) |
| Systemd unit generation | Yes | No (out of scope for v0.1.0) |

`install.sh` is **untouched** and remains the curl-bash path for users who
prefer a single curl command or want a system-wide (`--home-dir`) install.

## Contributing

The CLI lives inside the neuralgentics monorepo at
[`neuralgentics-cli/`](https://github.com/Veedubin/neuralgentics/tree/main/neuralgentics-cli).
The full specification is in the
[design doc](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md).

```bash
git clone https://github.com/Veedubin/neuralgentics.git
cd neuralgentics/neuralgentics-cli
uv sync          # install dev dependencies
uv run pytest    # run the test suite (155 tests)
```

Development checks:

```bash
uv run ruff check src/ tests/   # lint
uv run mypy src/                # typecheck
uv run pytest tests/ -v         # tests
```

## License

MIT — see [LICENSE](LICENSE).

## Links

- [Design doc](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md) — full specification, flag tables, merge algorithm, error model
- [Monorepo](https://github.com/Veedubin/neuralgentics) — the neuralgentics plugin, container stack, and this CLI
- [npm plugin](https://www.npmjs.com/package/@veedubin/neuralgentics) — `@veedubin/neuralgentics` (the OpenCode overlay the CLI bootstraps)
- [PyPI package](https://pypi.org/project/neuralgentics/) — this CLI