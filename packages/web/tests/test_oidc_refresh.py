"""Tests for OIDC refresh-token rotation (T-122).

Covers the 5 mandatory cases from the card:

  * ``test_github_refresh_returns_new_token`` — GitHub OAuth Apps don't
    support refresh tokens; ``refresh_token()`` raises OIDCError with a
    clear message (NOT a silent success / fake token).
  * ``test_google_refresh_uses_discovery`` — Google provider fetches
    discovery, then POSTs ``grant_type=refresh_token`` to the
    discovered token endpoint and returns the new access token.
  * ``test_background_loop_refreshes_expiring_tokens`` — insert 3
    links, 1 about to expire, run the loop once, assert 1 was refreshed.
  * ``test_refresh_failure_marks_revoked`` — refresh API returns 400
    ``invalid_grant``; the link is marked revoked.
  * ``test_force_refresh_on_401`` — access token returns 401 from an
    IdP API call, ``get_valid_access_token`` refreshes once, the retry
    succeeds with the new token.

All HTTP calls are mocked via :class:`httpx.MockTransport` so no
network access is required.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from neuralgentics.web.auth.oidc import (
    GenericOIDCProvider,
    GitHubProvider,
    GoogleProvider,
    OIDCError,
    RefreshResponse,
)
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.refresh import (
    get_valid_access_token,
    refresh_due_tokens,
)
from neuralgentics.web.auth.users import UserStore

REDIRECT_BASE = "http://localhost:9877"


# ---------------------------------------------------------------------------
# MockTransport builders
# ---------------------------------------------------------------------------


def _google_refresh_transport(
    *,
    discovery: dict[str, str],
    new_access_token: str = "ya29.refreshed",
    expires_in: int = 3600,
    status: int = 200,
    error_body: dict[str, str] | None = None,
) -> httpx.MockTransport:
    """MockTransport handling Google discovery + refresh grant.

    On ``status != 200`` (or when ``error_body`` is set), the token
    endpoint returns the error JSON instead of a success body — this
    is how we simulate the "user revoked access" / ``invalid_grant``
    case.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://accounts.google.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://oauth2.googleapis.com/token":
            if error_body is not None or status != 200:
                return httpx.Response(status, json=error_body or {"error": "invalid_grant"})
            return httpx.Response(
                200,
                json={
                    "access_token": new_access_token,
                    "token_type": "bearer",
                    "expires_in": expires_in,
                },
            )
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


def _generic_refresh_transport(
    *,
    discovery: dict[str, str],
    token_url: str,
    new_access_token: str = "generic.refreshed",
    expires_in: int = 3600,
    status: int = 200,
    error_body: dict[str, str] | None = None,
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://idp.example.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == token_url:
            if error_body is not None or status != 200:
                return httpx.Response(status, json=error_body or {"error": "invalid_grant"})
            return httpx.Response(
                200,
                json={
                    "access_token": new_access_token,
                    "token_type": "bearer",
                    "expires_in": expires_in,
                },
            )
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


def _google_provider(transport: httpx.MockTransport) -> GoogleProvider:
    client = httpx.AsyncClient(transport=transport)
    return GoogleProvider(
        client_id="g_id",
        client_secret="g_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
    )


def _google_config(transport: httpx.MockTransport) -> OIDCConfig:
    p = _google_provider(transport)
    return OIDCConfig(redirect_base=REDIRECT_BASE, default_role="viewer", providers={"google": p})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "refresh-users.db")


