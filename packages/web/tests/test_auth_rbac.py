"""Tests for neuralgentics.web.auth.rbac (T-109).

Covers:
  * require_role("admin") allows an admin user.
  * require_role("admin") denies a viewer with HTTP 403.
  * require_role raises HTTP 401 when request.state.user is unset.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException, Request
from starlette.datastructures import Headers

from neuralgentics.web.auth.rbac import require_role
from neuralgentics.web.auth.users import User


def _make_request(user: User | None) -> Request:
    """Build a minimal Request with state.user set (or absent)."""
    req = Request(
        scope={
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": Headers({}).raw,
            "query_string": b"",
            "client": ("127.0.0.1", 0),
        }
    )
    if user is not None:
        req.state.user = user
    return req


def test_require_role_admin_allows_admin_user() -> None:
    """A user with role=admin passes require_role('admin')."""
    dep = require_role("admin")
    user = User(username="root", role="admin", password_hash="x")
    assert dep(_make_request(user)) is user


def test_require_role_admin_denies_viewer_with_403() -> None:
    """A viewer calling an admin-only route gets HTTP 403, not 401."""
    dep = require_role("admin")
    user = User(username="anon", role="viewer", password_hash="x")
    with pytest.raises(HTTPException) as exc:
        dep(_make_request(user))
    assert exc.value.status_code == 403


def test_require_role_returns_401_when_user_missing() -> None:
    """No authenticated user on request.state → HTTP 401."""
    dep = require_role("admin")
    with pytest.raises(HTTPException) as exc:
        dep(_make_request(None))
    assert exc.value.status_code == 401
