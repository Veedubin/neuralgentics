# neuralgentics-web

Modular web UI shell for neuralgentics — a Grafana-style plugin manifest system
for building dashboards on top of the neuralgentics ecosystem.

## What it is

`neuralgentics-web` is a FastAPI application that discovers *modules* at
startup. Each module is a directory with a `module.yaml` manifest and (for
full modules) Python route handlers. For v0.1, three stub modules are shipped:

| Module | Status | Coming in |
|--------|--------|-----------|
| `gateway-audit` | stub | T-106 |
| `broker-audit` | stub | T-107 |
| `memini-browser` | stub | T-108 |

## Two modes

The same code runs in two modes. The mode is selected via `--mode` or the
`NEURALGENTICS_WEB_MODE` env var.

### Embedded mode

Localhost-only, no auth, reads from local files. Default port `9876`,
default host `127.0.0.1`.

```bash
# from this directory, after `pip install -e .[dev]`
python -m neuralgentics.web --mode=embedded --port=9876
```

Then open `http://127.0.0.1:9876/`.

### Team-server mode

Listens on `0.0.0.0`, PG-backed, **auth required** (JWT + OAuth2 stub, T-109).
Default port `9877`. Pass `--db-url` to open a PostgreSQL pool at startup.

```bash
python -m neuralgentics.web \
  --mode=team-server \
  --port=9877 \
  --db-url=postgresql://USER:PASSWORD@localhost:5434/DBNAME \
  --auth=oauth2
```

Health check (no auth required):

```bash
curl http://localhost:9877/api/v1/health
# {"status":"ok","mode":"team-server","db_connected":true,"auth_mode":"oauth2","users_seeded":3}
```

Without `--db-url` the server still boots; `db_connected` is `false` and
any PG-dependent endpoints return a placeholder. `asyncpg` is an optional
extra — install with:

```bash
pip install neuralgentics-web[team-server]
```

## Auth (team-server mode only)

T-109 ships three auth modes, selected via the `--auth` CLI flag or the
`NEURALGENTICS_WEB_AUTH` env var (default: `jwt`):

| Mode | Behavior |
|------|----------|
| `off` | No auth — dev only. Prints a loud warning. Anyone with network access can read/modify data. |
| `jwt` | Bearer JWT access tokens required for all protected routes. Use this for API clients (curl, scripts, other services). |
| `oauth2` | JWT path **plus** the `POST /auth/login` form, refresh-token rotation, and `GET /auth/me`. Use this for human users in a browser. |

### Embedded mode

Embedded mode is always anonymous + localhost-only (binds to `127.0.0.1`).
The auth layer is not installed. This is the security default — the network
itself is the boundary.

### Default users (dev only)

On first run the SQLite user store at `~/.neuralgentics/web-users.db` is
seeded with three dev users (bcrypt-hashed). A loud warning is printed to
stderr.

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin` | `admin` |
| `operator` | `operator` | `operator` |
| `viewer` | `viewer` | `viewer` |

**Change these passwords immediately in any non-dev deployment:**

```bash
python -m neuralgentics.web.auth.users set-password admin
# (prompts for a new password)
```

### RBAC

Three global roles (per-module RBAC is a future card):

| Action | admin | operator | viewer |
|--------|-------|----------|--------|
| Read modules (GET) | yes | yes | yes |
| Adjust trust (POST /memory/.../trust) | yes | yes | no |
| Modify config (POST /api/v1/config) | yes | no | no |
| Login / logout | yes | yes | yes |
| User management (POST /auth/users) | yes | no | no |

### OAuth2 login flow

```bash
# 1. Login (form-encoded):
curl -X POST http://localhost:9877/auth/login \
  -d "username=admin&password=admin"
# {"access_token":"...","refresh_token":"...","token_type":"bearer","expires_in":86400}

# 2. Use the access token on protected routes:
curl http://localhost:9877/api/v1/modules \
  -H "Authorization: Bearer <access_token>"

# 3. Refresh (rotation: old refresh token is revoked):
curl -X POST http://localhost:9877/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}'

