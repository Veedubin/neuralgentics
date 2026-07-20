# neuralgentics-web

A modular web UI shell with a Grafana-style plugin manifest system. FastAPI +
htmx + Jinja2. Optional auth (JWT, OAuth2, OIDC). Optional database (Postgres
in team-server mode). Zero required dependencies on anything else.

`pip install neuralgentics-web` gives you a `neuralgentics-web` command.

## What it is

`neuralgentics-web` is a FastAPI application that discovers **modules** at
startup. Each module is a directory with a `module.yaml` manifest and (for
full modules) Python route handlers.

Three modules ship in the box:

- `gateway-audit` — read-only live audit table + charts for the
  `neuralgentics-gateway` egress proxy
- `broker-audit` — read-only live audit table + stats for the
  `neuralgentics-broker` MCP tool-call broker
- `memini-browser` — search, view, and adjust the trust of memories in
  `memini-ai`

You can use any of these without the others. You can write your own modules
against any backend you have.

## What this is NOT

- Not a memory store. (Use [memini-ai](https://github.com/Veedubin/memini-ai-dev)
  for that.)
- Not a proxy. (Use [neuralgentics-gateway](https://github.com/Veedubin/neuralgentics-gateway)
  for that.)
- Not an MCP broker. (See [neuralgentics-broker](https://github.com/Veedubin/neuralgentics-broker)
  for that.)

These three products can be used together, but each is independent.

## Install

```bash
pip install neuralgentics-web
```

Optional extras:

```bash
pip install neuralgentics-web[team-server]   # adds asyncpg for Postgres
pip install neuralgentics-web[dev]           # adds pytest, ruff, mypy
```

## Quickstart

```bash
# Embedded mode — localhost only, no auth, no DB, no nothing.
neuralgentics-web --mode=embedded --port=9876

# Open http://localhost:9876 in a browser.
```

The shell loads every directory under `./modules/` (or wherever
`--modules-path` points) that contains a `module.yaml`. Shipped modules are
auto-discovered from the package data.

## Team-server mode

```bash
neuralgentics-web --mode=team-server \
    --host=0.0.0.0 --port=9877 \
    --db-url=postgres://user:pass@host:5432/dbname
```

- Listens on `--host:--port` (default `0.0.0.0:9877`)
- Persists users, OIDC tokens, and any module that opts into PG storage
- Exposes a `/health` endpoint for load balancers

## Auth (optional)

```bash
# JWT only (HS256) — username/password against the local SQLite user store
neuralgentics-web --auth=jwt --jwt-secret=$(openssl rand -hex 32)

# OAuth2 stub — replace with OIDC for real providers
neuralgentics-web --auth=oauth2

# OIDC — GitHub
neuralgentics-web --auth=oauth2 \
    --oidc-github-client-id=$GITHUB_CLIENT_ID \
    --oidc-github-client-secret=$GITHUB_CLIENT_SECRET \
    --oidc-redirect-base=https://your-host

# OIDC — Google
neuralgentics-web --auth=oauth2 \
    --oidc-google-client-id=$GOOGLE_CLIENT_ID \
    --oidc-google-client-secret=$GOOGLE_CLIENT_SECRET

# OIDC — generic (Okta, Auth0, Keycloak, etc.)
neuralgentics-web --auth=oauth2 \
    --oidc-generic-discovery-url=okta=https://your-tenant.okta.com/.well-known/openid-configuration \
    --oidc-generic-client-id=okta=$CLIENT_ID \
    --oidc-generic-client-secret=okta=$CLIENT_SECRET
```

Default users (seeded on first run with a loud warning):
- `admin / admin` — full access
- `operator / operator` — read + write
- `viewer / viewer` — read only

**Change these in production.** The CLI flag `--auth=off` bypasses auth
entirely (only safe in embedded mode, which binds to localhost).

## RBAC

Three roles: `admin`, `operator`, `viewer`. Default role for new OIDC users
is `--oidc-default-role` (default `viewer`).

For per-module overrides, add a `rbac:` block to the module's `module.yaml`:

```yaml
name: my-module
version: 0.1.0
rbac:
  actions:
    read: [viewer, operator, admin]
    write: [operator, admin]
    delete: [admin]
```

## Writing your own module

```python
# modules/my-module/module.yaml
name: my-module
version: 0.1.0
description: My custom module
```

```python
# modules/my-module/module.py
from fastapi import APIRouter

def build_router() -> APIRouter:
    router = APIRouter()
    @router.get("/hello")
    async def hello() -> dict:
        return {"hello": "world"}
    return router
```

Drop `modules/my-module/` into your `--modules-path` and reload.

For live reload, see [docs/HOT_RELOAD.md](docs/HOT_RELOAD.md).

## Optional integration with the neuralgentics ecosystem

If you also use `neuralgentics-gateway` and/or `neuralgentics-broker`, this
package can display their audit data:

- The `gateway-audit` module reads the gateway's `audit_events` Postgres
  table. Set `--db-url` to the same database the gateway writes to.
- The `broker-audit` module reads the broker's `~/.neuralgentics/broker_audit.jsonl`
  file (or its Postgres `broker_audit_log` table).

Each module works independently — you can use one without the other.

## License

MIT — see [LICENSE](LICENSE).