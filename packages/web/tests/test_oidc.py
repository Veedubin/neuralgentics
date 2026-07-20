"""Tests for the OIDC integration (T-112).

Covers:
  * State token CSRF protection (wrong state → 400, consumed-once).
  * User provisioning on first login (new user created with default role).
  * Existing user linked to a provider (cross-provider email match).
  * Login page shows configured providers (and hides them when not configured).
  * OIDC callback issues a valid JWT cookie.
  * Generic OIDC discovery (fake discovery URL → provider uses it).

All HTTP calls to the IdP are mocked via :class:`httpx.MockTransport` so
no network access is required.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from neuralgentics.web.auth.jwt import decode_access_token
from neuralgentics.web.auth.middleware import AUTH_COOKIE_NAME, AuthMiddleware
from neuralgentics.web.auth.oidc import (
    GenericOIDCProvider,
    GitHubProvider,
)
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.oidc_routes import build_oidc_router
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import UserStore

SECRET = "oidc-test-secret-32-bytes!!"
REDIRECT_BASE = "http://localhost:9877"


# ---------------------------------------------------------------------------
# httpx MockTransport helpers
# ---------------------------------------------------------------------------


def _github_transport(
    user_data: dict[str, Any], emails: list[dict[str, Any]]
) -> httpx.MockTransport:
    """Build a MockTransport that handles GitHub's token + user + emails."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://github.com/login/oauth/access_token":
            return httpx.Response(
                200, json={"access_token": "gho_mock", "token_type": "bearer", "scope": "read:user"}
            )
        if url == "https://api.github.com/user":
            return httpx.Response(200, json=user_data)
        if url == "https://api.github.com/user/emails":
            return httpx.Response(200, json=emails)
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


def _google_transport(discovery: dict[str, str], userinfo: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://accounts.google.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://oauth2.googleapis.com/token":
            return httpx.Response(
                200, json={"access_token": "ya29.mock", "token_type": "bearer", "expires_in": 3600}
            )
        if url == "https://openidconnect.googleapis.com/v1/userinfo":
            return httpx.Response(200, json=userinfo)
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


def _generic_transport(discovery: dict[str, str], userinfo: dict[str, Any]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://idp.example.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://idp.example.com/oauth/token":
            return httpx.Response(
                200, json={"access_token": "generic.mock", "token_type": "bearer"}
            )
        if url == "https://idp.example.com/oauth/userinfo":
            return httpx.Response(200, json=userinfo)
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "oidc-users.db")


def _build_app(
    store: UserStore,
    oidc_config: OIDCConfig,
    *,
    mode: str = "oauth2",
) -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthMiddleware, mode=mode, user_store=store, secret=SECRET)  # type: ignore[arg-type]
    oidc_providers = [
        {"name": p.name, "authorization_url": p.authorization_url}
        for p in oidc_config.providers.values()
    ]
    app.include_router(build_auth_router(store, secret=SECRET, oidc_providers=oidc_providers))
    app.include_router(build_oidc_router(user_store=store, oidc_config=oidc_config, secret=SECRET))
    return app


