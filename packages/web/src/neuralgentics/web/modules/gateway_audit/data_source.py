"""Data sources for the gateway-audit module.

Two concrete implementations:

* :class:`JSONLAuditSource` — embedded mode. Reads a JSONL file written by
  the gateway's ``audit/logger.go`` MemStore fallback (or any compatible
  writer). Polls the file's mtime/size every ``poll_interval`` seconds and
  emits any newly-appended lines as :class:`AuditEvent` objects.

* :class:`PGAuditSource` — team-server mode. Reads from the gateway's
  ``audit_events`` PostgreSQL table (schema defined in
  ``neuralgentics-gateway/audit/pgstore.go``) and listens on the
  ``gateway_audit_new`` NOTIFY channel for real-time push.

The gateway's actual ``audit.Event`` JSON shape (from
``neuralgentics-gateway/audit/logger.go``)::

    {"timestamp":"2026-07-19T12:34:56Z","method":"GET","host":"api.github.com",
     "uri":"/repos/...","decision":"allowed|denied","reason":"...",
     "client_ip":"10.0.0.4"}

We also accept the richer JSONL shape described in T-106 (with ``status``,
``bytes_sent``, ``bytes_received``, ``duration_ms``) — those fields are
optional and default to ``None``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

from neuralgentics.web._softimports import import_asyncpg

log = logging.getLogger("neuralgentics.web.gateway_audit")

# PG NOTIFY channel the gateway emits on after every INSERT. The gateway's
# audit.PGStore does not emit NOTIFY today (T-104 left that for a later card);
# PGAuditSource still LISTENs and works for tests that inject rows + NOTIFY
# directly. A future gateway patch adds a `NOTIFY gateway_audit_new` trigger.
NOTIFY_CHANNEL = "gateway_audit_new"

# The gateway's actual PG table (see neuralgentics-gateway/audit/pgstore.go).
PG_TABLE = "audit_events"


class AuditEvent(BaseModel):
    """One gateway audit event.

    Mirrors the gateway's ``audit.Event`` Go struct. Extra optional fields
    (``status``, ``bytes_sent``, ``bytes_received``, ``duration_ms``) come
    from the T-106 JSONL spec and are tolerated when absent.
    """

    timestamp: datetime
    method: str
    host: str
    uri: str = ""
    decision: str = "allowed"
    reason: str = ""
    client_ip: str = ""

    # Extended fields (T-106 JSONL spec). Optional — not emitted by the
    # gateway today, but tolerated when present.
    status: int | None = None
    bytes_sent: int | None = None
    bytes_received: int | None = None
    duration_ms: int | None = None
    # T-114.1: gateway's audit_events table now stores an upstream error
    # string per row (empty string when there was no error). Mirrored here
    # so the T-118 charts can surface it.
    error: str | None = None
    # T-151 / T-152: gateway's audit_events table stores the SID of the IAM
    # statement that matched on a deny (empty string when no IAM evaluator
    # was installed or no policy matched — the legacy allowlist path).
    # Mirrored here so the dashboard can surface which policy fired.
    policy_sid: str | None = None

    model_config = {"extra": "ignore"}

    @classmethod
    def from_jsonl_line(cls, line: str) -> AuditEvent:
        """Parse one JSONL line into an AuditEvent.

        Tolerates either the gateway's ``timestamp`` field name or the
        T-106 spec's ``ts`` field name; normalizes to ``timestamp``.
        """
        raw: dict[str, Any] = json.loads(line)
        if "ts" in raw and "timestamp" not in raw:
            raw["timestamp"] = raw["ts"]
        return cls.model_validate(raw)

    def row_tuple(self) -> tuple[str, str, str, str, str, str, str]:
        """Compact tuple for the HTML table row (7 visible columns)."""
        ts = self.timestamp.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")
        return (ts, self.method, self.host, self.uri, self.decision, self.reason, self.client_ip)


class AuditDataSource(Protocol):
    """Abstract audit data source."""

    async def recent(
        self,
        *,
        limit: int = 100,
        domain: str | None = None,
        status: int | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        policy_sid: str | None = None,
    ) -> list[AuditEvent]: ...

    def subscribe(self) -> AsyncIterator[AuditEvent]: ...


def _passes_filter(
    e: AuditEvent,
    *,
    domain: str | None,
    status: int | None,
    since: datetime | None,
    until: datetime | None,
    policy_sid: str | None = None,
) -> bool:
    """Client-side filter predicate used by JSONLAuditSource."""
    if domain is not None and domain not in e.host:
        return False
    if status is not None and e.status is not None and e.status != status:
        return False
    if status is not None and e.status is None:
        # The gateway doesn't populate `status`; treat a None status as a
        # non-match when the caller asked for a specific status code.
        return False
    if since is not None and e.timestamp < since:
        return False
    if until is not None and e.timestamp > until:
        return False
    return policy_sid is None or e.policy_sid == policy_sid


class JSONLAuditSource:
    """Reads audit events from a JSONL file (embedded mode).

    The file is one JSON object per line. We keep the whole file in memory
    (audit logs are bounded — the gateway rotates them). ``subscribe()``
    polls the file's mtime/size every ``poll_interval`` seconds and yields
    any newly-appended lines.
    """

    def __init__(self, path: Path, poll_interval: float = 1.0) -> None:
        self.path = path
        self.poll_interval = poll_interval
        self._events: list[AuditEvent] = []
        self._read_offset: int = 0
        self._loaded = False
        self._subscribe_queue: asyncio.Queue[AuditEvent] = asyncio.Queue()

    def _load_existing(self) -> None:
        """Read the entire file once at startup."""
        if self._loaded:
            return
        self._loaded = True
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = AuditEvent.from_jsonl_line(line)
                except Exception as exc:  # noqa: BLE001 — log+skip bad lines
                    log.warning("JSONL parse error in %s: %s", self.path, exc)
                    continue
                self._events.append(e)
        self._read_offset = self.path.stat().st_size if self.path.exists() else 0

    def _poll_new(self) -> list[AuditEvent]:
        """Read any lines appended since the last poll. Returns new events."""
        if not self.path.exists():
            return []
        try:
            st = self.path.stat()
        except OSError:
            return []
        if st.st_size < self._read_offset:
            # File was truncated/rotated — reset.
            self._read_offset = 0
            self._events = []
        if st.st_size == self._read_offset:
            return []
        new_events: list[AuditEvent] = []
        with self.path.open("r", encoding="utf-8") as fh:
            fh.seek(self._read_offset)
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = AuditEvent.from_jsonl_line(line)
                except Exception as exc:  # noqa: BLE001
                    log.warning("JSONL parse error in %s: %s", self.path, exc)
                    continue
                self._events.append(e)
                new_events.append(e)
            self._read_offset = fh.tell()
        return new_events

    async def recent(
        self,
        *,
        limit: int = 100,
        domain: str | None = None,
        status: int | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        policy_sid: str | None = None,
    ) -> list[AuditEvent]:
        """Return the last ``limit`` events matching the filters, newest first."""
        self._load_existing()
        filtered = [
            e
            for e in self._events
            if _passes_filter(
                e,
                domain=domain,
                status=status,
                since=since,
                until=until,
                policy_sid=policy_sid,
            )
        ]
        return list(reversed(filtered[-limit:]))

    def subscribe(self) -> AsyncIterator[AuditEvent]:
        """Async iterator that polls the file and yields newly-appended events."""
        self._load_existing()
        return self._subscribe_iter()

    async def _subscribe_iter(self) -> AsyncIterator[AuditEvent]:
        # Emit any existing events first so late subscribers see current state.
        # (SSE consumers usually want a fresh snapshot, not a live-only stream;
        # the audit_table.html template renders the snapshot separately and
        # the SSE stream only delivers *new* events. So we DO NOT replay here.)
        while True:
            new = self._poll_new()
            for e in new:
                yield e
            await asyncio.sleep(self.poll_interval)


class PGAuditSource:
    """Reads audit events from PostgreSQL (team-server mode).

    Uses the gateway's ``audit_events`` table. Real-time push is via
    LISTEN/NOTIFY on the ``gateway_audit_new`` channel. The gateway does
    not yet emit that NOTIFY (a future patch adds a trigger); until then
    this still works for tests that INSERT + NOTIFY directly.
    """

    def __init__(self, dsn: str, poll_interval: float = 1.0) -> None:
        self.dsn = dsn
        self.poll_interval = poll_interval
        self._pool: Any = None
        self._notify_queue: asyncio.Queue[AuditEvent] = asyncio.Queue()
        self._listener_started = False
        self._listener_conn: Any = None

    async def _ensure_pool(self) -> Any:
        if self._pool is None:
            asyncpg = import_asyncpg()

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
        return self._pool

    async def _row_to_event(self, row: Any) -> AuditEvent:
        # asyncpg records expose attributes by column name.
        ts = row["ts"]
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts)
        # T-114.2: read all 10 gateway columns (id, ts, method, host, uri,
        # decision, reason, client_ip, status, duration_ms, error). The
        # gateway schema (audit/pgstore.go) declares status/duration_ms as
        # NOT NULL DEFAULT 0 and error as NOT NULL DEFAULT ''. We translate
        # the 0/'' sentinels to None so the consumer can distinguish "no
        # upstream status received" from "real 200/404/etc." — that matches
        # the JSONL path's behaviour where those fields are simply absent.
        status = row["status"]
        if status == 0:
            status = None
        duration_ms = row["duration_ms"]
        if duration_ms == 0:
            duration_ms = None
        error = row["error"] or None  # '' → None
        # T-152: policy_sid is NOT NULL DEFAULT '' in the gateway schema
        # (audit/pgstore.go T-151). Empty string means no IAM statement
        # matched (legacy allowlist path or no IAM evaluator installed).
        # Normalize '' → None to match the existing error='' convention.
        policy_sid = row["policy_sid"] or None  # '' → None
        return AuditEvent(
            timestamp=ts,
            method=row["method"],
            host=row["host"],
            uri=row["uri"] or "",
            decision=row["decision"],
            reason=row["reason"] or "",
            client_ip=row["client_ip"] or "",
            status=status,
            duration_ms=duration_ms,
            error=error,
            policy_sid=policy_sid,
        )

    async def recent(
        self,
        *,
        limit: int = 100,
        domain: str | None = None,
        status: int | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        policy_sid: str | None = None,
    ) -> list[AuditEvent]:
        """Query ``audit_events`` with server-side filters, newest first.

        T-114.2: ``status`` is now a server-side filter (the gateway
        populates the column since T-114.1). To preserve the JSONL path's
        semantic of "status=None means 'any'", we map a None ``status``
        argument to "no filter"; an explicit ``status=0`` maps to a
        literal ``status=0`` filter (the gateway's sentinel for "no
        upstream status received").

        T-152: ``policy_sid`` is also a server-side filter. Like ``status``,
        ``None`` means "no filter"; a non-empty string is an exact match
        against the ``policy_sid`` column (the gateway stores SIDs as
        opaque strings, so LIKE would be wrong).
        """
        pool = await self._ensure_pool()
        # $1 = LIMIT, $2..$N = WHERE clauses (built in order: domain,
        # status, since, until, policy_sid).
        where: list[str] = []
        params: list[Any] = []
        idx = 2  # $1 is reserved for LIMIT
        if domain is not None:
            where.append(f"host LIKE ${idx}")
            params.append(f"%{domain}%")
            idx += 1
        if status is not None:
            where.append(f"status = ${idx}")
            params.append(status)
            idx += 1
        if since is not None:
            where.append(f"ts >= ${idx}")
            params.append(since)
            idx += 1
        if until is not None:
            where.append(f"ts <= ${idx}")
            params.append(until)
            idx += 1
        if policy_sid is not None:
            where.append(f"policy_sid = ${idx}")
            params.append(policy_sid)
            idx += 1
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        sql = (
            "SELECT ts, method, host, uri, decision, reason, client_ip, "
            "status, duration_ms, error, policy_sid "
            f"FROM {PG_TABLE}{where_sql} ORDER BY ts DESC LIMIT $1"
        )
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, limit, *params)
        return [await self._row_to_event(r) for r in rows]

    async def _start_listener(self) -> None:
        if self._listener_started:
            return
        self._listener_started = True
        pool = await self._ensure_pool()
        # asyncpg requires a dedicated connection for LISTEN. We hold it
        # for the lifetime of the source and release it in close().
        conn = await pool.acquire()
        self._listener_conn = conn
        try:
            await conn.add_listener(NOTIFY_CHANNEL, self._on_notify)
        except Exception as exc:  # noqa: BLE001
            log.warning("LISTEN %s failed: %s", NOTIFY_CHANNEL, exc)
            await pool.release(conn)
            self._listener_conn = None

    def _on_notify(
        self,
        connection: Any,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        """asyncpg listener callback. ``payload`` is the new row id (int)."""
        try:
            row_id = int(payload)
        except ValueError:
            row_id = 0
        # Fetch the row asynchronously and enqueue it. We can't await inside
        # this sync callback, so schedule a task.
        asyncio.ensure_future(self._fetch_and_enqueue(row_id))  # noqa: RUF006

    async def _fetch_and_enqueue(self, row_id: int) -> None:
        pool = await self._ensure_pool()
        sql = (
            "SELECT ts, method, host, uri, decision, reason, client_ip, "
            "status, duration_ms, error, policy_sid "
            f"FROM {PG_TABLE} WHERE id = $1"
        )
        async with pool.acquire() as conn:
            row = await conn.fetchrow(sql, row_id)
        if row is not None:
            e = await self._row_to_event(row)
            await self._notify_queue.put(e)

    def subscribe(self) -> AsyncIterator[AuditEvent]:
        # The iterator starts the listener lazily on first __anext__(); no
        # eager ensure_future (that created a task on whichever loop was
        # running, which conflicted with pytest-asyncio's loop management).
        return self._subscribe_iter()

    async def _subscribe_iter(self) -> AsyncIterator[AuditEvent]:
        # Start the listener BEFORE the first yield so NOTIFYs are captured
        # as soon as the consumer begins iterating.
        await self._start_listener()
        while True:
            e = await self._notify_queue.get()
            yield e

    async def close(self) -> None:
        # Remove the LISTEN listener + release the dedicated connection FIRST
        # so pool.close() doesn't deadlock waiting on it.
        import contextlib

        if self._listener_conn is not None and self._pool is not None:
            with contextlib.suppress(Exception):
                await self._listener_conn.remove_listener(NOTIFY_CHANNEL, self._on_notify)
            with contextlib.suppress(Exception):
                await self._pool.release(self._listener_conn)
            self._listener_conn = None
        if self._pool is not None:
            await self._pool.close()
            self._pool = None


def make_source_from_config(config: Any) -> AuditDataSource:
    """Pick a data source based on the WebConfig.

    * team-server mode with a db_url → :class:`PGAuditSource`
    * otherwise → :class:`JSONLAuditSource` (defaults to a file in the
      system temp dir; override via the ``NEURALGENTICS_AUDIT_FILE`` env var
      or the ``audit_file`` extra on the config).
    """
    mode = getattr(config, "mode", "embedded")
    db_url = getattr(config, "db_url", None)
    if mode == "team-server" and db_url:
        return PGAuditSource(db_url)
    audit_file = os.environ.get(
        "NEURALGENTICS_AUDIT_FILE",
        str(Path(os.environ.get("TMPDIR", "/tmp")) / "neuralgentics-audit.jsonl"),
    )
    extra = getattr(config, "extra", {})
    if isinstance(extra, dict) and "audit_file" in extra:
        audit_file = str(extra["audit_file"])
    return JSONLAuditSource(Path(audit_file))


__all__ = [
    "AuditDataSource",
    "AuditEvent",
    "JSONLAuditSource",
    "NOTIFY_CHANNEL",
    "PGAuditSource",
    "make_source_from_config",
]
