"""Tests for neuralgentics.web.auth.middleware (T-109).

Covers:
  * Valid access token attaches the resolved User to request.state.user.
  * Missing Authorization header returns 401 with WWW-Authenticate.
  * ``mode=off`` short-circuits and lets everything through.
  * Public path (``/``) bypasses auth.
  * Refresh token is not accepted as an access token.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from neuralgentics.web.auth.jwt import issue_access_token, issue_refresh_token
from neuralgentics.web.auth.middleware import AuthMiddleware
from neuralgentics.web.auth.users import UserStore

SECRET = "mw-test-secret"


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "mw-users.db")


def _build_app(store: UserStore, *, mode: str = "jwt") -> FastAPI:
    """Minimal app exposing one gated route that reflects request.state.user."""
    app = FastAPI()
    if mode not in ("off", "jwt", "oauth2"):
        raise ValueError(f"invalid mode: {mode}")
    app.add_middleware(AuthMiddleware, mode=mode, user_store=store, secret=SECRET)  # type: ignore[arg-type]

    @app.get("/api/v1/me")
    async def me(request: Request) -> dict[str, str | None]:
        user = getattr(request.state, "user", None)
        return {"user": user.username if user is not None else None}

    return app


def test_valid_token_attaches_user(store: UserStore) -> None:
    """Bearer <valid admin JWT> → /api/v1/me returns the username."""
    tok = issue_access_token("admin", "admin", secret=SECRET)
    app = _build_app(store, mode="jwt")
    with TestClient(app) as client:
        resp = client.get("/api/v1/me", headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"] == "admin"


def test_missing_token_returns_401_with_www_authenticate(store: UserStore) -> None:
    """No Authorization header → 401 + WWW-Authenticate: Bearer."""
    app = _build_app(store, mode="jwt")
    with TestClient(app) as client:
        resp = client.get("/api/v1/me")
    assert resp.status_code == 401
    assert resp.headers["WWW-Authenticate"].startswith("Bearer")


def test_mode_off_lets_unauthenticated_requests_through(store: UserStore) -> None:
    """With mode=off the middleware attaches user=None and returns 200."""
    app = _build_app(store, mode="off")
    with TestClient(app) as client:
        resp = client.get("/api/v1/me")
    assert resp.status_code == 200
    assert resp.json()["user"] is None


def test_public_path_bypasses_auth(store: UserStore) -> None:
    """``/`` is whitelisted and returns 200 even without a token."""
    app = _build_app(store, mode="jwt")

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"ok": "true"}

    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200


def test_refresh_token_rejected_as_access(store: UserStore) -> None:
    """A refresh token is not accepted as a Bearer access token."""
    tok = issue_refresh_token("admin", "admin", secret=SECRET)
    app = _build_app(store, mode="jwt")
    with TestClient(app) as client:
        resp = client.get("/api/v1/me", headers={"Authorization": f"Bearer {tok}"})
    assert resp.status_code == 401
