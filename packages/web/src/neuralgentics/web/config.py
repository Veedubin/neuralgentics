"""Pydantic settings for neuralgentics-web."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Mode = Literal["embedded", "team-server"]
AuthMode = Literal["off", "jwt", "oauth2"]
RbacMode = Literal["permissive", "strict"]

DEFAULT_EMBEDDED_PORT = 9876
DEFAULT_TEAM_SERVER_PORT = 9877
DEFAULT_EMBEDDED_HOST = "127.0.0.1"
DEFAULT_TEAM_SERVER_HOST = "0.0.0.0"


def _default_modules_path() -> Path:
    """Built-in modules directory: ``neuralgentics/web/modules``."""
    here = Path(__file__).resolve().parent
    return here / "modules"


class AuthConfig(BaseModel):
    """Auth-layer configuration (T-109, OIDC T-112).

    Only consulted in team-server mode — embedded mode is always anonymous
    + localhost-only.
    """

    auth_mode: AuthMode = "jwt"
    """``off`` disables auth entirely (dev only, prints a warning). ``jwt``
    requires Bearer JWT access tokens. ``oauth2`` enables the JWT path
    *plus* the ``/auth/login`` form + refresh-token rotation + OIDC."""

    jwt_secret: str | None = None
    """HS256 shared secret. If unset, a random one is generated per process
    and a loud warning is printed to stderr."""

    db_path: Path = Field(default_factory=lambda: Path.home() / ".neuralgentics" / "web-users.db")
    """SQLite user-store path. Default ``~/.neuralgentics/web-users.db``."""

    refresh_rotation: bool = True
    """Issue a new refresh token on every refresh (revokes the old one)."""

    access_ttl_seconds: int = 24 * 60 * 60
    """Access-token lifetime (default 24h)."""

    refresh_ttl_seconds: int = 7 * 24 * 60 * 60
    """Refresh-token lifetime (default 7d)."""

    # --- T-112: OIDC provider configuration ---
    oidc_github_client_id: str | None = None
    oidc_github_client_secret: str | None = None
    oidc_google_client_id: str | None = None
    oidc_google_client_secret: str | None = None
    oidc_redirect_base: str | None = None
    """Base URL for OIDC callbacks (e.g. ``https://neuralgentics.example.com``).
    The callback URL is ``{redirect_base}/auth/callback/{provider}``."""

    oidc_default_role: str = "viewer"
    """Role assigned to new OIDC users on first login (default: viewer)."""

    oidc_generic_providers: dict[str, dict[str, str]] = Field(default_factory=dict)
    """Generic OIDC providers: ``name`` → ``{discovery_url, client_id,
    client_secret, groups_claim}``. Populated from
    ``--oidc-generic-<name>-discovery-url`` CLI flags."""

    oidc_role_mappings: list[str] = Field(default_factory=list)
    """T-121: raw ``--oidc-role-mapping`` flag values. Each entry is a
    ``PROVIDER:GROUP_PATTERN=ROLE`` rule (or comma-separated list of
    rules). Parsed into :class:`RoleMapping` objects by
    :meth:`OIDCConfig.from_cli`."""

    model_config = {"arbitrary_types_allowed": True}


class WebConfig(BaseModel):
    """Resolved configuration for one server invocation."""

    mode: Mode = "embedded"
    host: str = DEFAULT_EMBEDDED_HOST
    port: int = DEFAULT_EMBEDDED_PORT
    db_url: str | None = None
    modules_path: Path = Field(default_factory=_default_modules_path)
    auth: AuthConfig = Field(default_factory=AuthConfig)
    # T-111: per-module RBAC strictness. ``permissive`` (default, backwards
    # compat) falls back to the global role table when a module's
    # ``module.yaml`` doesn't declare an action in ``rbac.actions``.
    # ``strict`` denies the request with 403 — the manifest is the single
    # source of truth for who-can-do-what in the module.
    rbac_mode: RbacMode = "permissive"

    model_config = {"arbitrary_types_allowed": True}

    @field_validator("modules_path")
    @classmethod
    def _must_exist(cls, v: Path) -> Path:
        if not v.exists():
            raise ValueError(f"modules_path does not exist: {v}")
        if not v.is_dir():
            raise ValueError(f"modules_path is not a directory: {v}")
        return v

    @classmethod
    def from_args(
        cls,
        *,
        mode: str,
        port: int | None,
        host: str | None,
        db_url: str | None,
        modules_path: str | None,
        auth_mode: str | None = None,
        jwt_secret: str | None = None,
        auth_db_path: str | None = None,
        rbac_mode: str | None = None,
        oidc_github_client_id: str | None = None,
        oidc_github_client_secret: str | None = None,
        oidc_google_client_id: str | None = None,
        oidc_google_client_secret: str | None = None,
        oidc_redirect_base: str | None = None,
        oidc_default_role: str | None = None,
        oidc_generic_providers: dict[str, dict[str, str]] | None = None,
        oidc_role_mappings: list[str] | None = None,
    ) -> WebConfig:
        # Env var fallback so the app factory can also be used without CLI args.
        env_mode = os.environ.get("NEURALGENTICS_WEB_MODE", mode)
        if port is None:
            port = int(os.environ.get("NEURALGENTICS_WEB_PORT", 0)) or None
        if host is None:
            host = os.environ.get("NEURALGENTICS_WEB_HOST")
        if db_url is None:
            db_url = os.environ.get("NEURALGENTICS_WEB_DB_URL")
        if modules_path is None:
            modules_path = os.environ.get("NEURALGENTICS_WEB_MODULES_PATH")
        if auth_mode is None:
            auth_mode = os.environ.get("NEURALGENTICS_WEB_AUTH", "jwt")
        if jwt_secret is None:
            jwt_secret = os.environ.get("WEB_JWT_SECRET")
        if auth_db_path is None:
            auth_db_path = os.environ.get("WEB_AUTH_DB_PATH")
        if rbac_mode is None:
            rbac_mode = os.environ.get("NEURALGENTICS_WEB_RBAC_MODE", "permissive")
        if rbac_mode not in ("permissive", "strict"):
            raise ValueError(f"invalid --rbac-mode {rbac_mode!r}; must be 'permissive' or 'strict'")

        resolved_mode: Mode = "team-server" if env_mode == "team-server" else "embedded"

        if port is None:
            port = (
                DEFAULT_TEAM_SERVER_PORT
                if resolved_mode == "team-server"
                else DEFAULT_EMBEDDED_PORT
            )
        if host is None:
            host = (
                DEFAULT_TEAM_SERVER_HOST
                if resolved_mode == "team-server"
                else DEFAULT_EMBEDDED_HOST
            )

        if resolved_mode == "team-server" and not db_url:
            log_msg = (
                "team-server mode without --db-url — PG-backed features will be no-ops "
                "until a DSN is provided"
            )
            # Non-fatal: health endpoint still works, /api/v1/modules works (file-based).
            import logging

            logging.getLogger("neuralgentics.web.config").warning(log_msg)

        if resolved_mode == "team-server" and auth_mode == "off":
            import logging
            import sys

            logging.getLogger("neuralgentics.web.config").warning(
                "team-server mode running with --auth=off — auth DISABLED. Use only in dev."
            )
            print(
                "WARNING: neuralgentics-web team-server running with --auth=off. "
                "Anyone with network access can read/modify data. "
                "Dev-only.",
                file=sys.stderr,
            )

        mp = Path(modules_path) if modules_path else _default_modules_path()
        auth_db = (
            Path(auth_db_path) if auth_db_path else Path.home() / ".neuralgentics" / "web-users.db"
        )

        auth_cfg = AuthConfig(
            auth_mode=auth_mode,  # type: ignore[arg-type]
            jwt_secret=jwt_secret,
            db_path=auth_db,
            oidc_github_client_id=oidc_github_client_id,
            oidc_github_client_secret=oidc_github_client_secret,
            oidc_google_client_id=oidc_google_client_id,
            oidc_google_client_secret=oidc_google_client_secret,
            oidc_redirect_base=oidc_redirect_base,
            oidc_default_role=oidc_default_role or "viewer",
            oidc_generic_providers=oidc_generic_providers or {},
            oidc_role_mappings=oidc_role_mappings or [],
        )

        return cls(
            mode=resolved_mode,
            host=host,
            port=port,
            db_url=db_url,
            modules_path=mp,
            auth=auth_cfg,
            rbac_mode=rbac_mode,  # type: ignore[arg-type]
        )
