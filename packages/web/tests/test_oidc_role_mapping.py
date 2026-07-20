"""Tests for OIDC group→role mapping (T-121).

Covers:

  * :class:`RoleMapping.parse` + :func:`parse_role_mappings` +
    :func:`extract_role_from_groups` (pure, no HTTP).
  * The full callback flow applies the mapping to a new OIDC user
    (operator/admin), highest-wins, no-match-uses-default.
  * Local users (the seeded ``admin/admin``) are never touched by
    role-mapping.
  * :meth:`GitHubProvider.fetch_userinfo` populates ``UserInfo.groups``
    from ``/user/orgs`` and ``/user/teams``.
  * :class:`GenericOIDCProvider` extracts groups from a configured
    claim (default ``groups``, override via ``groups_claim``), accepting
    both list-of-strings and list-of-objects-with-``name`` shapes.
  * The ``users.source`` column is set to ``"oidc"`` for OIDC-provisioned
    users and ``"local"`` for the seeded defaults.

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
    RoleMapping,
    extract_role_from_groups,
    parse_role_mappings,
)
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.oidc_routes import build_oidc_router
from neuralgentics.web.auth.routes import build_auth_router
from neuralgentics.web.auth.users import DEFAULT_USERS, UserStore

SECRET = "oidc-role-mapping-test-secret!"  # noqa: S105 — test only
REDIRECT_BASE = "http://localhost:9877"


# ---------------------------------------------------------------------------
# Pure unit tests — no HTTP, no DB.
# ---------------------------------------------------------------------------


def test_role_mapping_parse_basic() -> None:
    """RoleMapping.parse accepts PROVIDER:GROUP=ROLE."""
    m = RoleMapping.parse("github:myorg=operator")
    assert m.provider == "github"
    assert m.group_pattern == "myorg"
    assert m.role == "operator"


def test_role_mapping_parse_team_slug() -> None:
    """Group patterns may contain '/' (GitHub team slugs)."""
    m = RoleMapping.parse("github:myorg/admins=admin")
    assert m.provider == "github"
    assert m.group_pattern == "myorg/admins"
    assert m.role == "admin"


def test_role_mapping_parse_google_group_email() -> None:
    """Group patterns may contain '@' (Google group emails)."""
    m = RoleMapping.parse("google:admin@example.com=admin")
    assert m.provider == "google"
    assert m.group_pattern == "admin@example.com"
    assert m.role == "admin"


def test_role_mapping_parse_rejects_unknown_role() -> None:
    with pytest.raises(ValueError, match="role-mapping role"):
        RoleMapping.parse("github:myorg=superuser")


def test_role_mapping_parse_rejects_missing_eq() -> None:
    with pytest.raises(ValueError, match="PROVIDER:GROUP_PATTERN=ROLE"):
        RoleMapping.parse("github:myorg")


def test_role_mapping_parse_rejects_missing_colon() -> None:
    with pytest.raises(ValueError, match="PROVIDER:GROUP_PATTERN=ROLE"):
        RoleMapping.parse("myorg=operator")


def test_parse_role_mappings_comma_separated() -> None:
    """A single --oidc-role-mapping flag value may contain comma-separated rules."""
    rules = parse_role_mappings(["github:myorg/admins=admin,github:myorg/devs=operator"])
    assert len(rules) == 2
    assert rules[0].role == "admin"
    assert rules[1].role == "operator"


def test_parse_role_mappings_multiple_flags() -> None:
    """Multiple --oidc-role-mapping flags accumulate."""
    rules = parse_role_mappings(["github:myorg=operator", "google:admin@example.com=admin"])
    assert len(rules) == 2
    assert {r.provider for r in rules} == {"github", "google"}


def test_parse_role_mappings_skips_empty_pieces() -> None:
    """Trailing/leading commas don't produce empty rules."""
    rules = parse_role_mappings(["github:myorg=operator,,", ""])
    assert len(rules) == 1


def test_extract_role_no_match_returns_default() -> None:
    """User in no mapped group → default role."""
    mappings = parse_role_mappings(["github:myorg=operator"])
    role = extract_role_from_groups(
        provider="github",
        groups=["otherorg"],
        mappings=mappings,
        default_role="viewer",
    )
    assert role == "viewer"


def test_extract_role_single_match() -> None:
    mappings = parse_role_mappings(["github:myorg=operator"])
    role = extract_role_from_groups(
        provider="github",
        groups=["myorg"],
        mappings=mappings,
        default_role="viewer",
    )
    assert role == "operator"


