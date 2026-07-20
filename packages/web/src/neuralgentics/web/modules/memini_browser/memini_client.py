"""Backend clients for the memini-browser module (T-108).

Three implementations of the :class:`MeminiClient` Protocol:

* :class:`MockMeminiClient` — in-memory store used by tests and as the
  fallback when no real backend is available. Seeded with 3 sample
  memories + 1 relationship if empty.
* :class:`SDKMeminiClient` — wraps :class:`memini_ai.server.MemorySystem`
  for embedded mode (the ``memini-ai-dev`` package is a dependency).
* :class:`PGMeminiClient` — team-server fallback that queries the
  ``memories`` PG table directly via asyncpg. Only used when the SDK
  cannot reach an MCP server.

The browser is read-only for v0.14.0 except for trust adjustments,
which go through :meth:`adjust_trust` (the only write path).
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel

log = logging.getLogger("neuralgentics.web.memini_browser")


# ----- Pydantic models (the data shape exposed to templates) -----


class Relationship(BaseModel):
    """One relationship edge in the memory graph."""

    source_id: str
    target_id: str
    relationship_type: str
    confidence: float = 1.0


class MemorySummary(BaseModel):
    """One row in the search-results page."""

    id: str
    content_preview: str
    trust_score: float
    source_type: str
    created_at: datetime
    relationship_count: int
    score: float = 0.0


class Memory(BaseModel):
    """Full memory detail page payload."""

    id: str
    content: str
    metadata: dict[str, Any] = {}
    trust_score: float
    source_type: str
    source_path: str | None = None
    created_at: datetime
    relationships: list[Relationship] = []


class MemoryGraph(BaseModel):
    """Knowledge-graph view for one memory."""

    root_id: str
    entities: list[MemorySummary] = []
    relationships: list[Relationship] = []


class MeminiClient(Protocol):
    """Abstract memini memory browser backend."""

    async def search(self, query: str, *, limit: int = 20) -> list[MemorySummary]: ...

    async def get(self, memory_id: str) -> Memory: ...

    async def adjust_trust(
        self,
        memory_id: str,
        signal: str,
        reason: str = "",
    ) -> float: ...

    async def forget(self, memory_id: str) -> None:
        """Delete a memory (admin-only write path, T-110).

        Raises :class:`KeyError` if the memory doesn't exist.
        """
        ...

    async def get_graph(self, memory_id: str, *, depth: int = 1) -> MemoryGraph: ...

    async def close(self) -> None: ...


# ----- Signal schema (kept in sync with memini_ai.trust_engine) -----


VALID_TRUST_SIGNALS = {
    "user_confirmed",
    "user_corrected",
    "agent_used",
    "agent_ignored",
}

# Trust deltas applied by MockMeminiClient (mirrors memini_ai.trust_engine).
_TRUST_DELTAS = {
    "user_confirmed": +0.10,
    "user_corrected": -0.10,
    "agent_used": +0.05,
    "agent_ignored": -0.05,
}


def _clamp_trust(t: float) -> float:
    return max(0.0, min(1.0, t))


def _preview(content: str, n: int = 200) -> str:
    if len(content) <= n:
        return content
    return content[:n].rstrip() + "…"


# ----- MockMeminiClient (in-memory, for tests + fallback) -----


class MockMeminiClient:
    """In-memory memini backend used by tests and as a no-backend fallback.

    Stores memories in a dict keyed by id. ``adjust_trust`` records each
    adjustment in :attr:`trust_audit` so tests can verify the audit trail.
    """

    def __init__(self, seed: list[Memory] | None = None) -> None:
        self._memories: dict[str, Memory] = {}
        self._relationships: list[Relationship] = []
        self.trust_audit: list[dict[str, Any]] = []
        if seed is None:
            seed = _default_seed()
        for m in seed:
            self._memories[m.id] = m
        # Derive relationships from any seed memory that ships them.
        for m in seed:
            for r in m.relationships:
                if r not in self._relationships:
                    self._relationships.append(r)

    async def search(self, query: str, *, limit: int = 20) -> list[MemorySummary]:
        q = query.lower().strip()
        scored: list[tuple[float, Memory]] = []
        for m in self._memories.values():
            text = m.content.lower()
            if not q:
                score = 1.0
            elif q in text:
                # Naive substring score: longer queries score higher.
                score = 0.9 + 0.01 * min(len(q), 10)
            else:
                # Word-overlap fallback.
                words = set(q.split())
                hits = sum(1 for w in words if w in text)
                score = hits / max(1, len(words)) * 0.5
            if score > 0.0 or not q:
                scored.append((score, m))
        # Sort by score desc, then trust desc, then created_at desc.
        scored.sort(key=lambda t: (-t[0], -t[1].trust_score, -t[1].created_at.timestamp()))
        out: list[MemorySummary] = []
        for score, m in scored[:limit]:
            out.append(self._summary(m, score))
        return out

    async def get(self, memory_id: str) -> Memory:
        m = self._memories.get(memory_id)
        if m is None:
            raise KeyError(f"memory not found: {memory_id}")
        rels = [
            r for r in self._relationships if r.source_id == memory_id or r.target_id == memory_id
        ]
        return m.model_copy(update={"relationships": rels})

    async def adjust_trust(self, memory_id: str, signal: str, reason: str = "") -> float:
        if signal not in VALID_TRUST_SIGNALS:
            raise ValueError(f"invalid trust signal: {signal}")
        m = self._memories.get(memory_id)
        if m is None:
            raise KeyError(f"memory not found: {memory_id}")
        delta = _TRUST_DELTAS[signal]
        new_trust = _clamp_trust(m.trust_score + delta)
        self._memories[memory_id] = m.model_copy(update={"trust_score": new_trust})
        self.trust_audit.append(
            {
                "memory_id": memory_id,
                "signal": signal,
                "reason": reason,
                "old_trust": m.trust_score,
                "new_trust": new_trust,
                "ts": datetime.now(UTC),
            }
        )
        return new_trust

    async def forget(self, memory_id: str) -> None:
        """Delete a memory + its relationship edges (T-110 admin write path)."""
        if memory_id not in self._memories:
            raise KeyError(f"memory not found: {memory_id}")
        del self._memories[memory_id]
        # Drop any relationship edges that referenced the deleted memory.
        self._relationships = [
            r for r in self._relationships if r.source_id != memory_id and r.target_id != memory_id
        ]
        self.trust_audit.append(
            {
                "memory_id": memory_id,
                "signal": "forgotten",
                "reason": "admin forget",
                "old_trust": None,
                "new_trust": None,
                "ts": datetime.now(UTC),
            }
        )

    async def get_graph(self, memory_id: str, *, depth: int = 1) -> MemoryGraph:
        if memory_id not in self._memories:
            raise KeyError(f"memory not found: {memory_id}")
        # Collect entities = the root + every memory at the other end of a
        # relationship edge (depth 1 only for v0.14.0).
        related_ids: set[str] = {memory_id}
        rels: list[Relationship] = []
        for r in self._relationships:
            if r.source_id == memory_id or r.target_id == memory_id:
                rels.append(r)
                related_ids.add(r.source_id)
                related_ids.add(r.target_id)
        entities = [
            self._summary(self._memories[rid]) for rid in related_ids if rid in self._memories
        ]
        return MemoryGraph(root_id=memory_id, entities=entities, relationships=rels)

    async def close(self) -> None:
        return None

    def _summary(self, m: Memory, score: float = 0.0) -> MemorySummary:
        rel_count = sum(
            1 for r in self._relationships if r.source_id == m.id or r.target_id == m.id
        )
        return MemorySummary(
            id=m.id,
            content_preview=_preview(m.content),
            trust_score=m.trust_score,
            source_type=m.source_type,
            created_at=m.created_at,
            relationship_count=rel_count,
            score=score,
        )


def _default_seed() -> list[Memory]:
    """3 sample memories + 1 relationship for the mock backend."""
    now = datetime(2026, 7, 19, 12, 0, 0, tzinfo=UTC)
    a = Memory(
        id="mem-001",
        content="Authentication uses JWT tokens with RS256 signing. Tokens expire after 1 hour.",
        metadata={"topic": "auth", "tags": ["jwt", "security"]},
        trust_score=0.85,
        source_type="session",
        source_path="sessions/2026-07-19.md",
        created_at=now,
    )
    b = Memory(
        id="mem-002",
        content="The gateway rate-limits unauthenticated requests to 60/minute per IP.",
        metadata={"topic": "gateway", "tags": ["rate-limit", "security"]},
        trust_score=0.62,
        source_type="project",
        source_path="docs/gateway.md",
        created_at=now,
    )
    c = Memory(
        id="mem-003",
        content="PostgreSQL pgvector index uses ivfflat with lists=100 for 384-dim embeddings.",
        metadata={"topic": "postgres", "tags": ["pgvector", "index"]},
        trust_score=0.45,
        source_type="file",
        source_path="src/db/schema.sql",
        created_at=now,
    )
    # Wire one relationship: a → b (RELATED_TO).
    a.relationships.append(
        Relationship(source_id="mem-001", target_id="mem-002", relationship_type="RELATED_TO")
    )
    return [a, b, c]


# ----- SDKMeminiClient (wraps memini_ai.server.MemorySystem) -----


class SDKMeminiClient:
    """Wraps :class:`memini_ai.server.MemorySystem` for embedded mode.

    The SDK is the same code path the memini-ai MCP server uses, so the
    browser sees exactly what the agents see. Trust adjustments call
    ``update_memory_trust``; reads use ``query_memories`` / ``get_memory``
    / ``get_relationship_summary``.
    """

    def __init__(self, system: Any) -> None:
        self._system = system

    @classmethod
    async def create(cls) -> SDKMeminiClient:
        """Construct + initialize a MemorySystem from env."""
        from memini_ai.server import create_server  # type: ignore[import-untyped]

        server = create_server()
        # create_server() returns an MCPServer wrapping a MemorySystem.
        system = getattr(server, "_memory_system", None) or getattr(server, "memory_system", None)
        if system is None:
            raise RuntimeError("memini-ai create_server() did not expose a MemorySystem")
        if hasattr(system, "initialize"):
            await system.initialize()
        return cls(system)

    async def search(self, query: str, *, limit: int = 20) -> list[MemorySummary]:
        results = await self._system.query_memories(query, limit=limit)
        out: list[MemorySummary] = []
        for r in results:
            out.append(await self._row_to_summary(r))
        return out

    async def get(self, memory_id: str) -> Memory:
        entry = await self._system.get_memory(memory_id)
        if entry is None:
            raise KeyError(f"memory not found: {memory_id}")
        rels = await self._get_relationships(memory_id)
        return _entry_to_memory(entry, rels)

    async def adjust_trust(self, memory_id: str, signal: str, reason: str = "") -> float:
        if signal not in VALID_TRUST_SIGNALS:
            raise ValueError(f"invalid trust signal: {signal}")
        new_trust = await self._system.update_memory_trust(memory_id, signal)
        log.info(
            "trust adjusted: memory=%s signal=%s reason=%r new_trust=%.3f",
            memory_id,
            signal,
            reason,
            new_trust,
        )
        return float(new_trust)

    async def forget(self, memory_id: str) -> None:
        """Delete a memory via the SDK (T-110 admin write path).

        Resolves the SDK's delete method by name (``delete_memory`` /
        ``forget`` / ``remove_memory``) so this is robust to minor SDK
        revisions. Raises :class:`KeyError` if the memory doesn't exist.
        """
        delete_fn = (
            getattr(self._system, "delete_memory", None)
            or getattr(self._system, "forget", None)
            or getattr(self._system, "remove_memory", None)
        )
        if not callable(delete_fn):
            raise RuntimeError("memini-ai SDK has no delete_memory/forget/remove_memory method")
        result = await delete_fn(memory_id)
        # Some SDKs return a bool/row count; treat falsy as "not found".
        if result is False or result == 0:
            raise KeyError(f"memory not found: {memory_id}")
        log.info("memory forgotten via SDK: %s", memory_id)

    async def get_graph(self, memory_id: str, *, depth: int = 1) -> MemoryGraph:
        entry = await self._system.get_memory(memory_id)
        if entry is None:
            raise KeyError(f"memory not found: {memory_id}")
        rels = await self._get_relationships(memory_id)
        related_ids: set[str] = {memory_id}
        for r in rels:
            related_ids.add(r.source_id)
            related_ids.add(r.target_id)
        entities: list[MemorySummary] = []
        for rid in related_ids:
            e = await self._system.get_memory(rid)
            if e is not None:
                entities.append(await self._row_to_summary(e))
        return MemoryGraph(root_id=memory_id, entities=entities, relationships=rels)

    async def close(self) -> None:
        close = getattr(self._system, "close", None)
        if close is not None:
            await close()

    async def _get_relationships(self, memory_id: str) -> list[Relationship]:
        summary = await self._system.get_relationship_summary(memory_id)
        if not summary:
            return []
        out: list[Relationship] = []
        rows = summary if isinstance(summary, list) else summary.get("relationships", [])
        for row in rows:
            if isinstance(row, dict):
                out.append(
                    Relationship(
                        source_id=str(row.get("source_id") or row.get("sourceId") or memory_id),
                        target_id=str(row.get("target_id") or row.get("targetId") or ""),
                        relationship_type=str(
                            row.get("relationship_type") or row.get("type") or "RELATED_TO"
                        ),
                        confidence=float(row.get("confidence", 1.0)),
                    )
                )
        return out

    async def _row_to_summary(self, entry: Any) -> MemorySummary:
        text = getattr(entry, "text", "") or ""
        return MemorySummary(
            id=str(getattr(entry, "id", "")),
            content_preview=_preview(text),
            trust_score=float(getattr(entry, "trust_score", 0.5)),
            source_type=str(getattr(entry, "source_type", "unknown")),
            created_at=_entry_created_at(entry),
            relationship_count=0,
            score=float(getattr(entry, "score", 0.0)),
        )


def _entry_to_memory(entry: Any, rels: list[Relationship]) -> Memory:
    text = getattr(entry, "text", "") or ""
    meta_raw = getattr(entry, "metadata_json", None)
    if isinstance(meta_raw, str) and meta_raw:
        try:
            metadata: dict[str, Any] = json.loads(meta_raw)
        except json.JSONDecodeError:
            metadata = {"_raw": meta_raw}
    elif isinstance(meta_raw, dict):
        metadata = meta_raw
    else:
        metadata = {}
    return Memory(
        id=str(getattr(entry, "id", "")),
        content=text,
        metadata=metadata,
        trust_score=float(getattr(entry, "trust_score", 0.5)),
        source_type=str(getattr(entry, "source_type", "unknown")),
        source_path=getattr(entry, "source_path", None),
        created_at=_entry_created_at(entry),
        relationships=rels,
    )


def _entry_created_at(entry: Any) -> datetime:
    ts = getattr(entry, "timestamp", None) or getattr(entry, "created_at", None)
    if isinstance(ts, datetime):
        return ts
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(UTC)


# ----- PGMeminiClient (team-server fallback; reads the memories table) -----


class PGMeminiClient:
    """Reads the memini-ai ``memories`` table directly via asyncpg.

    Only used when the SDK can't reach an MCP server but a DSN is
    available. Read-only except for ``adjust_trust`` which UPDATEs the
    ``trust_score`` column (the SDK is the preferred write path — this
    fallback exists so the browser still works in a stripped-down
    team-server deployment).
    """

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._pool: Any = None

    async def _ensure_pool(self) -> Any:
        if self._pool is None:
            import asyncpg

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
        return self._pool

    async def search(self, query: str, *, limit: int = 20) -> list[MemorySummary]:
        pool = await self._ensure_pool()
        # ts_vector text search fallback (no embedding similarity over PG).
        async with pool.acquire() as conn:
            if query.strip():
                rows = await conn.fetch(
                    """
                    SELECT id, text, trust_score, source_type, timestamp
                    FROM memories
                    WHERE to_tsvector('english', text) @@ plainto_tsquery('english', $1)
                    ORDER BY trust_score DESC, timestamp DESC
                    LIMIT $2
                    """,
                    query,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, text, trust_score, source_type, timestamp
                    FROM memories
                    ORDER BY trust_score DESC, timestamp DESC
                    LIMIT $1
                    """,
                    limit,
                )
        return [self._row_to_summary(r) for r in rows]

    async def get(self, memory_id: str) -> Memory:
        pool = await self._ensure_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, text, metadata_json, trust_score, source_type, source_path, timestamp "
                "FROM memories WHERE id = $1",
                memory_id,
            )
            if row is None:
                raise KeyError(f"memory not found: {memory_id}")
        return self._row_to_memory(row)

    async def adjust_trust(self, memory_id: str, signal: str, reason: str = "") -> float:
        if signal not in VALID_TRUST_SIGNALS:
            raise ValueError(f"invalid trust signal: {signal}")
        pool = await self._ensure_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT trust_score FROM memories WHERE id = $1", memory_id)
            if row is None:
                raise KeyError(f"memory not found: {memory_id}")
            old = float(row["trust_score"])
            new = _clamp_trust(old + _TRUST_DELTAS[signal])
            await conn.execute(
                "UPDATE memories SET trust_score = $1 WHERE id = $2",
                new,
                memory_id,
            )
        log.info("PG trust adjusted: memory=%s signal=%s reason=%r", memory_id, signal, reason)
        return new

    async def forget(self, memory_id: str) -> None:
        """Delete a memory + its relationship edges (T-110 admin write path).

        Cascades to ``memory_relationships`` so dangling edges don't
        survive. Raises :class:`KeyError` if the memory didn't exist.
        """
        pool = await self._ensure_pool()
        async with pool.acquire() as conn:
            n = await conn.execute("DELETE FROM memories WHERE id = $1", memory_id)
            # asyncpg returns "DELETE N" — parse the row count.
            count = int(n.split()[-1]) if isinstance(n, str) else int(n or 0)
            if count == 0:
                raise KeyError(f"memory not found: {memory_id}")
            # Clean up dangling relationship edges (no FK cascade assumed).
            await conn.execute(
                "DELETE FROM memory_relationships WHERE source_id = $1 OR target_id = $1",
                memory_id,
            )
        log.info("PG memory forgotten: %s", memory_id)

    async def get_graph(self, memory_id: str, *, depth: int = 1) -> MemoryGraph:
        pool = await self._ensure_pool()
        async with pool.acquire() as conn:
            rel_rows = await conn.fetch(
                "SELECT source_id, target_id, relationship_type, confidence "
                "FROM memory_relationships WHERE source_id = $1 OR target_id = $1",
                memory_id,
            )
        rels = [
            Relationship(
                source_id=str(r["source_id"]),
                target_id=str(r["target_id"]),
                relationship_type=str(r["relationship_type"]),
                confidence=float(r["confidence"]),
            )
            for r in rel_rows
        ]
        related_ids: set[str] = {memory_id}
        for r in rels:
            related_ids.add(r.source_id)
            related_ids.add(r.target_id)
        entities: list[MemorySummary] = []
        if related_ids:
            async with pool.acquire() as conn:
                placeholders = ",".join(f"${i + 1}" for i in range(len(related_ids)))
                rows = await conn.fetch(
                    f"SELECT id, text, trust_score, source_type, timestamp "
                    f"FROM memories WHERE id IN ({placeholders})",
                    *related_ids,
                )
            entities = [self._row_to_summary(r) for r in rows]
        return MemoryGraph(root_id=memory_id, entities=entities, relationships=rels)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    def _row_to_summary(self, row: Any) -> MemorySummary:
        return MemorySummary(
            id=str(row["id"]),
            content_preview=_preview(row["text"] or ""),
            trust_score=float(row["trust_score"]),
            source_type=str(row["source_type"]),
            created_at=_pg_ts(row["timestamp"]),
            relationship_count=0,
        )

    def _row_to_memory(self, row: Any) -> Memory:
        # asyncpg Record exposes .keys(); membership check mirrors dict.
        meta_raw = row["metadata_json"] if "metadata_json" in row.keys() else None  # noqa: SIM118
        if isinstance(meta_raw, str) and meta_raw:
            try:
                metadata: dict[str, Any] = json.loads(meta_raw)
            except json.JSONDecodeError:
                metadata = {"_raw": meta_raw}
        elif isinstance(meta_raw, dict):
            metadata = meta_raw
        else:
            metadata = {}
        return Memory(
            id=str(row["id"]),
            content=row["text"] or "",
            metadata=metadata,
            trust_score=float(row["trust_score"]),
            source_type=str(row["source_type"]),
            source_path=row.get("source_path") if hasattr(row, "get") else None,
            created_at=_pg_ts(row["timestamp"]),
        )


