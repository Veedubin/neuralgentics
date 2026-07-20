"""Tests for neuralgentics.web.auth.routes — /auth/* HTTP routes (T-109).

Covers:
  * POST /auth/login (form) + GET /auth/me round-trip with a seeded admin.
  * POST /auth/logout invalidates a refresh token (subsequent refresh fails).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.middleware import AuthMiddleware
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import UserStore

SECRET = "routes-test-secret"


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "routes-users.db")


def _build_app(store: UserStore, *, mode: str = "oauth2") -> FastAPI:
    app = FastAPI()
    if mode not in ("off", "jwt", "oauth2"):
        raise ValueError(f"invalid mode: {mode}")
    app.add_middleware(AuthMiddleware, mode=mode, user_store=store, secret=SECRET)  # type: ignore[arg-type]
    app.include_router(build_auth_router(store, secret=SECRET))
    return app


def test_login_then_me_round_trip(store: UserStore) -> None:
    """POST /auth/login as admin → use access_token on GET /auth/me."""
    app = _build_app(store, mode="oauth2")
    with TestClient(app) as client:
        login_resp = client.post(
            "/auth/login",
            data={"username": "admin", "password": "admin"},
        )
        assert login_resp.status_code == 200, login_resp.text
        access = login_resp.json()["access_token"]

        me_resp = client.get("/auth/me", headers={"Authorization": f"Bearer {access}"})
        assert me_resp.status_code == 200
        assert me_resp.json() == {"username": "admin", "role": "admin"}


def test_logout_invalidates_refresh(store: UserStore) -> None:
    """POST /auth/logout → refresh with the old token returns 401."""
    app = _build_app(store, mode="oauth2")
    with TestClient(app) as client:
        login_resp = client.post(
            "/auth/login",
            data={"username": "admin", "password": "admin"},
        )
        refresh_tok = login_resp.json()["refresh_token"]

        out = client.post("/auth/logout", json={"refresh_token": refresh_tok})
        assert out.status_code == 200
        assert out.json() == {"revoked": True}

        # The revoked refresh token can no longer be exchanged.
        bad = client.post("/auth/refresh", json={"refresh_token": refresh_tok})
        assert bad.status_code == 401


def test_login_bad_credentials_returns_401(store: UserStore) -> None:
    """Wrong password → 401, not 500."""
    app = _build_app(store, mode="oauth2")
    with TestClient(app) as client:
        resp = client.post(
            "/auth/login",
            data={"username": "admin", "password": "wrong"},
        )
    assert resp.status_code == 401


def test_me_without_token_returns_401(store: UserStore) -> None:
    """GET /auth/me with no Bearer token → 401 from the RBAC dependency."""
    app = _build_app(store, mode="oauth2")
    with TestClient(app) as client:
        resp = client.get("/auth/me")
    assert resp.status_code == 401


def test_viewer_cannot_access_admin_only_endpoint(store: UserStore) -> None:
    """A viewer JWT against an admin-only route returns 403 (RBAC enforced)."""
    app = _build_app(store, mode="oauth2")
    from fastapi import Depends, Request

    from neuralgentics.web.auth.rbac import require_role
    from neuralgentics.web.auth.users import User

    @app.get("/api/v1/admin-only")
    async def admin_only(
        request: Request,  # noqa: ARG001 — needed so middleware runs first
        user: User = Depends(require_role("admin")),
    ) -> dict[str, str]:
        return {"who": user.username}

    # Viewer access token issued directly (not via login).
    viewer_tok = issue_access_token("viewer", "viewer", secret=SECRET)
    with TestClient(app) as client:
        resp = client.get("/api/v1/admin-only", headers={"Authorization": f"Bearer {viewer_tok}"})
    assert resp.status_code == 403
