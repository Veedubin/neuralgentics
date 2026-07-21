"""Tests for T-INSTALL-005: /auth/me in --auth=off mode + seeding suppression.

Two bugs reported from the install test on test-bunty (2026-07-20):

  1. ``GET /auth/me`` in ``--auth=off`` mode returned HTTP 500 instead of
     a sensible response. Root cause: the route used
     ``Depends(require_role(...))`` which returns ``None`` in auth-off
     mode (anonymous pass-through), then dereferenced ``user.username``
     → ``AttributeError`` → 500.

  2. The startup warning "seeding 3 default users (admin/admin, ...)"
     fired in embedded mode, where there is no ``/auth/login`` page to
     actually use those users. The warning is misleading.

These tests verify the fixes:

  * ``/auth/me`` in auth-off mode returns 200 with
    ``{"authenticated": false, "mode": "off", "user": null}`` (no 500).
  * EmbeddedMode constructs a UserStore with ``seed_defaults=False``.
  * The default-user seeding warning is absent in embedded mode.
  * Team-server mode with ``--auth=off`` also skips seeding.
  * Team-server mode with ``--auth=jwt`` (default) still seeds.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from neuralgentics.web.auth.middleware import AuthMiddleware
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import DEFAULT_USERS, UserStore
from neuralgentics.web.config import WebConfig
from neuralgentics.web.modes import EmbeddedMode, TeamServerMode

SECRET = "t-install-005-test-secret"

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _build_off_app(store: UserStore) -> FastAPI:
    """Build a minimal app with auth=off + the /auth router mounted.

    Mirrors what TeamServerMode.configure does when ``--auth=off`` is
    passed: middleware mode=off + /auth router included.
    """
    app = FastAPI()
    app.add_middleware(AuthMiddleware, mode="off", user_store=store, secret=SECRET)  # type: ignore[arg-type]
    app.include_router(build_auth_router(store, secret=SECRET, auth_mode="off"))
    return app


# ---------------------------------------------------------------------------
# /auth/me in auth-off mode
# ---------------------------------------------------------------------------


def test_auth_me_in_off_mode_returns_200_not_500(tmp_path: Path) -> None:
    """GET /auth/me with --auth=off returns 200, not 500.

    T-INSTALL-005: the previous behavior was a 500 (AttributeError from
    ``user.username`` when user is None). The fix returns a clean JSON
    body so clients can distinguish "no auth configured" (200, mode=off)
    from "auth configured but no token" (401, missing_token).
    """
    store = UserStore(tmp_path / "off-users.db", seed_defaults=False)
    app = _build_off_app(store)
    with TestClient(app) as client:
        resp = client.get("/auth/me")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text}"
    body = resp.json()
    assert body == {"authenticated": False, "mode": "off", "user": None}, (
        f"unexpected /auth/me body in off mode: {body!r}"
    )


def test_auth_me_in_off_mode_never_500(tmp_path: Path) -> None:
    """Regression: /auth/me in auth-off mode MUST NOT return 500.

    This is the exact symptom reported on test-bunty — a 500 from the
    route handler. We assert explicitly that the status code is not 5xx
    so a future regression (e.g. someone re-introducing
    ``user.username`` without a None-check) trips this test even if the
    fix shape changes.
    """
    store = UserStore(tmp_path / "off-users.db", seed_defaults=False)
    app = _build_off_app(store)
    with TestClient(app) as client:
        resp = client.get("/auth/me")
    assert resp.status_code < 500, (
        f"/auth/me 500'd in auth-off mode (regression of T-INSTALL-005): "
        f"status={resp.status_code} body={resp.text[:200]!r}"
    )


# ---------------------------------------------------------------------------
# Seeding warning suppression
# ---------------------------------------------------------------------------


def test_embedded_mode_does_not_seed_default_users(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """EmbeddedMode builds a UserStore with seed_defaults=False.

    T-INSTALL-005: the "seeding 3 default users" warning must NOT fire
    in embedded mode. We assert two things:
      1. The users table is empty after EmbeddedMode construction.
      2. Neither the WARNING log nor the stderr "seeding 3 default
         users" message appears.
    """
    config = WebConfig(
        mode="embedded",
        host="127.0.0.1",
        port=9876,
        modules_path=MODULES_DIR,
        auth=__import__(
            "neuralgentics.web.config",
            fromlist=["AuthConfig"],
        ).AuthConfig(
            auth_mode="off",
            db_path=tmp_path / "embedded-users.db",
        ),
    )
    with caplog.at_level(logging.WARNING, logger="neuralgentics.web.auth.users"):
        mode = EmbeddedMode(config)
    # No users seeded.
    users = mode.user_store.list_users()
    assert users == [], (
        f"EmbeddedMode seeded default users (regression of T-INSTALL-005): "
        f"users={[u.username for u in users]!r}"
    )
    # No "seeding" warning in logs.
    log_warnings = [
        r for r in caplog.records if "seeding" in r.message.lower() and "default users" in r.message
    ]
    assert not log_warnings, (
        f"unexpected 'seeding default users' log in embedded mode: "
        f"{[(r.levelname, r.message) for r in log_warnings]}"
    )
    # No "seeding" warning on stderr either.
    err = capsys.readouterr().err
    assert "seeding 3 default users" not in err, (
        f"unexpected 'seeding 3 default users' on stderr in embedded mode: {err!r}"
    )


def test_team_server_off_mode_does_not_seed_default_users(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """TeamServerMode with --auth=off skips default-user seeding.

    T-INSTALL-005: same rationale as embedded mode — when auth is
    explicitly disabled, the default users are unreachable and the
    warning is misleading.
    """
    config = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9000,
        modules_path=MODULES_DIR,
        auth=__import__(
            "neuralgentics.web.config",
            fromlist=["AuthConfig"],
        ).AuthConfig(
            auth_mode="off",
            db_path=tmp_path / "teamserver-off-users.db",
        ),
    )
    mode = TeamServerMode(config)
    users = mode.user_store.list_users()
    assert users == [], (
        f"TeamServerMode --auth=off seeded default users (regression of "
        f"T-INSTALL-005): users={[u.username for u in users]!r}"
    )
    err = capsys.readouterr().err
    assert "seeding 3 default users" not in err, (
        f"unexpected 'seeding 3 default users' on stderr in team-server --auth=off mode: {err!r}"
    )


def test_team_server_jwt_mode_still_seeds_default_users(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """TeamServerMode with --auth=jwt (default) still seeds default users.

    Regression guard: the seeding-suppression fix must NOT accidentally
    suppress seeding in the normal auth-enabled team-server mode, where
    the default users are reachable via the /auth/login form.
    """
    config = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9000,
        modules_path=MODULES_DIR,
        auth=__import__(
            "neuralgentics.web.config",
            fromlist=["AuthConfig"],
        ).AuthConfig(
            auth_mode="jwt",
            db_path=tmp_path / "teamserver-jwt-users.db",
            jwt_secret=SECRET,
        ),
    )
    TeamServerMode(config)
    # Re-open the store to read what was seeded.
    store = UserStore(tmp_path / "teamserver-jwt-users.db", seed_defaults=False)
    users = store.list_users()
    usernames = {u.username for u in users}
    assert usernames == {u for u, _p, _r in DEFAULT_USERS}, (
        f"TeamServerMode --auth=jwt did not seed default users: "
        f"got {usernames!r}, expected {{admin, operator, viewer}}"
    )


def test_userstore_seed_defaults_false_skips_seeding(tmp_path: Path) -> None:
    """Direct unit test: UserStore(seed_defaults=False) creates schema but no users."""
    store = UserStore(tmp_path / "no-seed.db", seed_defaults=False)
    assert store.list_users() == [], "seed_defaults=False should not seed any users"


def test_userstore_seed_defaults_true_still_seeds(tmp_path: Path) -> None:
    """Direct unit test: UserStore(seed_defaults=True) (default) still seeds."""
    store = UserStore(tmp_path / "seed.db")
    users = store.list_users()
    assert {u.username for u in users} == {"admin", "operator", "viewer"}
