"""Tests for the broker-audit module — team-server mode (PostgreSQL source).

Covers:
  * PGBrokerAuditSource.apply_schema() creates the ``broker_audit_log``
    table + NOTIFY trigger idempotently.
  * PGBrokerAuditSource.recent() reads from the table with filters.
  * PGBrokerAuditSource.subscribe() receives events via LISTEN/NOTIFY
    (the trigger fires automatically on INSERT — no manual NOTIFY
    needed, unlike the gateway-audit module which left the trigger for
    a future patch).

These tests require a live PostgreSQL. They're skipped automatically if
the ``NEURALGENTICS_TEST_PG_URL`` env var isn't set. Set it to run
them, e.g.::

    NEURALGENTICS_TEST_PG_URL=postgresql://user:pw@host:port/db \\
        pytest tests/test_broker_audit_team_server.py -v
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
    """Create a PGBrokerAuditSource, ensure the schema exists, and clean
    test rows.

    Returns the source ready for queries.
    """
    from neuralgentics.web.modules.broker_audit.data_source import (
        PG_TABLE,
        PGBrokerAuditSource,
    )

    src = PGBrokerAuditSource(dsn)
    pool = await src._ensure_pool()  # also applies schema
    async with pool.acquire() as conn:
        # Dedicated prefix so we never touch real broker data.
        await conn.execute(f"DELETE FROM {PG_TABLE} WHERE server LIKE 'pgtest-%'")
    return src


# ----- Test 1: PG apply_schema + recent() + filters -----


def test_pg_apply_schema_and_recent_reads_with_filters(pg_dsn: str) -> None:
    """apply_schema() creates the table + trigger; recent() returns rows
    with filters."""

    async def _body() -> None:
        from neuralgentics.web.modules.broker_audit.data_source import PG_TABLE

        src = await _make_source(pg_dsn)
        try:
            pool = await src._ensure_pool()
            # Verify the table + trigger exist.
            async with pool.acquire() as conn:
                exists = await conn.fetchval("SELECT to_regclass($1)", f"public.{PG_TABLE}")
                assert exists is not None, f"{PG_TABLE} table was not created"
                trig = await conn.fetchval(
                    "SELECT tgname FROM pg_trigger WHERE tgname = 'broker_audit_notify'"
                )
                assert trig == "broker_audit_notify", "NOTIFY trigger was not created"
                # Insert 3 test rows.
                for i in range(3):
                    await conn.execute(
                        f"INSERT INTO {PG_TABLE} "
                        "(ts, agent_role, server, tool, args_hash, success, "
                        "result_size, duration_ms, error) "
                        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                        datetime(2026, 7, 19, 12, i, 0, tzinfo=UTC),
                        "coder" if i % 2 == 0 else "architect",
                        f"pgtest-{i}",
                        "read_file" if i < 2 else "search",
                        "sha256:abc",
                        i != 1,  # row 1 is a failure
                        100 + i,
                        10 + i * 10,
                        "" if i != 1 else "enoent",
                    )
            recent = await src.recent(limit=10)
            assert len(recent) == 3
            # Newest first.
            assert recent[0].server == "pgtest-2"
            # Filter by tool.
            r_tool = await src.recent(limit=10, tool="read_file")
            assert len(r_tool) == 2
            assert all(e.tool == "read_file" for e in r_tool)
            # Filter by server.
            r_srv = await src.recent(limit=10, server="pgtest-1")
            assert len(r_srv) == 1
            assert r_srv[0].server == "pgtest-1"
            # Filter by role.
            r_role = await src.recent(limit=10, role="architect")
            assert len(r_role) == 1
            assert r_role[0].agent_role == "architect"
            # Filter by success.
            r_fail = await src.recent(limit=10, success=False)
            assert len(r_fail) == 1
            assert r_fail[0].error == "enoent"
            r_ok = await src.recent(limit=10, success=True)
            assert len(r_ok) == 2
            # Filter by since.
            r_since = await src.recent(limit=10, since=datetime(2026, 7, 19, 12, 1, 0, tzinfo=UTC))
            assert len(r_since) == 2
        finally:
            await src.close()

    asyncio.run(_body())


# ----- Test 2: PG LISTEN/NOTIFY (trigger fires on INSERT) -----


def test_pg_subscribe_receives_notify_via_trigger(pg_dsn: str) -> None:
    """INSERT into broker_audit_log → the trigger NOTIFYs → subscribe()
    iterator yields the event within 2s.

    Unlike the gateway-audit module (which left the NOTIFY trigger for a
    future patch and required a manual ``NOTIFY`` in tests), T-107 ships
    the trigger as part of apply_schema() — so a plain INSERT is enough.
    """
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        asyncio.set_event_loop_policy(None)

    dsn = os.environ["NEURALGENTICS_TEST_PG_URL"]

    async def _body() -> None:
        from neuralgentics.web.modules.broker_audit.data_source import PG_TABLE

        src = await _make_source(dsn)
        try:
            it = src.subscribe()
            recv_task = asyncio.ensure_future(it.__anext__())
            await asyncio.sleep(0.3)  # let LISTEN register
            pool = await src._ensure_pool()
            async with pool.acquire() as conn:
                # Plain INSERT — the trigger NOTIFYs automatically.
                await conn.execute(
                    f"INSERT INTO {PG_TABLE} "
                    "(ts, agent_role, server, tool, args_hash, success, "
                    "result_size, duration_ms, error) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                    datetime(2026, 7, 19, 12, 30, 0, tzinfo=UTC),
                    "coder",
                    "pgtest-notify",
                    "write_file",
                    "sha256:xyz",
                    False,
                    None,
                    99,
                    "permission denied",
                )
            e = await asyncio.wait_for(recv_task, timeout=3.0)
            assert e.server == "pgtest-notify"
            assert e.tool == "write_file"
            assert e.success is False
            assert e.error == "permission denied"
        finally:
            await src.close()

    asyncio.run(_body())
