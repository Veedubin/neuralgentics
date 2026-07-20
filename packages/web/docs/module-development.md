# Developing a neuralgentics-web module

This guide walks through writing a real module (post-T-105). The stub
modules shipped in v0.1 are placeholders; this is how the T-106/107/108
implementations will be structured.

## Layout

```
src/neuralgentics/web/modules/<your_module>/
├── __init__.py        # exports your Module subclass
├── module.yaml        # manifest
├── routes.py          # FastAPI route handlers
├── panels.py          # dashboard panel callables (future)
├── sse.py             # SSE channel handlers (future)
└── templates/         # module-local Jinja templates (optional)
    └── dashboard.html
```

## Step 1 — write the manifest

```yaml
# src/neuralgentics/web/modules/my_module/module.yaml
name: my-module
version: 0.1.0
display_name: "My Module"
description: "Does the thing"
routes:
  - path: /modules/my-module
    method: GET
    handler: neuralgentics.web.modules.my_module.routes:dashboard
api_endpoints:
  - path: /api/v1/my-module/data
    method: GET
    handler: neuralgentics.web.modules.my_module.routes:get_data
```

## Step 2 — write the handler

```python
# src/neuralgentics/web/modules/my_module/routes.py
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

@router.get("/modules/my-module", response_class=HTMLResponse)
async def dashboard() -> HTMLResponse:
    return HTMLResponse("<h1>My Module</h1>")

@router.get("/api/v1/my-module/data")
async def get_data() -> dict:
    return {"rows": []}
```

## Step 3 — register routes with the shell

In v0.1 the shell does not auto-import module `__init__.py` (T-106+ adds
that). For now, to wire a real handler, edit
`src/neuralgentics/web/app.py::build_app` to include your module's router
after the shell router. T-106 will move this into a `Module.register_routes`
hook called by the loader.

## Step 4 — test

```bash
pytest packages/web/tests/ -v
ruff check packages/web/
mypy --strict packages/web/
python -m neuralgentics.web --mode=embedded --port=9876
# visit http://localhost:9876/modules/my-module
```

## Module context

When the shell renders a module, it passes a `ModuleContext` carrying the
current mode, user (team-server), and an `extra` dict. Modules should not
read request state directly — use the context for mode-aware logic.

## Data sources (future)

T-106 (gateway-audit) will introduce the `data_sources` field:

```yaml
data_sources:
  - name: gateway-audit-db
    type: postgres
    dsn_env: NEURALGENTICS_AUDIT_DB_URL
```

The shell opens a pool per data source at startup and passes a handle into
the module's `ModuleContext`. T-105 only ships the empty list.

## SSE channels (future)

T-106+ wires `sse_channels`:

```yaml
sse_channels:
  - name: gateway-events
    handler: neuralgentics.web.modules.gateway_audit.sse:gateway_events
```

The shell builds an `sse_hub` and the module's callable subscribes to it.
T-105 ships the empty list.