def test_extract_role_highest_wins() -> None:
    """User in both an admin-mapped group and an operator-mapped group → admin."""
    mappings = parse_role_mappings(["github:myorg=operator", "github:myorg/admins=admin"])
    role = extract_role_from_groups(
        provider="github",
        groups=["myorg", "myorg/admins"],
        mappings=mappings,
        default_role="viewer",
    )
    assert role == "admin"


def test_extract_role_filters_by_provider() -> None:
    """A mapping for 'google' doesn't apply to a 'github' user even if the
    group pattern coincidentally matches."""
    mappings = parse_role_mappings(["google:myorg=admin"])
    role = extract_role_from_groups(
        provider="github",
        groups=["myorg"],
        mappings=mappings,
        default_role="viewer",
    )
    assert role == "viewer"


def test_extract_role_team_slug_overrides_org() -> None:
    """A team-level mapping (myorg/admins=admin) wins over an org-level
    mapping (myorg=operator) because admin > operator in ROLE_PRIVILEGE."""
    mappings = parse_role_mappings(["github:myorg=operator", "github:myorg/admins=admin"])
    role = extract_role_from_groups(
        provider="github",
        groups=["myorg", "myorg/admins"],
        mappings=mappings,
        default_role="viewer",
    )
    assert role == "admin"


# ---------------------------------------------------------------------------
# Fixtures + HTTP mocks for the callback-flow tests.
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "role-mapping-users.db")


