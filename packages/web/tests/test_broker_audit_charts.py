"""Tests for the broker-audit charts page (T-118).

Covers:
  * GET /modules/broker-audit/charts returns 200 HTML containing the two
    ``<canvas>`` elements used by Chart.js.
  * The page loads the Chart.js CDN script tag.
  * The page links back to the existing table page (Table/Charts tab nav).
  * The existing table page now contains a "Charts" link to the new route.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import neuralgentics.web.modules.broker_audit.data_source as ds_mod
from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


@pytest.fixture(autouse=True)
def fast_poll_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make JSONLBrokerAuditSource poll every 0.2s (so tests run fast)."""
    orig = ds_mod.JSONLBrokerAuditSource.__init__
    monkeypatch.setattr(
        ds_mod.JSONLBrokerAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: orig(self, path, poll_interval),
    )


@pytest.fixture
def broker_audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "broker-audit.jsonl"
    p.write_text("")
    monkeypatch.setenv("NEURALGENTICS_BROKER_AUDIT_FILE", str(p))
    return p


def _write_events(p: Path, events: list[dict[str, object]]) -> None:
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def _event(
    *,
    ts: str = "2026-07-19T12:00:00Z",
    role: str = "coder",
    server: str = "filesystem",
    tool: str = "read_file",
    success: bool = True,
    duration_ms: int = 45,
) -> dict[str, object]:
    return {
        "ts": ts,
        "agent_role": role,
        "server": server,
        "tool": tool,
        "args_hash": "sha256:abc",
        "success": success,
        "result_size": 1234,
        "duration_ms": duration_ms,
        "error": "",
    }


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_charts_template_renders_two_canvases(broker_audit_file: Path) -> None:
    """GET /modules/broker-audit/charts returns 200 HTML with the two
    canvas elements (tool-calls-over-time, top-tools)."""
    _write_events(broker_audit_file, [_event()])
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/broker-audit/charts")
    assert r.status_code == 200
    body = r.text
    assert '<canvas id="tool-calls-over-time"' in body
    assert '<canvas id="top-tools"' in body
    # Chart.js CDN script tag is present.
    assert "cdn.jsdelivr.net/npm/chart.js@4.4.0" in body
    # The page references the existing recent() endpoint.
    assert "/api/v1/broker-audit/recent" in body
    # Tab nav links back to the table page.
    assert 'href="/modules/broker-audit"' in body
    # aria-label for accessibility (basic).
    assert 'aria-label="Tool calls over time stacked bar chart"' in body


def test_table_page_links_to_charts(broker_audit_file: Path) -> None:
    """The existing table page now has a Charts tab linking to the new route."""
    _write_events(broker_audit_file, [_event()])
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/broker-audit")
    assert r.status_code == 200
    assert 'href="/modules/broker-audit/charts"' in r.text
