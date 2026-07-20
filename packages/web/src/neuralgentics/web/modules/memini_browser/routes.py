"""FastAPI routes for the memini-browser module (T-108).

Four endpoints:
  * ``GET  /modules/memini-browser``                    — search form + results
  * ``GET  /modules/memini-browser/memory/{memory_id}``  — full memory detail
  * ``POST /modules/memini-browser/memory/{memory_id}/trust`` — adjust trust
  * ``GET  /modules/memini-browser/memory/{memory_id}/graph`` — SVG graph

Plus one JSON endpoint:
  * ``GET  /api/v1/memini-browser/search``               — JSON search

The module is read-only except for the trust-adjust POST.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from jinja2 import ChoiceLoader, Environment, FileSystemLoader

from neuralgentics.web.auth.rbac import RbacMode, require_module_action
from neuralgentics.web.auth.users import User
from neuralgentics.web.modules.loader import module_route
from neuralgentics.web.modules.memini_browser.graph_viz import render_memory_graph_svg
from neuralgentics.web.modules.memini_browser.memini_client import (
    VALID_TRUST_SIGNALS,
    MeminiClient,
)
from neuralgentics.web.modules.registry import ModuleRegistry

log = logging.getLogger("neuralgentics.web.memini_browser.routes")

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


TEMPLATES = _make_templates()


def build_router(
    client: MeminiClient,
    *,
    registry: ModuleRegistry | None = None,
    rbac_mode: RbacMode = "permissive",
) -> APIRouter:
    """Construct the memini-browser APIRouter.

    T-111: when ``registry`` is provided, routes use per-module RBAC via
    :func:`require_module_action` (reading the module's ``module.yaml``
    ``rbac`` block at request time). When ``registry`` is ``None``
    (backwards compat, e.g. ad-hoc tests), routes fall back to the global
    T-110 :func:`require_role` table — the per-module dependency with
    ``fallback_roles`` reproduces the T-110 role lists exactly.
    """
    router = APIRouter(prefix="", tags=["memini-browser"])
    _templates = TEMPLATES
    # Module name matches the manifest's ``name`` field (hyphenated).
    _MODULE_NAME = "memini-browser"

    def _dep(action: str, fallback: tuple[str, ...]) -> Any:
        """Pick per-module RBAC when registry is wired, else global role."""
        if registry is not None:
            return require_module_action(
                module_name=_MODULE_NAME,
                action=action,
                registry=registry,
                fallback_roles=fallback,
                rbac_mode=rbac_mode,
            )
        # Backwards compat: pure global role gate (T-110 behavior).
        from neuralgentics.web.auth.rbac import require_role

        return require_role(*fallback)

    @router.get("/modules/memini-browser", response_class=HTMLResponse)
    @module_route("search")
    async def search_page(
        request: Request,
        q: str = Query("", description="Free-text search query"),
        limit: int = Query(20, ge=1, le=100),
        user: User | None = Depends(_dep("search", ("admin", "operator", "viewer"))),
    ) -> HTMLResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        results = await client.search(q, limit=limit)
        return _templates.TemplateResponse(
            request,
            "search.html",
            {
                "results": results,
                "q": q,
                "limit": limit,
                "title": "Memory Browser",
            },
        )

    @router.get("/api/v1/memini-browser/search")
    @module_route("search")
    async def api_search(
        q: str = Query("", description="Free-text search query"),
        limit: int = Query(20, ge=1, le=100),
        user: User | None = Depends(_dep("search", ("admin", "operator", "viewer"))),
    ) -> JSONResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        results = await client.search(q, limit=limit)
        return JSONResponse(
            {
                "results": [r.model_dump(mode="json") for r in results],
                "count": len(results),
                "q": q,
            }
        )

    @router.get("/modules/memini-browser/memory/{memory_id}", response_class=HTMLResponse)
    @module_route("view_memory")
    async def memory_detail(
        request: Request,
        memory_id: str,
        flash: str = Query("", description="One-shot flash message"),
        user: User | None = Depends(_dep("view_memory", ("admin", "operator", "viewer"))),
    ) -> HTMLResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        try:
            memory = await client.get(memory_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _templates.TemplateResponse(
            request,
            "memory_detail.html",
            {
                "memory": memory,
                "title": f"Memory {memory.id}",
                "flash": flash,
                "trust_audit_count": _trust_audit_count(client, memory.id),
                "decay_rate": memory.metadata.get("decay_rate"),
            },
        )

    @router.post("/modules/memini-browser/memory/{memory_id}/trust")
    @module_route("adjust_trust")
    async def adjust_trust(
        memory_id: str,
        signal: str = Form(...),
        reason: str = Form(""),
        user: User | None = Depends(_dep("adjust_trust", ("admin", "operator"))),
    ) -> RedirectResponse:
        # ``user`` is None only in --auth=off mode (embedded/dev). In
        # auth-on mode the dependency already 401/403'd before we get here.
        actor = user.username if user is not None else "anonymous"
        if signal not in VALID_TRUST_SIGNALS:
            raise HTTPException(
                status_code=400,
                detail=f"invalid signal '{signal}'; must be one of {sorted(VALID_TRUST_SIGNALS)}",
            )
        try:
            new_trust = await client.adjust_trust(memory_id, signal, reason)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        log.info(
            "trust adjusted via web: memory=%s signal=%s reason=%r new=%.3f actor=%s",
            memory_id,
            signal,
            reason,
            new_trust,
            actor,
        )
        flash = f"Trust adjusted via '{signal}' → new trust = {new_trust:.3f}"
        return RedirectResponse(
            url=f"/modules/memini-browser/memory/{memory_id}?flash={flash}",
            status_code=303,
        )

    @router.post("/modules/memini-browser/memory/{memory_id}/forget")
    @module_route("forget")
    async def forget_memory(
        memory_id: str,
        reason: str = Form(""),
        user: User | None = Depends(_dep("forget", ("admin",))),
    ) -> RedirectResponse:
        """Admin-only: delete a memory + its relationship edges (T-110).

        This is the most destructive write path in the browser — only
        ``admin`` may call it. Operators and viewers get 403 from the
        RBAC dependency before this handler runs. In ``--auth=off`` mode
        the dependency returns ``None`` (anonymous) and the forget
        proceeds (the localhost bind is the security boundary there).

        T-111: the ``forget`` action's fallback role list is ``("admin",)``
        — matching the T-110 behavior — so a module with no ``rbac``
        block keeps admin-only forget. A module that declares
        ``rbac.actions.forget: [operator, admin]`` would also admit
        operators (per-module override).
        """
        actor = user.username if user is not None else "anonymous"
        try:
            await client.forget(memory_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        log.warning(
            "memory forgotten via web: memory=%s reason=%r actor=%s",
            memory_id,
            reason,
            actor,
        )
        flash = f"Memory {memory_id} forgotten (deleted by {actor})."
        return RedirectResponse(
            url=f"/modules/memini-browser?flash={flash}",
            status_code=303,
        )

    @router.get("/modules/memini-browser/memory/{memory_id}/graph", response_class=HTMLResponse)
    @module_route("view_memory")
    async def memory_graph(
        request: Request,
        memory_id: str,
        user: User | None = Depends(_dep("view_memory", ("admin", "operator", "viewer"))),
    ) -> HTMLResponse:
        _ = user  # noqa: F841 — RBAC gate only; read endpoint
        try:
            graph = await client.get_graph(memory_id, depth=1)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        svg = render_memory_graph_svg(graph)
        return _templates.TemplateResponse(
            request,
            "graph_svg.html",
            {
                "svg": svg,
                "root_id": memory_id,
                "entity_count": len(graph.entities),
                "relationship_count": len(graph.relationships),
                "title": f"Graph {memory_id}",
            },
        )

    return router


def _trust_audit_count(client: MeminiClient, memory_id: str) -> int:
    """Best-effort count of recorded trust adjustments for a memory.

    Only :class:`MockMeminiClient` exposes ``trust_audit``; the SDK and PG
    backends don't expose it to the browser in v0.14.0.
    """
    audit = getattr(client, "trust_audit", None)
    if not audit:
        return 0
    return sum(1 for a in audit if a.get("memory_id") == memory_id)


__all__ = ["build_router"]