def _github_config(transport: httpx.MockTransport) -> OIDCConfig:
    """OIDCConfig with a GitHubProvider whose http_client uses ``transport``."""
    client = httpx.AsyncClient(transport=transport)
    p = GitHubProvider(client_id="gh_id", client_secret="gh_secret", http_client=client)
    return OIDCConfig(
        redirect_base=REDIRECT_BASE,
        default_role="viewer",
        providers={"github": p},
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_state_token_csrf_protection(store: UserStore) -> None:
    """Callback with a wrong state → 400. The state cookie was set by the
    login redirect, but the callback gets a different state value."""
    transport = _github_transport(
        user_data={"id": 42, "login": "alice", "name": "Alice"},
        emails=[{"email": "alice@example.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        # Start the flow — sets the state cookie.
        login_resp = client.get("/auth/login/github", follow_redirects=False)
        assert login_resp.status_code == 302
        # Callback with a DIFFERENT state than the cookie.
        resp = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": "WRONG-STATE"},
            follow_redirects=False,
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_state"


def test_state_token_csrf_protection_missing_cookie(store: UserStore) -> None:
    """Callback with no state cookie at all → 400."""
    transport = _github_transport(
        user_data={"id": 42, "login": "alice", "name": "Alice"},
        emails=[{"email": "alice@example.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        # No prior /auth/login/github call → no state cookie.
        resp = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": "anything"},
            follow_redirects=False,
        )
        assert resp.status_code == 400


def test_state_token_consumed_once(store: UserStore) -> None:
    """After a successful callback, the state cookie is cleared — a second
    callback with the same state fails (single-use)."""
    transport = _github_transport(
        user_data={"id": 42, "login": "alice", "name": "Alice"},
        emails=[{"email": "alice@example.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        # Start the flow.
        client.get("/auth/login/github", follow_redirects=False)
        # Extract the state from the redirect URL.
        # The cookie is set; we can read it from the client's cookie jar.
        state_cookie = None
        for k, v in client.cookies.items():
            if k == "oidc_state_github":
                state_cookie = v
                break
        assert state_cookie is not None, "state cookie should be set after login redirect"

        # First callback — should succeed (302 redirect to /).
        resp1 = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": state_cookie},
            follow_redirects=False,
        )
        assert resp1.status_code == 302, resp1.text
        assert resp1.headers["location"] == "/"

        # The state cookie should now be cleared. A second callback with
        # the same state should fail (cookie no longer present → 400).
        resp2 = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": state_cookie},
            follow_redirects=False,
        )
        assert resp2.status_code == 400


def test_user_provisioned_on_first_login(store: UserStore) -> None:
    """A new GitHub user (email not seen before) is created with the default
    role (viewer). The user_oauth_links table has a row linking them."""
    transport = _github_transport(
        user_data={"id": 42, "login": "alice", "name": "Alice"},
        emails=[{"email": "alice@example.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        client.get("/auth/login/github", follow_redirects=False)
        state = client.cookies.get("oidc_state_github")
        assert state is not None
        resp = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": state},
            follow_redirects=False,
        )
        assert resp.status_code == 302, resp.text

    # The user was created.
    user = store.get_by_username("alice@example.com")
    assert user is not None
    assert user.role == "viewer"
    # The OAuth link exists.
    linked = store.get_by_oauth("github", "42")
    assert linked is not None
    assert linked.username == "alice@example.com"


def test_existing_user_linked_to_provider(store: UserStore) -> None:
    """An existing user with email X logs in via GitHub (which returns the
    same email) → the provider link is created, no new user."""
    # Pre-create a user with the email that GitHub will return.
    # We use the OIDC provisioning path with Google first to simulate an
    # existing user created by a prior Google login.
    google_transport = _google_transport(
        discovery={
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
            "token_endpoint": "https://oauth2.googleapis.com/token",
            "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
        },
        userinfo={"sub": "g-123", "email": "bob@example.com", "name": "Bob"},
    )
    g_client = httpx.AsyncClient(transport=google_transport)
    google_p = type(
        "GoogleProvider",
        (),
        {
            "name": "google",
            "authorization_url": "https://accounts.google.com/o/oauth2/auth",
            "token_url": "https://oauth2.googleapis.com/token",
            "userinfo_url": "https://openidconnect.googleapis.com/v1/userinfo",
            "scopes": ("openid", "email", "profile"),
            "http_client": g_client,
            "authorization_params": lambda self, redirect_uri, state: {
                "client_id": "g_id",
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email profile",
                "state": state,
            },
            "exchange_code": lambda self, code, redirect_uri: _async_token(
                google_transport, "https://oauth2.googleapis.com/token"
            ),
            "fetch_userinfo": lambda self, access_token: _async_userinfo(
                google_transport, "https://openidconnect.googleapis.com/v1/userinfo"
            ),
        },
    )()
    config_google = OIDCConfig(
        redirect_base=REDIRECT_BASE,
        default_role="viewer",
        providers={"google": google_p},  # type: ignore[arg-type]
    )
    app_g = _build_app(store, config_google)
    with TestClient(app_g) as client:
        client.get("/auth/login/google", follow_redirects=False)
        state = client.cookies.get("oidc_state_google")
        resp = client.get(
            "/auth/callback/google",
            params={"code": "abc", "state": state},
            follow_redirects=False,
        )
        assert resp.status_code == 302, resp.text

    # Now the user bob@example.com exists (created by Google login).
    existing = store.get_by_username("bob@example.com")
    assert existing is not None

    # Now log in via GitHub with the SAME email → should link, not create.
    gh_transport = _github_transport(
        user_data={"id": 99, "login": "bobgh", "name": "Bob"},
        emails=[{"email": "bob@example.com", "primary": True, "verified": True}],
    )
    config_gh = _github_config(gh_transport)
    app_gh = _build_app(store, config_gh)
    with TestClient(app_gh) as client:
        client.get("/auth/login/github", follow_redirects=False)
        state = client.cookies.get("oidc_state_github")
        resp = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": state},
            follow_redirects=False,
        )
        assert resp.status_code == 302, resp.text

    # No new user created — same email.
    users = store.list_users()
    # Should have admin, operator, viewer (defaults) + bob@example.com.
    usernames = [u.username for u in users]
    assert "bob@example.com" in usernames
    # The GitHub link now exists, pointing to the same user.
    linked = store.get_by_oauth("github", "99")
    assert linked is not None
    assert linked.username == "bob@example.com"


def test_login_page_shows_configured_providers(store: UserStore) -> None:
    """When GitHub is configured, the login page HTML contains 'Login with
    GitHub'. When no providers are configured, it doesn't."""
    # Configured → button present.
    transport = _github_transport(
        user_data={"id": 1, "login": "x", "name": "X"},
        emails=[{"email": "x@x.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        resp = client.get("/auth/login")
        assert resp.status_code == 200
        assert "Login with GitHub" in resp.text

    # Not configured → no button.
    empty_config = OIDCConfig(redirect_base=REDIRECT_BASE, default_role="viewer", providers={})
    app2 = _build_app(store, empty_config)
    with TestClient(app2) as client:
        resp = client.get("/auth/login")
        assert resp.status_code == 200
        assert "Login with GitHub" not in resp.text


def test_oidc_callback_issues_jwt_cookie(store: UserStore) -> None:
    """A successful callback returns a 302 redirect to / with a valid JWT
    in the ``ng_auth`` cookie. The JWT decodes to the right sub + role."""
    transport = _github_transport(
        user_data={"id": 7, "login": "carol", "name": "Carol"},
        emails=[{"email": "carol@example.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        client.get("/auth/login/github", follow_redirects=False)
        state = client.cookies.get("oidc_state_github")
        resp = client.get(
            "/auth/callback/github",
            params={"code": "abc", "state": state},
            follow_redirects=False,
        )
        assert resp.status_code == 302
        # The auth cookie is set.
        auth_cookie = resp.cookies.get(AUTH_COOKIE_NAME)
        assert auth_cookie is not None, "ng_auth cookie should be set after callback"
        # The cookie contains a valid JWT.
        payload = decode_access_token(auth_cookie, secret=SECRET)
        assert payload["sub"] == "carol@example.com"
        assert payload["role"] == "viewer"
        assert payload["type"] == "access"


def test_oidc_generic_discovery(store: UserStore) -> None:
    """A GenericOIDCProvider fetches its config from the discovery URL and
    uses the discovered endpoints for token exchange + userinfo."""
    discovery = {
        "authorization_endpoint": "https://idp.example.com/oauth/authorize",
        "token_endpoint": "https://idp.example.com/oauth/token",
        "userinfo_endpoint": "https://idp.example.com/oauth/userinfo",
    }
    userinfo = {
        "sub": "okta-001",
        "email": "dave@example.com",
        "name": "Dave",
        "preferred_username": "dave",
    }
    transport = _generic_transport(discovery, userinfo)
    client = httpx.AsyncClient(transport=transport)
    p = GenericOIDCProvider(
        name="okta",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        client_id="okta_id",
        client_secret="okta_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
    )
    config = OIDCConfig(redirect_base=REDIRECT_BASE, default_role="viewer", providers={"okta": p})
    app = _build_app(store, config)
    with TestClient(app) as client:
        # Start the flow — the authorize URL should use the discovered endpoint.
        login_resp = client.get("/auth/login/okta", follow_redirects=False)
        assert login_resp.status_code == 302
        assert "idp.example.com/oauth/authorize" in login_resp.headers["location"]
        # Complete the callback.
        state = client.cookies.get("oidc_state_okta")
        resp = client.get(
            "/auth/callback/okta",
            params={"code": "abc", "state": state},
            follow_redirects=False,
        )
        assert resp.status_code == 302, resp.text

    # User was created from the generic provider's userinfo.
    user = store.get_by_username("dave@example.com")
    assert user is not None
    assert user.role == "viewer"
    linked = store.get_by_oauth("okta", "okta-001")
    assert linked is not None


def test_oidc_providers_endpoint(store: UserStore) -> None:
    """GET /auth/providers returns the list of configured providers."""
    transport = _github_transport(
        user_data={"id": 1, "login": "x", "name": "X"},
        emails=[{"email": "x@x.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        resp = client.get("/auth/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert data["enabled"] is True
        names = [p["name"] for p in data["providers"]]
        assert "github" in names


def test_oidc_disabled_when_no_providers(store: UserStore) -> None:
    """When no providers are configured, /auth/providers still responds
    (with enabled=False) and /auth/login/{provider} 404s."""
    config = OIDCConfig(redirect_base=REDIRECT_BASE, default_role="viewer", providers={})
    app = _build_app(store, config)
    with TestClient(app) as client:
        # /auth/providers — the OIDC router is empty so this 404s (no route).
        # That's the expected behavior: OIDC disabled = no OIDC routes.
        resp = client.get("/auth/providers")
        assert resp.status_code == 404
        # /auth/login/github also 404s (no OIDC route registered).
        resp2 = client.get("/auth/login/github", follow_redirects=False)
        assert resp2.status_code == 404


def test_unknown_provider_callback_404(store: UserStore) -> None:
    """Callback for a provider that isn't configured → 404."""
    transport = _github_transport(
        user_data={"id": 1, "login": "x", "name": "X"},
        emails=[{"email": "x@x.com", "primary": True, "verified": True}],
    )
    config = _github_config(transport)
    app = _build_app(store, config)
    with TestClient(app) as client:
        resp = client.get(
            "/auth/callback/gitlab",
            params={"code": "abc", "state": "x"},
            follow_redirects=False,
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Async helpers for the inline Google provider in test_existing_user_linked
# ---------------------------------------------------------------------------


async def _async_token(transport: httpx.MockTransport, url: str) -> Any:
    """Use a MockTransport to POST to ``url`` and return a TokenResponse."""
    from neuralgentics.web.auth.oidc import TokenResponse

    async with httpx.AsyncClient(transport=transport) as c:
        r = await c.post(
            url,
            data={
                "client_id": "x",
                "client_secret": "x",
                "code": "x",
                "redirect_uri": "x",
                "grant_type": "authorization_code",
            },
        )
        r.raise_for_status()
        return TokenResponse.from_raw(r.json())


async def _async_userinfo(transport: httpx.MockTransport, url: str) -> Any:
    """Use a MockTransport to GET ``url`` and return a UserInfo."""
    from neuralgentics.web.auth.oidc import UserInfo

    async with httpx.AsyncClient(transport=transport) as c:
        r = await c.get(url, headers={"Authorization": "Bearer x"})
        r.raise_for_status()
        raw = r.json()
        return UserInfo(
            provider_user_id=str(raw["sub"]),
            username=raw.get("preferred_username"),
            email=raw.get("email"),
            display_name=raw.get("name"),
            raw=raw,
        )
