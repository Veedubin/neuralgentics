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

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if hasattr(mode_handler, "configure_async"):
            await mode_handler.configure_async(app)
        else:
            mode_handler.configure(app)
        # Start module background tasks (SSE drain, etc.).
        for starter in getattr(app.state, "module_starters", []):
            starter()
        import asyncio

        await asyncio.sleep(0)
        yield
        # Run module shutdowns.
        for shutdown in app.state.module_shutdowns:
            try:
                await shutdown()
            except Exception:  # noqa: BLE001
                log.exception("module shutdown error")
        if hasattr(mode_handler, "shutdown_async"):
            await mode_handler.shutdown_async()

    app = FastAPI(
        title="neuralgentics-web",
        version="0.14.0",
        description="Modular web UI shell for neuralgentics",
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.registry = registry
    app.state.mode = config.mode
    app.state.mode_handler = mode_handler
    app.state.module_shutdowns = []
    app.state.module_starters = []

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # Include module routers FIRST (literal routes win over the shell's
    # /modules/{module_name} catch-all). register_module_routes is sync —
    # it only includes routers + records startup/shutdown hooks; the async
    # background tasks are started by the lifespan via module_starters.
    register_module_routes(app, registry, config)

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

    return app


def run_app(app: FastAPI, config: WebConfig) -> None:
    """Run the app with uvicorn. Blocking — call from __main__ only."""
    import uvicorn

    uvicorn.run(app, host=config.host, port=config.port, log_level="info")
