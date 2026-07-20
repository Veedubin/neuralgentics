"""Public API for the neuralgentics-web auth layer (T-109).

Importing from this package gives you the small set of objects you need
to wire auth into a FastAPI app — the rest of the modules are internal
implementations.
"""

from __future__ import annotations

from neuralgentics.web.auth.jwt import (
    ACCESS_TTL,
    ALG,
    REFRESH_TTL,
    decode_access_token,
    decode_refresh_token,
    decode_token,
    get_or_create_secret,
    issue_access_token,
    issue_refresh_token,
)
from neuralgentics.web.auth.middleware import AuthMiddleware, AuthMode
from neuralgentics.web.auth.oauth2_stub import AuthError, TokenSet, login, logout, refresh
from neuralgentics.web.auth.rbac import ROLES, require_role
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import DEFAULT_DB_PATH, DEFAULT_USERS, User, UserStore

__all__ = [
    # jwt
    "ALG",
    "ACCESS_TTL",
    "REFRESH_TTL",
    "get_or_create_secret",
    "issue_access_token",
    "issue_refresh_token",
    "decode_token",
    "decode_access_token",
    "decode_refresh_token",
    # users
    "User",
    "UserStore",
    "DEFAULT_DB_PATH",
    "DEFAULT_USERS",
    # middleware
    "AuthMiddleware",
    "AuthMode",
    # rbac
    "require_role",
    "ROLES",
    # oauth2 stub
    "TokenSet",
    "AuthError",
    "login",
    "refresh",
    "logout",
    # routes
    "build_auth_router",
]
