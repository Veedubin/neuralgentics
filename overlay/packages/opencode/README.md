# @veedubin/neuralgentics

Neuralgentics OpenCode Plugin — Multi-agent orchestration with trust-weighted memory, a permissions-based MCP broker, and context that survives sessions.

## What This Package Does

This npm package provides the Neuralgentics plugin for [OpenCode](https://github.com/modelcontextprotocol/opencode). It includes:

- **8 agent personas**: architect, coder, explorer, git, orchestrator, reviewer, tester, writer
- **5 skills**: boomerang-orchestrator, kanban-board-manager, skill-self-audit, todo-list-updater, update-gh-docs
- **MCP tools**: memory save/query, compaction backup/restore, stateless agent dispatch, self-evolution gate
- **Lifecycle hooks**: `session.created`, `session.idle`, `session.compacting`
- **Config merger**: Injects Neuralgentics version and memory URL into OpenCode config

## Install

Run this command in your project directory:

```bash
npx @veedubin/neuralgentics --init
```

### What `--init` Does

1. Downloads the latest `@veedubin/neuralgentics` release tarball.
2. Backs up your existing `.opencode/` directory (if any).
3. Deep-merges the plugin's `opencode.json` with your existing config (preserves your customizations).
4. Offers to set up the container stack (PostgreSQL + sidecar + backend).
   - Skips if `neuralgentics-postgres` is already running.
   - Never overwrites an existing `.env` file.
   - If `.env` is missing, copies `compose.example.env` and stops (lets you edit credentials before starting).
5. Prints DB connection info after successful setup.

## Manual Install

If you prefer not to use `--init`, add the plugin to your `.opencode/opencode.json`:

```json
{
  "plugins": [
    "@veedubin/neuralgentics"
  ]
}
```

Then run:

```bash
npm install @veedubin/neuralgentics
```

## Requirements

- Node.js 20+
- OpenCode ^1.15.0
- Docker or Podman (for the optional container stack)

## Container Stack

The memory backend runs as 3 containers:

- `neuralgentics-postgres`: PostgreSQL 18 + pgvector + TimescaleDB (port 6000)
- `neuralgentics-sidecar`: Python gRPC embedding service (BGE-Large, port 50051)
- `neuralgentics-backend`: Go JSON-RPC memory server (trust engine, knowledge graph, thought chains)

Start them with:

```bash
docker compose -f ~/.neuralgentics/docker-compose.yml up -d
```

## What You Get

- **Memory System**: Trust-weighted memory with PostgreSQL + pgvector, tiered loading (L0/L1/L2), and context continuity across sessions.
- **MCP Broker**: Permissions-based routing for 20+ MCP servers (GitHub, GitLab, filesystem, PostgreSQL, SQLite, Puppeteer, Playwright, etc.).
- **Orchestration**: 9-step Boomerang Protocol (Memory Query → Thought Chain → Planning → Delegation → Git Check → Quality Gates → IMPROVE → Doc Update → Memory Save).
- **Self-Evolution**: Auto-creates skills from repeated session patterns.
- **Kanban Board**: Tracks tasks in `TASKS.md` (triage, todo, ready, running, blocked, done, archived).

## License

MIT

## Links

- [GitHub Repository](https://github.com/Veedubin/neuralgentics)
- [Documentation](https://veedubin.github.io/neuralgentics/)