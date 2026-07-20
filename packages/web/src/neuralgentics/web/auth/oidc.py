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
class RefreshResponse:
    """Normalized refresh-token grant response (T-122).

    ``access_token`` is the new bearer token. ``expires_in`` is the
    lifetime in seconds (as returned by the IdP); callers convert it to
    an absolute unix expiry when persisting. ``refresh_token`` is the
    new refresh token if the IdP rotates it (RFC 6749 §6 recommends
    rotation; Google does, Okta can), else ``None`` and the caller
    keeps the old one.
    """

    access_token: str
    expires_in: int
    refresh_token: str | None = None


@dataclass(frozen=True)
class UserInfo:
    """Normalized user info from the IdP's userinfo endpoint.

    ``provider_user_id`` is always set (GitHub numeric id, Google sub).
    ``email`` may be None if the user hid it (private). ``display_name``
    is best-effort for the login page greeting.

    ``groups`` (T-121) holds the provider-specific group membership
    list used by role-mapping. Each entry is a string the operator can
    match against in ``--oidc-role-mapping``:

      * GitHub: ``"myorg"`` (org membership) and ``"myorg/admins"``
        (team slug, ``org/team``).
      * Google: group email from the OIDC ``groups`` claim (e.g.
        ``"admin@example.com"``) — populated only if the Google
        Workspace was configured to emit the claim.
      * Generic: each entry of the configured claim (default ``groups``)
        as a string.
    """

    provider_user_id: str
    username: str | None
    email: str | None
    display_name: str | None
    groups: list[str] = field(default_factory=list)
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

    async def refresh_token(self, refresh_token: str) -> RefreshResponse:
        """Exchange a stored refresh token for a new access token (T-122).

        Implementations return a :class:`RefreshResponse` with the new
        access token + lifetime (seconds). If the IdP rotates the
        refresh token, the new one is returned in
        :attr:`RefreshResponse.refresh_token`; otherwise it's ``None``
        and the caller keeps using the old one.

        Raises :class:`OIDCError` if the IdP rejects the refresh grant
        (revoked, expired, etc.) — the caller (background refresher /
        force-refresh-on-401 path) treats any exception as "mark the
        link revoked and force re-login".
        """
        ...


