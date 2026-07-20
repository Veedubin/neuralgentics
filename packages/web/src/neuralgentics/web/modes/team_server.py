"""Team-server mode — JWT+OAuth2 auth (T-109), PostgreSQL-backed (T-112 OIDC).

For T-105 we wired the *shape*: health endpoint reports ``mode: team-server``
and a PG connection opens if ``--db-url`` is set. T-109 adds the auth
layer:

  * ``AuthMiddleware`` is installed unless ``auth_mode == "off"``.
  * The ``/auth/*`` router is included (login/refresh/logout/me + OIDC
    login/callback/providers when configured).
  * A :class:`UserStore` (SQLite) is created at app-build time and shared
    via ``app.state.user_store`` so module routes can use the RBAC
    dependency if they want to.

T-112 adds the OIDC router (``/auth/login/{provider}``,
``/auth/callback/{provider}``, ``/auth/providers``) when at least one
provider is configured via CLI flags.

Embedded mode is intentionally untouched — it stays anonymous and
localhost-only.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from neuralgentics.web.auth.jwt import get_or_create_secret
from neuralgentics.web.auth.middleware import AuthMiddleware
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.oidc_routes import build_oidc_router
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web.team_server")


class TeamServerMode:
    """Configures the app for team-server mode (auth + PG)."""

    NAME = "team-server"

    def __init__(self, config: WebConfig) -> None:
        self.config = config
        self._pg_pool: Any = None
        # T-122: the asyncio task running the OIDC refresh loop. Created
        # in configure_async (lifespan startup) and cancelled in
        # shutdown_async (lifespan shutdown). None when OIDC is disabled
        # (start_refresh_loop is a no-op and returns immediately, so no
        # task is created) or before the lifespan has run.
        self._refresh_task: Any = None
        # Build the user store once at app construction — the schema is
        # tiny and the default-user seeding must run before any request.
        self.user_store = UserStore(config.auth.db_path)
        # JWT secret: explicit config > $WEB_JWT_SECRET (already read in
        # from_args) > generate-and-warn.
        self.jwt_secret: str = (
            config.auth.jwt_secret if config.auth.jwt_secret else get_or_create_secret()
        )
        # T-112: build the OIDC config from CLI flags.
        self.oidc_config = OIDCConfig.from_cli(
            github_client_id=config.auth.oidc_github_client_id,
            github_client_secret=config.auth.oidc_github_client_secret,
            google_client_id=config.auth.oidc_google_client_id,
            google_client_secret=config.auth.oidc_google_client_secret,
            generic_providers=config.auth.oidc_generic_providers,
            redirect_base=config.auth.oidc_redirect_base or "",
            default_role=config.auth.oidc_default_role,
            role_mappings=config.auth.oidc_role_mappings,
        )

    def configure(self, app: Any) -> None:
        """Install auth middleware + /auth router on the FastAPI app.

        Called synchronously from the lifespan (or directly for tests).
        """
        auth_mode = self.config.auth.auth_mode
        if auth_mode == "off":
            log.warning("team-server mode with --auth=off: no auth middleware installed")
            # Still install a pass-through middleware so request.state.user
            # is always defined — downstream handlers can rely on it.
            app.add_middleware(
                AuthMiddleware, mode="off", user_store=self.user_store, secret=self.jwt_secret
            )
        else:
            app.add_middleware(
                AuthMiddleware,
                mode=auth_mode,
                user_store=self.user_store,
                secret=self.jwt_secret,
            )

        # T-112: build the OIDC provider list for the login page UI.
        oidc_providers = [
            {"name": p.name, "authorization_url": p.authorization_url}
            for p in self.oidc_config.providers.values()
        ]
        # /auth/login (HTML), /auth/login (POST), /auth/refresh, /auth/logout,
        # /auth/me — always mounted; the middleware whitelists them.
        app.include_router(
            build_auth_router(
                self.user_store,
                secret=self.jwt_secret,
                oidc_providers=oidc_providers,
            )
        )

        # T-112: OIDC routes (login/{provider}, callback/{provider},
        # providers). Returns an empty router when OIDC is disabled.
        app.include_router(
            build_oidc_router(
                user_store=self.user_store,
                oidc_config=self.oidc_config,
                secret=self.jwt_secret,
            )
        )

        # Expose the user store on app.state so module routes can use it
        # via Depends(require_role(...)) — they read request.state.user
        # which the middleware populates.
        app.state.user_store = self.user_store
        app.state.jwt_secret = self.jwt_secret
        app.state.oidc_config = self.oidc_config

    async def configure_async(self, app: Any) -> None:
        """Lifespan-time hook: open the PG pool if a DSN was provided.

        The auth middleware + /auth router are installed synchronously at
        app-build time by :meth:`configure`; this async hook only opens
        the PG pool (and is safe to call when there's no DSN — it no-ops).

        T-122: also starts the OIDC refresh-token background loop when
        OIDC is enabled. The loop runs forever (5-min ticks) and is
        cancelled in :meth:`shutdown_async`.
        """
        # T-122: start the refresh loop. start_refresh_loop is a no-op
        # (returns immediately) when OIDC is disabled, so we don't even
        # need to gate on oidc_config.enabled here — but we do gate so
        # the log line is accurate.
        if self.oidc_config.enabled:
            import asyncio

            from neuralgentics.web.auth.refresh import start_refresh_loop

            self._refresh_task = asyncio.create_task(
                start_refresh_loop(
                    store=self.user_store,
                    oidc_config=self.oidc_config,
                )
            )
            log.info("team-server: OIDC refresh loop started")

        if not self.config.db_url:
            log.warning("team-server mode started without --db-url — PG features disabled")
            return
        try:
            import asyncpg
        except ImportError:
            log.error(
                "asyncpg not installed — install with: pip install neuralgentics-web[team-server]"
            )
            return
        self._pg_pool = await asyncpg.create_pool(self.config.db_url, min_size=1, max_size=4)
        log.info("team-server PG pool opened against %s", _redact_dsn(self.config.db_url))

    async def shutdown_async(self) -> None:
        # T-122: cancel the refresh loop first so it doesn't try to use
        # the user store / provider clients while we're tearing down.
        if self._refresh_task is not None:
            self._refresh_task.cancel()
            with contextlib.suppress(Exception):  # noqa: BLE001 — CancelledError + any tick error
                await self._refresh_task
            self._refresh_task = None
            log.info("team-server: OIDC refresh loop stopped")
        if self._pg_pool is not None:
            await self._pg_pool.close()
            self._pg_pool = None
            log.info("team-server PG pool closed")

    @property
    def health_payload(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "mode": "team-server",
            "db_connected": self._pg_pool is not None,
            "auth_mode": self.config.auth.auth_mode,
            "users_seeded": len(self.user_store.list_users()),
        }


def _redact_dsn(dsn: str) -> str:
    """Strip the password from a postgres DSN for safe logging."""
    if "@" not in dsn or "://" not in dsn:
        return dsn
    scheme_and_rest = dsn.split("://", 1)
    if len(scheme_and_rest) != 2:
        return dsn
    scheme, rest = scheme_and_rest
    if "@" not in rest:
        return dsn
    creds, host_part = rest.rsplit("@", 1)
    if ":" in creds:
        user, _pw = creds.split(":", 1)
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host_part}"
