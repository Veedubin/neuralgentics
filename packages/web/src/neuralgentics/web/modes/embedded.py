"""Embedded mode — localhost-only, no auth, reads local files.

The same FastAPI app is used in both modes; this module installs an
``off``-mode :class:`AuthMiddleware` so ``request.state.user`` is always
defined (as ``None``) for downstream handlers. Embedded mode binds to
127.0.0.1 only, so the missing auth is fine — the network itself is the
security boundary.
"""

from __future__ import annotations

import logging
from typing import Any

from neuralgentics.web.auth.middleware import AuthMiddleware
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web.embedded")


class EmbeddedMode:
    """Configures the app for embedded mode (localhost, no auth)."""

    NAME = "embedded"

    def __init__(self, config: WebConfig) -> None:
        self.config = config
        # A user store isn't strictly needed in embedded mode, but we
        # build one so the auth middleware has a consistent contract.
        # Tests can override the db_path via config.auth.db_path.
        # T-INSTALL-005: do NOT seed default users in embedded mode —
        # they are unreachable (no /auth/login page is mounted) and the
        # "seeding 3 default users" warning is misleading. The schema is
        # still created so a later switch to team-server mode (same DB
        # path) finds the tables ready.
        self.user_store = UserStore(config.auth.db_path, seed_defaults=False)

    def configure(self, app: Any) -> None:
        """Install an ``off``-mode AuthMiddleware so request.state.user is
        always defined (as None) — downstream handlers + RBAC dependency
        get a consistent contract."""
        app.add_middleware(AuthMiddleware, mode="off", user_store=self.user_store, secret=None)
        log.debug("embedded mode configured (no auth, localhost-only)")

    @property
    def health_payload(self) -> dict[str, Any]:
        return {"status": "ok", "mode": "embedded", "auth_mode": "off"}
