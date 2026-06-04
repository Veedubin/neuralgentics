"""FastAPI server for neuralgentics-core.

Routes:
    POST /broker/resolve_intent  — Resolve a user intent to a tool
    POST /broker/capabilities    — Register a new capability dynamically
    GET  /broker/capabilities    — List registered capabilities
    GET  /health                  — Liveness probe
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI

from neuralgentics_core.broker import get_registry, resolve_intent
from neuralgentics_core.config import settings
from neuralgentics_core.extractor import SessionExtractor
from neuralgentics_core.llm import get_llm_client, init_llm_client
from neuralgentics_core.models import (
    HealthResponse,
    RegisterCapabilityRequest,
    RegisterCapabilityResponse,
    ResolveIntentRequest,
    ResolveIntentResponse,
)

logger = logging.getLogger(__name__)

# Module-level extractor instance
_extractor: SessionExtractor | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage startup/shutdown lifecycle."""
    global _extractor  # noqa: PLW0603

    # Startup
    logger.info("Initializing neuralgentics-core...")

    # Initialize LLM client
    llm = init_llm_client()
    logger.info("LLM client initialized (base_url=%s, model=%s)", llm.base_url, llm.model)

    # Load capability registry
    registry = get_registry()
    logger.info("Capability registry loaded (%d capabilities)", len(registry.list_capabilities()))

    # Start session extractor
    _extractor = SessionExtractor()
    await _extractor.start()

    yield

    # Shutdown
    logger.info("Shutting down neuralgentics-core...")
    if _extractor:
        await _extractor.stop()
    await llm.close()
    logger.info("Shutdown complete.")


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    app = FastAPI(
        title="neuralgentics-core",
        version="0.1.0",
        description="Intent-to-Tool Broker and Session Log Context Extractor",
        lifespan=lifespan,
    )

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """Liveness and readiness probe."""
        llm_connected = False
        try:
            llm_connected = await get_llm_client().health_check()
        except Exception:
            pass

        return HealthResponse(
            status="ok" if llm_connected else "degraded",
            version="0.1.0",
            llm_connected=llm_connected,
        )

    # ------------------------------------------------------------------
    # Intent Broker
    # ------------------------------------------------------------------

    @app.post("/broker/resolve_intent", response_model=ResolveIntentResponse)
    async def resolve_intent_endpoint(request: ResolveIntentRequest) -> ResolveIntentResponse:
        """Resolve a natural-language intent to a specific tool and arguments."""
        result = await resolve_intent(request)
        return result

    @app.get("/broker/capabilities")
    async def list_capabilities() -> list[dict[str, str]]:
        """List all registered capabilities."""
        registry = get_registry()
        return [
            {"name": c.name, "description": c.description} for c in registry.list_capabilities()
        ]

    @app.post("/broker/capabilities", response_model=RegisterCapabilityResponse)
    async def register_capability(request: RegisterCapabilityRequest) -> RegisterCapabilityResponse:
        """Dynamically register a new capability."""
        registry = get_registry()
        cap = registry.register(name=request.name, description=request.description)
        return RegisterCapabilityResponse(name=cap.name, status="registered")

    return app


# Module-level app instance for uvicorn
app = create_app()


def main() -> None:
    """Entry point for the neuralgentics-core server."""
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    uvicorn.run(
        "neuralgentics_core.server:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
