# Neuralgentics Init CLI Bootstrapper — Architecture Design

**Status:** REVISED — single-wheel model (Session 33 user decision)
**Author:** boomerang-architect (original) → orchestrator (revisions)
**Date:** 2026-07-04
**Target:** Coder Context Package for T-BOOTSTRAP-001
**Revisions (Session 33):** Originally proposed TWO packages (`@veedubin/neuralgentics` on npm + `neuralgentics` on PyPI). User pushed back: "wtf do you mean? Why do we need to ship an entirely new app just to do a fucking init?" Revised to a SINGLE wheel on PyPI that contains BOTH the CLI entry point AND the opencode plugin entry point. See `## 11. Revision: Single-Wheel Model` below.
**References:**
- `neuralgentics/scripts/install.sh` (343 lines, existing bash installer)
- `neuralgentics/.github/workflows/release.yml` (tarball assembly + npm publish)
- `neuralgentics/AGENTS.md` (Container Deletion Policy, Quality Gates, Routing Rules)
- `neuralgentics/.opencode/opencode.json` (303 lines, target merge config)
- `neuralgentics/docker-compose.yml` (92 lines, 3-service container stack)
- `neuralgentics/podman-compose.yml` (114 lines, Podman variant)
- `neuralgentics/compose.example.env` (19 lines, env template)
- `HANDOFF.md` lines 1-50 (Session 32 npm publish pipeline state)

---

## 1. Command Surface

### 1.1 `neuralgentics init`

Bootstraps a project directory with the neuralgentics OpenCode plugin.

```
neuralgentics init [FLAGS]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--version`, `-v` | `str` | `latest` | Plugin version to install. `latest` resolves to the most recent GitHub release tag. Accepts `X.Y.Z` (e.g. `0.9.1`) or `latest`. |
| `--target`, `-t` | `Path` | `$PWD` | Directory to bootstrap. Creates `.opencode/` inside this directory. |
| `--with-backend` | `bool` | `False` | Bring up the container stack after init (`compose up -d`). |
| `--compose-file` | `str` | `auto` | Which compose file to use: `auto` (detect podman vs docker), `docker`, `podman`, or a custom path. |
| `--env-file` | `Path` | `None` | Path to `.env` file for compose. If not provided and `compose.example.env` exists in the tarball, copies it to `.env` and prompts user to edit. |
| `--yes`, `-y` | `bool` | `False` | Skip all confirmation prompts (merge diff review, backend bring-up confirmation). |
| `--offline` | `bool` | `False` | Use a bundled tarball from the wheel instead of downloading. Fails if no bundled tarball exists. |
| `--dry-run` | `bool` | `False` | Preview all actions without writing anything. Shows diff of opencode.json merge, lists files to extract, prints compose command. |
| `--force` | `bool` | `False` | Overwrite existing `.opencode/` files even if user-modified (see state file design). Without `--force`, user-modified files are preserved. |
| `--repo` | `str` | `Veedubin/neuralgentics` | GitHub repository to download from. For forks/custom builds. |
| `--help` | `bool` | — | Show help. |

**Conflicts:**
- `--offline` + `--version latest` → `latest` requires network to resolve; `--offline` forces a bundled version. If no bundled tarball exists, error.
- `--offline` + `--repo` → `--repo` is ignored; offline uses bundled tarball from the wheel.
- `--dry-run` + `--yes` → `--yes` is ignored; dry-run never prompts.

**Behavior:**
1. Resolve version: if `latest`, query GitHub API `GET /repos/{repo}/releases/latest` for the tag name. Strip `v` prefix.
2. Download tarball `neuralgentics-{version}.tar.gz` from `https://github.com/{repo}/releases/download/v{version}/`.
3. Download `checksums.txt` from the same release. Verify SHA256.
4. Extract tarball to a temp directory.
5. For each file in the tarball:
   - `.opencode/agents/*.md` → `{target}/.opencode/agents/`
   - `.opencode/skills/*/` → `{target}/.opencode/skills/`
   - `.opencode/opencode.json` → **merge** (see §4), don't clobber
   - `.opencode/package.json` → `{target}/.opencode/package.json` (if not exists; if exists, merge `dependencies`)
   - `.opencode/package-lock.json` → `{target}/.opencode/package-lock.json` (if not exists)
   - `.opencode/AGENTS.md` → `{target}/.opencode/AGENTS.md` (if not exists; if exists, warn and skip)
   - `.opencode/.gitignore` → `{target}/.opencode/.gitignore` (if not exists)
   - `node_modules/@veedubin/neuralgentics/` → `{target}/.opencode/node_modules/@veedubin/neuralgentics/`
   - `docker-compose.yml` → `{target}/docker-compose.yml` (if not exists)
   - `podman-compose.yml` → `{target}/podman-compose.yml` (if not exists)
   - `compose.example.env` → `{target}/compose.example.env` (if not exists)
   - `docker/*.Dockerfile` → `{target}/docker/` (if not exists)
   - `install.sh` → `{target}/install.sh` (if not exists)
6. Run `npm install --no-audit --no-fund` in `{target}/.opencode/`.
7. If `--with-backend`, bring up containers (see §5).
8. Write state file (see §3).
9. Print success summary with next steps.

### 1.2 `neuralgentics update`

Updates an existing installation to a newer version.

```
neuralgentics update [FLAGS]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--version`, `-v` | `str` | `latest` | Version to update to. |
| `--target`, `-t` | `Path` | `$PWD` | Project directory to update. |
| `--force` | `bool` | `False` | Overwrite user-modified files. Without `--force`, user-modified files are preserved and a warning is printed. |
| `--yes`, `-y` | `bool` | `False` | Skip confirmation prompts. |
| `--dry-run` | `bool` | `False` | Preview changes without applying. |
| `--repo` | `str` | `Veedubin/neuralgentics` | GitHub repository. |
| `--help` | `bool` | — | Show help. |

**Behavior:**
1. Read state file from `{target}/.opencode/.neuralgentics-state.json`. If missing, error: "No neuralgentics installation found. Run `neuralgentics init` first."
2. Compare installed version to requested version. If same, print "Already at version X.Y.Z" and exit 0.
3. If requested version is older than installed, warn and require `--force`.
4. Download new tarball, verify SHA256.
5. For each file in the new tarball:
   - If file exists and is user-modified (per state file manifest), skip and warn (unless `--force`).
   - If file exists and is NOT user-modified, overwrite.
   - If file is new, create.
6. Run `npm install --no-audit --no-fund` in `{target}/.opencode/`.
7. Update state file with new version and refreshed manifest.
8. Print summary of what was updated, what was skipped.

