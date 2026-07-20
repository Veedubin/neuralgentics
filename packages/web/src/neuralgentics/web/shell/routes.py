"""Shell routes — index page, /api/v1/modules, /api/v1/health.

These are the *core* routes that always exist regardless of which modules
are installed. Module routes are added on top by ``app.build_app``.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from neuralgentics.web.modules.registry import ModuleRegistry

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"


def build_shell_router(
    registry: ModuleRegistry,
    mode_name: str,
    templates: Jinja2Templates,
) -> APIRouter:
    """Construct the shell router. Mode name is for the health endpoint."""
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        modules = registry.all()
        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "modules": modules,
                "mode": mode_name,
                "title": "neuralgentics-web",
            },
        )

    @router.get("/api/v1/modules")
    async def list_modules() -> JSONResponse:
        return JSONResponse({"modules": registry.summaries(), "total": len(registry)})

    @router.get("/api/v1/modules/{module_name}")
    async def get_module(module_name: str) -> JSONResponse:
        m = registry.get(module_name)
        if m is None:
            return JSONResponse({"error": "not found", "name": module_name}, status_code=404)
        return JSONResponse(m.to_summary())

    # /api/v1/health is registered in the app factory so it can be enriched
    # with mode-specific fields (db_connected etc.). Do not register it here
    # — FastAPI uses the first registered route for a path, and the factory
    # needs to own this endpoint.

    # Module stub pages: each manifest's first route renders the stub template.
    @router.get("/modules/{module_name}", response_class=HTMLResponse)
    async def module_stub(request: Request, module_name: str) -> HTMLResponse:
        m = registry.get(module_name)
        if m is None:
            return HTMLResponse(f"<h1>Module {module_name} not found</h1>", status_code=404)
        return templates.TemplateResponse(
            request,
            "module_stub.html",
            {
                "module": m,
                "coming_in": m.to_summary()["coming_in"],
                "title": m.display_name,
            },
        )

    return router
