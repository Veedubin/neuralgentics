"""Tests for embedded mode — server starts and returns 200 on /."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_embedded_server_returns_200_on_root() -> None:
    """``GET /`` returns 200 HTML mentioning the 4 module cards."""
    app = build_app(_config())
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    body = resp.text
    assert "Gateway Audit" in body
    assert "Broker Audit" in body
    assert "Memory Browser" in body
    assert "Policy Editor" in body
    assert "embedded mode" in body


def test_embedded_modules_endpoint_lists_four() -> None:
    """``GET /api/v1/modules`` returns 4 modules."""
    app = build_app(_config())
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules")
    assert resp.status_code == 200
    data = resp.json()
    names = sorted(m["name"] for m in data["modules"])
    assert names == ["broker-audit", "gateway-audit", "memini-browser", "policy-editor"]
    assert data["total"] == 4
