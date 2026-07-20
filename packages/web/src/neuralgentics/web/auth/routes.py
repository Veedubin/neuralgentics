"""FastAPI router for ``/auth/*`` routes (T-109, OIDC added T-112).

Exposes:
  * ``GET  /auth/login``        — HTML login page (local form + OIDC buttons)
  * ``POST /auth/login``        — username + password form → ``TokenSet``
  * ``POST /auth/login/json``   — JSON body variant of login
  * ``POST /auth/refresh``      — refresh_token → new ``TokenSet`` (rotation)
  * ``POST /auth/logout``       — revoke a refresh_token (idempotent, 204)
  * ``GET  /auth/me``           — current user (requires access token)

OIDC routes (``/auth/login/{provider}``, ``/auth/callback/{provider}``,
``/auth/providers``) are added by :mod:`neuralgentics.web.auth.oidc_routes`
when at least one provider is configured.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from neuralgentics.web.auth.jwt import get_or_create_secret
from neuralgentics.web.auth.oauth2_stub import AuthError, login, logout, refresh
from neuralgentics.web.auth.rbac import require_role
from neuralgentics.web.auth.users import User, UserStore

log = logging.getLogger("neuralgentics.web.auth.routes")

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "shell" / "templates"
_templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


def build_auth_router(
    user_store: UserStore,
    secret: str | None = None,
    *,
    oidc_providers: list[dict[str, str]] | None = None,
) -> APIRouter:
    """Construct the ``/auth/*`` APIRouter.

    ``secret`` lets tests inject a fixed JWT secret; production reads
    ``$WEB_JWT_SECRET`` via :func:`~neuralgentics.web.auth.jwt.get_or_create_secret`.

    ``oidc_providers`` is the list of configured OIDC providers (each
    ``{"name": ..., "authorization_url": ...}``) for the login page UI.
    Empty/None = OIDC disabled, login page shows local form only.
    """
    router = APIRouter(prefix="/auth", tags=["auth"])
    _secret = secret if secret is not None else get_or_create_secret()
    providers = oidc_providers or []

    @router.get("/login", response_class=HTMLResponse)
    async def login_page(request: Request) -> HTMLResponse:
        """HTML login page with local form + OIDC buttons (if configured)."""
        return _templates.TemplateResponse(
            request,
            "login.html",
            {"providers": providers, "title": "Login"},
        )

    @router.post("/login")
    async def login_route(
        username: str = Form(...),
        password: str = Form(...),
    ) -> JSONResponse:
        try:
            tokens = login(username=username, password=password, store=user_store, secret=_secret)
        except AuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        return JSONResponse(tokens.as_dict())

    # Also accept JSON bodies — many API clients prefer it over form-data.
    @router.post("/login/json")
    async def login_json_route(payload: dict[str, Any]) -> JSONResponse:
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise HTTPException(status_code=400, detail="missing_fields")
        try:
            tokens = login(username=username, password=password, store=user_store, secret=_secret)
        except AuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        return JSONResponse(tokens.as_dict())

    @router.post("/refresh")
    async def refresh_route(payload: dict[str, Any]) -> JSONResponse:
        refresh_token = payload.get("refresh_token")
        if not isinstance(refresh_token, str):
            raise HTTPException(status_code=400, detail="missing_refresh_token")
        try:
            tokens = refresh(refresh_token=refresh_token, store=user_store, secret=_secret)
        except AuthError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        return JSONResponse(tokens.as_dict())

    @router.post("/logout")
    async def logout_route(payload: dict[str, Any]) -> JSONResponse:
        refresh_token = payload.get("refresh_token")
        if not isinstance(refresh_token, str):
            raise HTTPException(status_code=400, detail="missing_refresh_token")
        logout(refresh_token=refresh_token, store=user_store)
        return JSONResponse({"revoked": True}, status_code=200)

    @router.get("/me")
    async def me_route(
        user: User = Depends(require_role("admin", "operator", "viewer")),
    ) -> JSONResponse:
        return JSONResponse({"username": user.username, "role": user.role})

    return router


__all__ = ["build_auth_router"]
