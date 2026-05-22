"""Integration tests for memini-core HTTP server.

Uses pytest + httpx TestClient.
Does NOT require a PostgreSQL instance — the Database class is mocked
to use an in-memory dict store.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

# Add memini-core source to path before any imports
sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent / "packages" / "memini-core" / "src")
)

import memini_core.database  # must import before patch() targets it

import pytest
from httpx import ASGITransport, AsyncClient

# Patch Database BEFORE importing create_app
mock_db_instance = MagicMock()
mock_db_instance.connect.return_value = None
mock_db_instance.close.return_value = None

# In-memory store
_mem_store: dict[str, dict[str, Any]] = {}
_mem_counter: int = 0


def _reset_store() -> None:
    _mem_store.clear()
    global _mem_counter
    _mem_counter = 0


def _mock_add_memory(
    content: str,
    source_type: str = "session",
    metadata: dict[str, Any] | None = None,
) -> str:
    global _mem_counter
    _mem_counter += 1
    mem_id = f"test-uuid-{_mem_counter:04d}"
    _mem_store[mem_id] = {
        "id": mem_id,
        "content": content,
        "trustScore": 0.5,
        "embedding": [0.1] * 384,
        "sourceType": source_type,
        "metadata": metadata or {},
        "createdAt": "2025-01-01T00:00:00+00:00",
    }
    return mem_id


def _mock_get_memory(memory_id: str) -> dict[str, Any] | None:
    return _mem_store.get(memory_id)


def _mock_query_memories(query_text: str, limit: int = 10) -> list[dict[str, Any]]:
    results = list(_mem_store.values())
    return results[:limit]


mock_db_instance.add_memory.side_effect = _mock_add_memory
mock_db_instance.get_memory.side_effect = _mock_get_memory
mock_db_instance.query_memories.side_effect = _mock_query_memories


@pytest.fixture(autouse=True)
def reset_store() -> None:
    """Reset the in-memory store before every test."""
    _reset_store()


@pytest.fixture
async def client():
    """Create an async test client with mocked database."""
    with patch("memini_core.database.Database", return_value=mock_db_instance):
        # Import here so the patch is active when create_app runs
        from memini_core.server import create_app

        app = create_app(db_url="sqlite:///:memory:")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


# ============================================================================
# Tests
# ============================================================================


@pytest.mark.anyio
async def test_health(client: AsyncClient) -> None:
    """GET /health should return 200 with status 'ok'."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


@pytest.mark.anyio
async def test_add_memory(client: AsyncClient) -> None:
    """POST /memory/add should return a memory ID."""
    resp = await client.post(
        "/memory/add",
        json={"content": "hello world", "sourceType": "test"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "id" in data
    assert isinstance(data["id"], str)
    assert len(data["id"]) > 0


@pytest.mark.anyio
async def test_add_memory_minimal(client: AsyncClient) -> None:
    """POST /memory/add without sourceType should default to 'session'."""
    resp = await client.post(
        "/memory/add",
        json={"content": "minimal entry"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "id" in data


@pytest.mark.anyio
async def test_get_memory(client: AsyncClient) -> None:
    """GET /memory/{id} should return the stored memory."""
    # First add a memory
    add_resp = await client.post(
        "/memory/add",
        json={"content": "get me", "sourceType": "test"},
    )
    mem_id = add_resp.json()["id"]

    # Then fetch it
    resp = await client.get(f"/memory/{mem_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == mem_id
    assert data["content"] == "get me"
    assert data["sourceType"] == "test"
    assert data["trustScore"] == 0.5


@pytest.mark.anyio
async def test_get_memory_not_found(client: AsyncClient) -> None:
    """GET /memory/{id} for a non-existent memory should return 404."""
    resp = await client.get("/memory/non-existent-id")
    assert resp.status_code == 404
    data = resp.json()
    assert "detail" in data


@pytest.mark.anyio
async def test_query_memories(client: AsyncClient) -> None:
    """POST /memory/query should return matching memories."""
    # Add two memories
    await client.post(
        "/memory/add",
        json={"content": "first memory", "sourceType": "test"},
    )
    await client.post(
        "/memory/add",
        json={"content": "second memory", "sourceType": "test"},
    )

    resp = await client.post(
        "/memory/query",
        json={"query": "test", "limit": 10},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "results" in data
    assert len(data["results"]) == 2


@pytest.mark.anyio
async def test_query_memories_empty(client: AsyncClient) -> None:
    """POST /memory/query with no memories should return empty list."""
    resp = await client.post(
        "/memory/query",
        json={"query": "nothing", "limit": 10},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["results"] == []


@pytest.mark.anyio
async def test_health_then_add_then_query(client: AsyncClient) -> None:
    """Integration: health → add → query flow."""
    # Health
    health = await client.get("/health")
    assert health.status_code == 200

    # Add
    add_resp = await client.post(
        "/memory/add",
        json={"content": "integration test memory", "sourceType": "test"},
    )
    mem_id = add_resp.json()["id"]

    # Get by ID
    get_resp = await client.get(f"/memory/{mem_id}")
    assert get_resp.json()["content"] == "integration test memory"

    # Query
    query_resp = await client.post(
        "/memory/query",
        json={"query": "integration", "limit": 5},
    )
    assert len(query_resp.json()["results"]) >= 1
