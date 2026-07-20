"""Tests for the memini-browser module — knowledge-graph SVG (T-108).

Covers acceptance criterion 7 (graph SVG E2E):
  * GET /modules/memini-browser/memory/mem-001/graph returns 200 HTML with
    an inline SVG that contains the 2 entities (mem-001 root + mem-002
    related) and 1 relationship edge (RELATED_TO).
  * GET /modules/memini-browser/memory/mem-003/graph returns 200 with an
    SVG that has only 1 entity (the root, no relationships).
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _config() -> WebConfig:
    os.environ["NEURALGENTICS_MEMINI_BACKEND"] = "mock"
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_graph_svg_renders_entities_and_relationships() -> None:
    """GET /modules/memini-browser/memory/mem-001/graph returns 200 HTML
    with an inline SVG. The mock seed wires mem-001 → mem-002 RELATED_TO,
    so the SVG must contain both entity boxes + the relationship label."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser/memory/mem-001/graph")
    assert r.status_code == 200
    body = r.text
    # An inline SVG is present.
    assert "<svg" in body
    assert "</svg>" in body
    # The root id appears as text content (the box label uses a short id).
    assert "mem-001" in body
    # The related entity appears.
    assert "mem-002" in body
    # The relationship label is rendered.
    assert "RELATED_TO" in body
    # There is a <line> for the edge.
    assert "<line" in body
    # And at least 2 <rect> boxes for the entities.
    assert body.count("<rect") >= 2
    # Counts in the page footer.
    assert "2 entit" in body
    assert "1 edge" in body


def test_graph_svg_empty_for_isolated_memory() -> None:
    """GET /modules/memini-browser/memory/mem-003/graph returns 200 with
    an SVG that has 1 entity (the root) and 0 edges."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser/memory/mem-003/graph")
    assert r.status_code == 200
    body = r.text
    assert "<svg" in body
    assert "mem-003" in body
    # No relationship edge in the SVG for mem-003 (isolated in the seed).
    assert "RELATED_TO" not in body
    assert "<line" not in body
    # 1 entity, 0 edges.
    assert "1 entit" in body
    assert "0 edge" in body