### 1.3 `neuralgentics doctor`

Diagnoses the current project's neuralgentics installation.

```
neuralgentics doctor [FLAGS]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target`, `-t` | `Path` | `$PWD` | Project directory to diagnose. |
| `--json` | `bool` | `False` | Output as JSON for scripting. |
| `--help` | `bool` | — | Show help. |

**Checks performed:**

| Check | What it verifies | Severity if failing |
|-------|-----------------|---------------------|
| `opencode-on-path` | `opencode` (or `opencode.exe`) is on `$PATH` | **ERROR** — cannot proceed without it |
| `dot-opencode-exists` | `{target}/.opencode/` directory exists | **ERROR** — init not run |
| `state-file-valid` | `.opencode/.neuralgentics-state.json` exists and is valid JSON | **WARNING** — may be a manual install |
| `plugin-in-opencode-json` | `.opencode/opencode.json` has `@veedubin/neuralgentics` in `plugin` array | **ERROR** — plugin won't load |
| `instructions-in-opencode-json` | `.opencode/opencode.json` has `"AGENTS.md"` in `instructions` array | **WARNING** — AGENTS.md won't be loaded |
| `agents-exist` | `.opencode/agents/` has at least 1 `.md` file | **WARNING** — no agent personas |
| `skills-exist` | `.opencode/skills/` has at least 1 subdirectory | **WARNING** — no skills |
| `npm-deps-installed` | `.opencode/node_modules/@veedubin/neuralgentics/` exists | **ERROR** — plugin code missing |
| `backend-reachable` | If `docker-compose.yml` exists, check if `neuralgentics-backend` container is running and healthy | **INFO** — backend not running (only if user opted in) |
| `compose-available` | `docker compose` or `podman-compose` is on `$PATH` | **INFO** — needed for `--with-backend` |
| `git-repo-clean` | `git status --porcelain` in target dir (if a git repo) | **INFO** — uncommitted changes |

**Exit codes:**
- `0` — all checks pass (or only INFO-level findings)
- `1` — one or more WARNING-level findings
- `2` — one or more ERROR-level findings

### 1.4 `neuralgentics version`

Shows version information.

```
neuralgentics version [FLAGS]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | `bool` | `False` | Output as JSON. |
| `--help` | `bool` | — | Show help. |

**Output (text mode):**
```
neuralgentics CLI: 0.1.0
Installed plugin: 0.9.1 (at /home/user/project/.opencode)
Latest available: 0.9.2 (check with: neuralgentics update)
```

**Output (JSON mode):**
```json
{
  "cli_version": "0.1.0",
  "installed_plugin_version": "0.9.1",
  "install_path": "/home/user/project/.opencode",
  "latest_available": "0.9.2",
  "latest_checked_at": "2026-07-04T12:00:00Z"
}
```

The `latest_available` field requires a network call to GitHub API. If offline or the call fails, the field is `null` and a note is printed: "(offline — run `neuralgentics update --dry-run` to check)".

---

## 2. The Download Problem — Decision: Option (A)

**Chosen: Option (A) — Download from GitHub releases at runtime.**

### Justification

1. **Single source of truth.** The GitHub release tarball is the canonical artifact. Both `install.sh` and the new CLI pull from the same URL. No dual-release coordination risk.

2. **No wheel bloat.** The tarball is ~2-5 MB (plugin JS + config files). Shipping it inside the PyPI wheel would double the package size and create a version-skew problem: the wheel's bundled tarball could be stale while a newer GitHub release exists.

3. **No npm dependency for init.** Option (C) requires Node/npm at init time, which defeats the "easier than curl-bash" pitch. The user's stated goal is `uv pip install neuralgentics && uv run neuralgentics --init` — no Node prerequisite.

4. **Network at init time is acceptable.** The user is already running `uv pip install` (network required). The tarball download is a single HTTP GET of a few MB. GitHub availability is a reasonable dependency for a tool whose primary distribution channel is GitHub.

5. **Offline escape hatch is designed but deferred.** The `--offline` flag exists in the command surface but is gated on a bundled tarball being present in the wheel. This is explicitly deferred to v0.2.0+ when versioning is stable and we can justify the wheel bloat. For v0.1.0, `--offline` prints: "Offline mode requires a bundled tarball. This feature is planned for v0.2.0. For now, use `neuralgentics init` with a network connection."

### GitHub API Usage

- **Resolve `latest`:** `GET /repos/Veedubin/neuralgentics/releases/latest` → extract `tag_name` (e.g. `v0.9.1`), strip `v` prefix.
- **Download tarball:** `GET https://github.com/Veedubin/neuralgentics/releases/download/v{version}/neuralgentics-{version}.tar.gz`
- **Download checksums:** `GET https://github.com/Veedubin/neuralgentics/releases/download/v{version}/checksums.txt`
- **Rate limiting:** GitHub API allows 60 req/hr unauthenticated. The `latest` resolution is 1 request. If `GITHUB_TOKEN` env var is set, use it for 5000 req/hr. The tarball/checksums downloads are from `github.com` directly (not the API), so they don't count against rate limits.
- **Caching:** Cache the `latest` resolution for 1 hour in a temp file (`/tmp/neuralgentics-latest-cache.json`) to avoid repeated API calls during `doctor`/`version` invocations.

---

## 3. State File Design

### 3.1 Location

```
{target}/.opencode/.neuralgentics-state.json
```

Lives inside `.opencode/` so it's project-scoped and travels with the project (committed to git or not, user's choice). The `.gitignore` shipped in the tarball should include `.neuralgentics-state.json` — it's a local artifact, not source code.

### 3.2 Schema

```json
{
  "$schema": "https://raw.githubusercontent.com/Veedubin/neuralgentics/main/schemas/state-v1.json",
  "version": 1,
  "installed_version": "0.9.1",
  "installed_at": "2026-07-04T12:00:00Z",
  "updated_at": "2026-07-04T12:00:00Z",
  "cli_version": "0.1.0",
  "source": "github",
  "repo": "Veedubin/neuralgentics",
  "target": "/home/user/project",
  "files": {
    ".opencode/agents/architect.md": {
      "sha256": "abc123...",
      "user_modified": false,
      "installed_from": "0.9.1"
    },
    ".opencode/agents/coder.md": {
      "sha256": "def456...",
      "user_modified": true,
      "installed_from": "0.9.0",
      "last_known_shipped_sha256": "old789..."
    },
    ".opencode/opencode.json": {
      "sha256": "ghi789...",
      "user_modified": true,
      "installed_from": "0.9.0",
      "merged": true
    }
  },
  "backend": {
    "enabled": true,
    "compose_file": "docker-compose.yml",
    "compose_tool": "docker",
    "env_file": ".env",
    "containers": ["neuralgentics-postgres", "neuralgentics-sidecar", "neuralgentics-backend"]
  }
}
```

