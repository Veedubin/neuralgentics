"""Tests for team-server mode — health + modules endpoints.

We don't open a real PG pool here (no --db-url) so the team-server
mode still boots and serves /api/v1/health with ``mode: team-server``.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _config_no_db() -> WebConfig:
    return WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9877,
        db_url=None,
        modules_path=MODULES_DIR,
    )


def test_team_server_health_reports_team_server_mode() -> None:
    """``GET /api/v1/health`` returns ``{"status":"ok","mode":"team-server",...}``."""
    app = build_app(_config_no_db())
    with TestClient(app) as client:
        resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["mode"] == "team-server"
    # Without --db-url, db_connected must be False (not absent, not erroring).
    assert data["db_connected"] is False


def test_team_server_modules_endpoint_lists_three() -> None:
    """Same module discovery works in team-server mode."""
    app = build_app(_config_no_db())
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
