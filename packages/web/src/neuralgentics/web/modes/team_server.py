"""Team-server mode — JWT+OAuth2 auth (T-109), PostgreSQL-backed.

For T-105 we only wire the *shape*: the health endpoint reports
``mode: team-server`` and a PG connection is opened if ``--db-url`` is set.
Real auth (T-109), real audit-table queries (T-106/107/108), and
federation are out of scope for this card.
"""

from __future__ import annotations

import logging
from typing import Any

from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web.team_server")


class TeamServerMode:
    """Configures the app for team-server mode (auth + PG)."""

    NAME = "team-server"

    def __init__(self, config: WebConfig) -> None:
        self.config = config
        self._pg_pool: Any = None

    async def configure_async(self, app: Any) -> None:
        """Lifespan-time hook: open the PG pool if a DSN was provided."""
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
