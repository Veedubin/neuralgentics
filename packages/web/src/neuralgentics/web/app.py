"""FastAPI app factory + uvicorn runner.

The same app object serves both modes; the mode-specific bits are
encapsulated in :class:`EmbeddedMode` / :class:`TeamServerMode`.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from neuralgentics.web.config import WebConfig
from neuralgentics.web.modes import EmbeddedMode, TeamServerMode
from neuralgentics.web.modules.loader import discover_modules, register_module_routes
from neuralgentics.web.modules.registry import ModuleRegistry
from neuralgentics.web.shell.reload import DisabledModuleMiddleware, build_admin_modules_router
from neuralgentics.web.shell.routes import build_shell_router

log = logging.getLogger("neuralgentics.web.app")

STATIC_DIR = Path(__file__).resolve().parent / "shell" / "static"
TEMPLATES_DIR = Path(__file__).resolve().parent / "shell" / "templates"


def build_app(config: WebConfig) -> FastAPI:
    """Construct the FastAPI application for the given config.

    1. Discover modules from ``config.modules_path``.
    2. Include each module's FastAPI router (if it has a Python impl) BEFORE
       the shell router so the module's literal ``/modules/<name>`` route
       wins over the shell's ``/modules/{module_name}`` catch-all stub.
    3. Install the mode handler (embedded or team-server).
    4. Wire lifespan to start module background tasks + the team-server
       PG pool, and to shut them all down on exit.
    """
    registry: ModuleRegistry = discover_modules(config.modules_path)
    log.info("discovered %d module(s) from %s", len(registry), config.modules_path)

    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

    if config.mode == "team-server":
        mode_handler: Any = TeamServerMode(config)
    else:
        mode_handler = EmbeddedMode(config)

    app = FastAPI(
        title="neuralgentics-web",
        version="0.15.0",
        description="Modular web UI shell for neuralgentics",
        lifespan=None,  # set below after middleware is installed
    )
    app.state.config = config
    app.state.registry = registry
    app.state.mode = config.mode
    app.state.mode_handler = mode_handler
    app.state.module_shutdowns = []
    app.state.module_starters = []
    # T-115.1: prior-module shutdown coroutines scheduled by reload_module
    # when no event loop was running at reload time (rare; the common path
    # uses the running loop directly). Drained by the lifespan.
    app.state.pending_prior_shutdowns = []

    # Install mode-specific middleware + auth routes BEFORE module routes.
    # AuthMiddleware is the outermost layer so request.state.user is
    # populated for every downstream handler (module routes, RBAC deps).
    if hasattr(mode_handler, "configure_async"):
        # Team-server has an async configure (also opens PG pool).
        # We need a sync install path here so the middleware is registered
        # before the first request — the async part is for the PG pool.
        mode_handler.configure(app)
    else:
        mode_handler.configure(app)

    # DisabledModuleMiddleware (T-115): 404 for routes belonging to a
    # disabled module. Installed AFTER auth so it becomes the outermost
    # layer — a disabled module's routes return 404 without first demanding
    # auth (the route is effectively unmounted). The admin reload/enable/
    # disable endpoints are still auth-gated because they're registered as
    # normal routes and Auth runs on them via the middleware stack.
    app.add_middleware(DisabledModuleMiddleware, registry=registry)

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # Include module routers FIRST (literal routes win over the shell's
    # /modules/{module_name} catch-all). register_module_routes is sync —
    # it only includes routers + records startup/shutdown hooks; the async
    # background tasks are started by the lifespan via module_starters.
    register_module_routes(app, registry, config)

    # Admin module-management router (T-115): reload/enable/disable.
    # Registered AFTER module routers so the module's literal
    # /api/v1/modules/{name} routes (if any) don't shadow these admin paths.
    # All three endpoints are gated by Depends(require_role("admin")).
    app.include_router(build_admin_modules_router(registry, app, config))

    shell_router = build_shell_router(registry, config.mode, templates)
    app.include_router(shell_router)

    # Enrich /api/v1/health with mode-specific fields by overriding the route.
    @app.get("/api/v1/health", include_in_schema=False)
    async def health_full() -> dict[str, Any]:
        base = {"status": "ok", "mode": config.mode}
        extra = getattr(mode_handler, "health_payload", {})
        if isinstance(extra, dict):
            base.update(extra)
        return base

    # Lifespan: open the PG pool (team-server) and start module bg tasks.

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if hasattr(mode_handler, "configure_async"):
            # Already configured synchronously above; this opens the PG pool.
            await mode_handler.configure_async(app)
        for starter in getattr(app.state, "module_starters", []):
            starter()
        # T-115.1: drain any prior-module shutdowns scheduled before the
        # lifespan loop was running (rare path — reload_module usually finds
        # a running loop and schedules via create_task directly).
        import asyncio

        for prior_shutdown in getattr(app.state, "pending_prior_shutdowns", []):
            asyncio.create_task(prior_shutdown())
        app.state.pending_prior_shutdowns = []
        await asyncio.sleep(0)
        yield
        for shutdown in app.state.module_shutdowns:
            try:
                await shutdown()
            except Exception:  # noqa: BLE001
                log.exception("module shutdown error")
        if hasattr(mode_handler, "shutdown_async"):
            await mode_handler.shutdown_async()

    app.router.lifespan_context = lifespan

    return app


def run_app(app: FastAPI, config: WebConfig) -> None:
    """Run the app with uvicorn. Blocking — call from __main__ only."""
    import uvicorn

    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
