"""Tests for neuralgentics.web.auth.users (T-109).

Covers:
  * First-run seeding creates 3 default users.
  * get_by_username finds an existing user and returns None for a missing one.
  * verify accepts correct password and rejects wrong password.
  * update_password changes the hash and is respected by verify.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from neuralgentics.web.auth.users import DEFAULT_USERS, UserStore


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    """A fresh UserStore backed by a temp sqlite file."""
    return UserStore(tmp_path / "test-users.db")


def test_seeding_creates_three_default_users(store: UserStore) -> None:
    """First run seeds admin/operator/viewer from DEFAULT_USERS."""
    users = store.list_users()
    assert len(users) == len(DEFAULT_USERS)
    names = {u.username for u in users}
    assert names == {"admin", "operator", "viewer"}
    for u in users:
        assert u.role in {"admin", "operator", "viewer"}
        assert u.password_hash.startswith("$2")  # bcrypt


def test_get_by_username_round_trip(store: UserStore) -> None:
    """get_by_username returns the seeded admin and None for a stranger."""
    admin = store.get_by_username("admin")
    assert admin is not None
    assert admin.role == "admin"
    assert store.get_by_username("does-not-exist") is None


def test_verify_accepts_correct_and_rejects_wrong_password(store: UserStore) -> None:
    """verify returns the User on correct password, None on wrong."""
    assert store.verify("admin", "admin") is not None
    assert store.verify("admin", "wrong-password") is None
    # Constant-time-ish path: nonexistent user also returns None.
    assert store.verify("ghost", "admin") is None


def test_update_password_is_respected_by_verify(store: UserStore) -> None:
    """Changing admin's password invalidates the old one."""
    assert store.update_password("admin", "new-secret")
    assert store.verify("admin", "admin") is None
    assert store.verify("admin", "new-secret") is not None
    # Updating a nonexistent user returns False.
    assert store.update_password("ghost", "x") is False
