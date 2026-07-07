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
neuralgentics --init            # 3. download the plugin + merge opencode.json
opencode                        # 4. launch OpenCode with the plugin loaded
```

> **Note**: `neuralgentics init` (positional) still works as an alias for
> `neuralgentics --init`. The flag form is preferred for clarity.

## Usage

```
neuralgentics --init [--version X.Y.Z | latest] [--target DIR] [--force]
                     [--dry-run] [--yes] [--repo OWNER/REPO] [--offline]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--init` | off | Bootstrap the target directory with the neuralgentics plugin. |
| `--version [X.Y.Z]` | `latest` | With no argument: print the CLI version and exit. With an argument: the plugin version to install. |
| `--target`, `-t` | `.` | Directory to bootstrap. |
| `--force` | off | Overwrite `.opencode/` files even if user-modified. |
| `--dry-run` | off | Preview all actions without writing anything. |
| `--yes`, `-y` | off | Skip all confirmation prompts. |
| `--repo` | `Veedubin/neuralgentics` | GitHub repository to download from. |
| `--offline` | off | Use a bundled tarball instead of downloading (not yet available). |

`neuralgentics --version` (bare) prints `neuralgentics 0.1.0` and exits 0.
`neuralgentics --version 0.9.1 --init` installs plugin v0.9.1.

> Full flag tables and edge cases are in the
> [design doc](https://github.com/Veedubin/neuralgentics/blob/main/docs/design/init-cli-bootstrapper.md#1-command-surface).
> Note: v0.1.1 collapsed the four v0.1.0 subcommands (`init`/`update`/`doctor`/`version`)
> into a single `--init` flag — the subcommands never had working handlers and the
> user wanted a one-command bootstrap. See [CHANGELOG](CHANGELOG.md) for details.

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
| Update in-place | No (re-run install) | Yes (re-run `neuralgentics --init` — idempotent via state file) |
| Diagnostics | No | No (removed in v0.1.1) |
| Dry-run | Yes (`--dry-run`) | Yes (`--dry-run`) |
| Backend bring-up | Manual (prints command) | No (removed in v0.1.1; was a stub) |
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
uv run pytest    # run the test suite (125 tests)
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