def _pg_ts(v: Any) -> datetime:
    if isinstance(v, datetime):
        return v
    if isinstance(v, str) and v:
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(UTC)


# ----- Factory -----


def make_client_from_config(config: Any) -> MeminiClient:
    """Pick a MeminiClient based on the WebConfig + env.

    Selection order:
      1. ``NEURALGENTICS_MEMINI_BACKEND=mock`` (env) or ``memini_backend=mock``
         (config.extra) → :class:`MockMeminiClient`.
      2. team-server mode with ``db_url`` and ``memini_backend=pg`` →
        :class:`PGMeminiClient`.
      3. Otherwise → :class:`SDKMeminiClient` (embedded mode default).

    The mock is used for tests and for the documented
    ``--memini-backend=mock`` smoke mode.
    """
    backend = (
        os.environ.get(
            "NEURALGENTICS_MEMINI_BACKEND",
            "",
        )
        .strip()
        .lower()
    )
    extra = getattr(config, "extra", {}) or {}
    if isinstance(extra, dict):
        backend = backend or str(extra.get("memini_backend", "")).strip().lower()

    if backend == "mock":
        log.info("memini-browser using MockMeminiClient (explicit)")
        return MockMeminiClient()

    mode = getattr(config, "mode", "embedded")
    db_url = getattr(config, "db_url", None)
    if backend == "pg" and mode == "team-server" and db_url:
        log.info("memini-browser using PGMeminiClient (%s)", _redact(db_url))
        return PGMeminiClient(db_url)

    # Default: SDK (embedded mode).
    log.info("memini-browser using SDKMeminiClient (embedded)")
    # Defer the actual construction to the lifespan — return a lazy proxy.
    return _LazySDKClient()


