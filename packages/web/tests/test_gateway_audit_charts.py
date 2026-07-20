"""Tests for the gateway-audit charts page (T-118).

Covers:
  * GET /modules/gateway-audit/charts returns 200 HTML containing the three
    ``<canvas>`` elements used by Chart.js.
  * The page loads the Chart.js CDN script tag.
  * The page links back to the existing table page (Table/Charts tab nav).
  * The existing table page now contains a "Charts" link to the new route.

We do not exercise the Chart.js rendering itself (no JS engine in the test
client); we assert the server renders the canvas scaffolding correctly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import neuralgentics.web.modules.gateway_audit.data_source as ds_mod
from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


@pytest.fixture(autouse=True)
def fast_poll_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make JSONLAuditSource poll every 0.2s (so tests run fast)."""
    orig = ds_mod.JSONLAuditSource.__init__
    monkeypatch.setattr(
        ds_mod.JSONLAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: orig(self, path, poll_interval),
    )


@pytest.fixture
def audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "audit.jsonl"
    p.write_text("")
    monkeypatch.setenv("NEURALGENTICS_AUDIT_FILE", str(p))
    return p


def _write_events(p: Path, events: list[dict[str, object]]) -> None:
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_charts_template_renders_three_canvases(audit_file: Path) -> None:
    """GET /modules/gateway-audit/charts returns 200 HTML with the three
    canvas elements (requests-over-time, top-domains, status-distribution)."""
    _write_events(
        audit_file,
        [
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/r",
                "decision": "allowed",
                "client_ip": "1.1.1.1",
                "status": 200,
            }
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/gateway-audit/charts")
    assert r.status_code == 200
    body = r.text
    # The three canvas IDs the Chart.js script targets.
    assert '<canvas id="requests-over-time"' in body
    assert '<canvas id="top-domains"' in body
    assert '<canvas id="status-distribution"' in body
    # T-120: Chart.js is self-hosted with an SRI integrity hash (no CDN).
    assert "/static/chart.umd.min.js" in body
    assert 'integrity="sha384-' in body
    assert 'crossorigin="anonymous"' in body
    # The page references the existing recent() endpoint (the JS fetches it).
    assert "/api/v1/gateway-audit/recent" in body
    # Tab nav links back to the table page.
    assert 'href="/modules/gateway-audit"' in body
    # aria-label for accessibility (basic).
    assert 'aria-label="Requests over time line chart"' in body


def test_table_page_links_to_charts(audit_file: Path) -> None:
    """The existing table page now has a Charts tab linking to the new route."""
    _write_events(
        audit_file,
        [
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/r",
                "decision": "allowed",
                "client_ip": "1.1.1.1",
            }
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/gateway-audit")
    assert r.status_code == 200
    assert 'href="/modules/gateway-audit/charts"' in r.text
