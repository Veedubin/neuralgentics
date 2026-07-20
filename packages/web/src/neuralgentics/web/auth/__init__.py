"""Public API for the neuralgentics-web auth layer (T-109, OIDC T-112).

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
from neuralgentics.web.auth.middleware import AUTH_COOKIE_NAME, AuthMiddleware, AuthMode
from neuralgentics.web.auth.oauth2_stub import AuthError, TokenSet, login, logout, refresh
from neuralgentics.web.auth.oidc import (
    GenericOIDCProvider,
    GitHubProvider,
    GoogleProvider,
    OIDCError,
    OIDCProvider,
    TokenResponse,
    UserInfo,
)
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.oidc_routes import build_oidc_router
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
    "AUTH_COOKIE_NAME",
    # rbac
    "require_role",
    "ROLES",
    # oauth2 stub (local login)
    "TokenSet",
    "AuthError",
    "login",
    "refresh",
    "logout",
    # oidc (T-112)
    "OIDCProvider",
    "GitHubProvider",
    "GoogleProvider",
    "GenericOIDCProvider",
    "OIDCConfig",
    "OIDCError",
    "TokenResponse",
    "UserInfo",
    "build_oidc_router",
    # routes
    "build_auth_router",
]
