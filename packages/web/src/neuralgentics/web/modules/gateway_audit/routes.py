"""FastAPI routes for the gateway-audit module.

Three endpoints:
  * ``GET /modules/gateway-audit``           — HTML table of recent audit events.
  * ``GET /modules/gateway-audit/sse``        — SSE stream of new events.
  * ``GET /api/v1/gateway-audit/recent``     — JSON list with server-side filters.

The HTML page uses htmx + the htmx-sse extension (loaded via CDN) for live
updates. If the SSE connection drops, htmx falls back to 5s polling via
``hx-trigger="every 5s"`` on the table body.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from jinja2 import ChoiceLoader, Environment, FileSystemLoader
from sse_starlette.sse import EventSourceResponse

from neuralgentics.web.auth.rbac import RbacMode, require_module_action
from neuralgentics.web.auth.users import User
from neuralgentics.web.modules.gateway_audit.data_source import (
    AuditDataSource,
    AuditEvent,
)
from neuralgentics.web.modules.gateway_audit.sse import AuditBroadcaster, Goodbye
from neuralgentics.web.modules.loader import module_route
from neuralgentics.web.modules.registry import ModuleRegistry

log = logging.getLogger("neuralgentics.web.gateway_audit.routes")

MODULE_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
SHELL_TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "shell" / "templates"


def _make_templates() -> Jinja2Templates:
    """Jinja2 templates that resolve the module's templates first, then the
    shell's (so ``{% extends "base.html" %}`` works)."""
    env = Environment(
        loader=ChoiceLoader(
            [
                FileSystemLoader(str(MODULE_TEMPLATES_DIR)),
                FileSystemLoader(str(SHELL_TEMPLATES_DIR)),
            ]
        ),
        autoescape=True,
    )
    return Jinja2Templates(env=env)


# Build once at import — cheap.
TEMPLATES = _make_templates()


def _parse_iso(s: str | None) -> datetime | None:
    if s is None or s == "":
        return None
    # Tolerate a trailing 'Z' (Python <3.11's fromisoformat doesn't accept it).
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def build_router(
    data_source: AuditDataSource,
    broadcaster: AuditBroadcaster,
    *,
    registry: ModuleRegistry | None = None,
    rbac_mode: RbacMode = "permissive",
) -> APIRouter:
    """Construct the gateway-audit APIRouter.

    T-111: when ``registry`` is provided, routes use per-module RBAC via
    :func:`require_module_action`; otherwise they fall back to the global
    T-110 :func:`require_role` table (backwards compat).
    """
    router = APIRouter(prefix="", tags=["gateway-audit"])
    templates = TEMPLATES
    _MODULE_NAME = "gateway-audit"

    def _dep(action: str, fallback: tuple[str, ...]) -> Any:
        if registry is not None:
            return require_module_action(
                module_name=_MODULE_NAME,
                action=action,
                registry=registry,
                fallback_roles=fallback,
                rbac_mode=rbac_mode,
            )
        from neuralgentics.web.auth.rbac import require_role

        return require_role(*fallback)

    @router.get("/modules/gateway-audit", response_class=HTMLResponse)
    @module_route("view_audit")
    async def audit_table(
        request: Request,
        domain: str | None = Query(None),
        status: int | None = Query(None),
        since: str | None = Query(None),
        until: str | None = Query(None),
        limit: int = Query(100, ge=1, le=1000),
        user: User | None = Depends(_dep("view_audit", ("admin", "operator", "viewer"))),
    ) -> HTMLResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        events = await data_source.recent(
            limit=limit,
            domain=domain,
            status=status,
            since=_parse_iso(since),
            until=_parse_iso(until),
        )
        return templates.TemplateResponse(
            request,
            "audit_table.html",
            {
                "events": events,
                "filters": {
                    "domain": domain or "",
                    "status": status if status is not None else "",
                    "since": since or "",
                    "until": until or "",
                    "limit": limit,
                },
                "title": "Gateway Audit",
            },
        )

    @router.get("/api/v1/gateway-audit/recent")
    @module_route("view_audit")
    async def api_recent(
        domain: str | None = Query(None),
        status: int | None = Query(None),
        since: str | None = Query(None),
        until: str | None = Query(None),
        limit: int = Query(100, ge=1, le=1000),
        user: User | None = Depends(_dep("view_audit", ("admin", "operator", "viewer"))),
    ) -> JSONResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        events = await data_source.recent(
            limit=limit,
            domain=domain,
            status=status,
            since=_parse_iso(since),
            until=_parse_iso(until),
        )
        return JSONResponse(
            {
                "events": [json.loads(e.model_dump_json()) for e in events],
                "count": len(events),
            }
        )

    @router.get("/modules/gateway-audit/charts", response_class=HTMLResponse)
    @module_route("view_audit")
    async def audit_charts(
        request: Request,
        user: User | None = Depends(_dep("view_audit", ("admin", "operator", "viewer"))),
    ) -> HTMLResponse:
        """T-118: charts page. Aggregation happens client-side via Chart.js;
        this route only renders the canvas shell."""
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        return templates.TemplateResponse(
            request,
            "charts.html",
            {"title": "Gateway Audit"},
        )

    @router.get("/modules/gateway-audit/sse")
    @module_route("view_audit")
    async def sse_stream(
        request: Request,
        user: User | None = Depends(_dep("view_audit", ("admin", "operator", "viewer"))),
    ) -> EventSourceResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        q: asyncio.Queue[AuditEvent | Goodbye] = broadcaster.subscribe()

        async def event_generator() -> AsyncIterator[dict[str, str]]:
            # Yield a hello comment immediately so the response headers flush
            # (some ASGI transports — httpx.ASGITransport, TestClient — buffer
            # until the first chunk; without this, SSE connections hang on open).
            yield {"event": "hello", "data": '{"connected":true}'}
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event: AuditEvent | Goodbye = await asyncio.wait_for(q.get(), timeout=5.0)
                        # T-115.1: Goodbye sentinel → emit goodbye frame + close.
                        if isinstance(event, Goodbye):
                            yield {"event": "goodbye", "data": '{"reason":"reload"}'}
                            break
                        yield {
                            "event": "audit",
                            "data": event.model_dump_json(),
                        }
                    except TimeoutError:
                        # Heartbeat keeps proxies from closing the idle stream.
                        yield {"comment": "heartbeat"}
            finally:
                broadcaster.unsubscribe(q)

        return EventSourceResponse(event_generator())

    return router


__all__ = ["build_router"]
