"""The real gateway-audit module (T-106).

Replaces the T-105 stub. Provides:
  * a live audit table (last 100 HTTP events through the gateway)
  * an SSE stream that pushes new events in real time
  * server-side filters (domain, status, time range)

The data source is mode-dependent:
  * embedded mode  → :class:`JSONLAuditSource` (reads a local JSONL file)
  * team-server    → :class:`PGAuditSource` (reads the gateway's
    ``audit_events`` PG table + LISTEN/NOTIFY)
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import PrivateAttr

from neuralgentics.web.modules.base import Module
from neuralgentics.web.modules.gateway_audit.data_source import (
    AuditDataSource,
    make_source_from_config,
)
from neuralgentics.web.modules.gateway_audit.routes import build_router
from neuralgentics.web.modules.gateway_audit.sse import AuditBroadcaster
from neuralgentics.web.modules.registry import ModuleManifest

log = logging.getLogger("neuralgentics.web.gateway_audit")


class GatewayAuditModule(Module):
    """Full gateway-audit module.

    Constructed by :func:`register_module_routes` after module discovery.
    Owns a data source and a broadcaster.

    Lifecycle (sync router inclusion + async startup/shutdown):

      * :meth:`build_router` — sync. Returns the FastAPI router for the
        module. Called at app-build time so the module's literal
        ``/modules/gateway-audit`` route wins over the shell's catch-all.
      * :meth:`start_background` — sync, called from the lifespan. Spawns
        the SSE drain task that feeds the broadcaster from the data
        source's ``subscribe()``.
      * :meth:`shutdown` — async, called from the lifespan. Cancels the
        drain task + closes the data source.

    The data source and broadcaster are pydantic-private attributes (not
    pydantic fields) because they're plain Python objects with their own
    lifecycle — pydantic shouldn't try to validate them.
    """

    _data_source: AuditDataSource = PrivateAttr()
    _broadcaster: AuditBroadcaster = PrivateAttr()

    def __init__(self, manifest: ModuleManifest, data_source: AuditDataSource) -> None:
        super().__init__(manifest=manifest)
        self._data_source = data_source
        self._broadcaster = AuditBroadcaster()

    @property
    def data_source(self) -> AuditDataSource:
        return self._data_source

    @property
    def broadcaster(self) -> AuditBroadcaster:
        return self._broadcaster

    def build_router(self) -> Any:
        """Sync: return the FastAPI router for this module.

        Called at app-build time (before the shell router is included) so
        the literal ``/modules/gateway-audit`` route wins over the shell's
        ``/modules/{module_name}`` catch-all.
        """
        return build_router(self._data_source, self._broadcaster)

    def start_background(self) -> None:
        """Sync, called from the lifespan: spawn the SSE drain task."""
        self._broadcaster.start(self._data_source.subscribe())
        log.info("gateway-audit background drain started")

    async def shutdown(self) -> None:
        """Async, called from the lifespan: cancel drain + close source."""
        await self._broadcaster.stop()
        close = getattr(self._data_source, "close", None)
        if close is not None:
            await close()
        log.info("gateway-audit module shut down")

    async def register_routes(self, app: Any) -> None:
        """Back-compat for the legacy async register_routes contract.

        T-105 stubs expose an async register_routes; the new loader calls
        build_router() + start_background() + shutdown() separately. This
        method wraps all three for any caller still using the old contract.
        """
        app.include_router(self.build_router())
        self.start_background()
        shutdowns = list(getattr(app.state, "module_shutdowns", []))
        shutdowns.append(self.shutdown)
        app.state.module_shutdowns = shutdowns

    async def render(self, ctx: Any) -> str:
        """Default render — delegates to the GET /modules/gateway-audit route."""
        return "<!-- gateway-audit renders via its own router -->"


__all__ = ["GatewayAuditModule", "build"]


def build(manifest: ModuleManifest, config: Any) -> GatewayAuditModule:
    """Factory called by :func:`register_module_routes` to construct the
    module with a data source derived from the WebConfig."""
    data_source = make_source_from_config(config)
    return GatewayAuditModule(manifest, data_source)
