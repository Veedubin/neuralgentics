# Design: Rename neuralgentics DB Identity to memini-ai

**Status:** Draft  
**Date:** 2026-07-28  
**Author:** boomerang-architect  
**Trigger:** User complaint that the neuralgentics project conflates the orchestrator (neuralgentics) with the memory server (memini-ai). The PostgreSQL database is memini-ai's DB and should be named accordingly.

---

## 1. Problem Statement

The neuralgentics project currently uses `neuralgentics` as the database name, user, container name, and env var prefix. This is architecturally wrong:

- **neuralgentics** is the orchestrator plugin — it routes tasks, manages agents, and brokers MCP tools.
- **memini-ai** is the memory server — it owns the PostgreSQL database, the schema, the embeddings, and the knowledge graph.

The DB should be named `memini` (matching memini-ai's own installer defaults), not `neuralgentics`. The neuralgentics plugin should connect to memini-ai's DB, not pretend it owns one.

## 2. Canonical Naming Convention

### 2.1 What memini-ai's own installer uses (source of truth)

From `memini-ai-dev/src/memini_ai/installer.py`:

| Item | Value |
|------|-------|
| Default DB name | `memini` (`_DEFAULT_DB_NAME = "memini"`, line 469) |
| Admin role | `memini_admin` (`_ADMIN_ROLE = "memini_admin"`, line 468) |
| Project user env var | `MEMINI_PROJECT_USER` |
| Project password env var | `MEMINI_PROJECT_PASSWORD` |
| Interactive prompt default | `Database [memini]:` (line 853) |
| Canonical DSN pattern | `postgresql://memini_admin:<pw>@<host>:<port>/memini` |

### 2.2 What neuralgentics should use (this design)

| Item | Current (wrong) | New (correct) |
|------|-----------------|---------------|
| DB name | `neuralgentics` | `memini` |
| DB user (default) | `neuralgentics` | `memini` |
| DB password (default) | `neuralgentics` | `memini` |
| Container name | `neuralgentics-postgres` / `${STACK}-db` | `memini-postgres` / `${STACK}-db` |
| Stack name default | `neuralgentics` | `memini` |
| Stack directory | `~/.neuralgentics/` | `~/.memini-ai/` |
| Primary env var | `NEURALGENTICS_DB_URL` | `MEMINI_DB_URL` |
| Legacy env var | (none) | `NEURALGENTICS_DB_URL` (fallback) |
| Port env var | `NEURALGENTICS_DB_PORT` | `MEMINI_DB_PORT` |
| User env var | `NEURALGENTICS_DB_USER` | `MEMINI_DB_USER` |
| Password env var | `NEURALGENTICS_DB_PASSWORD` | `MEMINI_DB_PASSWORD` |
| DB name env var | `NEURALGENTICS_DB_NAME` | `MEMINI_DB_NAME` |
| Stack name env var | `NEURALGENTICS_STACK_NAME` | `MEMINI_STACK_NAME` |
| Canonical DSN | `postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics` | `postgresql://memini:memini@localhost:5434/memini` |

### 2.3 Rationale for `memini` (not `memini_ai` or `memini-ai`)

- PostgreSQL identifiers cannot contain hyphens without quoting. `memini` is clean, short, and matches memini-ai's own `_DEFAULT_DB_NAME`.
- The user `memini` (not `memini_admin`) is the runtime user. `memini_admin` is the bootstrap/admin role used by the installer to create the DB and extensions — it should not be the day-to-day connection user.
- The container name `memini-postgres` matches the user's existing running container (`memini-postgres` on port 5434).

## 3. Env Var Precedence (Go Backend)

### 3.1 Current state (config.go)

```go
func ResolveDatabaseURL() string {
    if url := os.Getenv("NEURALGENTICS_DB_URL"); url != "" {
        return url
    }
    return os.Getenv("MEMINI_DB_URL")
}
```

`NEURALGENTICS_DB_URL` takes precedence over `MEMINI_DB_URL`. This is backwards — `MEMINI_DB_URL` should be the canonical name.

### 3.2 New precedence (this design)

```go
func ResolveDatabaseURL() string {
    // MEMINI_DB_URL is the canonical env var (memini-ai owns the DB).
    if url := os.Getenv("MEMINI_DB_URL"); url != "" {
        return url
    }
    // NEURALGENTICS_DB_URL is a legacy fallback for existing users.
    return os.Getenv("NEURALGENTICS_DB_URL")
}
```

**Rationale:** `MEMINI_DB_URL` is what memini-ai's own installer writes. The neuralgentics plugin should read the same env var. `NEURALGENTICS_DB_URL` is kept as a silent fallback so existing users with it set don't break.

### 3.3 TypeScript plugin precedence (go-backend-client.ts)

The TypeScript plugin already auto-promotes `MEMINI_DB_URL` → `NEURALGENTICS_DB_URL` in the child env (lines 288-292). After this rename, the promotion should go the other way: if the user has `NEURALGENTICS_DB_URL` set (legacy), promote it to `MEMINI_DB_URL` for the child process. Or better: just pass both and let the Go binary's `ResolveDatabaseURL()` handle precedence.

**Recommended:** Stop auto-promoting. Just pass the parent env as-is. The Go binary's `ResolveDatabaseURL()` handles precedence. The plugin should only inject `MEMINI_DB_URL` when it has resolved a DSN from the memini-ai MCP config block.

### 3.4 Hardcoded default in main.go (line 798)

```go
dbURL = "postgresql://neuralgentics:neuralgentics@localhost:6000/neuralgentics"
```

Should become:

```go
dbURL = "postgresql://memini:memini@localhost:5434/memini"
```

This matches the user's actual running `memini-postgres` container on port 5434.

## 4. Container & Stack Rename

### 4.1 docker-compose.yml

| Line(s) | Current | New |
|---------|---------|-----|
| 1 (comment) | `Neuralgentics PostgreSQL stack` | `memini-ai PostgreSQL stack` |
| 20 | `${NEURALGENTICS_STACK_NAME:-neuralgentics}` | `${MEMINI_STACK_NAME:-memini}` |
| 38 (comment) | `user/db = neuralgentics, password = neuralgentics` | `user/db = memini, password = memini` |
| 43 | `image: ghcr.io/veedubin/neuralgentics-postgres:...` | `image: ghcr.io/veedubin/memini-postgres:...` |
| 44 | `container_name: ${NEURALGENTICS_STACK_NAME:-neuralgentics}-db` | `container_name: ${MEMINI_STACK_NAME:-memini}-db` |
| 46 | `"${NEURALGENTICS_DB_PORT:-6200}:5432"` | `"${MEMINI_DB_PORT:-5434}:5432"` |
| 48 | `POSTGRES_USER: ${NEURALGENTICS_DB_USER:-neuralgentics}` | `POSTGRES_USER: ${MEMINI_DB_USER:-memini}` |
| 49 | `POSTGRES_PASSWORD: ${NEURALGENTICS_DB_PASSWORD:-neuralgentics}` | `POSTGRES_PASSWORD: ${MEMINI_DB_PASSWORD:-memini}` |
| 50 | `POSTGRES_DB: ${NEURALGENTICS_DB_NAME:-neuralgentics}` | `POSTGRES_DB: ${MEMINI_DB_NAME:-memini}` |
| 59 | `neuralgentics-db:/var/lib/postgresql` | `memini-db:/var/lib/postgresql` |
| 61 | `neuralgentics-net` | `memini-net` |
| 104 (commented) | `NEURALGENTICS_DB_URL: postgresql://${NEURALGENTICS_DB_USER:-neuralgentics}:...` | `MEMINI_DB_URL: postgresql://${MEMINI_DB_USER:-memini}:...` |
| 111 (commented) | `neuralgentics-net` | `memini-net` |
| 122-123 | `neuralgentics-db:` / `name: ${NEURALGENTICS_STACK_NAME:-neuralgentics}-db` | `memini-db:` / `name: ${MEMINI_STACK_NAME:-memini}-db` |
| 128-129 | `neuralgentics-net:` / `name: ${NEURALGENTICS_STACK_NAME:-neuralgentics}-net` | `memini-net:` / `name: ${MEMINI_STACK_NAME:-memini}-net` |

### 4.2 compose.example.env

| Line | Current | New |
|------|---------|-----|
| 10 | `NEURALGENTICS_VERSION=v0.2.0` | `MEMINI_VERSION=v0.2.0` |
| 13 | `NEURALGENTICS_DB_PORT=6200` | `MEMINI_DB_PORT=5434` |
| 14 | `NEURALGENTICS_DB_USER=postgres` | `MEMINI_DB_USER=memini` |
| 15 | `NEURALGENTICS_DB_PASSWORD=neuralgentics` | `MEMINI_DB_PASSWORD=memini` |
| 16 | `NEURALGENTICS_DB_NAME=neuralgentics` | `MEMINI_DB_NAME=memini` |

### 4.3 db-stack.ts

| Line(s) | Current | New |
|---------|---------|-----|
| 60-61 | `DEFAULT_DSN = "postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics"` | `DEFAULT_DSN = "postgresql://memini:memini@localhost:5434/memini"` |
| 68 | `stackDir()` returns `~/.neuralgentics/` | `stackDir()` returns `~/.memini-ai/` |
| 183 | `get("NEURALGENTICS_STACK_NAME", "neuralgentics")` | `get("MEMINI_STACK_NAME", "memini")` |
| 184 | `get("NEURALGENTICS_DB_PORT", "6200")` | `get("MEMINI_DB_PORT", "5434")` |
| 185 | `get("NEURALGENTICS_DB_USER", "neuralgentics")` | `get("MEMINI_DB_USER", "memini")` |
| 186 | `get("NEURALGENTICS_DB_PASSWORD", "neuralgentics")` | `get("MEMINI_DB_PASSWORD", "memini")` |
| 187 | `get("NEURALGENTICS_DB_NAME", "neuralgentics")` | `get("MEMINI_DB_NAME", "memini")` |
| 338-339 (comment) | `NOTE: The default neuralgentics/neuralgentics superuser...` | `NOTE: The default memini/memini superuser...` |
| 426 | `const defaultName = process.env.USER ?? "neuralgentics"` | `const defaultName = process.env.USER ?? "memini"` |
| 591 | `neuralgentics --init-project` | `neuralgentics --init-project` (unchanged — CLI name stays) |
| 676 | `Data is safe in the neuralgentics-db volume.` | `Data is safe in the memini-db volume.` |

### 4.4 Stack directory rename

`~/.neuralgentics/` → `~/.memini-ai/`

This is a **breaking change for existing users** who have a stack at `~/.neuralgentics/`. Migration strategy:

1. On first `--db-start` after the rename, check if `~/.neuralgentics/` exists and `~/.memini-ai/` does not.
2. If so, offer to migrate: copy the directory and update the `.env` file's env var names.
3. If the user declines, use the old path as a fallback (read old env vars, old compose file).

## 5. Interactive Prompts Rename

### 5.1 prompts.ts

| Line(s) | Current | New |
|---------|---------|-----|
| 178 | `"  1. Built-in database (recommended)"` | `"  1. Built-in database (recommended)"` (unchanged) |
| 184 | `"  2. Team server"` | `"  2. memini-ai server"` |
| 185 | `"     Connect to a shared PostgreSQL database."` | `"     Connect to a shared memini-ai PostgreSQL database."` |
| 186 | `"     Best for teams who want shared memory across machines."` | `"     Best for teams who want shared memory across machines."` (unchanged) |
| 187 | `"     You'll need a PostgreSQL server already running."` | `"     You'll need a memini-ai PostgreSQL server already running."` |
| 219 | `"  Team server setup — connect to an existing PostgreSQL server.\n"` | `"  memini-ai server setup — connect to an existing PostgreSQL server.\n"` |
| 220 | `"  (Don't have one yet? Run neuralgentics --db-start first.)\n"` | `"  (Don't have one yet? Run neuralgentics --db-start first.)\n"` (unchanged) |
| 222 | `validateHost, "localhost"` | unchanged |
| 223 | `validatePort, "6200"` | `validatePort, "5434"` |
| 224 | `validateDatabase, "neuralgentics"` | `validateDatabase, "memini"` |
| 227 | `"  Username [neuralgentics]: "` | `"  Username [memini]: "` |
| 227 (default) | `\|\| "neuralgentics"` | `\|\| "memini"` |
| 425-430 (--yes --team defaults) | `"neuralgentics"` for host/port/db/user/password | `"localhost"`, `"5434"`, `"memini"`, `"memini"`, `"memini"` |

### 5.2 init.ts

| Line(s) | Current | New |
|---------|---------|-----|
| 1439 | `const port = promptConfig.teamPort ?? "6200"` | `const port = promptConfig.teamPort ?? "5434"` |
| 1440 | `const db = promptConfig.teamDatabase ?? "neuralgentics"` | `const db = promptConfig.teamDatabase ?? "memini"` |
| 1441 | `const user = promptConfig.teamUser ?? "neuralgentics"` | `const user = promptConfig.teamUser ?? "memini"` |
| 1442 | `const password = promptConfig.teamPassword ?? "neuralgentics"` | `const password = promptConfig.teamPassword ?? "memini"` |

## 6. Go Backend Changes

### 6.1 packages/backend-go/cmd/backend/main.go

| Line(s) | Change |
|---------|--------|
| 780 | `dbURL := os.Getenv("NEURALGENTICS_DB_URL")` → `dbURL := os.Getenv("MEMINI_DB_URL")` |
| 781-792 | The fallback block currently checks `MEMINI_DB_URL` as secondary. Reverse: check `NEURALGENTICS_DB_URL` as legacy fallback. |
| 798 | Hardcoded default: `"postgresql://neuralgentics:neuralgentics@localhost:6000/neuralgentics"` → `"postgresql://memini:memini@localhost:5434/memini"` |
| 1 (comment) | `"Neuralgentics backend binary"` → unchanged (it IS the neuralgentics backend) |
| 1177 | `Name: "neuralgentics-backend"` → unchanged (server identity, not DB identity) |

### 6.2 packages/memory/src/neuralgentics/memory/core/config.go

| Line(s) | Change |
|---------|--------|
| 12-14 | Comment: update to reflect new precedence (`MEMINI_DB_URL` first, `NEURALGENTICS_DB_URL` legacy) |
| 14 | `ErrMissingDatabaseURL` message: update to mention `MEMINI_DB_URL` first |
| 30 | `envconfig:"NEURALGENTICS_DB_URL"` → `envconfig:"MEMINI_DB_URL"` |
| 128-133 | `ResolveDatabaseURL()`: swap precedence — `MEMINI_DB_URL` first, `NEURALGENTICS_DB_URL` fallback |

### 6.3 packages/memory/src/neuralgentics/memory/core/config_test.go

| Line(s) | Change |
|---------|--------|
| 27-40 | `TestResolveDatabaseURL_PrefersNeuralgentics` → rename to `TestResolveDatabaseURL_PrefersMemini`, swap which env var is set |
| 42-54 | `TestResolveDatabaseURL_FallsBackToMemini` → rename to `TestResolveDatabaseURL_FallsBackToNeuralgentics`, swap which env var is set |
| 92-100 | `TestErrMissingDatabaseURL_ContainsBothNames` → update expected strings |

### 6.4 Test DSNs in Go test files

| File | Line | Current | New |
|------|------|---------|-----|
| `integration_dualwrite_test.go` | 21 | `postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics_test` | `postgresql://memini:memini@localhost:5434/memini_test` |
| `integration_backend_jsonrpc_test.go` | 101 | `postgresql://neuralgentics:neuralgentics@localhost:6200/neuralgentics_test` | `postgresql://memini:memini@localhost:5434/memini_test` |
| `bench/live_bench_test.go` | 8 | `NEURALGENTICS_DB_URL="postgresql://..."` | `MEMINI_DB_URL="postgresql://..."` |
| `store/memories_count_test.go` | 16 | `postgresql://postgres:testpassword@localhost:6200/neuralgentics_test` | `postgresql://memini:memini@localhost:5434/memini_test` |
| `store/postgres_test.go` | 67 | `postgresql://user:pass@localhost:5432/testdb` | unchanged (unit test, not integration) |
| `cmd/migrate/main.go` | 22 | `postgresql://postgres:password@localhost:5434/neuralgentics` | `postgresql://memini:memini@localhost:5434/memini` |

## 7. TypeScript Plugin Changes

### 7.1 go-backend-client.ts

| Line(s) | Change |
|---------|--------|
| 136-137 (comment) | Update: `MEMINI_DB_URL` is now canonical, no auto-promotion needed |
| 258-292 | `start()`: stop auto-promoting `MEMINI_DB_URL` → `NEURALGENTICS_DB_URL`. Instead, if `MEMINI_DB_URL` is not set but `NEURALGENTICS_DB_URL` is (legacy), promote the legacy var. Or simpler: just pass both and let the Go binary handle precedence. |
| 288-292 | Current: `if (!childEnv.NEURALGENTICS_DB_URL) { childEnv.NEURALGENTICS_DB_URL = meminiUrl; }` → New: `if (!childEnv.MEMINI_DB_URL) { childEnv.MEMINI_DB_URL = meminiUrl; }` |

### 7.2 go-backend-client.test.ts

| Line(s) | Change |
|---------|--------|
| 155 | Test name: `"start() auto-promotes MEMINI_DB_URL → NEURALGENTICS_DB_URL"` → `"start() auto-promotes MEMINI_DB_URL from config"` |
| 169 | Assertion: `capturedCalls[0].env.NEURALGENTICS_DB_URL` → `capturedCalls[0].env.MEMINI_DB_URL` |
| 174-186 | Test: `"explicit process.env.NEURALGENTICS_DB_URL wins over setLoadedConfig"` → update to test `MEMINI_DB_URL` precedence |
| 224-233 | Test: `"sentinel MEMINI_DB_URL values (pgembed, empty) are NOT promoted"` → update assertions |
| 236-241 | Test: `"missing memini-ai-dev block leaves NEURALGENTICS_DB_URL unset"` → update to `MEMINI_DB_URL` |

### 7.3 prompts.test.ts

| Line(s) | Change |
|---------|--------|
| 262-328 | Update all test DSNs from `neuralgentics` user/db to `memini` user/db |
| 566 | `MEMINI_DB_URL=postgresql://neuralgentics:pw@localhost:6200/neuralgentics` → `MEMINI_DB_URL=postgresql://memini:pw@localhost:5434/memini` |

### 7.4 db-stack.test.ts

| Line(s) | Change |
|---------|--------|
| 249-253 | Update env var names from `NEURALGENTICS_*` to `MEMINI_*` |
| 272-276 | Update test .env content |
| 289-292 | Update test env var names |
| 482, 522, 538, 650 | Update test env var names |

### 7.5 mcp-templates.ts

No changes needed — this file already uses `MEMINI_DB_URL` correctly. The templates are for the memini-ai MCP server, which already uses `MEMINI_DB_URL`.

### 7.6 server.ts

| Line(s) | Change |
|---------|--------|
| 162-163 | Comment: update to reflect new promotion direction |
| 454 | Comment: update to reflect `MEMINI_DB_URL` as canonical |

## 8. TUI Changes

### 8.1 packages/tui/src/neuralgentics-client/resolver.ts

| Line | Current | New |
|------|---------|-----|
| 112 | `process.env.NEURALGENTICS_DB_URL ?? DEFAULT_DB_URL` | `process.env.MEMINI_DB_URL ?? process.env.NEURALGENTICS_DB_URL ?? DEFAULT_DB_URL` |

### 8.2 packages/tui/src/neuralgentics-client/client.ts

| Line | Current | New |
|------|---------|-----|
| 95 (comment) | `NEURALGENTICS_DB_URL env` | `MEMINI_DB_URL env (legacy: NEURALGENTICS_DB_URL)` |
| 456 | `NEURALGENTICS_DB_URL: dbUrl` | `MEMINI_DB_URL: dbUrl` |

### 8.3 packages/tui/src/__tests__/neuralgentics-client.test.ts

| Line(s) | Change |
|---------|--------|
| 91-112 | Update tests to use `MEMINI_DB_URL` as primary, `NEURALGENTICS_DB_URL` as fallback |

## 9. Backward Compatibility Strategy

### 9.1 Env var fallback chain

```
MEMINI_DB_URL          ← canonical (new)
  ↓ (if unset)
NEURALGENTICS_DB_URL   ← legacy fallback
  ↓ (if unset)
hardcoded default      ← "postgresql://memini:memini@localhost:5434/memini"
```

This is implemented in:
- Go: `core/config.go` `ResolveDatabaseURL()`
- Go: `cmd/backend/main.go` lines 780-798
- TS: `go-backend-client.ts` `start()`
- TS: `packages/tui/src/neuralgentics-client/resolver.ts`

### 9.2 Stack env var fallback

The `resolveStackConfig()` function in `db-stack.ts` should read BOTH old and new env var names:

```typescript
const get = (key: string, legacyKey: string, fallback: string): string =>
    process.env[key] ?? process.env[legacyKey] ?? fileEnv[key] ?? fileEnv[legacyKey] ?? fallback;
```

This way, users with existing `NEURALGENTICS_DB_PORT=6200` in their `.env` will still work.

### 9.3 Stack directory migration

On first `--db-start` after the rename:
1. Check if `~/.memini-ai/` exists → use it.
2. If not, check if `~/.neuralgentics/` exists → offer migration prompt:
   ```
   Found existing stack at ~/.neuralgentics/. Migrate to ~/.memini-ai/?
   [Y/n]: 
   ```
3. If yes: copy directory, update `.env` to use new env var names.
4. If no: use `~/.neuralgentics/` as fallback path (read old env vars).

### 9.4 What does NOT change

- The npm package name: `@veedubin/neuralgentics` (unchanged)
- The CLI command: `neuralgentics --init-project` (unchanged)
- The Go binary name: `neuralgentics-backend` (unchanged)
- The GitHub repo: `Veedubin/neuralgentics` (unchanged)
- The container image names: `ghcr.io/veedubin/neuralgentics-postgres` etc. (unchanged for now — image rename is a separate, higher-risk change)
- Agent persona files: already reference `memini-ai-dev` as the MCP server (correct)

## 10. Files Changed (Complete List)

### Go backend
1. `packages/backend-go/cmd/backend/main.go` — lines 780-798 (env var precedence + hardcoded default)
2. `packages/memory/src/neuralgentics/memory/core/config.go` — lines 12-14, 30, 128-133 (env var precedence)
3. `packages/memory/src/neuralgentics/memory/core/config_test.go` — lines 27-100 (test updates)
4. `packages/memory/src/neuralgentics/memory/integration_dualwrite_test.go` — line 21 (test DSN)
5. `packages/memory/src/neuralgentics/memory/integration_backend_jsonrpc_test.go` — line 101 (test DSN)
6. `packages/memory/src/neuralgentics/memory/bench/live_bench_test.go` — line 8 (bench DSN)
7. `packages/memory/src/neuralgentics/memory/store/memories_count_test.go` — line 16 (test DSN)
8. `packages/memory/cmd/migrate/main.go` — line 22 (migration default DSN)

### TypeScript plugin
9. `overlay/packages/opencode/src/neuralgentics/prompts.ts` — lines 178-187, 219-227, 425-430 (prompt text + defaults)
10. `overlay/packages/opencode/src/neuralgentics/prompts.test.ts` — lines 262-328, 502-616 (test DSNs)
11. `overlay/packages/opencode/src/neuralgentics/db-stack.ts` — lines 60-61, 68, 183-187, 338-339, 426, 591, 676 (defaults + env vars)
12. `overlay/packages/opencode/src/neuralgentics/db-stack.test.ts` — lines 249-253, 272-276, 289-292, 482, 522, 538, 650 (test env vars)
13. `overlay/packages/opencode/src/neuralgentics/go-backend-client.ts` — lines 136-137, 258-292 (auto-promotion direction)
14. `overlay/packages/opencode/src/neuralgentics/go-backend-client.test.ts` — lines 155-241 (test assertions)
15. `overlay/packages/opencode/src/neuralgentics/init.ts` — lines 1439-1442 (team server defaults)
16. `overlay/packages/opencode/src/neuralgentics/server.ts` — lines 162-163, 454 (comments)

### Compose stack
17. `overlay/packages/opencode/docker-compose.yml` — lines 1, 20, 38, 43-44, 46, 48-50, 59, 61, 104, 111, 122-123, 128-129 (all neuralgentics → memini references)
18. `compose.example.env` — lines 10, 13-16 (env var names + defaults)

### TUI
19. `packages/tui/src/neuralgentics-client/resolver.ts` — line 112 (env var precedence)
20. `packages/tui/src/neuralgentics-client/client.ts` — lines 95, 456 (env var name)
21. `packages/tui/src/__tests__/neuralgentics-client.test.ts` — lines 91-112 (test updates)

### Documentation
22. `AGENTS.md` — "Currently-Running Containers" table, "Go Backend Default Connection" section
23. `docs/design/session-29-container-architecture.md` — container name references

**Total: ~23 files**

## 11. Test Plan

### 11.1 Unit tests (must pass before merge)

| Test file | What to verify |
|-----------|---------------|
| `config_test.go` | `ResolveDatabaseURL()` prefers `MEMINI_DB_URL`, falls back to `NEURALGENTICS_DB_URL` |
| `prompts.test.ts` | All prompt defaults use `memini` user/db/port |
| `db-stack.test.ts` | `resolveStackConfig()` reads `MEMINI_*` env vars, falls back to `NEURALGENTICS_*` |
| `go-backend-client.test.ts` | `start()` sets `MEMINI_DB_URL` from config, legacy `NEURALGENTICS_DB_URL` promoted |
| `neuralgentics-client.test.ts` | Resolver prefers `MEMINI_DB_URL`, falls back to `NEURALGENTICS_DB_URL` |

### 11.2 Integration tests

| Test | What to verify |
|------|---------------|
| `integration_dualwrite_test.go` | Connects to `memini` DB on port 5434 |
| `integration_backend_jsonrpc_test.go` | JSON-RPC server connects to `memini` DB |
| `memories_count_test.go` | Store connects to `memini` DB |

### 11.3 Manual verification

1. **Existing `memini-postgres` container**: Verify the Go backend connects to it with the new default DSN.
2. **Existing `neuralgentics-postgres` container**: Verify the Go backend connects to it when `NEURALGENTICS_DB_URL` is set (legacy fallback).
3. **`--init-project --team`**: Verify the interactive prompt defaults to `memini` user/db/port.
4. **`--db-start`**: Verify the compose stack uses `memini` env vars and container name.
5. **Stack migration**: Verify `~/.neuralgentics/` → `~/.memini-ai/` migration works.

## 12. Rollout Strategy

### Phase 1: Go backend + TypeScript plugin (this change)
- Update all env var names, defaults, and precedence.
- Add backward-compat fallbacks everywhere.
- Update tests.
- Bump neuralgentics version.

### Phase 2: Container image rename (future)
- Rename `ghcr.io/veedubin/neuralgentics-postgres` → `ghcr.io/veedubin/memini-postgres`.
- This is a separate change because it requires CI workflow updates and ghcr.io repo creation.

### Phase 3: Stack directory migration (future)
- Implement the `~/.neuralgentics/` → `~/.memini-ai/` migration prompt in `db-stack.ts`.

## 13. Open Questions

1. **Should the container image be renamed now or later?** The docker-compose.yml references `ghcr.io/veedubin/neuralgentics-postgres`. Renaming the image requires creating a new ghcr.io repo and updating CI. Recommendation: do it in Phase 2 to keep this change focused.

2. **Should `~/.neuralgentics/` be migrated automatically or with a prompt?** The user's existing stack at `~/.neuralgentics/` has data. Automatic migration is risky. Recommendation: prompt on first `--db-start`.

3. **What about the `neuralgentics-postgres` container already running on port 6200?** This container has `POSTGRES_USER=neuralgentics`, `POSTGRES_DB=neuralgentics`. It cannot be renamed in-place — the user would need to `--db-stop` the old stack and `--db-start` a new one. The new stack would create a fresh `memini` DB. Existing data in the `neuralgentics` DB would need a `pg_dump` / `pg_restore` migration. Recommendation: document the migration path, don't automate it.
