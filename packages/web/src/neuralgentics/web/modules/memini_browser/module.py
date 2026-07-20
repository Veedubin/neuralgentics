"""The real memini-browser module (T-108).

Replaces the T-105 stub. Provides:
  * a search form (free text) over the memini-ai memory database
  * a results table (top N by trust + relevance)
  * a memory detail page (full content, metadata, trust, relationships,
    decay status)
  * a trust-adjust form (the only write path in v0.14.0)
  * an SVG knowledge-graph visualization (entities + relationships,
    circular layout, server-rendered)

The backend is selected by :func:`make_client_from_config` based on env
and WebConfig:
  * ``NEURALGENTICS_MEMINI_BACKEND=mock`` → :class:`MockMeminiClient`
  * team-server + ``memini_backend=pg`` → :class:`PGMeminiClient`
  * otherwise → :class:`SDKMeminiClient` (wraps memini-ai SDK)

The module has no SSE channel — memory writes happen out-of-band (via
the memini-ai MCP server), so there is no real-time stream to surface.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import PrivateAttr

from neuralgentics.web.modules.base import Module
from neuralgentics.web.modules.memini_browser.memini_client import (
    MeminiClient,
    make_client_from_config,
)
from neuralgentics.web.modules.memini_browser.routes import build_router
from neuralgentics.web.modules.registry import ModuleManifest

log = logging.getLogger("neuralgentics.web.memini_browser")


class MeminiBrowserModule(Module):
    """Full memini-browser module.

    Constructed by :func:`register_module_routes` after module discovery.
    Owns a :class:`MeminiClient` backend.

    Lifecycle:
      * :meth:`build_router` — sync. Returns the FastAPI router.
      * :meth:`start_background` — sync, called from the lifespan. No
        background tasks for v0.14.0 (no SSE).
      * :meth:`shutdown` — async, closes the client.
    """

    _client: MeminiClient = PrivateAttr()

    def __init__(self, manifest: ModuleManifest, client: MeminiClient) -> None:
        super().__init__(manifest=manifest)
        self._client = client

    @property
    def client(self) -> MeminiClient:
        return self._client

    def build_router(self, **kwargs: Any) -> Any:
        """Build the FastAPI router. T-111: accepts optional
        ``registry=`` + ``rbac_mode=`` kwargs to wire per-module RBAC;
        unknown kwargs are ignored for backwards compat."""
        return build_router(self._client, **kwargs)

    def start_background(self) -> None:
        log.info("memini-browser module started (backend=%s)", type(self._client).__name__)

    async def shutdown(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await close()
        log.info("memini-browser module shut down")

    async def register_routes(self, app: Any) -> None:
        app.include_router(self.build_router())
        self.start_background()
        shutdowns = list(getattr(app.state, "module_shutdowns", []))
        shutdowns.append(self.shutdown)
        app.state.module_shutdowns = shutdowns

    async def render(self, ctx: Any) -> str:
        return "<!-- memini-browser renders via its own router -->"


__all__ = ["MeminiBrowserModule", "build"]


def build(manifest: ModuleManifest, config: Any) -> MeminiBrowserModule:
    """Factory called by :func:`register_module_routes`."""
    client = make_client_from_config(config)
    return MeminiBrowserModule(manifest, client)