# ---------------------------------------------------------------------------
# GitHub — fixed endpoints (no OIDC discovery).
# ---------------------------------------------------------------------------

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_URL = "https://api.github.com/user"
GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
GITHUB_ORGS_URL = "https://api.github.com/user/orgs"
GITHUB_TEAMS_URL = "https://api.github.com/user/teams"
GITHUB_SCOPES: tuple[str, ...] = ("read:user", "user:email", "read:org")


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

    async def refresh_token(self, refresh_token: str) -> RefreshResponse:
        """GitHub does NOT support refresh-token grants for OAuth Apps.

        GitHub OAuth Apps issue access tokens that are valid until the
        user revokes them or revokes the app — there's no expiry and no
        refresh token. GitHub Apps (a different product) DO issue
        refresh tokens (8-hour access tokens + refresh), but our
        :class:`GitHubProvider` is for OAuth Apps (the
        ``/login/oauth/access_token`` endpoint).

        So for OAuth Apps the T-112 callback typically stores
        ``refresh_token=None`` and the background refresher skips this
        link (no refresh token to exchange). If a caller does invoke
        ``refresh_token()`` here (e.g. the force-refresh-on-401 path),
        we raise :class:`OIDCError` with a clear message rather than
        silently pretending to refresh.

        Operators who need refresh tokens should switch to a GitHub App
        (separate client_id/secret, different token endpoint) or use
        the Generic OIDC provider against an IdP that supports RFC 6749
        §6 (Google, Okta, Auth0, Keycloak all do).
        """
        raise OIDCError(
            "github OAuth Apps do not support refresh-token grants "
            "(use a GitHub App or a different provider for refresh support)"
        )

    async def fetch_userinfo(self, access_token: str) -> UserInfo:
        """GET /user + /user/emails (+ /user/orgs + /user/teams for T-121).

        GitHub hides email unless /emails is fetched separately. T-121
        also fetches org membership (``/user/orgs``) and team membership
        (``/user/teams``) so role-mapping can match ``myorg`` or
        ``myorg/admins``. Group-fetch failures are logged and the user
        is still provisioned with an empty ``groups`` list — operators
        who want role-mapping must grant the ``read:org`` scope, but we
        don't hard-fail a login if they didn't.
        """
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
            # T-121: fetch org + team membership for role-mapping. Best-effort:
            # a missing scope or a transient error degrades to an empty
            # groups list (the user still gets the default role).
            groups: list[str] = []
            try:
                orgs_resp = await client.get(GITHUB_ORGS_URL, headers=headers)
                if orgs_resp.status_code == 200:
                    orgs_list = orgs_resp.json()
                    if isinstance(orgs_list, list):
                        for o in orgs_list:
                            if isinstance(o, dict) and isinstance(o.get("login"), str):
                                groups.append(o["login"])
                else:
                    log.warning(
                        "github /user/orgs returned %d — role-mapping groups will be empty",
                        orgs_resp.status_code,
                    )
            except httpx.HTTPError as exc:
                log.warning("github /user/orgs failed: %s — proceeding without org groups", exc)
            try:
                teams_resp = await client.get(GITHUB_TEAMS_URL, headers=headers)
                if teams_resp.status_code == 200:
                    teams_list = teams_resp.json()
                    if isinstance(teams_list, list):
                        for t in teams_list:
                            if not isinstance(t, dict):
                                continue
                            org = t.get("organization")
                            slug = t.get("slug")
                            if (
                                isinstance(org, dict)
                                and isinstance(org.get("login"), str)
                                and isinstance(slug, str)
                            ):
                                groups.append(f"{org['login']}/{slug}")
                else:
                    log.warning(
                        "github /user/teams returned %d — team-level role-mapping disabled",
                        teams_resp.status_code,
                    )
            except httpx.HTTPError as exc:
                log.warning("github /user/teams failed: %s — proceeding without team groups", exc)
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
            groups=groups,
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

    async def refresh_token(self, refresh_token: str) -> RefreshResponse:
        """POST ``grant_type=refresh_token`` to Google's token endpoint.

        Google follows RFC 6749 §6 — refresh tokens are long-lived
        (until revoked) and access tokens expire in ~1h. The response
        always includes a new ``access_token`` + ``expires_in``; the
        refresh token is NOT rotated by default (the same one keeps
        working), so we return ``refresh_token=None`` and the caller
        keeps using the stored one.
        """
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.post(
                self.token_url,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            # Don't raise_for_status here — a 400 with {"error": "invalid_grant"}
            # is the canonical "user revoked access" signal that the caller
            # needs to translate into a revoked link, not an OIDCError-from-
            # httpx that loses the error body.
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        if "error" in raw:
            raise OIDCError(
                f"google refresh error: {raw.get('error_description', raw.get('error'))}"
            )
        # Google always returns expires_in; guard anyway.
        exp = raw.get("expires_in")
        if not isinstance(exp, int):
            exp = 3600
        return RefreshResponse(
            access_token=str(raw["access_token"]),
            expires_in=exp,
            # Google doesn't rotate the refresh token.
            refresh_token=raw.get("refresh_token")
            if isinstance(raw.get("refresh_token"), str)
            else None,
        )

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
        # T-121: Google Workspace emits a ``groups`` claim in the
        # userinfo response when the OAuth client is configured to
        # request it. The value is a list of group email strings
        # (e.g. ``["admin@example.com", "devs@example.com"]``). We
        # extract them as-is; operators match against the email in
        # ``--oidc-role-mapping=google:admin@example.com=admin``.
        groups = _extract_groups_claim(raw)
        return UserInfo(
            provider_user_id=str(sub),
            username=login,
            email=email,
            display_name=name or login or email,
            groups=groups,
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

    ``groups_claim`` (T-121) selects which userinfo claim holds the
    group membership list. Defaults to ``"groups"``. The claim may be
    either a list of strings or a list of objects with a ``name`` key
    (Okta / Keycloak both shapes exist in the wild); objects are
    flattened to their ``name`` value.
    """

    name: str
    discovery_url: str
    client_id: str
    client_secret: str
    redirect_base: str
    http_client: httpx.AsyncClient | None = None
    groups_claim: str = "groups"

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

    async def refresh_token(self, refresh_token: str) -> RefreshResponse:
        """POST ``grant_type=refresh_token`` to the discovered token endpoint.

        Same shape as Google's refresh. Generic OIDC IdPs (Okta, Auth0,
        Keycloak, Azure AD) all follow RFC 6749 §6. We don't assume the
        IdP rotates the refresh token — if it does, the new one is in
        the response and we return it; if not, we return ``None`` and
        the caller keeps the old one.
        """
        await self._ensure_discovered()
        client = await self._client()
        try:
            resp = await client.post(
                self.token_url,
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            raw = resp.json()
        finally:
            if self.http_client is None:
                await client.aclose()
        if "error" in raw:
            raise OIDCError(
                f"{self.name} refresh error: {raw.get('error_description', raw.get('error'))}"
            )
        exp = raw.get("expires_in")
        if not isinstance(exp, int):
            # RFC 6749 §4.2.2 says expires_in SHOULD be present; if absent,
            # assume 1h (Google's default) so the background loop still
            # schedules a refresh.
            exp = 3600
        return RefreshResponse(
            access_token=str(raw["access_token"]),
            expires_in=exp,
            refresh_token=raw.get("refresh_token")
            if isinstance(raw.get("refresh_token"), str)
            else None,
        )

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
        # T-121: extract the configured claim (default ``groups``).
        groups = _extract_groups_claim(raw, claim=self.groups_claim)
        return UserInfo(
            provider_user_id=str(sub),
            username=login,
            email=email,
            display_name=name or login or email,
            groups=groups,
            raw=raw,
        )


def _extract_groups_claim(raw: dict[str, Any], claim: str = "groups") -> list[str]:
    """Flatten a userinfo ``groups`` claim into a list of strings.

    Accepts either a list of strings (Google, Keycloak) or a list of
    objects with a ``name`` key (Okta). Non-conforming entries are
    silently skipped — operators are expected to configure the claim
    name correctly; we don't crash a login over a malformed claim.
    """
    val = raw.get(claim)
    if not isinstance(val, list):
        return []
    out: list[str] = []
    for entry in val:
        if isinstance(entry, str):
            out.append(entry)
        elif isinstance(entry, dict):
            name = entry.get("name")
            if isinstance(name, str):
                out.append(name)
    return out


class OIDCError(Exception):
    """Raised on OIDC protocol failures (bad token, missing userinfo, etc.)."""


# ---------------------------------------------------------------------------
# T-121: group → role mapping
# ---------------------------------------------------------------------------

# Role privilege ordering (lowest → highest). Used to pick the "highest
# wins" role when a user matches multiple mapping rules. Operators can
# only assign roles from this set — anything else is rejected at config
# build time (RoleMapping.parse).
ROLE_PRIVILEGE: dict[str, int] = {"viewer": 0, "operator": 1, "admin": 2}


@dataclass(frozen=True)
class RoleMapping:
    """One ``--oidc-role-mapping`` rule.

    ``provider`` is the OIDC provider name (``github``, ``google``,
    custom). ``group_pattern`` is the provider-specific group identifier
    (GitHub org slug ``myorg``, GitHub team slug ``myorg/admins``,
    Google group email ``admin@example.com``, or any string the generic
    provider emits in its configured claim). ``role`` is the role to
    apply when the user is a member of that group.
    """

    provider: str
    group_pattern: str
    role: str

    @staticmethod
    def parse(spec: str) -> RoleMapping:
        """Parse a single ``PROVIDER:GROUP_PATTERN=ROLE`` rule.

        Raises ``ValueError`` on malformed input or an unknown role.
        """
        if "=" not in spec:
            raise ValueError(f"role-mapping must be PROVIDER:GROUP_PATTERN=ROLE, got: {spec!r}")
        lhs, role = spec.rsplit("=", 1)
        role = role.strip()
        if role not in ROLE_PRIVILEGE:
            raise ValueError(
                f"role-mapping role must be one of {sorted(ROLE_PRIVILEGE)}, got: {role!r}"
            )
        if ":" not in lhs:
            raise ValueError(f"role-mapping must be PROVIDER:GROUP_PATTERN=ROLE, got: {spec!r}")
        provider, group_pattern = lhs.split(":", 1)
        provider = provider.strip()
        group_pattern = group_pattern.strip()
        if not provider or not group_pattern:
            raise ValueError(
                f"role-mapping provider and group_pattern must be non-empty, got: {spec!r}"
            )
        return RoleMapping(provider=provider, group_pattern=group_pattern, role=role)


def parse_role_mappings(rules: list[str]) -> list[RoleMapping]:
    """Parse a list of ``--oidc-role-mapping`` flag values.

    Each flag value may itself contain comma-separated rules, so
    ``["github:myorg=operator", "github:myorg/admins=admin,google:admins@admin"]``
    is accepted. Invalid rules raise ``ValueError`` (fail-fast at
    startup — operators should not discover a misconfigured mapping at
    login time).
    """
    out: list[RoleMapping] = []
    for rule in rules:
        for piece in rule.split(","):
            piece = piece.strip()
            if not piece:
                continue
            out.append(RoleMapping.parse(piece))
    return out


def extract_role_from_groups(
    provider: str,
    groups: list[str],
    mappings: list[RoleMapping],
    default_role: str,
) -> str:
    """Pick the role for an OIDC user based on their group membership.

    Iterates all mappings for ``provider`` whose ``group_pattern`` is in
    ``groups``; among the matching roles, the most privileged one wins
    (``admin`` > ``operator`` > ``viewer``). If no mapping matches, the
    ``default_role`` is returned.

    The ``default_role`` is NOT validated against :data:`ROLE_PRIVILEGE`
    here — the caller (the OIDC config / CLI) is responsible for
    validating it. This lets an operator set ``--oidc-default-role=
    viewer`` and have the function return ``"viewer"`` for unmatched
    users without re-validating on every call.
    """
    best_role: str | None = None
    best_rank = -1
    for m in mappings:
        if m.provider != provider:
            continue
        if m.group_pattern in groups:
            rank = ROLE_PRIVILEGE.get(m.role, -1)
            if rank > best_rank:
                best_rank = rank
                best_role = m.role
    return best_role if best_role is not None else default_role


__all__ = [
    "DEFAULT_SCOPES",
    "STATE_COOKIE_TEMPLATE",
    "STATE_COOKIE_TTL_SECONDS",
    "TokenResponse",
    "RefreshResponse",
    "UserInfo",
    "OIDCProvider",
    "GitHubProvider",
    "GoogleProvider",
    "GenericOIDCProvider",
    "OIDCError",
    "extract_role_from_groups",
]