# 4. Logout (revokes the refresh token; access token expires naturally):
curl -X POST http://localhost:9877/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh_token>"}'
```

Access tokens expire in 24h; refresh tokens in 7d. Refresh-token rotation is
ON by default — each successful refresh issues a new refresh token and
revokes the old one.

### JWT secret

HS256 is the algorithm for v0.14.x (the team-server is intended for a
trusted network). The secret is read from `$WEB_JWT_SECRET`; if unset, a
random one is generated per process and a loud warning is printed to stderr
(tokens invalidate on every restart).

```bash
export WEB_JWT_SECRET="$(openssl rand -hex 32)"
```

RS256 / asymmetric JWT, real OIDC (Google, GitHub, etc.), and per-module
RBAC are deferred to future cards. This is a **stub** implementation — the
OAuth2 form is functional but not production-grade.

## Module discovery

At startup the loader scans `modules/*/module.yaml` (built-in directory by
default; override with `--modules-path` or `NEURALGENTICS_WEB_MODULES_PATH`).
Each `module.yaml` is validated against the manifest schema and registered.
Invalid manifests are logged and skipped. Hot-reload is a future card.

### Drop-in a new module

```bash
mkdir src/neuralgentics/web/modules/my-module
cat > src/neuralgentics/web/modules/my-module/module.yaml <<'YAML'
name: my-module
version: 0.1.0
display_name: "My Module"
description: "does the thing"
routes:
  - path: /modules/my-module
    method: GET
    template: module_stub.html
api_endpoints:
  - path: /api/v1/my-module/thing
    method: GET
    handler: stub
YAML
python -m neuralgentics.web --mode=embedded --port=9876
# now visit http://localhost:9876/ — your module appears in the grid.
```

### module.yaml format

Modeled on Grafana's `plugin.json` + VS Code's `package.json contributes`:

```yaml
name: gateway-audit           # required, no whitespace
version: 0.1.0                # required
display_name: "Gateway Audit" # required
description: "Live view..."    # required
author: Veedubin              # optional, default Veedubin
license: MIT                  # optional, default MIT
routes:                       # HTTP routes the module contributes
  - path: /modules/gateway-audit
    method: GET
    template: module_stub.html
    context:
      message: "Coming in T-106"
api_endpoints:                # REST endpoints the module contributes
  - path: /api/v1/gateway-audit/recent
    method: GET
    handler: stub             # stub | <module>.<submodule>:<callable>
sse_channels: []              # SSE channels (future cards)
data_sources: []              # declared data sources (future cards)
```

Full spec: `docs/module-manifest-spec.md`. How to write a real module:
`docs/module-development.md`.

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | HTML — module grid |
| `/modules/<name>` | GET | HTML — one module's stub page |
| `/api/v1/modules` | GET | JSON — all discovered modules |
| `/api/v1/modules/<name>` | GET | JSON — one module |
| `/api/v1/health` | GET | JSON — `{status, mode, db_connected?}` |

## Configuration reference

| Flag / env | Flag | Default | Notes |
|-----------|------|---------|-------|
| `NEURALGENTICS_WEB_MODE` | `--mode` | `embedded` | `embedded` or `team-server` |
| `NEURALGENTICS_WEB_PORT` | `--port` | `9876` embedded / `9877` team | listen port |
| `NEURALGENTICS_WEB_HOST` | `--host` | `127.0.0.1` / `0.0.0.0` | bind host |
| `NEURALGENTICS_WEB_DB_URL` | `--db-url` | none | PG DSN (team-server only) |
| `NEURALGENTICS_WEB_MODULES_PATH` | `--modules-path` | built-in `modules/` | override module dir |

## Development

```bash
pip install -e .[dev]
pytest tests/ -v          # 11 tests
ruff check .               # clean
mypy --strict .            # clean
```

Python 3.12+. Stack: FastAPI + uvicorn + Jinja2 + htmx (CDN) + Tailwind
(CDN) + Pydantic v2 + PyYAML.

## Docker (team-server)

```bash
docker build -t neuralgentics-web:0.13.0 -f Dockerfile .
docker run -p 9877:9877 -e NEURALGENTICS_WEB_DB_URL=postgresql://... \
  neuralgentics-web:0.13.0
```

See `Dockerfile` for the multi-stage build (Python base → distroless).

## License

MIT © Veedubin. Part of the neuralgentics project.