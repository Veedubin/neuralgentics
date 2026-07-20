"""The real broker-audit module (T-107).

Replaces the T-105 stub. Provides:
  * a live tool-calls table (last 100 broker tool calls)
  * an SSE stream that pushes new tool-call events in real time
  * server-side filters (tool, server, role, success, time range)
  * an aggregate stats panel (total calls, success rate, avg latency,
    top 5 most-used tools)

The data source is mode-dependent:
  * embedded mode  → :class:`JSONLBrokerAuditSource` (reads a local JSONL
    file written by the broker's audit hooks — the broker doesn't have
    these yet; T-107 ships the consumer side, a future broker patch adds
    the producer)
  * team-server    → :class:`PGBrokerAuditSource` (reads the
    ``broker_audit_log`` PG table + LISTEN/NOTIFY on
    ``broker_audit_new``; the table + trigger are created idempotently
    by :meth:`PGBrokerAuditSource.apply_schema`)
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import PrivateAttr

from neuralgentics.web.modules.base import Module
from neuralgentics.web.modules.broker_audit.data_source import (
    BrokerAuditDataSource,
    make_source_from_config,
)
from neuralgentics.web.modules.broker_audit.routes import build_router
from neuralgentics.web.modules.broker_audit.sse import BrokerAuditBroadcaster
from neuralgentics.web.modules.registry import ModuleManifest

log = logging.getLogger("neuralgentics.web.broker_audit")


class BrokerAuditModule(Module):
    """Full broker-audit module.

    Constructed by :func:`register_module_routes` after module discovery.
    Owns a data source and a broadcaster.

    Lifecycle (sync router inclusion + async startup/shutdown):

      * :meth:`build_router` — sync. Returns the FastAPI router for the
        module. Called at app-build time so the module's literal
        ``/modules/broker-audit`` route wins over the shell's catch-all.
      * :meth:`start_background` — sync, called from the lifespan. Spawns
        the SSE drain task that feeds the broadcaster from the data
        source's ``subscribe()``.
      * :meth:`shutdown` — async, called from the lifespan. Cancels the
        drain task + closes the data source.
    """

    _data_source: BrokerAuditDataSource = PrivateAttr()
    _broadcaster: BrokerAuditBroadcaster = PrivateAttr()

    def __init__(self, manifest: ModuleManifest, data_source: BrokerAuditDataSource) -> None:
        super().__init__(manifest=manifest)
        self._data_source = data_source
        self._broadcaster = BrokerAuditBroadcaster()

    @property
    def data_source(self) -> BrokerAuditDataSource:
        return self._data_source

    @property
    def broadcaster(self) -> BrokerAuditBroadcaster:
        return self._broadcaster

    def build_router(self, **kwargs: Any) -> Any:
        """Sync: return the FastAPI router for this module.

        T-111: accepts optional ``registry=`` + ``rbac_mode=`` kwargs to
        wire per-module RBAC; unknown kwargs are ignored for backwards
        compat. Called at app-build time (before the shell router is
        included) so the literal ``/modules/broker-audit`` route wins
        over the shell's ``/modules/{module_name}`` catch-all.
        """
        return build_router(self._data_source, self._broadcaster, **kwargs)

    def start_background(self) -> None:
        """Sync, called from the lifespan: spawn the SSE drain task."""
        self._broadcaster.start(self._data_source.subscribe())
        log.info("broker-audit background drain started")

    async def shutdown(self) -> None:
        """Async, called from the lifespan: cancel drain + close source."""
        await self._broadcaster.stop()
        close = getattr(self._data_source, "close", None)
        if close is not None:
            await close()
        log.info("broker-audit module shut down")

    async def register_routes(self, app: Any) -> None:
        """Back-compat for the legacy async register_routes contract."""
        app.include_router(self.build_router())
        self.start_background()
        shutdowns = list(getattr(app.state, "module_shutdowns", []))
        shutdowns.append(self.shutdown)
        app.state.module_shutdowns = shutdowns

    async def render(self, ctx: Any) -> str:
        """Default render — delegates to the GET /modules/broker-audit route."""
        return "<!-- broker-audit renders via its own router -->"


__all__ = ["BrokerAuditModule", "build"]


def build(manifest: ModuleManifest, config: Any) -> BrokerAuditModule:
    """Factory called by :func:`register_module_routes` to construct the
    module with a data source derived from the WebConfig."""
    data_source = make_source_from_config(config)
    return BrokerAuditModule(manifest, data_source)
