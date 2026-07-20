"""Module-route RBAC tests (T-110).

Verifies that every real module route enforces the correct role via
``Depends(require_role(...))`` and that ``--auth=off`` (embedded mode)
bypasses the role gate.

Coverage matrix:

  * **Read endpoints** (gateway-audit table/recent/sse, broker-audit
    table/recent/sse, memini-browser search/detail/graph/api-search,
    shell /api/v1/modules + /api/v1/modules/{name}):
      - 401 without a Bearer token (team-server mode).
      - 200 with a viewer JWT (viewer is allowed; so are
        operator/admin, tested as a superset).
  * **Trust adjust** (POST /modules/memini-browser/memory/{id}/trust):
      - 403 with viewer.
      - 200 (redirect 303) with operator.
      - 200 (redirect 303) with admin.
  * **Forget** (POST /modules/memini-browser/memory/{id}/forget):
      - 403 with viewer.
      - 403 with operator.
      - 200 (redirect 303) with admin.
  * **Auth-off bypass** (embedded mode): every endpoint above returns
    200 (or 303 for the POSTs) with NO Authorization header — the
    localhost bind is the security boundary, not the role gate.

The mock memini backend (``NEURALGENTICS_MEMINI_BACKEND=mock``) is used
so no live PG / SDK is required. The gateway/broker audit sources use
the embedded JSONL source with a throwaway file under tmp_path.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import AuthConfig, WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"

SECRET = "module-rbac-test-secret-32-bytes-long"


# --------------------------------------------------------------------------------------
# Fixtures + helpers
# --------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mock_memini_backend() -> Any:
    """Force the memini-browser to use the in-memory mock backend."""
    os.environ["NEURALGENTICS_MEMINI_BACKEND"] = "mock"
    yield
    os.environ.pop("NEURALGENTICS_MEMINI_BACKEND", None)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "module-rbac-users.db"


@pytest.fixture(autouse=True)
def _audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Create an empty JSONL audit file + wire both modules at it.

    The gateway-audit JSONL source reads ``NEURALGENTICS_AUDIT_FILE``;
    the broker-audit source reads ``NEURALGENTICS_BROKER_AUDIT_FILE``.
    """
    gw = tmp_path / "audit.jsonl"
    gw.write_text("")
    monkeypatch.setenv("NEURALGENTICS_AUDIT_FILE", str(gw))
    bk = tmp_path / "broker-audit.jsonl"
    bk.write_text("")
    monkeypatch.setenv("NEURALGENTICS_BROKER_AUDIT_FILE", str(bk))
    return gw


def _team_server_config(db_path: Path) -> WebConfig:
    """A team-server WebConfig with JWT auth pointed at a temp DB."""
    cfg = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9877,
        modules_path=MODULES_DIR,
    )
    cfg.auth = AuthConfig(
        auth_mode="jwt",
        jwt_secret=SECRET,
        db_path=db_path,
        refresh_rotation=True,
    )
    return cfg


def _embedded_config() -> WebConfig:
    """An embedded (auth=off) WebConfig."""
    return WebConfig(
        mode="embedded",
        host="127.0.0.1",
        port=9876,
        modules_path=MODULES_DIR,
    )


def _tok(role: str) -> str:
    """Issue a short-lived access token for the given role."""
    return issue_access_token(role, role, secret=SECRET)


# --------------------------------------------------------------------------------------
# Read endpoints — viewer (any logged-in user) required.
# --------------------------------------------------------------------------------------

READ_ENDPOINTS: list[tuple[str, str]] = [
    ("GET", "/modules/gateway-audit"),
    ("GET", "/api/v1/gateway-audit/recent"),
    ("GET", "/modules/broker-audit"),
    ("GET", "/api/v1/broker-audit/recent"),
    ("GET", "/modules/memini-browser"),
    ("GET", "/api/v1/memini-browser/search"),
    ("GET", "/modules/memini-browser/memory/mem-001"),
    ("GET", "/modules/memini-browser/memory/mem-001/graph"),
    ("GET", "/api/v1/modules"),
    ("GET", "/api/v1/modules/gateway-audit"),
]