### 3.3 Field Semantics

| Field | Purpose |
|-------|---------|
| `version` | Schema version. Bump when the schema changes. v1 is the initial schema. |
| `installed_version` | The plugin version currently installed. |
| `installed_at` | ISO 8601 timestamp of initial `init`. |
| `updated_at` | ISO 8601 timestamp of last `init` or `update`. |
| `cli_version` | Version of the `neuralgentics` CLI that performed the last operation. For diagnostics. |
| `source` | Always `"github"` for v0.1.0. Reserved for future offline/bundled sources. |
| `repo` | GitHub repo used. Allows forks. |
| `target` | Absolute path to the project directory. For `doctor` to verify it's looking at the right state file. |
| `files` | Manifest of every file extracted from the tarball. Key is relative path from `target`. |
| `files.{path}.sha256` | SHA256 of the file as it currently exists on disk. |
| `files.{path}.user_modified` | `true` if the file's SHA256 differs from the shipped SHA256 at install time. Set to `true` on first detection, never auto-reset to `false`. |
| `files.{path}.installed_from` | Plugin version that originally installed this file. |
| `files.{path}.last_known_shipped_sha256` | The SHA256 of this file as shipped in the tarball. Used during `update` to detect if the shipped version changed. If the shipped version changed AND the user modified the file, `update` prints a conflict warning. |
| `files.{path}.merged` | `true` if this file was merged (not simply copied). Only relevant for `opencode.json`. |
| `backend` | Backend state. `null` if `--with-backend` was never used. |

### 3.4 Corruption Handling

If the state file is missing, corrupted (invalid JSON), or has a `version` field we don't recognize:

