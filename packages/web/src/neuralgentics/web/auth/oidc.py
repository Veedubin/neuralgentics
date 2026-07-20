"""OIDC provider abstraction (T-112).

Real OIDC integration replacing the T-109 stub. Three provider kinds:

  * :class:`GitHubProvider` — GitHub's OAuth2 (not proper OIDC; fixed
    endpoints, no discovery document).
  * :class:`GoogleProvider` — Google's OIDC (fetches
    ``https://accounts.google.com/.well-known/openid-configuration``).
  * :class:`GenericOIDCProvider` — any OIDC IdP with a discovery URL
    (Okta, Auth0, Keycloak, etc.).

All providers implement :class:`OIDCProvider` (a :class:`typing.Protocol`)
so the route layer can treat them uniformly. HTTP calls use
:class:`httpx.AsyncClient`; tests inject a fake transport to avoid
network access.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

import httpx

log = logging.getLogger("neuralgentics.web.auth.oidc")

# Default scopes. Individual providers override as needed (GitHub uses
# ``read:user user:email`` instead of ``openid email profile``).
DEFAULT_SCOPES: tuple[str, ...] = ("openid", "email", "profile")

# Cookie name template for the CSRF state token. One cookie per provider
# so concurrent flows (rare but possible) don't clobber each other.
STATE_COOKIE_TEMPLATE = "oidc_state_{provider}"

# State cookie lifetime in seconds (10 min). The OAuth2 redirect should
# complete well within this window; long enough for a slow IdP, short
# enough to limit replay window.
STATE_COOKIE_TTL_SECONDS = 600


@dataclass(frozen=True)
class TokenResponse:
    """Normalized token response from the IdP's token endpoint."""

    access_token: str
    token_type: str = "bearer"
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: str | None = None
    id_token: str | None = None

    @classmethod
    def from_raw(cls, raw: dict[str, Any]) -> TokenResponse:
        """Build from the IdP's raw JSON (keys vary slightly by provider)."""
        return cls(
            access_token=str(raw["access_token"]),
            token_type=str(raw.get("token_type", "bearer")),
            refresh_token=raw.get("refresh_token")
            if isinstance(raw.get("refresh_token"), str)
            else None,
            expires_in=int(raw["expires_in"]) if raw.get("expires_in") is not None else None,
            scope=raw.get("scope") if isinstance(raw.get("scope"), str) else None,
            id_token=raw.get("id_token") if isinstance(raw.get("id_token"), str) else None,
        )


@dataclass(frozen=True)
class UserInfo:
    """Normalized user info from the IdP's userinfo endpoint.

    ``provider_user_id`` is always set (GitHub numeric id, Google sub).
    ``email`` may be None if the user hid it (private). ``display_name``
    is best-effort for the login page greeting.
    """

    provider_user_id: str
    username: str | None
    email: str | None
    display_name: str | None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


@runtime_checkable
class OIDCProvider(Protocol):
    """A configured OIDC/OAuth2 provider.

    Implementations are immutable dataclasses holding client_id/secret +
    endpoints. The two async methods do the network I/O at request time.
    """

    name: str
    authorization_url: str
    token_url: str
    userinfo_url: str
    scopes: tuple[str, ...]

    def authorization_params(self, redirect_uri: str, state: str) -> dict[str, str]:
        """Build the query params for the authorize redirect."""
        ...

    async def exchange_code(self, code: str, redirect_uri: str) -> TokenResponse:
        """Exchange an authorization code for an access token."""
        ...

    async def fetch_userinfo(self, access_token: str) -> UserInfo:
        """Fetch the user info using the access token."""
        ...


# ---------------------------------------------------------------------------
# GitHub — fixed endpoints (no OIDC discovery).
# ---------------------------------------------------------------------------

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
GITHUB_SCOPES: tuple[str, ...] = ("read:user", "user:email")


