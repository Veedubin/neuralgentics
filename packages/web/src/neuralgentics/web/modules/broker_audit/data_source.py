"""Data sources for the broker-audit module (T-107).

Two concrete implementations, mirroring the gateway-audit pattern (T-106):

* :class:`JSONLBrokerAuditSource` — embedded mode. Reads a JSONL file
  written by the broker's audit hooks (which don't exist yet — T-107
  ships the consumer side; a future broker patch will write the file).
  Polls the file's mtime/size every ``poll_interval`` seconds and emits
  any newly-appended lines as :class:`BrokerAuditEvent` objects.

* :class:`PGBrokerAuditSource` — team-server mode. Reads from the
  ``broker_audit_log`` PostgreSQL table (schema created idempotently by
  :meth:`apply_schema`) and listens on the ``broker_audit_new`` NOTIFY
  channel for real-time push. Unlike the gateway's ``audit_events`` table
  (which left the NOTIFY trigger for a future patch), T-107 ships the
  trigger as part of :meth:`apply_schema` so team-server mode is fully
  wired out of the box.

The JSONL shape (one object per line)::

    {"ts":"2026-07-19T12:34:56Z","agent_role":"coder","server":"filesystem",
     "tool":"read_file","args_hash":"sha256:abc...","success":true,
     "result_size":1234,"duration_ms":45,"error":""}
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

log = logging.getLogger("neuralgentics.web.broker_audit")

# PG NOTIFY channel the trigger emits on after every INSERT.
NOTIFY_CHANNEL = "broker_audit_new"

# PG table for team-server mode (NEW in T-107).
PG_TABLE = "broker_audit_log"

# Idempotent schema for broker_audit_log + the LISTEN/NOTIFY trigger.
# Applied by PGBrokerAuditSource.apply_schema() on first pool creation.
SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {PG_TABLE} (
    id          SERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_role  TEXT        NOT NULL,
    server      TEXT        NOT NULL,
    tool        TEXT        NOT NULL,
    args_hash   TEXT,
    success     BOOLEAN     NOT NULL,
    result_size INTEGER,
    duration_ms INTEGER     NOT NULL,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_broker_audit_ts   ON {PG_TABLE} (ts DESC);
CREATE INDEX IF NOT EXISTS idx_broker_audit_tool ON {PG_TABLE} (tool);

CREATE OR REPLACE FUNCTION notify_broker_audit_new() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('{NOTIFY_CHANNEL}', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS broker_audit_notify ON {PG_TABLE};
CREATE TRIGGER broker_audit_notify AFTER INSERT ON {PG_TABLE}
    FOR EACH ROW EXECUTE FUNCTION notify_broker_audit_new();
"""


class BrokerAuditEvent(BaseModel):
    """One broker tool-call audit event.

    Mirrors the T-107 JSONL spec. ``ts`` is the canonical field name
    (the PG table uses ``ts`` too); we also tolerate ``timestamp`` as
    an alias for parity with the gateway-audit event shape.
    """

    ts: datetime
    agent_role: str
    server: str
    tool: str
    args_hash: str | None = None
    success: bool
    result_size: int | None = None
    duration_ms: int
    error: str = ""

    model_config = {"extra": "ignore"}

    @classmethod
    def from_jsonl_line(cls, line: str) -> BrokerAuditEvent:
        """Parse one JSONL line into a BrokerAuditEvent.

        Tolerates either ``ts`` (T-107 spec) or ``timestamp`` (alias);
        normalizes to ``ts``.
        """
        raw: dict[str, Any] = json.loads(line)
        if "timestamp" in raw and "ts" not in raw:
            raw["ts"] = raw["timestamp"]
        return cls.model_validate(raw)

    def row_tuple(self) -> tuple[str, str, str, str, str, str, str, str]:
        """Compact tuple for the HTML table row (8 visible columns)."""
        ts = self.ts.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")
        succ = "✓" if self.success else "✗"
        dur = f"{self.duration_ms}ms"
        size = str(self.result_size) if self.result_size is not None else "—"
        return (
            ts,
            self.agent_role,
            self.server,
            self.tool,
            succ,
            dur,
            size,
            self.error,
        )


