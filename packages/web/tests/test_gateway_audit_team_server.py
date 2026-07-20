"""Tests for the gateway-audit module — team-server mode (PostgreSQL source).

Covers:
  * PGAuditSource.recent() reads from the ``audit_events`` table with filters.
  * PGAuditSource.subscribe() receives events via LISTEN/NOTIFY.

These tests require a live PostgreSQL. They're skipped automatically if the
``NEURALGENTICS_TEST_PG_URL`` env var isn't set. Set it to run them, e.g.::

    NEURALGENTICS_TEST_PG_URL=postgresql://user:pw@host:port/db \\
        pytest tests/test_gateway_audit_team_server.py -v
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from typing import Any

import pytest

pg_url = os.environ.get("NEURALGENTICS_TEST_PG_URL")

# Skip the whole module if PG isn't configured.
pytestmark = pytest.mark.skipif(
    pg_url is None,
    reason="Set NEURALGENTICS_TEST_PG_URL to run team-server (PG) tests",
)


@pytest.fixture
def pg_dsn() -> str:
    """The configured test PG DSN."""
    return pg_url  # type: ignore[return-value]


async def _make_source(dsn: str) -> Any:
    """Create a PGAuditSource, ensure the schema exists, and clean test rows.

    Returns the source ready for queries.
    """
    from neuralgentics.web.modules.gateway_audit.data_source import PGAuditSource

    src = PGAuditSource(dsn)
    pool = await src._ensure_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_events (
                id          BIGSERIAL PRIMARY KEY,
                ts          TIMESTAMPTZ NOT NULL,
                method      TEXT        NOT NULL,
                host        TEXT        NOT NULL,
                uri         TEXT        NOT NULL DEFAULT '',
                decision    TEXT        NOT NULL,
                reason      TEXT        NOT NULL DEFAULT '',
                client_ip   TEXT        NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events (ts DESC);
            """
        )
        # Dedicated prefix so we never touch real gateway data.
        await conn.execute("DELETE FROM audit_events WHERE host LIKE 'pgtest-%'")
    return src


# ----- Test 1: PG recent() + filters -----


def test_pg_recent_reads_with_filters(pg_dsn: str) -> None:
    """Insert 3 rows into audit_events; recent() returns them with filters."""

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                for i in range(3):
                    await conn.execute(
                        "INSERT INTO audit_events (ts, method, host, uri, "
                        "decision, reason, client_ip) "
                        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                        datetime(2026, 7, 19, 12, i, 0, tzinfo=UTC),
                        "GET",
                        f"pgtest-{i}.com",
                        f"/r{i}",
                        "allowed",
                        "",
                        "1.2.3.4",
                    )
            recent = await src.recent(limit=10)
            assert len(recent) == 3
            assert recent[0].host == "pgtest-2.com"
            r2 = await src.recent(limit=10, domain="pgtest-1")
            assert len(r2) == 1
            assert r2[0].host == "pgtest-1.com"
            r3 = await src.recent(limit=10, since=datetime(2026, 7, 19, 12, 1, 0, tzinfo=UTC))
            assert len(r3) == 2
            r4 = await src.recent(limit=10, until=datetime(2026, 7, 19, 12, 1, 0, tzinfo=UTC))
            assert len(r4) == 2
        finally:
            await src.close()

    asyncio.run(_body())


# ----- Test 2: PG LISTEN/NOTIFY -----


def test_pg_subscribe_receives_notify() -> None:
    """INSERT + NOTIFY → subscribe() iterator yields the event within 2s.

    Uses a dedicated event loop (asyncio.run) instead of pytest-asyncio's
    managed loop. pytest-asyncio auto-mode installs a custom event-loop
    policy that interferes with async-generator tasks scheduled via
    asyncio.ensure_future; resetting the policy + asyncio.run keeps the
    test hermetic.
    """
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        asyncio.set_event_loop_policy(None)
    from neuralgentics.web.modules.gateway_audit.data_source import NOTIFY_CHANNEL

    dsn = os.environ["NEURALGENTICS_TEST_PG_URL"]

    async def _body() -> None:
        src = await _make_source(dsn)
        try:
            it = src.subscribe()
            recv_task = asyncio.ensure_future(it.__anext__())
            await asyncio.sleep(0.3)
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "INSERT INTO audit_events (ts, method, host, uri, decision, reason, client_ip) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                    datetime(2026, 7, 19, 12, 30, 0, tzinfo=UTC),
                    "POST",
                    "pgtest-notify.com",
                    "/n",
                    "denied",
                    "policy",
                    "9.9.9.9",
                )
                row_id = row["id"]
                await conn.execute(f"NOTIFY {NOTIFY_CHANNEL}, '{row_id}'")
            e = await asyncio.wait_for(recv_task, timeout=3.0)
            assert e.host == "pgtest-notify.com"
            assert e.decision == "denied"
        finally:
            await src.close()

    asyncio.run(_body())
