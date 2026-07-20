"""Tests for the gateway-audit SSE broadcaster (unit-level).

Covers:
  * The broadcaster fans out events to multiple subscribers.
  * A late subscriber still receives events appended after it subscribed.

These tests drive the broadcaster + JSONLAuditSource directly (no HTTP),
which is the cleanest way to validate the SSE plumbing without the
httpx-ASGITransport streaming-buffering caveat documented in
``test_gateway_audit_embedded.py``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

from neuralgentics.web.modules.gateway_audit.data_source import (
    AuditEvent,
    JSONLAuditSource,
)
from neuralgentics.web.modules.gateway_audit.sse import AuditBroadcaster


def _event(host: str = "x.com", method: str = "GET") -> AuditEvent:
    from datetime import UTC, datetime

    return AuditEvent(
        timestamp=datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC),
        method=method,
        host=host,
        uri="/",
        decision="allowed",
        reason="",
        client_ip="1.2.3.4",
    )


def test_broadcaster_fans_out_to_multiple_subscribers() -> None:
    """One event from the source reaches every subscriber queue."""
    b = AuditBroadcaster()

    async def _run() -> None:
        # The source iter is a simple async iterator that yields one event.
        async def source() -> AsyncIterator[AuditEvent]:
            yield _event(host="a.com")
            yield _event(host="b.com")

        b.start(source())
        q1 = b.subscribe()
        q2 = b.subscribe()
        e1a = await asyncio.wait_for(q1.get(), timeout=1.0)
        e1b = await asyncio.wait_for(q1.get(), timeout=1.0)
        e2a = await asyncio.wait_for(q2.get(), timeout=1.0)
        e2b = await asyncio.wait_for(q2.get(), timeout=1.0)
        assert e1a.host == "a.com"
        assert e1b.host == "b.com"
        assert e2a.host == "a.com"
        assert e2b.host == "b.com"
        await b.stop()

    asyncio.run(_run())


def test_broadcaster_subscriber_receives_event_after_subscribe() -> None:
    """A subscriber that joins after the source starts still gets new events
    (the broadcaster only pushes events that arrive after subscribe)."""
    b = AuditBroadcaster()

    async def _run() -> None:
        # Source yields one event immediately, then waits for a flag.
        fired = asyncio.Event()

        async def source() -> AsyncIterator[AuditEvent]:
            yield _event(host="early.com")
            await fired.wait()
            yield _event(host="late.com")

        b.start(source())
        # Subscribe AFTER the early event (which has no subscribers yet, so
        # it's dropped — by design: SSE only delivers live events).
        await asyncio.sleep(0.05)
        q = b.subscribe()
        fired.set()
        e = await asyncio.wait_for(q.get(), timeout=1.0)
        assert e.host == "late.com"
        await b.stop()

    asyncio.run(_run())


def test_jsonl_source_polls_for_new_lines(tmp_path: Path) -> None:
    """JSONLAuditSource.subscribe() yields events appended after subscribe()."""
    p = tmp_path / "audit.jsonl"
    p.write_text("")  # empty initially

    async def _run() -> None:
        src = JSONLAuditSource(p, poll_interval=0.1)
        # Pre-populate with one event so recent() works.
        with p.open("a") as fh:
            fh.write(
                json.dumps(
                    {
                        "timestamp": "2026-07-19T12:00:00Z",
                        "method": "GET",
                        "host": "initial.com",
                        "uri": "/",
                        "decision": "allowed",
                        "client_ip": "1.1.1.1",
                    }
                )
                + "\n"
            )
        # recent() sees the initial event.
        recent = await src.recent(limit=10)
        assert len(recent) == 1
        assert recent[0].host == "initial.com"
        # subscribe() — no replay of existing events (per design).
        it = src.subscribe()
        # Append a new event.
        await asyncio.sleep(0.05)
        with p.open("a") as fh:
            fh.write(
                json.dumps(
                    {
                        "timestamp": "2026-07-19T12:01:00Z",
                        "method": "POST",
                        "host": "appended.com",
                        "uri": "/x",
                        "decision": "allowed",
                        "client_ip": "2.2.2.2",
                    }
                )
                + "\n"
            )
        # The iterator should yield the appended event.
        e = await asyncio.wait_for(it.__anext__(), timeout=2.0)
        assert e.host == "appended.com"

    asyncio.run(_run())


def test_audit_event_parses_ts_alias() -> None:
    """AuditEvent.from_jsonl_line accepts either ``timestamp`` or ``ts``."""
    from datetime import UTC, datetime

    e1 = AuditEvent.from_jsonl_line(
        json.dumps(
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "a.com",
            }
        )
    )
    assert e1.timestamp == datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)

    e2 = AuditEvent.from_jsonl_line(
        json.dumps(
            {
                "ts": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "a.com",
            }
        )
    )
    assert e2.timestamp == datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)
