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
        # Schema mirrors the gateway's audit/pgstore.go (T-114.1): the
        # status/duration_ms/error columns are added idempotently so this
        # works on both fresh and pre-T-114.1 databases.
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
                client_ip   TEXT        NOT NULL DEFAULT '',
                status      INTEGER     NOT NULL DEFAULT 0,
                duration_ms INTEGER     NOT NULL DEFAULT 0,
                error       TEXT        NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events (ts DESC);
            """
        )
        # Idempotent column adds for pre-T-114.1 databases.
        await conn.execute(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'audit_events' AND column_name = 'status') THEN
                    ALTER TABLE audit_events ADD COLUMN status INTEGER NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'audit_events'
                               AND column_name = 'duration_ms') THEN
                    ALTER TABLE audit_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'audit_events' AND column_name = 'error') THEN
                    ALTER TABLE audit_events ADD COLUMN error TEXT NOT NULL DEFAULT '';
                END IF;
            END $$;
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


# ----- T-114.2: consumer reads status / duration_ms / error columns -----


async def _insert_row(
    conn: Any,
    *,
    ts: datetime,
    host: str = "pgtest-cols.com",
    method: str = "GET",
    uri: str = "/x",
    decision: str = "allowed",
    reason: str = "",
    client_ip: str = "1.2.3.4",
    status: int | None = None,
    duration_ms: int | None = None,
    error: str | None = None,
) -> None:
    """Insert one row into audit_events with the T-114.1 extended columns.

    ``None`` maps to the gateway's NOT NULL DEFAULT (status=0, duration_ms=0,
    error='') so the test mirrors what the gateway actually writes when a
    field is unset.
    """
    if status is None:
        status = 0
    if duration_ms is None:
        duration_ms = 0
    if error is None:
        error = ""
    await conn.execute(
        "INSERT INTO audit_events "
        "(ts, method, host, uri, decision, reason, client_ip, status, duration_ms, error) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        ts,
        method,
        host,
        uri,
        decision,
        reason,
        client_ip,
        status,
        duration_ms,
        error,
    )


def test_consumer_reads_status_field(pg_dsn: str) -> None:
    """Insert a row with status=200; recent() returns event.status == 200."""

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-cols.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 0, 0, tzinfo=UTC),
                    status=200,
                    host="pgtest-cols.com",
                )
            recent = await src.recent(limit=10)
            assert len(recent) == 1
            assert recent[0].status == 200
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_reads_duration_ms_field(pg_dsn: str) -> None:
    """Insert a row with duration_ms=1234; recent() returns event.duration_ms == 1234."""

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-cols.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 1, 0, tzinfo=UTC),
                    duration_ms=1234,
                    host="pgtest-cols.com",
                )
            recent = await src.recent(limit=10)
            assert len(recent) == 1
            assert recent[0].duration_ms == 1234
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_reads_error_field(pg_dsn: str) -> None:
    """Insert row with error='upstream timeout'; recent() returns matching error."""

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-cols.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 2, 0, tzinfo=UTC),
                    error="upstream timeout",
                    host="pgtest-cols.com",
                )
            recent = await src.recent(limit=10)
            assert len(recent) == 1
            assert recent[0].error == "upstream timeout"
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_handles_null_status(pg_dsn: str) -> None:
    """Insert a row with status=0 (gateway sentinel for 'no upstream status');
    recent() returns event.status is None (consumer normalizes 0 → None).
    """

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-cols.com'")
                # status=None → _insert_row writes the DEFAULT 0
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 3, 0, tzinfo=UTC),
                    status=None,
                    host="pgtest-cols.com",
                )
            recent = await src.recent(limit=10)
            assert len(recent) == 1
            assert recent[0].status is None
            assert recent[0].duration_ms is None
            assert recent[0].error is None
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_status_filter_server_side(pg_dsn: str) -> None:
    """T-114.2: status filter is now pushed to the server (status= column exists).
    Insert rows with status 200 and 404; recent(status=404) returns only the 404.
    """

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-cols.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 10, 0, tzinfo=UTC),
                    status=200,
                    host="pgtest-cols.com",
                )
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 19, 13, 11, 0, tzinfo=UTC),
                    status=404,
                    host="pgtest-cols.com",
                )
            r200 = await src.recent(limit=10, status=200)
            r404 = await src.recent(limit=10, status=404)
            assert len(r200) == 1 and r200[0].status == 200
            assert len(r404) == 1 and r404[0].status == 404
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
