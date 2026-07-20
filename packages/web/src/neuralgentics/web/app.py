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
from neuralgentics.web.modules.loader import discover_modules
from neuralgentics.web.modules.registry import ModuleRegistry
from neuralgentics.web.shell.routes import build_shell_router

log = logging.getLogger("neuralgentics.web.app")

STATIC_DIR = Path(__file__).resolve().parent / "shell" / "static"
TEMPLATES_DIR = Path(__file__).resolve().parent / "shell" / "templates"


def build_app(config: WebConfig) -> FastAPI:
    """Construct the FastAPI application for the given config.

    1. Discover modules from ``config.modules_path``.
    2. Build the shell router (/, /api/v1/modules, /api/v1/health, /modules/<name>).
    3. Install the mode handler (embedded or team-server).
    4. Wire lifespan so team-server can open/close its PG pool.
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
        yield
        if hasattr(mode_handler, "shutdown_async"):
            await mode_handler.shutdown_async()

    app = FastAPI(
        title="neuralgentics-web",
        version="0.13.0",
        description="Modular web UI shell for neuralgentics",
        lifespan=lifespan,
    )
    app.state.config = config
    app.state.registry = registry
    app.state.mode = config.mode
    app.state.mode_handler = mode_handler

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

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