class _LazySDKClient:
    """Defers SDKMeminiClient.create() until first use.

    The SDK construction opens a PG pool + loads an embedding model — we
    don't want that at app-build time (only at request time, inside the
    lifespan). This proxy lazily creates the real client on first call.
    """

    def __init__(self) -> None:
        self._real: SDKMeminiClient | None = None

    async def _ensure(self) -> SDKMeminiClient:
        if self._real is None:
            self._real = await SDKMeminiClient.create()
        return self._real

    async def search(self, query: str, *, limit: int = 20) -> list[MemorySummary]:
        client = await self._ensure()
        return await client.search(query, limit=limit)

    async def get(self, memory_id: str) -> Memory:
        client = await self._ensure()
        return await client.get(memory_id)

    async def adjust_trust(self, memory_id: str, signal: str, reason: str = "") -> float:
        client = await self._ensure()
        return await client.adjust_trust(memory_id, signal, reason)

    async def forget(self, memory_id: str) -> None:
        client = await self._ensure()
        await client.forget(memory_id)

    async def get_graph(self, memory_id: str, *, depth: int = 1) -> MemoryGraph:
        client = await self._ensure()
        return await client.get_graph(memory_id, depth=depth)

    async def close(self) -> None:
        if self._real is not None:
            await self._real.close()
            self._real = None


def _redact(dsn: str) -> str:
    if "://" in dsn and "@" in dsn:
        scheme, rest = dsn.split("://", 1)
        creds, host = rest.rsplit("@", 1)
        if ":" in creds:
            user, _pw = creds.split(":", 1)
            creds = f"{user}:***"
        return f"{scheme}://{creds}@{host}"
    return dsn


__all__ = [
    "Memory",
    "MemoryGraph",
    "MemorySummary",
    "MeminiClient",
    "MockMeminiClient",
    "PGMeminiClient",
    "Relationship",
    "SDKMeminiClient",
    "VALID_TRUST_SIGNALS",
    "make_client_from_config",
]