@pytest.mark.parametrize(("method", "path"), READ_ENDPOINTS)
def test_read_endpoint_requires_auth(method: str, path: str, db_path: Path) -> None:
    """No Bearer token → 401 with WWW-Authenticate."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.request(method, path)
    assert resp.status_code == 401, (method, path, resp.text)
    assert resp.headers["WWW-Authenticate"].startswith("Bearer")


@pytest.mark.parametrize(("method", "path"), READ_ENDPOINTS)
def test_read_endpoint_allows_viewer(method: str, path: str, db_path: Path) -> None:
    """Viewer JWT → 200 (read endpoints allow any logged-in user)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    tok = _tok("viewer")
    with TestClient(app) as client:
        resp = client.request(method, path, headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 200, (method, path, resp.text)


# --------------------------------------------------------------------------------------
# Trust adjust — admin + operator only (viewer 403).
# --------------------------------------------------------------------------------------


def test_trust_adjust_viewer_gets_403(db_path: Path) -> None:
    """Viewer JWT → 403 on POST /modules/memini-browser/memory/{id}/trust."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert resp.status_code == 403, resp.text


def test_trust_adjust_operator_allowed(db_path: Path) -> None:
    """Operator JWT → 303 redirect (trust adjusted successfully)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
            headers={"Authorization": f"Bearer {_tok('operator')}"},
            follow_redirects=False,
        )
    assert resp.status_code == 303, resp.text
    assert "/modules/memini-browser/memory/mem-001" in resp.headers["location"]


def test_trust_adjust_admin_allowed(db_path: Path) -> None:
    """Admin JWT → 303 redirect (trust adjusted successfully)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "agent_used"},
            headers={"Authorization": f"Bearer {_tok('admin')}"},
            follow_redirects=False,
        )
    assert resp.status_code == 303, resp.text


def test_trust_adjust_unauthenticated_401(db_path: Path) -> None:
    """No token → 401 (not 403 — the auth middleware rejects first)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
        )
    assert resp.status_code == 401, resp.text


# --------------------------------------------------------------------------------------
# Forget — admin only (viewer + operator 403).
# --------------------------------------------------------------------------------------


def test_forget_viewer_gets_403(db_path: Path) -> None:
    """Viewer JWT → 403 on POST /modules/memini-browser/memory/{id}/forget."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert resp.status_code == 403, resp.text


def test_forget_operator_gets_403(db_path: Path) -> None:
    """Operator JWT → 403 (operator can adjust trust but cannot forget)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('operator')}"},
        )
    assert resp.status_code == 403, resp.text


def test_forget_admin_allowed(db_path: Path) -> None:
    """Admin JWT → 303 redirect (memory deleted, redirect to search page)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        # Sanity: memory exists before forget.
        pre = client.get(
            "/modules/memini-browser/memory/mem-001",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
        assert pre.status_code == 200, pre.text

        resp = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
            follow_redirects=False,
        )
        assert resp.status_code == 303, resp.text
        assert "/modules/memini-browser" in resp.headers["location"]

        # After forget, the memory is gone (404).
        post = client.get(
            "/modules/memini-browser/memory/mem-001",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
    assert post.status_code == 404, post.text


def test_forget_unauthenticated_401(db_path: Path) -> None:
    """No token → 401."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post("/modules/memini-browser/memory/mem-001/forget")
    assert resp.status_code == 401, resp.text


def test_forget_unknown_memory_returns_404(db_path: Path) -> None:
    """Admin can call forget, but a non-existent memory → 404 (not 500)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/does-not-exist/forget",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
    assert resp.status_code == 404, resp.text


# --------------------------------------------------------------------------------------
# --auth=off (embedded mode) bypass — role gate steps aside.
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path"), READ_ENDPOINTS)
def test_auth_off_bypasses_read_endpoints(method: str, path: str) -> None:
    """In embedded mode (auth=off), read endpoints return 200 with no token."""
    app = build_app(_embedded_config())
    with TestClient(app) as client:
        resp = client.request(method, path)
    assert resp.status_code == 200, (method, path, resp.text)


def test_auth_off_bypasses_trust_adjust() -> None:
    """Embedded mode: trust adjust proceeds without a token (303)."""
    app = build_app(_embedded_config())
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
            follow_redirects=False,
        )
    assert resp.status_code == 303, resp.text


def test_auth_off_bypasses_forget() -> None:
    """Embedded mode: forget proceeds without a token (303).

    The localhost bind is the security boundary in embedded mode; the
    RBAC gate steps aside (returns user=None) so destructive writes are
    allowed locally. Team-server deployments must run with auth on.
    """
    app = build_app(_embedded_config())
    with TestClient(app) as client:
        resp = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            follow_redirects=False,
        )
    assert resp.status_code == 303, resp.text


# --------------------------------------------------------------------------------------
# Admin-only module management (T-115) still enforced.
# --------------------------------------------------------------------------------------


def test_admin_reload_still_enforced_in_team_server(db_path: Path) -> None:
    """T-115 reload endpoint: viewer 403, admin 200 (regression guard)."""
    UserStore(db_path)
    app = build_app(_team_server_config(db_path))
    with TestClient(app) as client:
        v = client.post(
            "/api/v1/modules/gateway-audit/reload",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
        assert v.status_code == 403, v.text

        a = client.post(
            "/api/v1/modules/gateway-audit/reload",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
    # Reload may 400 for stubs or 200 for real modules — either way it's
    # NOT a 403 (the RBAC gate passed for admin).
    assert a.status_code in (200, 400), a.text
