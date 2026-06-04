"""Test that plugin can talk to memini-core."""

import pytest
import httpx

BASE_URL = "http://localhost:8900"


def test_health():
    r = httpx.get(f"{BASE_URL}/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_add_and_query_memory():
    # Add
    r = httpx.post(
        f"{BASE_URL}/memory/add",
        json={"content": "Test memory", "metadata": {"test": True}},
    )
    assert r.status_code == 200
    data = r.json()
    assert "id" in data

    # Query
    r2 = httpx.post(
        f"{BASE_URL}/memory/query",
        json={"query": "test", "top_k": 5},
    )
    assert r2.status_code == 200
    results = r2.json()
    assert any("Test memory" in str(m) for m in results)
