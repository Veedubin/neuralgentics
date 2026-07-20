"""Tests for neuralgentics.web.auth.oauth2_stub service layer (T-109).

Covers:
  * login succeeds with correct seeded credentials → TokenSet.
  * login raises AuthError on bad password.
  * refresh rotates: the old refresh token is revoked and a new pair is issued.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from neuralgentics.web.auth.jwt import decode_access_token, decode_refresh_token
from neuralgentics.web.auth.oauth2_stub import AuthError, login, logout, refresh
from neuralgentics.web.auth.users import UserStore

SECRET = "oauth2-test-secret"


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "oauth-users.db")


def test_login_success_with_seeded_admin(store: UserStore) -> None:
    """login(admin/admin) returns a TokenSet whose tokens decode cleanly."""
    tokens = login(username="admin", password="admin", store=store, secret=SECRET)
    acc = decode_access_token(tokens.access_token, secret=SECRET)
    ref = decode_refresh_token(tokens.refresh_token, secret=SECRET)
    assert acc["sub"] == "admin" and acc["role"] == "admin" and acc["type"] == "access"
    assert ref["sub"] == "admin" and ref["type"] == "refresh"
    assert tokens.token_type == "bearer"
    assert tokens.expires_in == 24 * 60 * 60


def test_login_bad_credentials_raises(store: UserStore) -> None:
    """A wrong password raises AuthError (401), not a None return."""
    with pytest.raises(AuthError) as exc:
        login(username="admin", password="nope", store=store, secret=SECRET)
    assert exc.value.status_code == 401


def test_refresh_rotates_and_revokes_old_token(store: UserStore) -> None:
    """A successful refresh issues a new pair and invalidates the old refresh."""
    first = login(username="admin", password="admin", store=store, secret=SECRET)
    second = refresh(refresh_token=first.refresh_token, store=store, secret=SECRET)
    # New pair is valid and distinct.
    assert second.access_token != first.access_token
    assert second.refresh_token != first.refresh_token
    decode_access_token(second.access_token, secret=SECRET)
    # Old refresh token is now revoked.
    with pytest.raises(AuthError):
        refresh(refresh_token=first.refresh_token, store=store, secret=SECRET)


def test_logout_revokes_refresh_token(store: UserStore) -> None:
    """logout marks the refresh token as revoked; refresh then fails."""
    tokens = login(username="admin", password="admin", store=store, secret=SECRET)
    assert logout(refresh_token=tokens.refresh_token, store=store) is True
    with pytest.raises(AuthError):
        refresh(refresh_token=tokens.refresh_token, store=store, secret=SECRET)