class BrokerAuditDataSource(Protocol):
    """Abstract broker-audit data source."""

    async def recent(
        self,
        *,
        limit: int = 100,
        tool: str | None = None,
        server: str | None = None,
        role: str | None = None,
        success: bool | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[BrokerAuditEvent]: ...

    def subscribe(self) -> AsyncIterator[BrokerAuditEvent]: ...


def _passes_filter(
    e: BrokerAuditEvent,
    *,
    tool: str | None,
    server: str | None,
    role: str | None,
    success: bool | None,
    since: datetime | None,
    until: datetime | None,
) -> bool:
    """Client-side filter predicate used by JSONLBrokerAuditSource."""
    if tool is not None and e.tool != tool:
        return False
    if server is not None and e.server != server:
        return False
    if role is not None and e.agent_role != role:
        return False
    if success is not None and e.success != success:
        return False
    if since is not None and e.ts < since:
        return False
    return not (until is not None and e.ts > until)


class JSONLBrokerAuditSource:
    """Reads broker audit events from a JSONL file (embedded mode).

    The file is one JSON object per line. We keep the whole file in
    memory (audit logs are bounded — the broker rotates them).
    ``subscribe()`` polls the file's mtime/size every ``poll_interval``
    seconds and yields any newly-appended lines.
    """

    def __init__(self, path: Path, poll_interval: float = 1.0) -> None:
        self.path = path
        self.poll_interval = poll_interval
        self._events: list[BrokerAuditEvent] = []
        self._read_offset: int = 0
        self._loaded = False

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
                    e = BrokerAuditEvent.from_jsonl_line(line)
                except Exception as exc:  # noqa: BLE001 — log+skip bad lines
                    log.warning("JSONL parse error in %s: %s", self.path, exc)
                    continue
                self._events.append(e)
        self._read_offset = self.path.stat().st_size if self.path.exists() else 0

    def _poll_new(self) -> list[BrokerAuditEvent]:
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
        new_events: list[BrokerAuditEvent] = []
        with self.path.open("r", encoding="utf-8") as fh:
            fh.seek(self._read_offset)
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = BrokerAuditEvent.from_jsonl_line(line)
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
        tool: str | None = None,
        server: str | None = None,
        role: str | None = None,
        success: bool | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[BrokerAuditEvent]:
        """Return the last ``limit`` events matching the filters, newest first."""
        self._load_existing()
        filtered = [
            e
            for e in self._events
            if _passes_filter(
                e,
                tool=tool,
                server=server,
                role=role,
                success=success,
                since=since,
                until=until,
            )
        ]
        return list(reversed(filtered[-limit:]))

    def subscribe(self) -> AsyncIterator[BrokerAuditEvent]:
        """Async iterator that polls the file and yields newly-appended events."""
        self._load_existing()
        return self._subscribe_iter()

    async def _subscribe_iter(self) -> AsyncIterator[BrokerAuditEvent]:
        # SSE consumers want live-only events (the table renders the
        # snapshot separately); do NOT replay existing events here.
        while True:
            new = self._poll_new()
            for e in new:
                yield e
            await asyncio.sleep(self.poll_interval)


class PGBrokerAuditSource:
    """Reads broker audit events from PostgreSQL (team-server mode).

    Uses the ``broker_audit_log`` table (created idempotently by
    :meth:`apply_schema`). Real-time push is via LISTEN/NOTIFY on the
    ``broker_audit_new`` channel — the trigger is installed by
    :meth:`apply_schema`, so INSERTs automatically NOTIFY.
    """

    def __init__(self, dsn: str, poll_interval: float = 1.0) -> None:
        self.dsn = dsn
        self.poll_interval = poll_interval
        self._pool: Any = None
        self._notify_queue: asyncio.Queue[BrokerAuditEvent] = asyncio.Queue()
        self._listener_started = False
        self._listener_conn: Any = None
        self._schema_applied = False

    async def _ensure_pool(self) -> Any:
        if self._pool is None:
            import asyncpg

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
            await self.apply_schema()
        return self._pool

    async def apply_schema(self) -> None:
        """Create the ``broker_audit_log`` table + indexes + NOTIFY trigger.

        Idempotent — safe to call on every startup. Called automatically
        on first pool creation; exposed publicly so tests can verify it.
        """
        if self._schema_applied:
            return
        if self._pool is None:
            import asyncpg

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
        async with self._pool.acquire() as conn:
            await conn.execute(SCHEMA_SQL)
        self._schema_applied = True
        log.info("broker_audit_log schema applied (table + indexes + NOTIFY trigger)")

    async def _row_to_event(self, row: Any) -> BrokerAuditEvent:
        ts = row["ts"]
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts)
        # asyncpg Record supports .get(); use it for nullable columns.
        return BrokerAuditEvent(
            ts=ts,
            agent_role=row["agent_role"],
            server=row["server"],
            tool=row["tool"],
            args_hash=row.get("args_hash"),
            success=row["success"],
            result_size=row.get("result_size"),
            duration_ms=row["duration_ms"],
            error=row.get("error", ""),
        )

    async def recent(
        self,
        *,
        limit: int = 100,
        tool: str | None = None,
        server: str | None = None,
        role: str | None = None,
        success: bool | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[BrokerAuditEvent]:
        """Query ``broker_audit_log`` with server-side filters, newest first."""
        pool = await self._ensure_pool()
        where: list[str] = []
        params: list[Any] = []
        idx = 2  # $1 is reserved for LIMIT
        if tool is not None:
            where.append(f"tool = ${idx}")
            params.append(tool)
            idx += 1
        if server is not None:
            where.append(f"server = ${idx}")
            params.append(server)
            idx += 1
        if role is not None:
            where.append(f"agent_role = ${idx}")
            params.append(role)
            idx += 1
        if success is not None:
            where.append(f"success = ${idx}")
            params.append(success)
            idx += 1
        if since is not None:
            where.append(f"ts >= ${idx}")
            params.append(since)
            idx += 1
        if until is not None:
            where.append(f"ts <= ${idx}")
            params.append(until)
            idx += 1
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        sql = (
            "SELECT id, ts, agent_role, server, tool, args_hash, success, "
            "result_size, duration_ms, error "
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
        """asyncpg listener callback.

        The trigger emits ``row_to_json(NEW)::text`` as the payload, so
        we can parse it directly into a BrokerAuditEvent without a second
        round-trip to the DB.
        """
        try:
            data = json.loads(payload)
            e = BrokerAuditEvent.model_validate(data)
            asyncio.ensure_future(self._notify_queue.put(e))  # noqa: RUF006
        except Exception as exc:  # noqa: BLE001
            log.warning("broker_audit NOTIFY parse error: %s", exc)

    def subscribe(self) -> AsyncIterator[BrokerAuditEvent]:
        return self._subscribe_iter()

    async def _subscribe_iter(self) -> AsyncIterator[BrokerAuditEvent]:
        await self._start_listener()
        while True:
            e = await self._notify_queue.get()
            yield e

    async def close(self) -> None:
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


def make_source_from_config(config: Any) -> BrokerAuditDataSource:
    """Pick a data source based on the WebConfig.

    * team-server mode with a db_url → :class:`PGBrokerAuditSource`
    * otherwise → :class:`JSONLBrokerAuditSource` (defaults to a file in
      the system temp dir; override via the
      ``NEURALGENTICS_BROKER_AUDIT_FILE`` env var or the
      ``broker_audit_file`` extra on the config).
    """
    mode = getattr(config, "mode", "embedded")
    db_url = getattr(config, "db_url", None)
    if mode == "team-server" and db_url:
        return PGBrokerAuditSource(db_url)
    audit_file = os.environ.get(
        "NEURALGENTICS_BROKER_AUDIT_FILE",
        str(Path(os.environ.get("TMPDIR", "/tmp")) / "neuralgentics-broker-audit.jsonl"),
    )
    extra = getattr(config, "extra", {})
    if isinstance(extra, dict) and "broker_audit_file" in extra:
        audit_file = str(extra["broker_audit_file"])
    return JSONLBrokerAuditSource(Path(audit_file))


__all__ = [
    "BrokerAuditDataSource",
    "BrokerAuditEvent",
    "JSONLBrokerAuditSource",
    "NOTIFY_CHANNEL",
    "PG_TABLE",
    "PGBrokerAuditSource",
    "SCHEMA_SQL",
    "make_source_from_config",
]
