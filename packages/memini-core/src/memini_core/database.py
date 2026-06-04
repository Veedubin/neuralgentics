"""PostgreSQL/pgvector storage layer for memini-core.

Uses psycopg2-binary for synchronous database access. Tables:
- memories: core memory entries with vector embeddings
- memory_relationships: directed edges between memories
- project_chunks: indexed file chunks with embeddings
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any

import psycopg2
import psycopg2.extras

from memini_core.embeddings import Embedder

# ---------------------------------------------------------------------------
# Schema SQL
# ---------------------------------------------------------------------------

_SQL_CREATE_EXTENSIONS = """
CREATE EXTENSION IF NOT EXISTS vector;
"""

_SQL_CREATE_MEMORIES = """
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    embedding vector(384),
    trust_score FLOAT DEFAULT 0.5 CHECK (trust_score >= 0 AND trust_score <= 1),
    source_type TEXT NOT NULL DEFAULT 'session',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);
"""

_SQL_CREATE_MEMORIES_INDEX = """
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_score);
"""

_SQL_CREATE_RELATIONSHIPS = """
CREATE TABLE IF NOT EXISTS memory_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL CHECK (
        relationship_type IN ('SUPERSEDES', 'RELATED_TO', 'CONTRADICTS', 'DERIVED_FROM')
    ),
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(source_id, target_id, relationship_type)
);
"""

_SQL_CREATE_RELATIONSHIPS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_rel_source ON memory_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON memory_relationships(target_id);
"""

_SQL_CREATE_PROJECT_CHUNKS = """
CREATE TABLE IF NOT EXISTS project_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(384),
    metadata JSONB DEFAULT '{}'::jsonb
);
"""