def _github_transport(
    user_data: dict[str, Any],
    emails: list[dict[str, Any]],
    orgs: list[dict[str, Any]] | None = None,
    teams: list[dict[str, Any]] | None = None,
) -> httpx.MockTransport:
    """Mock GitHub's token + user + emails + orgs + teams endpoints."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://github.com/login/oauth/access_token":
            return httpx.Response(
                200,
                json={"access_token": "gho_mock", "token_type": "bearer", "scope": "read:org"},
            )
        if url == "https://api.github.com/user":
            return httpx.Response(200, json=user_data)
        if url == "https://api.github.com/user/emails":
            return httpx.Response(200, json=emails)
        if url == "https://api.github.com/user/orgs":
            return httpx.Response(200, json=orgs or [])
        if url == "https://api.github.com/user/teams":
            return httpx.Response(200, json=teams or [])
        return httpx.Response(404, text=f"not mocked: {url}")

    return httpx.MockTransport(handler)


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


def _github_config(
    transport: httpx.MockTransport,
    *,
    role_mappings: list[str] | None = None,
    default_role: str = "viewer",
) -> OIDCConfig:
    """OIDCConfig with a GitHubProvider whose http_client uses ``transport``."""
    client = httpx.AsyncClient(transport=transport)
    p = GitHubProvider(client_id="gh_id", client_secret="gh_secret", http_client=client)
    return OIDCConfig(
        redirect_base=REDIRECT_BASE,
        default_role=default_role,
        providers={"github": p},
        role_mappings=parse_role_mappings(role_mappings) if role_mappings else [],
    )


def _login_via_github(store: UserStore, config: OIDCConfig) -> str:
    """Run a full GitHub OIDC callback flow and return the username provisioned."""
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
        # Return the username encoded in the JWT cookie for the caller to inspect.
        auth_cookie = resp.cookies.get(AUTH_COOKIE_NAME)
        assert auth_cookie is not None
        payload = decode_access_token(auth_cookie, secret=SECRET)
        return str(payload["sub"])


# ---------------------------------------------------------------------------
# Callback-flow tests.
# ---------------------------------------------------------------------------


def test_role_mapping_applies_to_new_user(store: UserStore) -> None:
    """A new GitHub user in the mapped org gets the mapped role, not the default."""
    transport = _github_transport(
        user_data={"id": 101, "login": "alice", "name": "Alice"},
        emails=[{"email": "alice@example.com", "primary": True, "verified": True}],
        orgs=[{"login": "myorg"}],
        teams=[],
    )
    config = _github_config(
        transport,
        role_mappings=["github:myorg=operator"],
        default_role="viewer",
    )
    username = _login_via_github(store, config)
    assert username == "alice@example.com"
    user = store.get_by_username(username)
    assert user is not None
    assert user.role == "operator"
    assert user.source == "oidc"


def test_role_mapping_highest_wins(store: UserStore) -> None:
    """User in both an admin-mapped team and an operator-mapped org → admin."""
    transport = _github_transport(
        user_data={"id": 102, "login": "bob", "name": "Bob"},
        emails=[{"email": "bob@example.com", "primary": True, "verified": True}],
        orgs=[{"login": "myorg"}],
        teams=[{"organization": {"login": "myorg"}, "slug": "admins"}],
    )
    config = _github_config(
        transport,
        role_mappings=["github:myorg=operator", "github:myorg/admins=admin"],
        default_role="viewer",
    )
    username = _login_via_github(store, config)
    user = store.get_by_username(username)
    assert user is not None
    assert user.role == "admin"


def test_role_mapping_no_match_uses_default(store: UserStore) -> None:
    """User not in any mapped group → default role."""
    transport = _github_transport(
        user_data={"id": 103, "login": "carol", "name": "Carol"},
        emails=[{"email": "carol@example.com", "primary": True, "verified": True}],
        orgs=[{"login": "unrelatedorg"}],
        teams=[],
    )
    config = _github_config(
        transport,
        role_mappings=["github:myorg=operator"],
        default_role="viewer",
    )
    username = _login_via_github(store, config)
    user = store.get_by_username(username)
    assert user is not None
    assert user.role == "viewer"


def test_role_mapping_local_user_untouched(store: UserStore) -> None:
    """The seeded local admin/admin is NOT changed by role-mapping even if a
    mapping rule would otherwise apply. The cross-provider email-match path
    may link the OIDC login to the existing local user (when GitHub returns
    an email that matches a local username), but the callback's set_role
    call is gated on user.source == 'oidc' — local users are immune."""
    # Sanity: the seeded admin exists and is local.
    admin = store.get_by_username("admin")
    assert admin is not None
    assert admin.role == "admin"
    assert admin.source == "local"

    # A GitHub login that returns email='admin' — contrived, but it
    # exercises the cross-provider email-match path: the OIDC link is
    # created against the existing LOCAL admin user. Role-mapping must
    # NOT touch the local admin even though a 'myorg=admin' rule matches
    # the (empty) groups list... actually groups are empty here so no
    # rule would match anyway. The real test is: even if a rule DID
    # match, the local admin's role stays 'admin' and source stays 'local'.
    transport = _github_transport(
        user_data={"id": 104, "login": "dave", "name": "Dave"},
        emails=[{"email": "admin", "primary": True, "verified": True}],  # contrived
        orgs=[{"login": "myorg"}],
        teams=[],
    )
    config = _github_config(
        transport,
        role_mappings=["github:myorg=admin"],
        default_role="viewer",
    )
    # The login links to the existing local admin (cross-provider email match).
    username = _login_via_github(store, config)
    assert username == "admin"
    # The local admin is UNCHANGED — role-mapping skipped because source='local'.
    admin_after = store.get_by_username("admin")
    assert admin_after is not None
    assert admin_after.role == "admin", "local admin's role must not be changed by OIDC mapping"
    assert admin_after.source == "local", "local admin's source must stay 'local'"


def test_role_mapping_jwt_reflects_new_role(store: UserStore) -> None:
    """The JWT issued at callback time carries the mapped role (not the
    pre-mapping default), so the user doesn't need a second login to get
    the right privileges."""
    transport = _github_transport(
        user_data={"id": 105, "login": "eve", "name": "Eve"},
        emails=[{"email": "eve@example.com", "primary": True, "verified": True}],
        orgs=[{"login": "myorg"}],
        teams=[],
    )
    config = _github_config(
        transport,
        role_mappings=["github:myorg=operator"],
        default_role="viewer",
    )
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
        auth_cookie = resp.cookies.get(AUTH_COOKIE_NAME)
        assert auth_cookie is not None
        payload = decode_access_token(auth_cookie, secret=SECRET)
        assert payload["role"] == "operator"


# ---------------------------------------------------------------------------
# Provider fetch_userinfo group tests (no full callback).
# ---------------------------------------------------------------------------


async def test_github_org_membership_fetch() -> None:
    """GitHubProvider.fetch_userinfo populates UserInfo.groups from
    /user/orgs (org slugs) and /user/teams (org/team slugs)."""
    transport = _github_transport(
        user_data={"id": 200, "login": "frank", "name": "Frank"},
        emails=[{"email": "frank@example.com", "primary": True, "verified": True}],
        orgs=[{"login": "myorg"}, {"login": "otherorg"}],
        teams=[
            {"organization": {"login": "myorg"}, "slug": "admins"},
            {"organization": {"login": "myorg"}, "slug": "devs"},
        ],
    )
    client = httpx.AsyncClient(transport=transport)
    p = GitHubProvider(client_id="gh_id", client_secret="gh_secret", http_client=client)
    try:
        info = await p.fetch_userinfo("gho_mock")
    finally:
        await client.aclose()
    assert info.groups == ["myorg", "otherorg", "myorg/admins", "myorg/devs"]


async def test_github_orgs_failure_empty_groups() -> None:
    """If /user/orgs returns a non-200 (e.g. missing read:org scope), groups
    is empty rather than crashing the login."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://github.com/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "gho_mock", "token_type": "bearer"})
        if url == "https://api.github.com/user":
            return httpx.Response(200, json={"id": 201, "login": "g", "name": "G"})
        if url == "https://api.github.com/user/emails":
            return httpx.Response(200, json=[])
        if url == "https://api.github.com/user/orgs":
            return httpx.Response(403, json={"message": "Forbidden"})
        if url == "https://api.github.com/user/teams":
            return httpx.Response(403, json={"message": "Forbidden"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GitHubProvider(client_id="gh_id", client_secret="gh_secret", http_client=client)
    try:
        info = await p.fetch_userinfo("gho_mock")
    finally:
        await client.aclose()
    assert info.groups == []
    assert info.provider_user_id == "201"


async def test_generic_claim_extraction_default() -> None:
    """GenericOIDCProvider extracts the default 'groups' claim (list of strings)."""
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
        "groups": ["admin@example.com", "devs@example.com"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://idp.example.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://idp.example.com/oauth/userinfo":
            return httpx.Response(200, json=userinfo)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GenericOIDCProvider(
        name="okta",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        client_id="okta_id",
        client_secret="okta_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
    )
    try:
        info = await p.fetch_userinfo("generic.mock")
    finally:
        await client.aclose()
    assert info.groups == ["admin@example.com", "devs@example.com"]


async def test_generic_claim_extraction_custom_claim() -> None:
    """GenericOIDCProvider extracts a custom claim (set via groups_claim)."""
    discovery = {
        "authorization_endpoint": "https://idp.example.com/oauth/authorize",
        "token_endpoint": "https://idp.example.com/oauth/token",
        "userinfo_endpoint": "https://idp.example.com/oauth/userinfo",
    }
    # Okta-style: groups live in 'groups' but as list of objects with 'name'.
    userinfo = {
        "sub": "okta-002",
        "email": "eve@example.com",
        "name": "Eve",
        "groups": [{"name": "admins"}, {"name": "devs"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://idp.example.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://idp.example.com/oauth/userinfo":
            return httpx.Response(200, json=userinfo)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GenericOIDCProvider(
        name="okta",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        client_id="okta_id",
        client_secret="okta_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
        groups_claim="groups",  # explicit, exercises the override path
    )
    try:
        info = await p.fetch_userinfo("generic.mock")
    finally:
        await client.aclose()
    assert info.groups == ["admins", "devs"]


async def test_generic_claim_extraction_renamed_claim() -> None:
    """A renamed claim (e.g. Keycloak 'realm_roles' or Okta 'memberOf') is
    extracted when the operator sets groups_claim accordingly."""
    discovery = {
        "authorization_endpoint": "https://idp.example.com/oauth/authorize",
        "token_endpoint": "https://idp.example.com/oauth/token",
        "userinfo_endpoint": "https://idp.example.com/oauth/userinfo",
    }
    userinfo = {
        "sub": "kc-001",
        "email": "frank@example.com",
        "name": "Frank",
        "memberOf": ["role:admin", "role:operator"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://idp.example.com/.well-known/openid-configuration":
            return httpx.Response(200, json=discovery)
        if url == "https://idp.example.com/oauth/userinfo":
            return httpx.Response(200, json=userinfo)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    p = GenericOIDCProvider(
        name="kc",
        discovery_url="https://idp.example.com/.well-known/openid-configuration",
        client_id="kc_id",
        client_secret="kc_secret",
        redirect_base=REDIRECT_BASE,
        http_client=client,
        groups_claim="memberOf",
    )
    try:
        info = await p.fetch_userinfo("generic.mock")
    finally:
        await client.aclose()
    assert info.groups == ["role:admin", "role:operator"]


# ---------------------------------------------------------------------------
# users.source column tests.
# ---------------------------------------------------------------------------


def test_users_source_column_seeded_locals_are_local(store: UserStore) -> None:
    """The three default seeded users have source='local'."""
    for username, _pw, role in DEFAULT_USERS:
        user = store.get_by_username(username)
        assert user is not None, f"seeded user {username} missing"
        assert user.source == "local", f"{username} should be source='local'"
        assert user.role == role


def test_users_source_column_oidc_user_is_oidc(store: UserStore) -> None:
    """An OIDC-provisioned user has source='oidc'."""
    transport = _github_transport(
        user_data={"id": 300, "login": "grace", "name": "Grace"},
        emails=[{"email": "grace@example.com", "primary": True, "verified": True}],
        orgs=[],
        teams=[],
    )
    config = _github_config(transport)  # no role mappings
    username = _login_via_github(store, config)
    user = store.get_by_username(username)
    assert user is not None
    assert user.source == "oidc"
