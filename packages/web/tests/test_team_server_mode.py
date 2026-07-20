"""Tests for team-server mode — health + modules endpoints.

We don't open a real PG pool here (no --db-url) so the team-server
mode still boots and serves /api/v1/health with ``mode: team-server``.

T-109 update: team-server now requires auth by default (``--auth=jwt``).
The modules endpoint returns 401 without a token, 200 with an admin JWT.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"
SECRET = "team-server-test-secret"


def _config_no_db(tmp_path: Path | None = None) -> WebConfig:
    from neuralgentics.web.config import AuthConfig

    db = tmp_path / "ts-users.db" if tmp_path else Path("/tmp/ts-test-users.db")
    cfg = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9877,
        db_url=None,
        modules_path=MODULES_DIR,
    )
    cfg.auth = AuthConfig(auth_mode="jwt", jwt_secret=SECRET, db_path=db)
    return cfg


def test_team_server_health_reports_team_server_mode(tmp_path: Path) -> None:
    """``GET /api/v1/health`` returns ``{"status":"ok","mode":"team-server",...}``."""
    # Health is a public path — no token needed.
    app = build_app(_config_no_db(tmp_path))
    with TestClient(app) as client:
        resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["mode"] == "team-server"
    assert data["db_connected"] is False
    assert data["auth_mode"] == "jwt"
    assert data["users_seeded"] == 3


def test_team_server_modules_endpoint_requires_auth(tmp_path: Path) -> None:
    """T-109 AC #5: no token → 401 with WWW-Authenticate."""
    app = build_app(_config_no_db(tmp_path))
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules")
    assert resp.status_code == 401
    assert resp.headers["WWW-Authenticate"].startswith("Bearer")


def test_team_server_modules_endpoint_lists_three_with_admin_token(tmp_path: Path) -> None:
    """T-109 AC #6: admin JWT → /api/v1/modules returns 200 with 3 modules."""
    UserStore(tmp_path / "ts-users.db")  # pre-seed
    app = build_app(_config_no_db(tmp_path))
    tok = issue_access_token("admin", "admin", secret=SECRET)
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules", headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
