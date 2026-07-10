# Migrating from Neuralgentics v0.6.x to v0.7.0+

## Why the Change

Neuralgentics v0.7.0 dropped the standalone TUI and transitioned to an **OpenCode plugin**. This change was driven by:

- **Better integration**: OpenCode provides a unified interface for agents, plugins, and tools.
- **Reduced maintenance**: No more platform-specific binaries (5-target build matrix).
- **Enhanced functionality**: Access to OpenCode's MCP broker, LSP, and formatter ecosystem.
- **Simplified install**: Single `npx @veedubin/neuralgentics --init` command instead of curl-bash.

## What Changed

| Feature | v0.6.x (Standalone TUI) | v0.7.0+ (OpenCode Plugin) |
|---------|-------------------------|---------------------------|
| **Install Method** | `curl -fsSL .../install.sh | bash` | `npx @veedubin/neuralgentics --init` |
| **Command** | `neuralgentics` | `opencode` (OpenCode loads the plugin) |
| **Backend** | Downloaded binary | Container (`neuralgentics-backend`) |
| **Sidecar** | Systemd service or PID-file wrapper | Container (`neuralgentics-sidecar`) |
| **Database** | Podman container (`neuralgentics-pg`) | Container (`neuralgentics-postgres`) |
| **Config** | `~/.neuralgentics/.env` | `.opencode/opencode.json` (deep-merged) |
| **Memory** | Go backend binary | Go backend container (same schema as memini-ai) |

## Step-by-Step Migration

### 1. Remove the Old Install

```bash
# Remove the old install directory (default: ~/.neuralgentics)
rm -rf ~/.neuralgentics/

# If you installed to a custom path, remove that directory instead
# rm -rf /path/to/your/install
```

### 2. Bootstrap Your Project with the New Plugin

```bash
cd /path/to/your/project
npx @veedubin/neuralgentics --init
```

The `--init` command will:
- Download the latest `@veedubin/neuralgentics` release tarball.
- Back up your existing `.opencode/` directory (if any).
- Deep-merge the plugin's `opencode.json` with your existing config.
- Offer to set up the container stack (PostgreSQL + sidecar + backend).

### 3. Start OpenCode

```bash
opencode
```

OpenCode will load the Neuralgentics plugin automatically.

## Container Changes

The memory backend is now a **3-container stack** (PostgreSQL + sidecar + backend) instead of a single downloaded binary. After running `--init`:

```bash
# Start the containers (if you chose to set them up)
docker compose -f ~/.neuralgentics/docker-compose.yml up -d
```

### Key Differences:

- **Port**: The PostgreSQL container now runs on port **6000** (was 5434 in v0.6.x).
- **Credentials**: Default credentials are `neuralgentics:neuralgentics` (same as v0.6.x, but now consistent with memini-ai).
- **SSL**: SSL is enabled by default (self-signed cert generated during `--init`).
- **Data Directory**: Data is stored in a Docker volume, not on the host filesystem.

## Config Changes

- **`opencode.json`**: The plugin deep-merges its config with your existing `.opencode/opencode.json`. Your customizations (models, MCP servers, etc.) are preserved.
- **`.env`**: The `--init` command respects your existing `.env` file. If it's missing, it copies `compose.example.env` and stops (lets you edit credentials before starting the containers).

## Removed Features

- **Standalone TUI binary**: The `neuralgentics` command no longer exists. Use `opencode` instead.
- **PyPI package**: The `neuralgentics-cli` package on PyPI was a mistake and has been removed.
- **Curl-bash installer**: The `scripts/install.sh` installer is deprecated. Use `npx @veedubin/neuralgentics --init` instead.
- **5-platform build matrix**: The plugin is platform-independent (single npm package).

## Troubleshooting

### Issue: OpenCode Doesn't Load the Plugin

- Ensure `@veedubin/neuralgentics` is listed in `.opencode/opencode.json` under `"plugins"`.
- Run `npm install @veedubin/neuralgentics` if you installed manually.

### Issue: Containers Won't Start

- Check if `neuralgentics-postgres` is already running: `docker ps --filter name=neuralgentics-postgres`.
- If the container exists but is stopped, start it: `docker start neuralgentics-postgres`.
- If the container doesn't exist, recreate it: `docker compose -f ~/.neuralgentics/docker-compose.yml up -d`.

### Issue: DB Connection Refused

- Ensure the container is running: `docker ps --filter name=neuralgentics-postgres`.
- Check the port: `docker port neuralgentics-postgres 5432` should return `0.0.0.0:6000`.
- Verify credentials in `.env` or `docker-compose.yml`.

### Issue: SSL Errors

- The backend defaults to `sslmode=require`. If you see SSL errors, ensure:
  - The `neuralgentics-postgres` container was started with SSL enabled.
  - The self-signed cert is mounted correctly (check `docker-compose.yml`).

## Migrating from BGE-Large to BGE-M3 (v0.11.0+)

If you upgraded from a pre-v0.11.0 install, your existing memories were embedded with BGE-Large. The v0.11.0 default is BGE-M3, which produces different vectors. Re-embed your memories:

```bash
# After upgrading to v0.11.0
npx @veedubin/neuralgentics migrate-embeddings --from bge-large --to bge-m3
```

This takes ~2-5 minutes for ~80 memories. Old vectors are preserved in `embedding_legacy` columns for 30 days (or until you drop them).

If you want to keep using BGE-Large, pass `--embed-model bge-large` to the init CLI or set `NEURALGENTICS_EMBED_MODEL=bge-large` in `.env`. No migration needed.

## What to Do If You're Stuck

Open an issue at:

[https://github.com/Veedubin/neuralgentics/issues](https://github.com/Veedubin/neuralgentics/issues)