"""JWT sign/verify for neuralgentics-web team-server mode (T-109).

HS256 only for v0.14.x — the team-server is intended for a trusted
network, so a single shared secret is acceptable. RS256 / asymmetric
keys are deferred to a future card.

Two token kinds:
  * **access**  — 24h expiry, used as ``Authorization: Bearer <token>``.
  * **refresh** — 7d expiry, used only at ``POST /auth/refresh``.

Both share the same secret + algorithm; the ``type`` claim distinguishes
them so a refresh token can't be accidentally used as an access token.
Every token carries a random ``jti`` (JWT ID) so two tokens issued in
the same second with the same sub/role still differ — this is what makes
refresh-token rotation safe (the new refresh token has a different
string even though everything else is identical).
"""

from __future__ import annotations

import os
import secrets
import sys
import time
from typing import Any

import jwt

ALG = "HS256"
ACCESS_TTL = 24 * 60 * 60  # 24h
REFRESH_TTL = 7 * 24 * 60 * 60  # 7d

_DEFAULT_SECRET: str | None = None


def _new_jti() -> str:
    """Return a fresh random JWT ID (16 url-safe chars)."""
    return secrets.token_urlsafe(12)


def get_or_create_secret() -> str:
    """Return ``$WEB_JWT_SECRET`` or generate + cache a random one.

    When a random secret is generated we print a loud warning to stderr so
    a dev never silently runs with an ephemeral secret in production.
    """
    global _DEFAULT_SECRET
    env = os.environ.get("WEB_JWT_SECRET")
    if env:
        return env
    if _DEFAULT_SECRET is None:
        _DEFAULT_SECRET = secrets.token_urlsafe(48)
        print(
            "WARNING: neuralgentics-web — WEB_JWT_SECRET not set; generated an "
            "ephemeral random secret. All tokens invalidate on restart. "
            "Set WEB_JWT_SECRET for persistent auth in team-server mode.",
            file=sys.stderr,
        )
    return _DEFAULT_SECRET


def issue_access_token(subject: str, role: str, secret: str | None = None) -> str:
    """Sign a 24h access JWT for ``subject`` (username) with ``role``."""
    sec = secret if secret is not None else get_or_create_secret()
    now = int(time.time())
    payload = {
        "sub": subject,
        "role": role,
        "type": "access",
        "jti": _new_jti(),
        "iat": now,
        "exp": now + ACCESS_TTL,
    }
    return jwt.encode(payload, sec, algorithm=ALG)


def issue_refresh_token(subject: str, role: str, secret: str | None = None) -> str:
    """Sign a 7d refresh JWT for ``subject`` (username) with ``role``."""
    sec = secret if secret is not None else get_or_create_secret()
    now = int(time.time())
    payload = {
        "sub": subject,
        "role": role,
        "type": "refresh",
        "jti": _new_jti(),
        "iat": now,
        "exp": now + REFRESH_TTL,
    }
    return jwt.encode(payload, sec, algorithm=ALG)


def decode_token(token: str, secret: str | None = None) -> dict[str, Any]:
    """Verify + decode a JWT. Raises ``jwt.InvalidTokenError`` on failure."""
    sec = secret if secret is not None else get_or_create_secret()
    return jwt.decode(token, sec, algorithms=[ALG])


def decode_access_token(token: str, secret: str | None = None) -> dict[str, Any]:
    """Decode + assert the token is an *access* token.

    Raises ``jwt.InvalidTokenError`` if the signature/expiry is bad or the
    ``type`` claim isn't ``"access"``.
    """
    payload = decode_token(token, secret=secret)
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("not an access token")
    return payload


def decode_refresh_token(token: str, secret: str | None = None) -> dict[str, Any]:
    """Decode + assert the token is a *refresh* token."""
    payload = decode_token(token, secret=secret)
    if payload.get("type") != "refresh":
        raise jwt.InvalidTokenError("not a refresh token")
    return payload


__all__ = [
    "ALG",
    "ACCESS_TTL",
    "REFRESH_TTL",
    "get_or_create_secret",
    "issue_access_token",
    "issue_refresh_token",
    "decode_token",
    "decode_access_token",
    "decode_refresh_token",
]
