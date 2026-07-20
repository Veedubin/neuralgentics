"""Tests for the gateway-audit consumer reading the ``policy_sid`` column.

T-152: T-151 added the ``policy_sid`` column to the gateway's PG schema and
writes to it on every policy deny. This test file verifies the *consumer* side
(PGAuditSource) reads that column and surfaces it on :class:`AuditEvent`.

These tests require a live PostgreSQL. They're skipped automatically if the
``NEURALGENTICS_TEST_PG_URL`` env var isn't set (same convention as
``test_gateway_audit_team_server.py``)::

    NEURALGENTICS_TEST_PG_URL=postgresql://user:pw@host:port/db \\
        pytest tests/test_gateway_audit_consumer.py -v

Convention verified here (matches the existing ``error='' -> None`` pattern
from T-114.2):

* ``policy_sid`` column is ``TEXT NOT NULL DEFAULT ''`` in the gateway
  schema (T-151). Empty string = no policy statement matched (legacy allowlist
  path or no policy evaluator installed).
* Consumer normalizes empty string to ``None`` on read, so callers can
  distinguish "no policy applied" from a real SID without inspecting the
  sentinel themselves.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from typing import Any

import pytest

pg_url = os.environ.get("NEURALGENTICS_TEST_PG_URL")

pytestmark = pytest.mark.skipif(
    pg_url is None,
    reason="Set NEURALGENTICS_TEST_PG_URL to run team-server (PG) tests",
)


@pytest.fixture
def pg_dsn() -> str:
    """The configured test PG DSN."""
    return pg_url  # type: ignore[return-value]


async def _make_source(dsn: str) -> Any:
    """Create a PGAuditSource, ensure the schema (incl. policy_sid) exists.

    Mirrors the helper in ``test_gateway_audit_team_server.py`` but adds
    the T-151 ``policy_sid`` column idempotently so the tests work on both
    pre-T-151 and post-T-151 databases.
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
                client_ip   TEXT        NOT NULL DEFAULT '',
                status      INTEGER     NOT NULL DEFAULT 0,
                duration_ms INTEGER     NOT NULL DEFAULT 0,
                error       TEXT        NOT NULL DEFAULT '',
                policy_sid  TEXT        NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events (ts DESC);
            """
        )
        # Idempotent column adds for older databases.
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
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'audit_events'
                               AND column_name = 'policy_sid') THEN
                    ALTER TABLE audit_events ADD COLUMN policy_sid TEXT NOT NULL DEFAULT '';
                END IF;
            END $$;
            """
        )
        # Dedicated prefix so we never touch real gateway data.
        await conn.execute("DELETE FROM audit_events WHERE host LIKE 'pgtest-sid-%'")
        # Also clean up rows left by other test files that share the same DB
        # (the existing test_gateway_audit_team_server.py uses host='pgtest-cols.com'
        # and 'pgtest-notify.com' without filtering recent() by host, which makes
        # the shared test DB accumulate rows across runs). We don't touch those
        # rows — we just filter our own recent() calls by domain below.
    return src


async def _insert_row(
    conn: Any,
    *,
    ts: datetime,
    host: str = "pgtest-sid.com",
    method: str = "GET",
    uri: str = "/x",
    decision: str = "denied",
    reason: str = "iam-deny",
    client_ip: str = "1.2.3.4",
    status: int = 0,
    duration_ms: int = 0,
    error: str = "",
    policy_sid: str = "",
) -> None:
    """Insert one row with the T-151 extended column set (incl. policy_sid).

    Defaults mirror the gateway's NOT NULL DEFAULT values so the test
    matches what the gateway actually writes when a field is unset.
    """
    await conn.execute(
        "INSERT INTO audit_events "
        "(ts, method, host, uri, decision, reason, client_ip, "
        "status, duration_ms, error, policy_sid) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
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
        policy_sid,
    )


# ----- T-152: consumer reads the policy_sid column -----


def test_consumer_reads_policy_sid_field(pg_dsn: str) -> None:
    """Insert a row with policy_sid='deny-foo'; recent() surfaces it on the
    AuditEvent so the dashboard can show which policy statement fired.
    """

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-sid.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 20, 10, 0, 0, tzinfo=UTC),
                    policy_sid="deny-foo",
                    host="pgtest-sid.com",
                )
            recent = await src.recent(limit=10, domain="pgtest-sid")
            assert len(recent) == 1
            assert recent[0].policy_sid == "deny-foo"
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_handles_empty_policy_sid(pg_dsn: str) -> None:
    """Insert a row with policy_sid='' (legacy / no policy match); recent()
    returns ``event.policy_sid is None`` — the consumer normalizes the
    empty-string sentinel to None, matching the existing ``error='' → None``
    convention from T-114.2.
    """

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-sid.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 20, 10, 1, 0, tzinfo=UTC),
                    policy_sid="",  # legacy / no match
                    host="pgtest-sid.com",
                )
            recent = await src.recent(limit=10, domain="pgtest-sid")
            assert len(recent) == 1
            assert recent[0].policy_sid is None
        finally:
            await src.close()

    asyncio.run(_body())


def test_consumer_filters_by_policy_sid(pg_dsn: str) -> None:
    """T-152: ``recent(policy_sid=...)`` pushes the filter server-side.
    Insert rows with two different SIDs; filtering returns only the
    matching SID.
    """

    async def _body() -> None:
        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM audit_events WHERE host = 'pgtest-sid.com'")
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 20, 10, 2, 0, tzinfo=UTC),
                    policy_sid="deny-foo",
                    host="pgtest-sid.com",
                )
                await _insert_row(
                    conn,
                    ts=datetime(2026, 7, 20, 10, 3, 0, tzinfo=UTC),
                    policy_sid="deny-bar",
                    host="pgtest-sid.com",
                )
            r_foo = await src.recent(limit=10, domain="pgtest-sid", policy_sid="deny-foo")
            assert len(r_foo) == 1
            assert r_foo[0].policy_sid == "deny-foo"
            r_bar = await src.recent(limit=10, domain="pgtest-sid", policy_sid="deny-bar")
            assert len(r_bar) == 1
            assert r_bar[0].policy_sid == "deny-bar"
            # No policy_sid filter, just domain → both rows.
            r_all = await src.recent(limit=10, domain="pgtest-sid")
            assert len(r_all) == 2
        finally:
            await src.close()

    asyncio.run(_body())
