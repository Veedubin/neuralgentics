# neuralgentics-web — architecture

## Module system

```
neuralgentics.web
├── app.py            ← FastAPI app factory (both modes)
├── config.py         ← Pydantic settings (mode/port/db_url/modules_path)
├── __main__.py       ← CLI entry: python -m neuralgentics.web
├── shell/
│   ├── routes.py     ← core routes: /, /api/v1/modules, /api/v1/health, /modules/<name>
│   ├── templates/    ← base.html, index.html, module_stub.html
│   └── static/       ← style.css (Tailwind via CDN, no build step)
├── modules/
│   ├── loader.py     ← discover_modules(modules_path) → ModuleRegistry
│   ├── registry.py   ← ModuleManifest schema + ModuleRegistry
│   ├── base.py       ← Module base class (full modules subclass this)
│   ├── gateway_audit/  ← stub (T-106 will make it real)
│   ├── broker_audit/   ← stub (T-107)
│   └── memini_browser/ ← stub (T-108)
└── modes/
    ├── embedded.py     ← localhost-only, no auth
    └── team_server.py  ← PG-backed, auth deferred to T-109
```

## Discovery lifecycle

1. `build_app(config)` calls `discover_modules(config.modules_path)`.
2. The loader walks `modules_path/*/module.yaml`, parses each with
   PyYAML, validates against `ModuleManifest` (Pydantic v2).
3. Invalid manifests are logged and skipped (per design doc).
4. Valid manifests are registered in a `ModuleRegistry`.
5. The shell router exposes `/api/v1/modules` (JSON list) and
   `/modules/<name>` (HTML stub page) for each registered manifest.

## Embedded vs team-server

The app object is identical. The difference is configuration:

- **Embedded:** `EmbeddedMode` is a no-op marker. Host defaults to
  `127.0.0.1`. No PG pool. `/api/v1/health` returns
  `{"status":"ok","mode":"embedded"}`.
- **Team-server:** `TeamServerMode.configure_async(app)` opens an
  `asyncpg.create_pool(dsn)` if `--db-url` is set. The lifespan hook closes
  the pool on shutdown. `/api/v1/health` returns
  `{"status":"ok","mode":"team-server","db_connected":bool}`.

Auth (JWT + OAuth2) is deferred to T-109. In v0.1, team-server mode has no
auth middleware — it is intended to run behind an OAuth2 proxy in
production, or be reached only via Tailscale during development.

## Module manifest format

See `packages/web/docs/module-manifest-spec.md` for the full schema. The
v0.1 manifest supports:

- `name`, `version`, `display_name`, `description`, `author`, `license`
- `routes` — list of `{path, method, handler?, template?, context?}`
- `api_endpoints` — list of `{path, method, handler}`
- `sse_channels` — reserved (future cards)
- `data_sources` — reserved (future cards)

## Naming conventions

| Thing | Convention | Why |
|-------|-----------|-----|
| Directory | `gateway_audit` (underscore) | Python-valid identifier; module `__init__.py` is importable |
| Manifest `name` | `gateway-audit` (hyphen) | URL-friendly; matches Grafana plugin id style |

The loader matches on the manifest `name` field, not the directory name.

## Future cards (out of T-105 scope)

| Card | Adds |
|------|------|
| T-106 | gateway-audit full impl (SSE + audit table) |
| T-107 | broker-audit full impl (tool calls table) |
| T-108 | memini-browser full impl (memory search UI) |
| T-109 | auth layer (JWT + OAuth2 stub + RBAC) |
| future | hot-reload of modules |
| future | multi-team-server HA |
| future | HTTPS / cert management |

## Quality gates

```
pytest packages/web/tests/ -v   → 11 tests pass
ruff check packages/web/        → clean
mypy --strict packages/web/     → clean
```

## Deployment

Embedded mode is dev-only — `python -m neuralgentics.web`. Team-server
ships as a container built from `packages/web/Dockerfile` (multi-stage:
python:3.12-slim builder → python:3.12-slim runtime with `libpq5` only).