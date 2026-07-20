"""Tests for neuralgentics.web.auth.jwt (T-109).

Covers:
  * Sign + verify round-trip.
  * Expired token is rejected.
  * Bad signature is rejected.
  * ``type`` claim distinguishes access vs refresh.
"""

from __future__ import annotations

import time

import jwt
import pytest

from neuralgentics.web.auth.jwt import (
    ALG,
    decode_access_token,
    decode_refresh_token,
    decode_token,
    issue_access_token,
    issue_refresh_token,
)

SECRET = "test-secret-key-for-jwt-tests-do-not-use-in-prod"


def test_sign_and_verify_roundtrip() -> None:
    """issue_access_token → decode_access_token returns the same sub/role."""
    tok = issue_access_token("alice", "admin", secret=SECRET)
    payload = decode_access_token(tok, secret=SECRET)
    assert payload["sub"] == "alice"
    assert payload["role"] == "admin"
    assert payload["type"] == "access"
    # Refresh variant must NOT validate as access.
    rtok = issue_refresh_token("alice", "admin", secret=SECRET)
    with pytest.raises(jwt.InvalidTokenError):
        decode_access_token(rtok, secret=SECRET)
    rpayload = decode_refresh_token(rtok, secret=SECRET)
    assert rpayload["type"] == "refresh"


def test_expired_token_rejected() -> None:
    """A token whose exp is in the past raises ExpiredSignatureError."""
    now = int(time.time())
    payload = {
        "sub": "bob",
        "role": "viewer",
        "type": "access",
        "iat": now - 10,
        "exp": now - 1,
    }
    tok = jwt.encode(payload, SECRET, algorithm=ALG)
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_token(tok, secret=SECRET)


def test_bad_signature_rejected() -> None:
    """A token signed with a different secret is rejected."""
    tok = issue_access_token("carol", "operator", secret=SECRET)
    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(tok, secret="a-different-secret-entirely")
