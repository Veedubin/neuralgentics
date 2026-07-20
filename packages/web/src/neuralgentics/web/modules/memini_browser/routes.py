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

from fastapi import APIRouter, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from jinja2 import ChoiceLoader, Environment, FileSystemLoader

from neuralgentics.web.modules.memini_browser.graph_viz import render_memory_graph_svg
from neuralgentics.web.modules.memini_browser.memini_client import (
    VALID_TRUST_SIGNALS,
    MeminiClient,
)

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


def build_router(client: MeminiClient) -> APIRouter:
    """Construct the memini-browser APIRouter."""
    router = APIRouter(prefix="", tags=["memini-browser"])
    _templates = TEMPLATES

    @router.get("/modules/memini-browser", response_class=HTMLResponse)
    async def search_page(
        request: Request,
        q: str = Query("", description="Free-text search query"),
        limit: int = Query(20, ge=1, le=100),
    ) -> HTMLResponse:
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
    async def api_search(
        q: str = Query("", description="Free-text search query"),
        limit: int = Query(20, ge=1, le=100),
    ) -> JSONResponse:
        results = await client.search(q, limit=limit)
        return JSONResponse(
            {
                "results": [r.model_dump(mode="json") for r in results],
                "count": len(results),
                "q": q,
            }
        )

    @router.get("/modules/memini-browser/memory/{memory_id}", response_class=HTMLResponse)
    async def memory_detail(
        request: Request,
        memory_id: str,
        flash: str = Query("", description="One-shot flash message"),
    ) -> HTMLResponse:
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
    async def adjust_trust(
        memory_id: str,
        signal: str = Form(...),
        reason: str = Form(""),
    ) -> RedirectResponse:
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
            "trust adjusted via web: memory=%s signal=%s reason=%r new=%.3f",
            memory_id,
            signal,
            reason,
            new_trust,
        )
        flash = f"Trust adjusted via '{signal}' → new trust = {new_trust:.3f}"
        return RedirectResponse(
            url=f"/modules/memini-browser/memory/{memory_id}?flash={flash}",
            status_code=303,
        )

    @router.get("/modules/memini-browser/memory/{memory_id}/graph", response_class=HTMLResponse)
    async def memory_graph(
        request: Request,
        memory_id: str,
    ) -> HTMLResponse:
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
