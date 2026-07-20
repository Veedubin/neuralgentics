"""OAuth2 stub: login + refresh + logout business logic (T-109).

This is the *service layer* — pure functions that take a
:class:`~neuralgentics.web.auth.users.UserStore` and a secret and return
plain dicts suitable for JSON responses. The thin HTTP layer lives in
:mod:`neuralgentics.web.auth.routes` and is what FastAPI actually calls.

Refresh-token rotation is ON by default: every successful refresh
issues a new refresh token and revokes the old one. This limits the
blast radius of a stolen refresh token to one use.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from neuralgentics.web.auth.jwt import (
    ACCESS_TTL,
    decode_refresh_token,
    issue_access_token,
    issue_refresh_token,
)
from neuralgentics.web.auth.users import User, UserStore

log = logging.getLogger("neuralgentics.web.auth.oauth2_stub")


@dataclass(frozen=True)
class TokenSet:
    """One login/refresh response."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = ACCESS_TTL

    def as_dict(self) -> dict[str, object]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "token_type": self.token_type,
            "expires_in": self.expires_in,
        }


class AuthError(Exception):
    """Raised by the OAuth2 stub on bad credentials / bad tokens."""

    def __init__(self, detail: str, status_code: int = 401) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def login(
    *,
    username: str,
    password: str,
    store: UserStore,
    secret: str | None = None,
) -> TokenSet:
    """Verify ``username``/``password`` and return a fresh ``TokenSet``.

    Raises :class:`AuthError` (401) on bad credentials.
    """
    user = store.verify(username, password)
    if user is None:
        raise AuthError("invalid_credentials", status_code=401)
    return _issue_pair(user, store, secret=secret)


def refresh(
    *,
    refresh_token: str,
    store: UserStore,
    secret: str | None = None,
) -> TokenSet:
    """Exchange a valid refresh token for a new access + refresh pair.

    The old refresh token is revoked (rotation). Raises :class:`AuthError`
    on missing/expired/revoked tokens.
    """
    import jwt as _jwt

    try:
        payload = decode_refresh_token(refresh_token, secret=secret)
    except _jwt.ExpiredSignatureError as exc:
        raise AuthError("expired_token", status_code=401) from exc
    except _jwt.InvalidTokenError as exc:
        raise AuthError("invalid_token", status_code=401) from exc

    if not store.is_refresh_valid(refresh_token):
        raise AuthError("invalid_token", status_code=401)

    username = payload.get("sub")
    role = payload.get("role")
    if not isinstance(username, str) or not isinstance(role, str):
        raise AuthError("invalid_token", status_code=401)

    user = store.get_by_username(username)
    if user is None or user.role != role:
        raise AuthError("invalid_token", status_code=401)

    store.revoke_refresh(refresh_token)
    return _issue_pair(user, store, secret=secret)


def logout(
    *,
    refresh_token: str,
    store: UserStore,
) -> bool:
    """Revoke ``refresh_token``. Idempotent — returns whether it was newly
    revoked."""
    return store.revoke_refresh(refresh_token)


def _issue_pair(user: User, store: UserStore, *, secret: str | None) -> TokenSet:
    """Issue an access + refresh pair and persist the refresh token."""
    access = issue_access_token(user.username, user.role, secret=secret)
    refresh_tok = issue_refresh_token(user.username, user.role, secret=secret)
    # Refresh tokens expire in 7d (REFRESH_TTL). Persist with that expiry.
    from neuralgentics.web.auth.jwt import REFRESH_TTL

    store.register_refresh(refresh_tok, user.username, expires_at=int(time.time()) + REFRESH_TTL)
    return TokenSet(access_token=access, refresh_token=refresh_tok)


__all__ = ["TokenSet", "AuthError", "login", "refresh", "logout"]
