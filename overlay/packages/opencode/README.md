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

The memory backend runs as a PostgreSQL container (default port 6200). The
sidecar and backend services are optional and commented out in the shipped
compose file.

Start the bundled stack (recommended):
```bash
npx @veedubin/neuralgentics --db-start
```
This writes `docker-compose.yml` + `.env` to `~/.neuralgentics/`, runs
`compose up -d`, waits for `pg_isready`, then **offers to create your first
database user** (recommended — don't share the default `neuralgentics`
superuser). After a user is created it prints that user's DSN to paste into
`--init-project`:
```
postgresql://<your-user>:<your-password>@localhost:6200/neuralgentics
```

Non-interactive (for scripts / CI):
```bash
npx @veedubin/neuralgentics --db-start --db-user alice --db-password 's3cret'
# or skip user creation entirely:
npx @veedubin/neuralgentics --db-start --yes
```

Stop the stack (volumes are preserved):
```bash
npx @veedubin/neuralgentics --db-stop
```

Manual start (if you prefer compose directly):
```bash
docker compose -f ~/.neuralgentics/docker-compose.yml up -d
# or
podman-compose -f ~/.neuralgentics/docker-compose.yml up -d
```

The shipped compose file ships a single PostgreSQL service:
- **`db-server`** (container `${NEURALGENTICS_STACK_NAME:-neuralgentics}-db`):
  PostgreSQL 18 + pgvector + TimescaleDB, port `${NEURALGENTICS_DB_PORT:-6200}`.
  The service is named `db-server` (a generic, role-based name) so you can run
  as many independent stacks as you want — see "Multi-instance" below.

The sidecar (embedding gRPC) and backend (Go JSON-RPC) services are commented
out in the compose file — uncomment them only if you need multi-model
embeddings or the team-server Go backend.

### Why create your own user?

The default superuser (`neuralgentics`/`neuralgentics`) works, but it has full
administrative privileges — you shouldn't share it across people or machines.
`--db-start`'s interactive offer creates a plain `CREATE USER` + `GRANT ALL
PRIVILEGES ON DATABASE` (no superuser), so the new account can connect and
read/write memories but can't drop the database or create other roles.
Usernames must match `^[a-zA-Z_][a-zA-Z0-9_]*$` (letters, digits, underscore;
must start with a letter or underscore) — this prevents SQL injection in the
identifier. Passwords are single-quote-escaped (`'` → `''`) in the SQL
literal. If you decline the offer, `--db-start` prints the exact `podman exec`
psql one-liner you can run later.

### Multi-instance (run several stacks side by side)

Every resource in the compose file is parameterised by
`${NEURALGENTICS_STACK_NAME:-neuralgentics}`:
- container name: `${STACK}-db`
- volume name: `${STACK}-db` (via the volume's `name:` property)
- network name: `${STACK}-net`

So you can run a second stack alongside the first by copying the env file,
setting a different stack name AND a different port, and pointing at the new
env file:
```bash
cp ~/.neuralgentics/compose.example.env ~/.neuralgentics/.env.proj2
# edit .env.proj2:
#   NEURALGENTICS_STACK_NAME=neuralgentics-proj2
#   NEURALGENTICS_DB_PORT=6300
podman-compose --env-file ~/.neuralgentics/.env.proj2 up -d
```
Both stacks share the same `docker-compose.yml` — only the env file differs.
Run `neuralgentics --db-start --db-user <name>` once per stack to create its
first database user.

### Team server mode (connect-to-existing)

`--init-project` team mode is **connect-to-existing only**. The old
"I'll create it" option (which was a no-op lie) has been removed. If you
don't have a PostgreSQL server yet, run `neuralgentics --db-start` first.

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