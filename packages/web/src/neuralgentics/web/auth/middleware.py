"""FastAPI middleware that extracts + validates a Bearer JWT (T-109,
OIDC cookie support T-112).

Three modes (matching the ``--auth`` CLI flag):

  * ``off``    — every request gets ``request.state.user = None`` and is
                  allowed through. Use only in dev.
  * ``jwt``    — requires ``Authorization: Bearer <access-jwt>``. Used by
                  API clients (curl, scripts, other services).
  * ``oauth2`` — same as ``jwt`` for protected routes, but the OAuth2
                  login form (``/auth/login``) is also enabled. T-112 also
                  enables OIDC provider login + callback routes.

Token sources (T-112): the middleware accepts either
  * ``Authorization: Bearer <jwt>`` header (API clients), OR
  * ``ng_auth`` cookie (browser sessions after OIDC login).
The header wins if both are present.

Auth-public paths (always allowed without a token):
  * ``/auth/login``, ``/auth/login/{provider}``, ``/auth/callback/{provider}``,
    ``/auth/providers``, ``/auth/refresh``, ``/auth/logout``
  * ``/api/v1/health``
  * ``/``  and ``/static/*`` (the shell is rendered even without auth so
    the user can see the login form — but every API call is still gated)

The middleware attaches the resolved :class:`User` to
``request.state.user`` so downstream handlers + the
:func:`~neuralgentics.web.auth.rbac.require_role` dependency can read it.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from neuralgentics.web.auth.jwt import decode_access_token
from neuralgentics.web.auth.users import User, UserStore

log = logging.getLogger("neuralgentics.web.auth.middleware")

AuthMode = Literal["off", "jwt", "oauth2"]

# Paths that are always reachable without a token. Kept prefix-based so
# ``/static/anything`` is whitelisted. T-112 adds the OIDC callback/login
# paths so the IdP redirect + the authorize redirect don't require a token.
PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/auth/login",
    "/auth/callback",
    "/auth/providers",
    "/auth/refresh",
    "/auth/logout",
    "/api/v1/health",
    "/static/",
    "/docs",
    "/openapi.json",
    "/redoc",
)

# The shell index itself — anonymous access so the login form can render.
# (Everything substantive under /api/v1/* and /modules/* is still gated.)
PUBLIC_EXACT_PATHS: frozenset[str] = frozenset({"/"})

# Cookie name that carries the JWT after OIDC login (T-112).
AUTH_COOKIE_NAME = "ng_auth"


def _is_public(path: str) -> bool:
    if path in PUBLIC_EXACT_PATHS:
        return True
    return any(path.startswith(p) for p in PUBLIC_PATH_PREFIXES)


def _unauthorized(detail: str, *, www_authenticate: bool = True) -> JSONResponse:
    headers: dict[str, str] = {}
    if www_authenticate:
        headers["WWW-Authenticate"] = 'Bearer realm="neuralgentics-web"'
    return JSONResponse({"error": detail}, status_code=401, headers=headers)


def _extract_token(request: Request) -> str | None:
    """Pull the JWT from the Authorization header or the ``ng_auth`` cookie.

    Header wins if both are present (API clients should use the header).
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.removeprefix("Bearer ").strip()
    cookie = request.cookies.get(AUTH_COOKIE_NAME)
    if cookie:
        return cookie
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """Attach ``request.state.user`` based on a Bearer JWT or auth cookie.

    Constructed once at app build time and shared across requests.
    """

    def __init__(
        self,
        app: Any,
        *,
        mode: AuthMode = "jwt",
        user_store: UserStore,
        secret: str | None = None,
    ) -> None:
        super().__init__(app)
        if mode not in ("off", "jwt", "oauth2"):
            raise ValueError(f"invalid auth mode: {mode!r}")
        self.mode: AuthMode = mode
        self.user_store = user_store
        self.secret = secret

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        if self.mode == "off":
            request.state.user = None
            off_response: Response = await call_next(request)
            return off_response

        path = request.url.path

        if _is_public(path):
            request.state.user = None
            public_response: Response = await call_next(request)
            return public_response

        token = _extract_token(request)
        if not token:
            return _unauthorized("missing_token")

        try:
            payload = decode_access_token(token, secret=self.secret)
        except jwt.ExpiredSignatureError:
            return _unauthorized("expired_token")
        except jwt.InvalidTokenError:
            return _unauthorized("invalid_token")

        username = payload.get("sub")
        if not isinstance(username, str):
            return _unauthorized("invalid_token")

        user: User | None = self.user_store.get_by_username(username)
        if user is None:
            return _unauthorized("unknown_user")

        request.state.user = user
        authed_response: Response = await call_next(request)
        return authed_response


__all__ = ["AuthMiddleware", "AuthMode", "AUTH_COOKIE_NAME"]