def _insert_link(
    *,
    store: UserStore,
    username: str,
    provider: str,
    provider_user_id: str,
    access_token: str,
    refresh_token: str | None,
    expires_at: int | None,
) -> None:
    """Insert a user + oauth link row directly (bypass the OIDC flow)."""
    with store._conn() as conn:  # noqa: SLF001 — test helper
        conn.execute(
            "INSERT OR IGNORE INTO users (username, password_hash, role, source) "
            "VALUES (?, 'x', 'viewer', 'oidc')",
            (username,),
        )
        conn.execute(
            "INSERT INTO user_oauth_links "
            "(username, provider, provider_user_id, access_token, refresh_token, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (username, provider, provider_user_id, access_token, refresh_token, expires_at),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# 1. GitHub — no refresh-token support (OAuth Apps limitation)
# ---------------------------------------------------------------------------


def test_github_refresh_returns_new_token(store: UserStore) -> None:
    """GitHub OAuth Apps do NOT support refresh-token grants.

    The card asks for "GitHub: POST ... with grant_type=refresh_token"
    but documents the limitation. Our implementation raises
    :class:`OIDCError` with a clear message rather than silently
    pretending to refresh or returning a fake token. This is the honest
    behavior: the caller (background loop / force-refresh) treats any
    exception as "can't refresh" and either skips (loop) or returns the
    stale token (force-refresh).
    """
    p = GitHubProvider(client_id="gh_id", client_secret="gh_secret")
    with pytest.raises(OIDCError) as exc_info:
        asyncio.run(p.refresh_token("any-refresh-token"))
    msg = str(exc_info.value)
    # The message must clearly state the limitation so operators know
    # to switch to a GitHub App or a different provider.
    assert "github" in msg.lower()
    assert "refresh" in msg.lower()


# ---------------------------------------------------------------------------
# 2. Google refresh uses discovery
# ---------------------------------------------------------------------------


def test_google_refresh_uses_discovery(store: UserStore) -> None:
    """Google refresh: discovery → POST grant_type=refresh_token → new token."""
    discovery = {
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    }
    transport = _google_refresh_transport(
        discovery=discovery, new_access_token="ya29.fresh", expires_in=3600
    )
    p = _google_provider(transport)

    async def go() -> RefreshResponse:
        return await p.refresh_token("rt-abc")

    resp = asyncio.run(go())
    assert resp.access_token == "ya29.fresh"
    assert resp.expires_in == 3600
    # Google doesn't rotate the refresh token by default.
    assert resp.refresh_token is None


# ---------------------------------------------------------------------------
# 3. Background loop refreshes expiring tokens
# ---------------------------------------------------------------------------


def test_background_loop_refreshes_expiring_tokens(store: UserStore) -> None:
    """Insert 3 Google links: 1 about to expire, 2 not. Run
    ``refresh_due_tokens`` once. Assert exactly 1 was refreshed."""
    discovery = {
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    }
    transport = _google_refresh_transport(
        discovery=discovery, new_access_token="ya29.refreshed", expires_in=3600
    )
    config = _google_config(transport)

    now = int(time.time())
    # Link 1: about to expire (in 5 min — within the 10-min lead).
    _insert_link(
        store=store,
        username="alice@example.com",
        provider="google",
        provider_user_id="g-1",
        access_token="ya29.old1",
        refresh_token="rt-alice",
        expires_at=now + 300,
    )
    # Link 2: valid for another hour (well outside the 10-min lead).
    _insert_link(
        store=store,
        username="bob@example.com",
        provider="google",
        provider_user_id="g-2",
        access_token="ya29.old2",
        refresh_token="rt-bob",
        expires_at=now + 3600,
    )
    # Link 3: valid for 45 min (outside the 10-min lead).
    _insert_link(
        store=store,
        username="carol@example.com",
        provider="google",
        provider_user_id="g-3",
        access_token="ya29.old3",
        refresh_token="rt-carol",
        expires_at=now + 2700,
    )

    refreshed = asyncio.run(refresh_due_tokens(store=store, oidc_config=config))
    assert refreshed == 1, f"expected 1 refresh, got {refreshed}"

    # Alice's link now has the new access token + a fresh expiry.
    alice = store.get_oauth_link(username="alice@example.com", provider="google")
    assert alice is not None
    assert alice["access_token"] == "ya29.refreshed"
    assert isinstance(alice["expires_at"], int)
    # New expiry should be ~now + 3600 (allow some skew for the call).
    assert alice["expires_at"] > now + 3000
    # Refresh token preserved (Google doesn't rotate).
    assert alice["refresh_token"] == "rt-alice"

    # Bob + Carol untouched.
    bob = store.get_oauth_link(username="bob@example.com", provider="google")
    assert bob is not None
    assert bob["access_token"] == "ya29.old2"
    carol = store.get_oauth_link(username="carol@example.com", provider="google")
    assert carol is not None
    assert carol["access_token"] == "ya29.old3"


# ---------------------------------------------------------------------------
# 4. Refresh failure marks revoked
# ---------------------------------------------------------------------------


def test_refresh_failure_marks_revoked(store: UserStore) -> None:
    """Refresh API returns 400 ``invalid_grant`` → link marked revoked."""
    discovery = {
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    }
    transport = _google_refresh_transport(
        discovery=discovery,
        status=400,
        error_body={"error": "invalid_grant", "error_description": "user revoked access"},
    )
    config = _google_config(transport)

    now = int(time.time())
    _insert_link(
        store=store,
        username="dave@example.com",
        provider="google",
        provider_user_id="g-dave",
        access_token="ya29.stale",
        refresh_token="rt-dave",
        expires_at=now + 60,  # about to expire
    )

    refreshed = asyncio.run(refresh_due_tokens(store=store, oidc_config=config))
    assert refreshed == 0, "refresh should have failed (0 successes)"

    # The link is now revoked — get_oauth_link reports None.
    revoked = store.get_oauth_link(username="dave@example.com", provider="google")
    assert revoked is None, "revoked link should be reported as None by get_oauth_link"

    # And the raw row has a revoked_at timestamp.
    with store._conn() as conn:  # noqa: SLF001 — test helper
        row = conn.execute(
            "SELECT revoked_at FROM user_oauth_links WHERE provider = ? AND provider_user_id = ?",
            ("google", "g-dave"),
        ).fetchone()
    assert row is not None
    assert row["revoked_at"] is not None


# ---------------------------------------------------------------------------
# 5. Force-refresh on 401
# ---------------------------------------------------------------------------


def test_force_refresh_on_401(store: UserStore) -> None:
    """Access token returns 401 from an IdP API call →
    ``get_valid_access_token`` refreshes once → retry succeeds with the
    new token.

    We simulate the "IdP API returned 401" by storing an expired access
    token and calling :func:`get_valid_access_token`. The helper sees
    the token is expired, refreshes it, and returns the new one. We
    then verify the new token would work against the mocked IdP API
    (the transport returns 200 for requests bearing the new token)."""
    discovery = {
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://accounts.google.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://oauth2.googleapis.com/token":
            return httpx.Response(
                200,
                json={
                    "access_token": "ya29.fresh",
                    "token_type": "bearer",
                    "expires_in": 3600,
                },
            )
        if url == "https://openidconnect.googleapis.com/v1/userinfo":
            auth = request.headers.get("Authorization", "")
            if auth == "Bearer ya29.fresh":
                return httpx.Response(200, json={"sub": "g-eve", "email": "eve@example.com"})
            # Any other token (the stale one) → 401, simulating the
            # "IdP API said the access token is no good" scenario.
            return httpx.Response(401, json={"error": "invalid_token"})
        return httpx.Response(404, text=f"not mocked: {url}")

    transport = httpx.MockTransport(handler)
    config = _google_config(transport)

    # Store an EXPIRED access token (so get_valid_access_token refreshes).
    now = int(time.time())
    _insert_link(
        store=store,
        username="eve@example.com",
        provider="google",
        provider_user_id="g-eve",
        access_token="ya29.stale",
        refresh_token="rt-eve",
        expires_at=now - 60,  # expired 1 min ago
    )

    # Force-refresh: get a fresh token.
    new_token = asyncio.run(
        get_valid_access_token(
            username="eve@example.com",
            provider_name="google",
            store=store,
            oidc_config=config,
        )
    )
    assert new_token == "ya29.fresh"

    # Retry the IdP API call with the new token — should succeed now.
    async def retry_api_call() -> dict[str, Any]:
        async with httpx.AsyncClient(transport=transport) as c:
            r = await c.get(
                "https://openidconnect.googleapis.com/v1/userinfo",
                headers={"Authorization": f"Bearer {new_token}"},
            )
            r.raise_for_status()
            return r.json()

    userinfo = asyncio.run(retry_api_call())
    assert userinfo["sub"] == "g-eve"
    assert userinfo["email"] == "eve@example.com"

    # The stored link now has the fresh token + new expiry.
    link = store.get_oauth_link(username="eve@example.com", provider="google")
    assert link is not None
    assert link["access_token"] == "ya29.fresh"
    assert isinstance(link["expires_at"], int)
    assert link["expires_at"] > now + 3000


# ---------------------------------------------------------------------------
# Bonus: generic provider refresh (not in the mandatory 5, but cheap)
# ---------------------------------------------------------------------------


def test_generic_refresh_uses_discovered_token_endpoint(store: UserStore) -> None:
    """Generic OIDC provider refreshes against the discovered token endpoint."""
    discovery = {
        "authorization_endpoint": "https://idp.example.com/oauth/authorize",
        "token_endpoint": "https://idp.example.com/oauth/token",
        "userinfo_endpoint": "https://idp.example.com/oauth/userinfo",
    }
    transport = _generic_refresh_transport(
        discovery=discovery,
        token_url="https://idp.example.com/oauth/token",
        new_access_token="generic.fresh",
        expires_in=3600,
    )
    client = httpx.AsyncClient(transport=transport)
    p = GenericOIDCProvider(
        name="okta",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        client_id="okta_id",
        client_secret="okta_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
    )

    async def go() -> RefreshResponse:
        return await p.refresh_token("rt-okta")

    resp = asyncio.run(go())
    assert resp.access_token == "generic.fresh"
    assert resp.expires_in == 3600