_SQL_CREATE_PROJECT_CHUNKS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON project_chunks
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON project_chunks(file_path);
"""

_SCHEMA_SQL = "\n".join(
    [
        _SQL_CREATE_EXTENSIONS,
        _SQL_CREATE_MEMORIES,
        _SQL_CREATE_MEMORIES_INDEX,
        _SQL_CREATE_RELATIONSHIPS,
        _SQL_CREATE_RELATIONSHIPS_INDEX,
        _SQL_CREATE_PROJECT_CHUNKS,
        _SQL_CREATE_PROJECT_CHUNKS_INDEX,
    ]
)


# ---------------------------------------------------------------------------
# Vector helpers
# ---------------------------------------------------------------------------


def _vec_to_str(vec: list[float] | None) -> str | None:
    """Convert a float list to pgvector string format '[0.1, 0.2, ...]'."""
    if vec is None:
        return None
    return "[" + ", ".join(str(x) for x in vec) + "]"


def _parse_vec(val: Any) -> list[float] | None:
    """Parse a pgvector value (string or tuple) into a float list."""
    if val is None:
        return None
    if isinstance(val, str):
        return json.loads(val)
    return list(val)


# ---------------------------------------------------------------------------
# Database class
# ---------------------------------------------------------------------------


class Database:
    """PostgreSQL/pgvector storage for memories, relationships, and project chunks.

    Uses psycopg2-binary for synchronous access. Schema is created
    idempotently on first connection.
    """

    def __init__(
        self,
        db_url: str | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        self._db_url = db_url or os.environ.get("MEMINI_DB_URL", "")
        self._embedder = embedder or Embedder()
        self._conn: psycopg2.extensions.connection | None = None

    # -- connection management ------------------------------------------------

    def connect(self) -> None:
        """Open a connection and ensure the schema exists."""
        self._conn = psycopg2.connect(self._db_url)
        self._conn.autocommit = True
        self._ensure_schema()

    def close(self) -> None:
        """Close the database connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _ensure_schema(self) -> None:
        """Create tables and indexes if they don't exist (idempotent)."""
        conn = self._conn
        assert conn is not None and not conn.closed
        with conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL)

    def _cursor(self) -> psycopg2.extensions.cursor:
        """Return a dict cursor on the current connection."""
        if self._conn is None or self._conn.closed:
            self.connect()
        conn = self._conn
        assert conn is not None and not conn.closed
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # -- memories CRUD -------------------------------------------------------

    def add_memory(
        self,
        content: str,
        source_type: str = "session",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Insert a memory and return its UUID.

        Embedding is generated automatically from content.

        Args:
            content: Memory text.
            source_type: Origin label (session, file, web, project).
            metadata: Optional JSON metadata dict.

        Returns:
            The new memory's UUID as a string.
        """
        embedding = self._embedder.encode(content)
        memory_id = str(uuid.uuid4())
        vec_str = _vec_to_str(embedding)
        meta_json = json.dumps(metadata or {})

        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO memories (id, content, embedding, source_type, metadata)
                VALUES (%s, %s, %s::vector, %s, %s::jsonb)
                """,
                (memory_id, content, vec_str, source_type, meta_json),
            )
        return memory_id

    def get_memory(self, memory_id: str) -> dict[str, Any] | None:
        """Fetch a single memory by ID.

        Args:
            memory_id: UUID string.

        Returns:
            Dict with id, content, trust_score, embedding, source_type,
            metadata, created_at — or None if not found.
        """
        with self._cursor() as cur:
            cur.execute(
                """
                SELECT id, content, trust_score, embedding, source_type,
                       metadata, created_at
                FROM memories WHERE id = %s
                """,
                (memory_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return _row_to_memory_dict(row)

    def query_memories(self, query_text: str, limit: int = 10) -> list[dict[str, Any]]:
        """Search memories by semantic similarity.

        Args:
            query_text: Natural-language query.
            limit: Maximum results.

        Returns:
            List of memory dicts ordered by similarity (best first).
        """
        embedding = self._embedder.encode(query_text)
        vec_str = _vec_to_str(embedding)

        with self._cursor() as cur:
            cur.execute(
                """
                SELECT id, content, trust_score, embedding, source_type,
                       metadata, created_at,
                       1 - (embedding <=> %s::vector) AS score
                FROM memories
                WHERE trust_score >= 0.2
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (vec_str, vec_str, limit),
            )
            rows = cur.fetchall()
        return [_row_to_memory_dict(r) for r in rows]

    def update_trust(self, memory_id: str, trust_score: float) -> None:
        """Overwrite the trust_score for a memory.

        Args:
            memory_id: UUID string.
            trust_score: New score (0.0–1.0).
        """
        with self._cursor() as cur:
            cur.execute(
                "UPDATE memories SET trust_score = %s WHERE id = %s",
                (trust_score, memory_id),
            )

    def delete_memory(self, memory_id: str) -> bool:
        """Delete a memory by ID.

        Returns:
            True if a row was deleted.
        """
        with self._cursor() as cur:
            cur.execute("DELETE FROM memories WHERE id = %s", (memory_id,))
            return cur.rowcount > 0

    def list_memories(self, limit: int = 100) -> list[dict[str, Any]]:
        """List recent non-archived memories.

        Args:
            limit: Maximum results.

        Returns:
            List of memory dicts ordered by created_at DESC.
        """
        with self._cursor() as cur:
            cur.execute(
                """
                SELECT id, content, trust_score, embedding, source_type,
                       metadata, created_at
                FROM memories WHERE trust_score >= 0.2
                ORDER BY created_at DESC LIMIT %s
                """,
                (limit,),
            )
            rows = cur.fetchall()
        return [_row_to_memory_dict(r) for r in rows]

    # -- relationships CRUD ---------------------------------------------------

    def add_relationship(
        self,
        source_id: str,
        target_id: str,
        relationship_type: str,
        confidence: float = 1.0,
    ) -> None:
        """Create a relationship between two memories.

        Args:
            source_id: Source memory UUID.
            target_id: Target memory UUID.
            relationship_type: SUPERSEDES | RELATED_TO | CONTRADICTS | DERIVED_FROM.
            confidence: Edge confidence (0.0–1.0).
        """
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO memory_relationships
                    (source_id, target_id, relationship_type, confidence)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (source_id, target_id, relationship_type)
                DO UPDATE SET confidence = EXCLUDED.confidence
                """,
                (source_id, target_id, relationship_type, confidence),
            )

    def get_relationships(self, memory_id: str) -> list[dict[str, Any]]:
        """Return all relationships where the given memory is source or target.

        Args:
            memory_id: UUID string.

        Returns:
            List of dicts with source_id, target_id, type, confidence.
        """
        with self._cursor() as cur:
            cur.execute(
                """
                SELECT source_id, target_id, relationship_type AS type, confidence
                FROM memory_relationships
                WHERE source_id = %s OR target_id = %s
                """,
                (memory_id, memory_id),
            )
            rows = cur.fetchall()
        return [
            {
                "sourceId": str(r["source_id"]),
                "targetId": str(r["target_id"]),
                "type": r["type"],
                "confidence": r["confidence"],
            }
            for r in rows
        ]

    # -- project chunks -------------------------------------------------------

    def add_chunk(
        self,
        file_path: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Insert a project file chunk with auto-generated embedding.

        Returns:
            The chunk's UUID.
        """
        embedding = self._embedder.encode(content)
        chunk_id = str(uuid.uuid4())
        vec_str = _vec_to_str(embedding)
        meta_json = json.dumps(metadata or {})

        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO project_chunks (id, file_path, content, embedding, metadata)
                VALUES (%s, %s, %s, %s::vector, %s::jsonb)
                """,
                (chunk_id, file_path, content, vec_str, meta_json),
            )
        return chunk_id

    def search_chunks(self, query_text: str, limit: int = 20) -> list[dict[str, Any]]:
        """Search project chunks by semantic similarity.

        Args:
            query_text: Natural-language query.
            limit: Maximum results.

        Returns:
            List of chunk dicts with file_path, content, score.
        """
        embedding = self._embedder.encode(query_text)
        vec_str = _vec_to_str(embedding)

        with self._cursor() as cur:
            cur.execute(
                """
                SELECT file_path, content, metadata,
                       1 - (embedding <=> %s::vector) AS score
                FROM project_chunks
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (vec_str, vec_str, limit),
            )
            rows = cur.fetchall()
        return [
            {
                "filePath": r["file_path"],
                "content": r["content"],
                "metadata": r["metadata"],
                "score": r["score"],
            }
            for r in rows
        ]

    def delete_chunks_by_path(self, file_path: str) -> int:
        """Delete all chunks for a given file path.

        Returns:
            Number of deleted rows.
        """
        with self._cursor() as cur:
            cur.execute("DELETE FROM project_chunks WHERE file_path = %s", (file_path,))
            return cur.rowcount


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_memory_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a RealDictRow into a JSON-friendly memory dict."""
    return {
        "id": str(row["id"]),
        "content": row["content"],
        "trustScore": row["trust_score"],
        "embedding": _parse_vec(row["embedding"]),
        "sourceType": row["source_type"],
        "metadata": row["metadata"] if isinstance(row["metadata"], dict) else {},
        "createdAt": row["created_at"].isoformat() if row["created_at"] else None,
    }
