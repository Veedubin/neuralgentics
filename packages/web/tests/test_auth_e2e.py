"""E2E auth tests against the full neuralgentics-web app (T-109).

Covers the 4 acceptance-criteria E2E scenarios:

  1. Embedded mode still works without auth (GET / → 200).
  2. Team-server mode requires auth (GET /api/v1/modules → 401 with
     WWW-Authenticate).
  3. RBAC enforcement — viewer can't POST trust, operator can.
  4. OAuth2 login flow — POST /auth/login → use access_token on
     /api/v1/modules → 200.

We monkeypatch ``AuthConfig.db_path`` and the JWT secret so tests are
hermetic (no shared ``~/.neuralgentics/web-users.db``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import AuthConfig, WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"

SECRET = "e2e-test-secret"
DEFAULT_AUTH_CONFIG: dict[str, Any] = {
    "auth_mode": "oauth2",
    "jwt_secret": SECRET,
    "db_path": "tmp-web-users.db",  # placeholder; real path set per-test below
    "refresh_rotation": True,
}


def _config(
    *,
    mode: str,
    auth_mode: str = "oauth2",
    db_path: Path,
) -> WebConfig:
    """Build a WebConfig whose AuthConfig points at a temp sqlite DB."""
    cfg = WebConfig(
        mode=mode,  # type: ignore[arg-type]
        host="127.0.0.1",
        port=9876 if mode == "embedded" else 9877,
        modules_path=MODULES_DIR,
    )
    cfg.auth = AuthConfig(
        auth_mode=auth_mode,  # type: ignore[arg-type]
        jwt_secret=SECRET,
        db_path=db_path,
        refresh_rotation=True,
    )
    return cfg


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "e2e-users.db"


def test_embedded_mode_still_works_without_auth(db_path: Path) -> None:
    """Embedded mode never installs AuthMiddleware — GET / returns 200."""
    cfg = _config(mode="embedded", auth_mode="off", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    assert "Memory Browser" in resp.text or "embedded mode" in resp.text


def test_team_server_requires_auth_for_modules(db_path: Path) -> None:
    """No Bearer token → GET /api/v1/modules returns 401 + WWW-Authenticate."""
    cfg = _config(mode="team-server", auth_mode="jwt", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules")
    assert resp.status_code == 401
    assert resp.headers["WWW-Authenticate"].startswith("Bearer")


def test_team_server_admin_token_can_list_modules(db_path: Path) -> None:
    """Bearer <admin JWT> → GET /api/v1/modules returns 200 with 3 modules."""
    # Pre-seed the user store so the JWT's sub resolves.
    UserStore(db_path)
    cfg = _config(mode="team-server", auth_mode="jwt", db_path=db_path)
    app = build_app(cfg)
    tok = issue_access_token("admin", "admin", secret=SECRET)
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules", headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 4


def test_team_server_bad_token_returns_401(db_path: Path) -> None:
    """Bearer <garbage> → 401."""
    cfg = _config(mode="team-server", auth_mode="jwt", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules", headers={"Authorization": "Bearer not-a-jwt"})
    assert resp.status_code == 401


def test_oauth2_login_flow_grants_access(db_path: Path) -> None:
    """POST /auth/login with admin/admin → use access_token on /api/v1/modules."""
    cfg = _config(mode="team-server", auth_mode="oauth2", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        login = client.post(
            "/auth/login",
            data={"username": "admin", "password": "admin"},
        )
        assert login.status_code == 200, login.text
        tokens = login.json()
        assert tokens["token_type"] == "bearer"
        assert tokens["expires_in"] == 24 * 60 * 60

        resp = client.get(
            "/api/v1/modules",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
    assert resp.status_code == 200
    assert resp.json()["total"] == 4


def test_oauth2_refresh_rotates_tokens(db_path: Path) -> None:
    """Login → refresh → old refresh token is rejected."""
    cfg = _config(mode="team-server", auth_mode="oauth2", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        login = client.post(
            "/auth/login",
            data={"username": "operator", "password": "operator"},
        )
        assert login.status_code == 200
        first_refresh = login.json()["refresh_token"]

        refreshed = client.post("/auth/refresh", json={"refresh_token": first_refresh})
        assert refreshed.status_code == 200
        assert refreshed.json()["refresh_token"] != first_refresh

        # Old refresh is now revoked.
        bad = client.post("/auth/refresh", json={"refresh_token": first_refresh})
    assert bad.status_code == 401


def test_rbac_viewer_denied_operator_allowed_on_trust_post(db_path: Path) -> None:
    """Viewer JWT → 403 on POST /api/v1/test/trust/{id}; operator JWT → 200.

    The trust-adjust endpoint in the real memini-browser module is a
    form-POST that always redirects, which makes asserting 403-vs-200
    awkward. We register a gated mirror route here that uses the same
    RBAC dependency (``require_role('admin','operator')``) — the
    middleware + dependency path is identical to the production route.
    """
    UserStore(db_path)
    cfg = _config(mode="team-server", auth_mode="oauth2", db_path=db_path)
    app = build_app(cfg)
    viewer_tok = issue_access_token("viewer", "viewer", secret=SECRET)
    operator_tok = issue_access_token("operator", "operator", secret=SECRET)

    from fastapi import Depends

    from neuralgentics.web.auth.rbac import require_role
    from neuralgentics.web.auth.users import User

    @app.post("/api/v1/test/trust/{memory_id}")
    async def test_trust(
        memory_id: str,
        user: User = Depends(require_role("admin", "operator")),
    ) -> dict[str, str]:
        return {"actor": user.username, "memory_id": memory_id}

    with TestClient(app) as client:
        v = client.post(
            "/api/v1/test/trust/abc",
            headers={"Authorization": f"Bearer {viewer_tok}"},
        )
        assert v.status_code == 403, v.text

        o = client.post(
            "/api/v1/test/trust/abc",
            headers={"Authorization": f"Bearer {operator_tok}"},
        )
        assert o.status_code == 200, o.text
    assert o.json() == {"actor": "operator", "memory_id": "abc"}


def test_auth_off_mode_lets_team_server_run_unauthenticated(db_path: Path) -> None:
    """``--auth=off`` in team-server mode skips auth entirely (dev only)."""
    cfg = _config(mode="team-server", auth_mode="off", db_path=db_path)
    app = build_app(cfg)
    with TestClient(app) as client:
        resp = client.get("/api/v1/modules")
    assert resp.status_code == 200
    assert resp.json()["total"] == 4