@dataclass
class GitHubProvider:
    """GitHub OAuth2 provider (not full OIDC — no discovery)."""

    client_id: str
    client_secret: str
    # httpx client for tests to inject a mock transport. Production leaves
    # this None and a fresh client is created per call.
    http_client: httpx.AsyncClient | None = None

    name: str = "github"
    authorization_url: str = GITHUB_AUTHORIZE_URL
    token_url: str = GITHUB_TOKEN_URL
    userinfo_url: str = GITHUB_USER_URL
    scopes: tuple[str, ...] = GITHUB_SCOPES

    def authorization_params(self, redirect_uri: str, state: str) -> dict[str, str]:
        return {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(self.scopes),
            "state": state,
        }

    async def _client(self) -> httpx.AsyncClient:
        return self.http_client if self.http_client is not None else httpx.AsyncClient(timeout=15.0)

    async def exchange_code(self, code: str, redirect_uri: str) -> TokenResponse:
        """POST to GitHub's token endpoint. GitHub accepts JSON or form."""
        client = await self._client()
        try:
            resp = await client.post(
                self.token_url,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        if "error" in raw:
            raise OIDCError(f"github token error: {raw.get('error_description', raw.get('error'))}")
        return TokenResponse.from_raw(raw)

    async def fetch_userinfo(self, access_token: str) -> UserInfo:
        """GET /user + /user/emails. GitHub hides email unless /emails is
        fetched separately."""
        client = await self._client()
        try:
            headers = {
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
            }
            user_resp = await client.get(self.userinfo_url, headers=headers)
            user_resp.raise_for_status()
            user_raw = user_resp.json()
            # Fetch emails (separate endpoint; may be empty if user hid all).
            email: str | None = None
            try:
                emails_resp = await client.get(GITHUB_EMAILS_URL, headers=headers)
                emails_resp.raise_for_status()
                emails_list = emails_resp.json()
                if isinstance(emails_list, list):
                    # Prefer the primary + verified email.
                    for e in emails_list:
                        if isinstance(e, dict) and e.get("primary") and e.get("verified"):
                            email = e.get("email") if isinstance(e.get("email"), str) else None
                            if email:
                                break
                    # Fallback: any email.
                    if email is None:
                        for e in emails_list:
                            if isinstance(e, dict) and isinstance(e.get("email"), str):
                                email = e["email"]
                                break
            except httpx.HTTPError as exc:
                log.warning("github /user/emails failed: %s — proceeding without email", exc)
        finally:
            if self.http_client is None:
                await client.aclose()
        gid = user_raw.get("id")
        if gid is None:
            raise OIDCError("github /user response missing 'id'")
        login = user_raw.get("login") if isinstance(user_raw.get("login"), str) else None
        name = user_raw.get("name") if isinstance(user_raw.get("name"), str) else None
        return UserInfo(
            provider_user_id=str(gid),
            username=login,
            email=email,
            display_name=name or login,
            raw=user_raw,
        )


# ---------------------------------------------------------------------------
# Google — OIDC discovery.
# ---------------------------------------------------------------------------

GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"


@dataclass
class GoogleProvider:
    """Google OIDC provider. Fetches discovery once on first use."""

    client_id: str
    client_secret: str
    redirect_base: str
    http_client: httpx.AsyncClient | None = None

    name: str = "google"
    # Filled in lazily from discovery.
    authorization_url: str = ""
    token_url: str = ""
    userinfo_url: str = ""
    scopes: tuple[str, ...] = DEFAULT_SCOPES
    _discovered: bool = False

    async def _ensure_discovered(self) -> None:
        if self._discovered:
            return
        client = (
            self.http_client if self.http_client is not None else httpx.AsyncClient(timeout=15.0)
        )
        try:
            resp = await client.get(GOOGLE_DISCOVERY_URL)
            resp.raise_for_status()
            cfg = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        au = cfg.get("authorization_endpoint")
        tu = cfg.get("token_endpoint")
        uu = cfg.get("userinfo_endpoint")
        if not isinstance(au, str) or not isinstance(tu, str) or not isinstance(uu, str):
            raise OIDCError("google discovery missing required endpoints")
        self.authorization_url = au
        self.token_url = tu
        self.userinfo_url = uu
        self._discovered = True

    def authorization_params(self, redirect_uri: str, state: str) -> dict[str, str]:
        return {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "state": state,
        }

    async def _client(self) -> httpx.AsyncClient:
        return self.http_client if self.http_client is not None else httpx.AsyncClient(timeout=15.0)

    async def exchange_code(self, code: str, redirect_uri: str) -> TokenResponse:
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.post(
                self.token_url,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
            resp.raise_for_status()
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        if "error" in raw:
            raise OIDCError(f"google token error: {raw.get('error_description', raw.get('error'))}")
        return TokenResponse.from_raw(raw)

    async def fetch_userinfo(self, access_token: str) -> UserInfo:
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.get(
                self.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        sub = raw.get("sub")
        if sub is None:
            raise OIDCError("google userinfo missing 'sub'")
        email = raw.get("email") if isinstance(raw.get("email"), str) else None
        name = raw.get("name") if isinstance(raw.get("name"), str) else None
        login = (
            raw.get("preferred_username")
            if isinstance(raw.get("preferred_username"), str)
            else None
        )
        return UserInfo(
            provider_user_id=str(sub),
            username=login,
            email=email,
            display_name=name or login or email,
            raw=raw,
        )


# ---------------------------------------------------------------------------
# Generic OIDC — any IdP with a discovery URL.
# ---------------------------------------------------------------------------


@dataclass
class GenericOIDCProvider:
    """Generic OIDC provider configured by a discovery URL.

    Used for Okta, Auth0, Keycloak, Azure AD, etc. The provider name is
    set from the CLI flag (``--oidc-generic-<name>-discovery-url=...``).
    """

    name: str
    discovery_url: str
    client_id: str
    client_secret: str
    redirect_base: str
    http_client: httpx.AsyncClient | None = None

    authorization_url: str = ""
    token_url: str = ""
    userinfo_url: str = ""
    scopes: tuple[str, ...] = DEFAULT_SCOPES
    _discovered: bool = False

    async def _ensure_discovered(self) -> None:
        if self._discovered:
            return
        client = (
            self.http_client if self.http_client is not None else httpx.AsyncClient(timeout=15.0)
        )
        try:
            resp = await client.get(self.discovery_url)
            resp.raise_for_status()
            cfg = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        au = cfg.get("authorization_endpoint")
        tu = cfg.get("token_endpoint")
        uu = cfg.get("userinfo_endpoint")
        if not isinstance(au, str) or not isinstance(tu, str) or not isinstance(uu, str):
            raise OIDCError(f"discovery at {self.discovery_url} missing required endpoints")
        self.authorization_url = au
        self.token_url = tu
        self.userinfo_url = uu
        self._discovered = True

    def authorization_params(self, redirect_uri: str, state: str) -> dict[str, str]:
        return {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "state": state,
        }

    async def _client(self) -> httpx.AsyncClient:
        return self.http_client if self.http_client is not None else httpx.AsyncClient(timeout=15.0)

    async def exchange_code(self, code: str, redirect_uri: str) -> TokenResponse:
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.post(
                self.token_url,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
            resp.raise_for_status()
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        if "error" in raw:
            raise OIDCError(
                f"{self.name} token error: {raw.get('error_description', raw.get('error'))}"
            )
        return TokenResponse.from_raw(raw)

    async def fetch_userinfo(self, access_token: str) -> UserInfo:
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.get(
                self.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        sub = raw.get("sub")
        if sub is None:
            raise OIDCError(f"{self.name} userinfo missing 'sub'")
        email = raw.get("email") if isinstance(raw.get("email"), str) else None
        name = raw.get("name") if isinstance(raw.get("name"), str) else None
        login = (
            raw.get("preferred_username")
            if isinstance(raw.get("preferred_username"), str)
            else None
        )
        return UserInfo(
            provider_user_id=str(sub),
            username=login,
            email=email,
            display_name=name or login or email,
            raw=raw,
        )


class OIDCError(Exception):
    """Raised on OIDC protocol failures (bad token, missing userinfo, etc.)."""


__all__ = [
    "DEFAULT_SCOPES",
    "STATE_COOKIE_TEMPLATE",
    "STATE_COOKIE_TTL_SECONDS",
    "TokenResponse",
    "UserInfo",
    "OIDCProvider",
    "GitHubProvider",
    "GoogleProvider",
    "GenericOIDCProvider",
    "OIDCError",
]