1. Print a warning: "State file missing or corrupted. Re-initializing state from current files."
2. Treat all existing files as "user_modified: true" (conservative — don't overwrite anything without `--force`).
3. Rebuild the manifest by computing SHA256 of every file in `.opencode/` that matches a known tarball path.
4. Write a fresh state file with `installed_version` set to the version being installed.

### 3.5 Migration

When the schema version bumps (e.g. v1 → v2):
1. Read the old state file.
2. Transform to the new schema (add default values for new fields, rename old fields).
3. Write the new state file with `version: 2`.
4. Keep a backup: `.opencode/.neuralgentics-state.json.v1.bak`.

---

## 4. `opencode.json` Merge Strategy

### 4.1 Merge Algorithm

The merge is a **deep merge with user-preservation semantics**. The user's existing `opencode.json` is the base; the shipped `opencode.json` from the tarball is the overlay. The algorithm:

```
function merge_opencode_json(user_json, shipped_json):
    result = deep_copy(user_json)

    // 1. Plugin array — ADD only, never remove
    result.plugin = union(user_json.plugin, shipped_json.plugin)
    // Deduplicate: if "@veedubin/neuralgentics" is already present, don't add again.

    // 2. Instructions array — ADD only, never remove
    result.instructions = union(user_json.instructions, shipped_json.instructions)
    // Deduplicate: if "AGENTS.md" is already present, don't add again.

    // 3. Provider block — PRESERVE user's entirely
    // Do NOT touch result.provider. The user's model choices are sacred.

    // 4. MCP servers — PRESERVE user's, ADD new ones from shipped that don't exist
    for each (key, value) in shipped_json.mcp:
        if key not in result.mcp:
            result.mcp[key] = value
    // Never remove or modify existing MCP entries.

    // 5. LSP — PRESERVE user's, ADD new ones
    for each (key, value) in shipped_json.lsp:
        if key not in result.lsp:
            result.lsp[key] = value

    // 6. Formatter — PRESERVE user's, ADD new ones
    for each (key, value) in shipped_json.formatter:
        if key not in result.formatter:
            result.formatter[key] = value

    // 7. Top-level scalars — ADD if missing, PRESERVE if present
    for each key in ["$schema", "autoupdate", "tool_output", "compaction", "small_model"]:
        if key not in result:
            result[key] = shipped_json[key]

    return result
```

### 4.2 What is NEVER touched

- `provider` — the entire block is preserved as-is. The user's Ollama Cloud API key, model choices, custom providers — all untouched.
- Any existing `mcp` server entry — not modified, not removed.
- Any existing `lsp` entry.
- Any existing `formatter` entry.
- Any existing `plugin` entry (we only add, never remove).
- Any existing `instructions` entry (we only add, never remove).

### 4.3 What IS added (idempotently)

- `@veedubin/neuralgentics` to `plugin` array (if not present).
- `"AGENTS.md"` to `instructions` array (if not present).
- Any new MCP servers from the shipped config that the user doesn't already have.
- Any new LSP entries from the shipped config.
- Any new formatter entries from the shipped config.
- Top-level keys that are missing (`$schema`, `autoupdate`, `tool_output`, `compaction`, `small_model`).

### 4.4 Diff Display

Before writing, unless `--yes` is passed, show a unified diff of the changes:

```
--- .opencode/opencode.json (current)
+++ .opencode/opencode.json (after merge)
@@ -259,7 +259,8 @@
   "plugin": [
-    "@franlol/opencode-md-table-formatter@latest"
+    "@franlol/opencode-md-table-formatter@latest",
+    "@veedubin/neuralgentics"
   ],
@@ -294,7 +295,8 @@
   "instructions": [
-    "AGENTS.md"
+    "AGENTS.md",
+    "AGENTS.md"
   ],

Apply these changes? [Y/n]
```

If the diff is empty (nothing to change), print "opencode.json is already up to date." and skip the prompt.

### 4.5 Edge Cases

| Scenario | Behavior |
|----------|----------|
| No existing `opencode.json` | Copy shipped version verbatim. |
| Existing `opencode.json` is invalid JSON | Error: "opencode.json is not valid JSON. Please fix it and re-run." Exit code 3. |
| User has `@veedubin/neuralgentics` already | Skip plugin addition (idempotent). |
| User has `"AGENTS.md"` already in instructions | Skip instructions addition (idempotent). |
| Shipped config has a new MCP server with same name as user's | Skip — user's version wins. Print info: "MCP server 'foo' already exists in your config — keeping your version." |
| User's config is missing `$schema` | Add it from shipped. |
| User's config has extra keys not in shipped | Preserve them. |

---

## 5. Backend Bring-Up (`--with-backend`)

### 5.1 Detection: Podman vs Docker

```
function detect_compose_tool():
    if --compose-file is a custom path:
        // User specified exact file. Detect tool from file content or flag.
        if --compose-file == "podman" or file contains "userns_mode":
            tool = "podman-compose"
        else:
            tool = "docker"
    elif --compose-file == "docker":
        tool = "docker"
    elif --compose-file == "podman":
        tool = "podman-compose"
    else:  // "auto"
        // Check for podman first (user's preference on this machine)
        if command_exists("podman") and command_exists("podman-compose"):
            tool = "podman-compose"
            compose_file = "podman-compose.yml"
        elif command_exists("docker"):
            tool = "docker"
            compose_file = "docker-compose.yml"
        else:
            error("Neither docker nor podman-compose found. Install one to use --with-backend.")
```

### 5.2 The Exact Command

```
{compose_tool} compose -f {compose_file} up -d
```

Where:
- `compose_tool` is `"docker"` or `"podman-compose"`
- `compose_file` is the resolved compose file path

If `--env-file` is provided:
```
{compose_tool} compose -f {compose_file} --env-file {env_file} up -d
```

If `compose.example.env` exists and no `--env-file` and no existing `.env`:
1. Copy `compose.example.env` to `.env`.
2. Print: "Created .env from compose.example.env. Edit it to set your database password and embedding device, then run: {compose_command}"
3. Do NOT run `compose up` — the user must review the env file first.

### 5.3 What We Do If Backend Is Already Running

Check for running containers:
```
docker ps --filter name=neuralgentics-postgres --format '{{.Status}}'
# or
podman ps --filter name=neuralgentics-postgres --format '{{.Status}}'
```

If any of the three containers (postgres, sidecar, backend) are already running:
- Print: "Backend containers are already running. Skipping compose up."
- If `--force` is passed, print: "Backend is already running. Use `{compose_tool} compose -f {compose_file} down` to stop it first, then re-run with --with-backend." (Note: we never run `down` ourselves — see §5.5.)

### 5.4 Customization

Users customize the backend via:
1. **`.env` file** — sets `NEURALGENTICS_DB_PORT`, `NEURALGENTICS_DB_USER`, `NEURALGENTICS_DB_PASSWORD`, `NEURALGENTICS_DB_NAME`, `NEURALGENTICS_EMBED_DEVICE`, `NEURALGENTICS_VERSION`.
2. **`compose.override.yml`** — Docker Compose automatically merges `docker-compose.override.yml` if present. Users can add port mappings, volume mounts, etc. there. We document this in the success message.

### 5.5 Container Deletion Policy Compliance

**This CLI NEVER runs any of the following commands:**

- `docker rm`, `podman rm`
- `docker compose down`, `podman-compose down`
- `docker volume rm`, `podman volume rm`
- `docker rmi`, `podman rmi`
- `docker system prune`, `podman system prune`
- `docker compose rm`, `podman-compose rm`
- Any command that destroys containers, volumes, images, or networks.

**The only compose subcommand we run is `up -d`.** If the user needs to stop or remove containers, they do it manually. The success message includes the exact `down` command they would run, but we never run it for them.

**If `--with-backend` is passed and containers already exist but are stopped:**
- `compose up -d` will restart them. This is safe — it preserves volumes and data.
- We do NOT remove and recreate. We do NOT run `down` first.

### 5.6 What If `docker-compose.yml` Isn't in the Tarball?

The tarball currently includes `docker-compose.yml`, `podman-compose.yml`, and `docker/*.Dockerfile` (see `release.yml` lines 99-105). If a future release removes them:

- `--with-backend` prints: "This release does not include container definitions. The backend must be set up manually. See https://github.com/Veedubin/neuralgentics for instructions."
- Exit code 0 (not an error — the plugin init succeeded, just the backend is unavailable).

---

## 6. Error Model

| Error Class | Exit Code | Message Template | Remediation |
|-------------|-----------|------------------|-------------|
| `OPencodeNotFound` | 4 | `opencode is not installed or not on PATH. Install it: curl -fsSL https://opencode.ai/install.sh \| bash` | Install OpenCode, then re-run. |
| `NpmNotFound` | 5 | `npm is not installed or not on PATH. Install Node.js 20+: https://nodejs.org/` | Install Node.js, then re-run `npm install` in `.opencode/`. |
| `NetworkError` | 6 | `Failed to download {url}: {http_status} {reason}. Check your network connection and that version {version} exists.` | Check network, verify version exists at GitHub releases page. |
| `Sha256Mismatch` | 7 | `SHA256 verification failed for {filename}. Expected: {expected}, got: {actual}. The download may be corrupted or tampered. Try again.` | Re-run. If persistent, report to GitHub issues. |
| `TarballCorrupt` | 8 | `Failed to extract tarball: {error}. The archive may be corrupt or the disk may be full.` | Check disk space, re-download. |
| `ExtractionFailed` | 9 | `Extraction verification failed: {file} not found after extraction. The archive may be incomplete.` | Check the release assets on GitHub. |
| `OpenCodeJsonInvalid` | 3 | `.opencode/opencode.json is not valid JSON: {parse_error}. Please fix it and re-run.` | Fix the JSON syntax error manually. |
| `MergeConflict` | 10 | `Merge conflict in {file}: the shipped version changed and you have local modifications. Use --force to overwrite, or resolve manually.` | Review diff, decide whether to keep local changes or accept shipped version. |
| `StateFileCorrupt` | 0 (warning) | `State file is missing or corrupted. Re-initializing from current files.` | Automatic recovery — no user action needed. |
| `ComposeNotFound` | 11 | `Neither docker nor podman-compose found. Install one to use --with-backend.` | Install Docker or podman-compose. |
| `ComposeUpFailed` | 12 | `compose up failed: {stderr}. Check the compose file and your container runtime.` | Check container runtime status, port conflicts, disk space. |
| `NpmInstallFailed` | 13 | `npm install failed in {path}: {stderr}. Plugin dependencies may not be installed. Run manually: cd {path} && npm install` | Check Node.js version, network, disk space. |
| `VersionNotFound` | 14 | `Version {version} not found. Available versions: {list}. Use 'latest' for the most recent release.` | Check available versions at GitHub releases. |
| `OfflineNoBundle` | 15 | `Offline mode requires a bundled tarball, which is not available in this version. Use online mode or wait for v0.2.0+.` | Run without --offline. |
| `PermissionDenied` | 16 | `Cannot write to {path}: {error}. Check directory permissions.` | Fix permissions or run from a writable directory. |
| `TargetNotDirectory` | 17 | `{target} is not a directory. Specify an existing directory with --target.` | Create the directory or specify a different target. |

### 6.1 Error Output Format

All errors print to stderr in this format:
```
[ERROR] {message}
Suggestion: {remediation}
```

If `--json` is passed (for `doctor`), errors are structured:
```json
{
  "status": "error",
  "error_class": "NetworkError",
  "exit_code": 6,
  "message": "Failed to download...",
  "remediation": "Check your network..."
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

| Module | What We Test | Tool |
|--------|-------------|------|
| `tarball.py` | Extract tarball to temp dir, verify file layout, verify SHA256 computation | `pytest` + `tarfile` stdlib |
| `state_file.py` | Read/write state file, corruption recovery, schema migration v1→v2, `user_modified` detection via SHA256 comparison | `pytest` + `tempfile` |
| `merge.py` | opencode.json merge: plugin addition (idempotent), instructions addition, provider preservation, MCP preservation, LSP preservation, formatter preservation, missing key addition, invalid JSON handling, empty diff detection | `pytest` + `json` |
| `version_resolver.py` | Parse `latest` from mock GitHub API response, parse `X.Y.Z` string, version comparison (is `0.9.1` > `0.9.0`?), cache hit/miss | `pytest` + `responses` or `pytest-httpx` |
| `doctor.py` | Each check in isolation: opencode-on-path (mock `shutil.which`), dot-opencode-exists (temp dir), state-file-valid (valid/invalid/missing JSON), plugin-in-opencode-json (present/absent), etc. | `pytest` + `unittest.mock` |
| `compose.py` | Podman vs docker detection (mock `shutil.which`), compose command construction, env file handling, already-running detection (mock subprocess) | `pytest` + `unittest.mock` |
| `cli.py` | Argument parsing: all flags, conflicts, defaults | `pytest` + `typer` CliRunner |

### 7.2 Integration Tests

| Scenario | What We Test | Setup |
|----------|-------------|-------|
| `init` against mock GitHub release | Mock `httpx` to return a known tarball + checksums. Run `init`. Assert file layout, state file contents, opencode.json merge result. | `pytest` + `pytest-httpx` + temp dir |
| `init` idempotency | Run `init` twice. Assert second run is a no-op (all files match, state file unchanged). | Temp dir with pre-populated state file |
| `update` from old version | Install v0.9.0, then `update` to v0.9.1. Assert only changed files are updated, user-modified files are preserved. | Temp dir with v0.9.0 state + one user-modified file |
| `update` with `--force` | Same as above but with `--force`. Assert user-modified files are overwritten. | Same setup |
| `doctor` all-green | Set up a complete installation. Run `doctor`. Assert exit code 0. | Temp dir with full file layout |
| `doctor` with errors | Remove `opencode` from PATH mock, delete `node_modules/`. Run `doctor`. Assert exit code 2, specific checks fail. | Temp dir with partial installation |
| `init` with existing `opencode.json` | Pre-create an `opencode.json` with custom provider and MCP. Run `init`. Assert provider and MCP are preserved, plugin is added. | Temp dir with pre-existing opencode.json |
| SHA256 mismatch | Mock download to return a tarball whose SHA256 doesn't match checksums. Assert exit code 7. | `pytest-httpx` with mismatched content |
| Network failure | Mock `httpx` to raise `ConnectError`. Assert exit code 6, helpful message. | `pytest-httpx` with mock exception |

### 7.3 E2E Tests (Optional, Marked)

These are marked with `@pytest.mark.e2e` and skipped by default (`pytest -m "not e2e"`). Run manually with `pytest -m e2e`.

| Scenario | What We Test |
|----------|-------------|
| Full `init` against real GitHub release | Run `init` in a temp dir against the actual `Veedubin/neuralgentics` latest release. Assert `.opencode/` is populated, `opencode.json` is valid JSON, state file is written. |
| `version --json` against real GitHub API | Run `version --json`. Assert `latest_available` is a valid semver string. |

### 7.4 What We DON'T Test

- **Real OpenCode startup** — out of scope. We verify `opencode.json` is valid JSON and has the plugin reference; we don't launch opencode.
- **Real container bring-up** — out of scope. We verify the compose command is constructed correctly; we don't run it.
- **Real npm install** — out of scope. We verify the command is constructed correctly; we don't run it (network + Node dependency).
- **Windows-specific paths** — nice-to-have. We test on Linux in CI. Windows support is documented as "best-effort" for v0.1.0.

---

## 8. Packaging & Distribution

### 8.1 Build Backend

**Chosen: `hatchling`** (via `hatch`).

Justification:
- `hatchling` is the default backend for `uv init --lib`. Zero-config for simple packages.
- It's faster than `setuptools` (no `setup.py` execution at build time).
- It supports PEP 621 `pyproject.toml` metadata natively.
- It handles entry points cleanly via `[project.scripts]`.

### 8.2 Python Version Support

**Chosen: Python 3.10+**

Justification:
- Python 3.10 is the oldest version still receiving security updates (until Oct 2026).
- `typer` and `httpx` both support 3.10+.
- Ubuntu 22.04 LTS ships Python 3.10. Users on older LTS releases (20.04) would need a PPA or `uv`'s managed Python, which is acceptable.
- Dropping 3.9 avoids the `Union[X, Y]` vs `X | Y` type syntax split.

### 8.3 Dependencies

| Package | Version | Justification |
|---------|---------|---------------|
| `typer` | `>=0.15,<1` | CLI framework with rich error messages, shell completion, and `CliRunner` for testing. Chosen over `argparse` because: (a) subcommand grouping is cleaner, (b) `--help` output is auto-formatted with `rich`, (c) `CliRunner` makes testing trivial. |
| `httpx` | `>=0.28,<1` | Async HTTP client for GitHub API + tarball download. Chosen over `requests` because: (a) `pytest-httpx` provides a first-class mock, (b) HTTP/2 support for future-proofing, (c) `follow_redirects=True` by default. |
| `rich` | `>=13,<14` | Terminal formatting: colored output, progress bars for downloads, diff display for merge preview, tables for `doctor` output. Already a transitive dep of `typer`. |
| `pydantic` | `>=2,<3` | State file schema validation. Chosen over manual `dict` validation because: (a) schema is versioned and will evolve, (b) `pydantic` gives us free JSON Schema generation for `$schema` field, (c) type coercion and error messages are built-in. |

**Total dependency footprint:** 4 direct deps. `typer` pulls in `rich` and `click`. `httpx` pulls in `httpcore`, `certifi`, `h11`. `pydantic` pulls in `pydantic-core`, `annotated-types`, `typing-extensions`. Total transitive deps: ~12. Wheel size: ~2-3 MB. Acceptable.

### 8.4 Entry Point

```toml
[project.scripts]
neuralgentics = "neuralgentics.cli:main"
```

The `main` function is a `typer.Typer` app with subcommands registered via `app.add_typer()`.

### 8.5 PyPI Publish Workflow

Mirror the `publish-npm` job in `release.yml` (lines 212-258). Use **OIDC trusted publishing** — no API tokens needed.

```yaml
# .github/workflows/pypi-publish.yml (NEW FILE, not touching release.yml)
name: Publish to PyPI

on:
  push:
    tags: ['cli-v*']  # Separate tag namespace: cli-v0.1.0 vs v0.9.1 (plugin)

permissions:
  contents: read
  id-token: write  # Required for OIDC

jobs:
  pypi-publish:
    name: Build and publish to PyPI
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v5
      - run: uv build
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          attestations: true
```

**Tag namespace:** The CLI uses `cli-v*` tags (e.g. `cli-v0.1.0`) to avoid collision with the plugin's `v*` tags (e.g. `v0.9.1`). The `release.yml` workflow triggers on `v*` and is unchanged.

### 8.6 Versioning

**Chosen: Independent versioning.** The CLI (`neuralgentics` on PyPI) and the plugin (`@veedubin/neuralgentics` on npm) have separate version numbers.

Justification:
- The CLI bootstraps the plugin. It changes less frequently than the plugin.
- The plugin ships agent personas, skills, and MCP tools — these evolve with the project.
- The CLI ships download logic, merge logic, and diagnostics — these stabilize quickly.
- Independent versioning avoids lockstep releases: a plugin bug fix (v0.9.2) shouldn't force a CLI release (v0.1.1) if the CLI code didn't change.
- The CLI's `version` command shows both versions, so users always know what they have.

**Initial version:** `0.1.0` for the CLI. The plugin is at `0.9.1`.

### 8.7 CHANGELOG

Keep a `CHANGELOG.md` in the CLI package root (not the neuralgentics monorepo root — that one is for the plugin). Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## 9. Relationship to `install.sh`

### 9.1 What Stays

`install.sh` is **untouched**. It remains the curl-bash path for users who:
- Don't have Python/uv installed
- Prefer a single curl command
- Want system-wide installation (`--home-dir`)
- Want systemd unit generation and linger setup

### 9.2 What the New CLI Does That `install.sh` Doesn't

| Feature | `install.sh` | `neuralgentics` CLI |
|---------|-------------|---------------------|
| Install method | `curl \| bash` | `uv pip install` + `uv run` |
| Project-local install | Yes (default) | Yes (default) |
| Home-dir install | Yes (`--home-dir`) | No (out of scope for v0.1.0) |
| opencode.json merge | No (symlinks entire `.opencode/`) | Yes (deep merge, preserves user config) |
| Idempotent re-run | Partially (skips env file, external skills) | Fully (state file tracks every file) |
| Version pinning | Yes (`--version`) | Yes (`--version`) |
| Update in-place | No (re-run install) | Yes (`neuralgentics update`) |
| Diagnostics | No | Yes (`neuralgentics doctor`) |
| Dry-run | Yes (`--dry-run`) | Yes (`--dry-run`) |
| Backend bring-up | Manual (prints command) | Semi-automated (`--with-backend`) |
| Systemd unit | Yes | No (out of scope for v0.1.0) |
| Linger prompt | Yes | No (out of scope for v0.1.0) |
| Env file generation | Yes (`.env` for sidecar) | Partial (copies `compose.example.env` to `.env`) |
| External skills copy | Yes (`share/external_skills/`) | Yes (same tarball, same extraction) |

### 9.3 Features in `install.sh` NOT Replicated in CLI v0.1.0

1. **Systemd unit generation** — The CLI is project-local. Systemd units are for system-wide installs. Out of scope for v0.1.0. If users want systemd, they use `install.sh --home-dir`.
2. **Linger prompting** — Tied to systemd. Out of scope.
3. **Home-dir install (`~/.neuralgentics`)** — The CLI installs to `$PWD/.opencode/`. Home-dir install requires symlink management and global state, which is a different use case. Out of scope for v0.1.0.
4. **Sidecar env file generation** — The old sidecar ran as a systemd unit with a `.env` file. In the containerized model, the sidecar runs in a container with env vars from `compose.example.env`. The CLI copies `compose.example.env` to `.env` but doesn't generate a sidecar-specific env file.

### 9.4 Recommended Messaging

The CLI's success message should mention both paths:

```
╔══════════════════════════════════════════════════════════════╗
║  neuralgentics v0.9.1 initialized!                          ║
║                                                             ║
║  Plugin:  .opencode/node_modules/@veedubin/neuralgentics/   ║
║  Config:  .opencode/opencode.json                          ║
║  Agents:  .opencode/agents/ (8 personas)                    ║
║  Skills:  .opencode/skills/ (5 skills)                      ║
║                                                             ║
║  Next steps:                                                ║
║    opencode                                                 ║
║                                                             ║
║  Optional backend (PostgreSQL + embeddings):                ║
║    neuralgentics init --with-backend                        ║
║                                                             ║
║  Alternative: curl-bash installer (system-wide):            ║
║    curl -fsSL https://raw.githubusercontent.com/... \      ║
║      | bash -s -- --home-dir                                ║
╚══════════════════════════════════════════════════════════════╝
```

---

## 10. Out of Scope (Explicit)

| Feature | Reason | Target Version |
|---------|--------|---------------|
| `neuralgentics remove` (uninstaller) | Requires tracking all files, handling user-modified files, and potentially removing containers. Complex and risky for v0.1.0. | v0.2.0 |
| Auto-update check on every invocation | Adds network latency to every command. Users can run `neuralgentics version` or `neuralgentics update --dry-run` explicitly. | v0.3.0 |
| Plugin configuration UI | Out of scope for a bootstrapper. Users edit `opencode.json` directly. | Never (not a bootstrapper concern) |
| Systemd unit generation | Project-local tool. Systemd is for system-wide installs. Use `install.sh --home-dir` for that. | Maybe v0.3.0 if demand exists |
| Home-dir install (`~/.neuralgentics`) | Different use case (symlink management, global state). | Maybe v0.3.0 |
| Windows support | `uv` works on Windows, but `podman-compose` and `docker compose` have different path semantics. Best-effort for v0.1.0 — we don't block on Windows, but we accept patches. | v0.2.0 |
| `sudo` or root-requiring operations | Explicitly out of scope. The CLI runs as a normal user. | Never |
| Offline mode with bundled tarball | Requires wheel bloat and dual-release coordination. Deferred until versioning is stable. | v0.2.0 |
| GPG signature verification | SHA256 is sufficient for v0.1.0. GPG adds key management complexity. | v0.3.0 |
| Shell completion generation | `typer` supports it natively. We can add `neuralgentics --install-completion` in a patch release. | v0.1.1 |
| `neuralgentics self-update` | `uv pip install --upgrade neuralgentics` already does this. | Never (uv handles it) |

---

## Appendix A: Directory Layout of the Python Package

```
neuralgentics-cli/          # NEW directory, sibling to neuralgentics/
├── pyproject.toml
├── CHANGELOG.md
├── README.md
├── LICENSE
├── src/
│   └── neuralgentics/
│       ├── __init__.py
│       ├── cli.py           # typer app, subcommand registration
│       ├── init.py          # init command logic
│       ├── update.py        # update command logic
│       ├── doctor.py        # doctor command logic
│       ├── version_cmd.py   # version command logic
│       ├── download.py      # GitHub API + tarball download + SHA256 verify
│       ├── extract.py       # tarball extraction
│       ├── merge.py         # opencode.json merge algorithm
│       ├── state.py         # state file read/write/validate/migrate
│       ├── compose.py       # podman/docker detection, compose command construction
│       └── errors.py        # error classes, exit codes, message templates
└── tests/
    ├── test_cli.py
    ├── test_init.py
    ├── test_update.py
    ├── test_doctor.py
    ├── test_version.py
    ├── test_download.py
    ├── test_extract.py
    ├── test_merge.py
    ├── test_state.py
    ├── test_compose.py
    └── conftest.py           # shared fixtures (temp dirs, mock httpx, etc.)
```

## Appendix B: `pyproject.toml` Skeleton

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "neuralgentics"
version = "0.1.0"
description = "Bootstrapper for the neuralgentics OpenCode plugin"
readme = "README.md"
license = {text = "MIT"}
requires-python = ">=3.10"
authors = [
    {name = "Veedubin", email = "..."}
]
keywords = ["opencode", "neuralgentics", "ai", "agent", "plugin"]
classifiers = [
    "Development Status :: 3 - Alpha",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Operating System :: POSIX :: Linux",
    "Operating System :: MacOS",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.10",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
]
dependencies = [
    "typer>=0.15,<1",
    "httpx>=0.28,<1",
    "rich>=13,<14",
    "pydantic>=2,<3",
]

[project.scripts]
neuralgentics = "neuralgentics.cli:main"

[project.urls]
Homepage = "https://github.com/Veedubin/neuralgentics"
Repository = "https://github.com/Veedubin/neuralgentics"
Issues = "https://github.com/Veedubin/neuralgentics/issues"
Changelog = "https://github.com/Veedubin/neuralgentics/blob/main/neuralgentics-cli/CHANGELOG.md"

[tool.hatch.build.targets.wheel]
packages = ["src/neuralgentics"]

[tool.pytest.ini_options]
markers = [
    "e2e: end-to-end tests (require network, skipped by default)",
]
addopts = "-m 'not e2e' --strict-markers"

[tool.ruff]
target-version = "py310"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "C4", "SIM"]

[tool.mypy]
python_version = "3.10"
strict = true
```

---

## Appendix C: Open Questions for the User

1. **Tag namespace for CLI releases:** The design proposes `cli-v*` tags (e.g. `cli-v0.1.0`) to avoid collision with the plugin's `v*` tags. Is this acceptable, or would you prefer a separate repo for the CLI?

2. **Home-dir install as v0.2.0 or never?** The CLI is project-local by design. If users want `~/.neuralgentics` with symlinks, they use `install.sh`. Should the CLI ever support home-dir install, or is that permanently out of scope?

3. **`--with-backend` env file behavior:** Currently, if `compose.example.env` exists and no `.env` exists, we copy it and tell the user to edit before running `compose up`. Should we instead prompt interactively for the database password and embedding device? (Leaning toward "no" — keep it simple.)

4. **`neuralgentics` package name on PyPI:** The name `neuralgentics` is available on PyPI as of this writing. Should we reserve it now (create an empty package) or wait until v0.1.0 is ready to publish?

5. **CLI source location:** The design assumes a new `neuralgentics-cli/` directory sibling to `neuralgentics/`. Should it live inside the monorepo (e.g. `neuralgentics/packages/cli/`) or as a separate repo? Monorepo is simpler for coordinated releases; separate repo is cleaner for independent versioning.

---

## Appendix D: Top 3 Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **GitHub API rate limiting** — 60 req/hr unauthenticated. A user running `init`, `doctor`, and `version` in quick succession could hit the limit. | `init` fails with a 403. | Cache the `latest` resolution for 1 hour. Use `GITHUB_TOKEN` if available. The tarball download doesn't hit the API. |
| **opencode.json merge destroys user config** — A bug in the merge algorithm could drop the user's provider block, wiping their API keys and model choices. | User's OpenCode stops working. Hard to diagnose. | The merge algorithm explicitly preserves `provider`, `mcp`, `lsp`, and `formatter` blocks. These are never touched. The merge is tested with 10+ scenarios including custom providers, multiple MCP servers, and malformed JSON. `--dry-run` shows the diff before writing. |
| **State file drift** — The state file tracks SHA256 of every file. If a user edits a file and the SHA256 changes, `update` will skip it. But if the user edits it back to the original content, the SHA256 matches again and `update` will overwrite it. | User loses a carefully crafted edit that happened to match the original SHA256. | Extremely unlikely (SHA256 collision is astronomically improbable). The `user_modified` flag is set to `true` on first detection and never auto-reset to `false`. Even if the SHA256 matches again, the flag stays `true`. |

---

## 11. Revision: Single-Wheel Model (Session 33)

### 11.1 Why this revision

The original design (§1-10) proposed a separate PyPI bootstrapper package named `neuralgentics`, distinct from the npm plugin `@veedubin/neuralgentics`. User pushed back: shipping a whole new app for one command is overkill, and "I want the milk, not the cow." The user wants the simplest path to:

```bash
uv pip install neuralgentics
neuralgentics --init          # bootstraps the project
opencode                      # loads the plugin (from the SAME package)
```

### 11.2 Revised architecture: ONE wheel, two entry points

A single PyPI package named `neuralgentics` exposes BOTH:

1. **A CLI entry point** (`[project.scripts]`) that registers the `neuralgentics` console command with subcommands `init`, `update`, `doctor`, `version`.
2. **A plugin entry point** (`[project.entry-points."opencode.plugin"]`) that OpenCode auto-discovers when loading the user's project.

OpenCode's plugin discovery reads Python entry points in the group `opencode.plugin` from any installed package. We register a function in our package that returns a `Plugin` object (or whatever the opencode-py SDK expects). The plugin code itself is a thin wrapper — the heavy lifting (agents, skills, opencode.json) still comes from the GitHub release tarball at `init` time.

### 11.3 What changes from §1-10

| Section | Change |
|---------|--------|
| §8.1 Build backend | Unchanged — still hatchling. |
| §8.3 Dependencies | Drop `typer` and `rich` (use stdlib `argparse` + plain text output — keeps the wheel small and dep-free). Keep `httpx` for downloads, `pydantic` for state file validation. **Net: 2 direct deps instead of 4.** |
| §8.4 Entry point | ONE entry point: `[project.scripts] neuralgentics = "neuralgentics.cli:main"`. The OpenCode plugin is the npm package, referenced from `.opencode/opencode.json` after `init`. No Python entry point for OpenCode — that mechanism doesn't exist in the current plugin system. |
| §8.5 PyPI workflow | Unchanged — same `cli-v*` tag trigger, same OIDC trusted publishing. The PyPI name is `neuralgentics`, not `@veedubin/neuralgentics`. |
| §8.6 Versioning | Wheel version is independent of the npm plugin. Wheel = `0.1.0`. npm plugin = `0.9.1`. GitHub release tarball version = `v0.9.1`. Three version numbers, two artifacts, one CLI. The wheel version tracks the CLI's own evolution (download logic, merge logic, doctor checks). |
| Appendix A: Directory layout | No `plugin.py` — CLI only. `cli.py` uses `argparse` instead of `typer`. Output uses plain text/ANSI codes instead of `rich`. |
| Appendix C Q5 (CLI location) | Resolved: `neuralgentics-cli/` sibling to `neuralgentics/`. (User did not answer; defaulting to architect's recommendation.) |
| Appendix C Q1-Q3 | Q1: cli-v* tags accepted. Q2: home-dir install deferred to v0.2.0. Q3: copy + tell user to edit. (User did not answer; defaulting to architect's recommendations.) |
| New Q4 (PyPI name reservation) | Will be done as a separate stub release v0.0.1 if the user confirms in a future session. Skipping for v0.1.0 unless asked. |

### 11.4 How the plugin gets loaded (the actual answer)

User's words: "I want the milk, not the cow." After investigation, here's the actual flow:

- **The PyPI wheel is a CLI tool only.** It does NOT register as an OpenCode plugin via Python entry points — that mechanism doesn't exist in the current OpenCode plugin system.
- **OpenCode plugins are loaded from `opencode.json`'s `plugin` array.** They are either npm package names (`"@veedubin/boomerang-v3"`) or local file paths (`"file:///path/to/dir"`).
- **The actual plugin is the npm package `@veedubin/neuralgentics`** (already shipped, already on npm via Session 32). The wheel is the thing that DOWNLOADS the npm package's files into the project.
- **`init`'s job is threefold:**
  1. Download the GitHub release tarball.
  2. Extract `.opencode/`, `docker-compose.yml`, `compose.example.env`, etc. into the project.
  3. Patch `.opencode/opencode.json`'s `plugin` array to add the reference to the plugin (either npm-style or file-style).
- **For npm-style resolution:** the user must have `npm install` run (which `init` does automatically). The plugin reference becomes `"@veedubin/neuralgentics"`.
- **For file-style resolution:** the user can point to a locally-built copy of the plugin (for development). The CLI just adds the right entry.

**Why this is still "the milk":** Three commands, no extra mental load:

```bash
uv pip install neuralgentics            # ONE install — small wheel, no big deps
neuralgentics --init                     # CLI downloads tarball, sets up .opencode/, patches opencode.json
opencode                                 # OpenCode reads .opencode/opencode.json, sees the plugin ref, loads it
```

The user never touches npm. The user never runs `curl | bash`. The wheel is small (CLI only). The plugin is still the npm package (loaded via `opencode.json`). They're decoupled — the wheel can update independently, the plugin can update independently, they cooperate via the tarball.

This is actually a CLEANER separation than the original "single wheel is also the plugin" idea, because:
- Wheel size stays tiny (~2-3 MB, no plugin code).
- Plugin versioning is independent (npm handles it, not pip).
- OpenCode's plugin system is untouched.
- No fighting with Python entry points that don't exist.

**The wheel is the bootstrapper. The plugin is the npm package. The tarball is the bridge.**

### 11.5 What stays from the original design

Everything in §1-§7 (command surface, state file, merge algorithm, backend, error model, testing) is **unchanged**. The revision only touches §8 (packaging) and Appendix A (directory layout). All the merge, download, and doctor logic from the original design carries forward verbatim.

### 11.6 Revised directory layout (Appendix A v2)

```
neuralgentics-cli/                       # NEW directory, sibling to neuralgentics/
├── pyproject.toml
├── CHANGELOG.md
├── README.md
├── LICENSE
├── src/
│   └── neuralgentics/
│       ├── __init__.py                  # __version__ = "0.1.0"
│       ├── cli.py                       # argparse-based CLI, subcommands: init, update, doctor, version
│       ├── init_cmd.py                  # init command logic (was init.py)
│       ├── update_cmd.py                # update command logic (was update.py)
│       ├── doctor_cmd.py                # doctor command logic (was doctor.py)
│       ├── version_cmd.py               # version command logic (was version_cmd.py)
│       ├── download.py                  # GitHub API + tarball download + SHA256 verify
│       ├── extract.py                   # tarball extraction
│       ├── merge.py                     # opencode.json merge algorithm
│       ├── state.py                     # state file read/write/validate/migrate
│       ├── compose.py                   # podman/docker detection, compose command construction
│       └── errors.py                    # error classes, exit codes, message templates
└── tests/
    ├── test_cli.py
    ├── test_init.py
    ├── test_update.py
    ├── test_doctor.py
    ├── test_version.py
    ├── test_download.py
    ├── test_extract.py
    ├── test_merge.py
    ├── test_state.py
    ├── test_compose.py
    └── conftest.py                      # shared fixtures (temp dirs, mock httpx, etc.)
```

Note: no `plugin.py`. The wheel is CLI-only. The OpenCode plugin is the npm package, loaded via `.opencode/opencode.json`.

### 11.7 The milk

User's words: "I want the milk, not the cow." The milk is:

```bash
uv pip install neuralgentics            # ONE install
neuralgentics --init                     # downloads the tarball, sets up .opencode/
opencode                                 # plugin auto-discovered via entry point
```

That's it. Three commands. No npm, no curl-bash, no symlinks. The wheel IS the milk.
