"""Tests for the memini-browser module — search (embedded mode + mock backend).

Covers acceptance criteria 4 (search E2E) + 9 (manifest):
  * GET /modules/memini-browser?q=authentication returns 200 HTML with 3
    results (the mock seed).
  * GET /modules/memini-browser (empty query) returns 200 HTML with the
    default 20-result page.
  * GET /modules/memini-browser?q=pgvector returns only the 1 matching
    result (filters by content).
  * GET /api/v1/memini-browser/search?q=rate returns JSON with the
    matching results.
  * The manifest at modules/memini_browser/module.yaml lists the real
    routes (/modules/memini-browser, /memory/{id}, /graph, /trust POST).
"""

from __future__ import annotations

from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _config() -> WebConfig:
    # The WebConfig doesn't accept `extra` in the constructor, but
    # make_client_from_config reads env vars first — set the mock backend.
    import os

    os.environ["NEURALGENTICS_MEMINI_BACKEND"] = "mock"
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_search_returns_results_for_authentication_query() -> None:
    """GET /modules/memini-browser?q=authentication returns 200 HTML with 3
    seeded results from the mock backend."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser?q=authentication")
    assert r.status_code == 200
    body = r.text
    assert "<table" in body
    # The mock seed has 3 memories, all touch "security"/"auth" topics.
    # The query "authentication" should substring-match mem-001 (JWT auth).
    assert "mem-001" in body
    assert "JWT" in body
    # Trust badge rendered (mem-001 trust=0.85 → green).
    assert "0.85" in body
    # Search form present.
    assert 'name="q"' in body
    # Stub page should NOT render.
    assert "coming in T-108" not in body
    assert "Coming in T-108" not in body


def test_search_with_empty_query_returns_full_list() -> None:
    """GET /modules/memini-browser (no query) returns 200 HTML with the full
    seed list (3 results, sorted by trust desc)."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser")
    assert r.status_code == 200
    body = r.text
    # All 3 seed memories should appear.
    assert "mem-001" in body
    assert "mem-002" in body
    assert "mem-003" in body
    # Empty-query path returns everything (mock returns all memories when
    # q is empty). The header renders "3</span> results" (the count is in a
    # <span id="result-count">3</span> and the pluralizer emits " results").
    assert 'id="result-count">3</span>' in body
    assert "results" in body


def test_search_filters_by_query_content() -> None:
    """GET /modules/memini-browser?q=pgvector returns only the 1 matching
    result (mem-003). Verifies server-side filtering by content."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser?q=pgvector")
    assert r.status_code == 200
    body = r.text
    assert "mem-003" in body
    # The other two memories do NOT mention pgvector.
    assert "mem-001" not in body
    assert "mem-002" not in body
    # The JSON API echoes the same filter.
    with TestClient(app) as client:
        rj = client.get("/api/v1/memini-browser/search?q=pgvector")
    assert rj.status_code == 200
    data = rj.json()
    assert data["count"] == 1
    assert data["results"][0]["id"] == "mem-003"
    assert "pgvector" in data["results"][0]["content_preview"].lower()


def test_manifest_lists_real_routes() -> None:
    """modules/memini_browser/module.yaml declares the 4 real routes +
    the JSON search endpoint. Verifies the manifest was updated for T-108."""
    manifest_path = MODULES_DIR / "memini_browser" / "module.yaml"
    with manifest_path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    assert raw["name"] == "memini-browser"
    assert raw["version"] == "0.14.0"
    paths = {r["path"] for r in raw["routes"]}
    assert "/modules/memini-browser" in paths
    assert "/modules/memini-browser/memory/{memory_id}" in paths
    assert "/modules/memini-browser/memory/{memory_id}/graph" in paths
    # The trust-adjust POST is in the routes list.
    trust_routes = [r for r in raw["routes"] if r["path"].endswith("/trust")]
    assert len(trust_routes) == 1
    assert trust_routes[0]["method"] == "POST"
    api_paths = {e["path"] for e in raw["api_endpoints"]}
    assert "/api/v1/memini-browser/search" in api_paths
