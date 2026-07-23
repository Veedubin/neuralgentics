# @veedubin/neuralgentics

Neuralgentics OpenCode Plugin — Multi-agent orchestration with trust-weighted memory, a permissions-based MCP broker, and context that survives sessions.

## What This Package Does

This npm package provides the Neuralgentics plugin for [OpenCode](https://github.com/modelcontextprotocol/opencode). It includes:

- **8 agent personas**: architect, coder, explorer, git, orchestrator, reviewer, tester, writer
- **7 skills**: orchestrator, handoff, kanban-board-manager, skill-self-audit, todo-list-updater, update-gh-docs, external-skills-fetcher
- **7 slash commands**: `/handoff`, `/orchestrator`, `/kanban-board-manager`, `/skill-self-audit`, `/todo-list-updater`, `/update-gh-docs`, `/external-skills-fetcher`
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

## CLI Flags

The `init` command accepts these flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--embed-model {bge-m3|bge-large|all-MiniLM-L6-v2}` | bge-m3 | Embedding model. bge-m3 is multilingual 8K, bge-large is English 512, MiniLM is fast 384. |
| `--quantize {fp32|fp16|int8}` | auto | Embedding model precision. Auto = fp16 on GPU, int8 on CPU. |
| `--no-lazy-load` | false | Eager-load model at startup. Skip for default lazy mode. |
| `--idle-min N` | 5 | Minutes of inactivity before sidecar unloads model. |
| `--status-port N` | 50052 | HTTP port for sidecar /status endpoint. |
| `--device {cpu|cuda}` | auto | Embedding model device. |
| `--with-backend` | false | Set up local database containers. |
| `--target DIR` | `.` | Directory to bootstrap. |
| `--yes`, `-y` | false | Skip all confirmation prompts. |
| `--dry-run` | false | Preview actions without writing. |
| `--force` | false | Overwrite existing files. |

### Examples

```bash
# Default — lazy load, int8 on CPU, no GPU detection
npx @veedubin/neuralgentics --init

# GPU machine — use fp16, eager load
npx @veedubin/neuralgentics --init --quantize fp16 --no-lazy-load

# Long-idle tolerance — don't unload for 30 min
npx @veedubin/neuralgentics --init --idle-min 30
```

## Migrate Embeddings

If you're upgrading from a previous version that used BGE-Large, your existing memories need to be re-embedded with the new model (the vector geometry is different).

```bash
# Preview what will be migrated
npx @veedubin/neuralgentics migrate-embeddings --dry-run

# Run the migration (safe — old vectors backed up automatically)
npx @veedubin/neuralgentics migrate-embeddings --from bge-large --to bge-m3

# Options
#   --from MODEL     Only migrate memories currently using this model (default: all)
#   --to MODEL       Target model (default: bge-m3)
#   --batch N        Memories per batch (default: 10)
#   --no-backup      Don't preserve old vectors in embedding_legacy column
```

The migration is safe to interrupt. Old vectors are preserved in `embedding_legacy` and `embedding_model_legacy` columns until you drop them manually.

## Multi-model support (v0.12.0+)

If memories were stored with different embedding models over time (e.g., early memories with BGE-Large, later with BGE-M3), queries automatically merge results across all model spaces using RRF (Reciprocal Rank Fusion). Each model space is searched independently, and the rankings are fused by `score = sum(1 / (k + rank))`.

No action needed — this is the default behavior. To disable RRF and use only the active model's column:

```bash
ENABLE_RRF=false
```

### Supported models

| Model            | Dimensions | Column             | Notes                          |
| ---------------- | ---------- | ------------------ | ------------------------------ |
| `all-MiniLM-L6-v2` | 384        | `embedding`          | Original memini-ai default     |
| `BAAI/bge-m3`      | 1024       | `embedding_bge_m3`  | New default since v0.11.0      |
| `BAAI/bge-large-en-v1.5` | 1024 | `embedding_bge_large` | Used by neuralgentics Go backend |

### When RRF helps

- **Mixed-history installs**: Old memories (one model) + new memories (another model)
- **Multi-user**: Different peers on the same DB using different models
- **A/B testing**: Comparing retrieval quality between models

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

- `neuralgentics-postgres`: PostgreSQL 18 + pgvector + TimescaleDB (port 6200)
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