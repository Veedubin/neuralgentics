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
