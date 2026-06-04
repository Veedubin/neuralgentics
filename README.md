# Neuralgentics

> Specialized coding agent built on OpenCode. Trust-weighted memory. Permission-gated MCP.

📖 **Full documentation: <https://neuralgentics.github.io/neuralgentics/>**

## Quick links

- [Installation](https://neuralgentics.github.io/neuralgentics/getting-started/installation/)
- [Quickstart](https://neuralgentics.github.io/neuralgentics/getting-started/quickstart/)
- [Architecture overview](https://neuralgentics.github.io/neuralgentics/architecture/overview/)
- [Environment variables](https://neuralgentics.github.io/neuralgentics/reference/env-vars/)
- [Troubleshooting](https://neuralgentics.github.io/neuralgentics/troubleshooting/)

## 30-second pitch

Neuralgentics is a coding-agent runtime that:

1. **Routes tasks to specialist sub-agents** (coder, architect, tester, ...)
   via a typed routing matrix
2. **Stores everything in a trust-weighted memory engine** (PostgreSQL + pgvector)
3. **Mediates all external tool access through an MCP broker** that enforces
   role-based permissions and reduces tool-catalog tokens by 95%
4. **Speaks MCP to the world** (42 JSON-RPC methods, stdio transport)
5. **Installs in one command** (`./scripts/install.sh`) or one
   `podman-compose up`

HACK THE PLANET. See the [docs](https://neuralgentics.github.io/neuralgentics/)
for everything else.

## Development setup

Neuralgentics uses [`uv`](https://docs.astral.sh/uv/) to manage Python dependencies
from the `pyproject.toml` files in each Python package, and `npm` for the
TypeScript overlay. **There are no vendored dependencies in the repo** — all
build artifacts, virtualenvs, and the vendored OpenCode source are excluded
by `.gitignore` and re-created locally on first run.

```bash
# 1. Install uv (one-time)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Install each Python package in editable mode (creates .venv automatically)
uv pip install --system -e packages/memini-core -e packages/broker
uv pip install --system -e packages/memory/cmd/embedding-sidecar

# 3. Install the TypeScript overlay
cd overlay/packages/opencode && npm install && cd -

# 4. Verify the install
make lint
```

To run the full quality-gate suite:

```bash
make all          # lint + typecheck + build + test + smoke
make docs-serve   # serve the documentation site locally
```

The `[Makefile](./Makefile)` documents every target.
