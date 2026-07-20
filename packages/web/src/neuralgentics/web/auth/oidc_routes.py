"""OIDC HTTP routes (T-112).

Adds the following to the ``/auth`` router:

  * ``GET  /auth/login/{provider}`` — start the flow, redirect to IdP.
  * ``GET  /auth/callback/{provider}`` — handle the callback, exchange
    code, create/update user, issue JWT, set cookie, redirect to ``/``.
  * ``GET  /auth/providers`` — list configured providers (JSON, for the
    login page UI to render buttons).
  * ``GET  /auth/login`` (HTML) — login page with local form + provider
    buttons (only when OIDC is enabled).

CSRF: a random state token is generated, stored in a short-lived signed
cookie ``oidc_state_<provider>``, and sent as the ``state`` query param
to the IdP. On callback, the cookie value must match the query param.
The cookie is cleared on callback (single-use).

JWT issuance: on successful callback, the server issues its own HS256
access token (same as T-109 local login) and sets it in an
``ng_auth`` HttpOnly cookie. The browser is then redirected to ``/``.
API clients can still use ``Authorization: Bearer <jwt>`` — the
middleware accepts either the cookie or the header.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.responses import Response

from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.oidc import (
    STATE_COOKIE_TEMPLATE,
    STATE_COOKIE_TTL_SECONDS,
    OIDCError,
    TokenResponse,
    UserInfo,
    extract_role_from_groups,
)
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.users import UserStore

log = logging.getLogger("neuralgentics.web.auth.oidc_routes")

# Cookie that carries our own JWT after OIDC login. HttpOnly so JS can't
# read it; SameSite=Lax so the redirect from the IdP carries it; Secure
# when the redirect_base is https.
AUTH_COOKIE_NAME = "ng_auth"
AUTH_COOKIE_TTL = 24 * 60 * 60  # 24h, matches ACCESS_TTL


def _new_state() -> str:
    """Return a fresh 32-byte url-safe state token."""
    return secrets.token_urlsafe(32)


def _state_cookie_name(provider: str) -> str:
    return STATE_COOKIE_TEMPLATE.format(provider=provider)


def _set_state_cookie(response: Response, provider: str, state: str, secure: bool) -> None:
    """Attach the CSRF state cookie to ``response``."""
    response.set_cookie(
        key=_state_cookie_name(provider),
        value=state,
        max_age=STATE_COOKIE_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/auth",
    )


def _clear_state_cookie(response: Response, provider: str, secure: bool) -> None:
    """Delete the CSRF state cookie (single-use consumption)."""
    response.delete_cookie(
        key=_state_cookie_name(provider),
        path="/auth",
        secure=secure,
        samesite="lax",
        httponly=True,
    )


def _set_auth_cookie(response: Response, jwt_token: str, secure: bool) -> None:
    """Attach the ``ng_auth`` JWT cookie to ``response``."""
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=jwt_token,
        max_age=AUTH_COOKIE_TTL,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def _is_secure(redirect_base: str) -> bool:
    """True if the redirect_base is https (cookie should be Secure)."""
    return redirect_base.startswith("https://")


def build_oidc_router(
    *,
    user_store: UserStore,
    oidc_config: OIDCConfig,
    secret: str | None = None,
) -> APIRouter:
    """Construct the OIDC ``/auth/*`` router.

    Returns an empty router (no routes) when ``oidc_config.enabled`` is
    False — the caller includes it unconditionally and gets a no-op when
    OIDC isn't configured.
    """
    router = APIRouter(prefix="/auth", tags=["auth-oidc"])

    if not oidc_config.enabled:
        # No providers configured — return an empty router. The T-109
        # local-login routes (in routes.py) remain the only auth path.
        return router

    secure = _is_secure(oidc_config.redirect_base)
    providers = oidc_config.providers

    @router.get("/providers")
    async def list_providers() -> JSONResponse:
        """List configured OIDC providers (for the login page UI)."""
        return JSONResponse(
            {
                "providers": [
                    {"name": p.name, "authorization_url": p.authorization_url}
                    for p in providers.values()
                ],
                "enabled": True,
            }
        )

    @router.get("/login/{provider}")
    async def login_with_provider(provider: str, request: Request) -> RedirectResponse:
        """Start the OIDC flow: redirect to the IdP's authorize URL."""
        p = providers.get(provider)
        if p is None:
            raise HTTPException(status_code=404, detail=f"unknown_oidc_provider: {provider}")
        try:
            redirect_uri = oidc_config.callback_url(provider)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        # For Google/Generic providers, trigger discovery so the authorize
        # URL is populated before we redirect. GitHub has fixed endpoints.
        if not p.authorization_url:
            discover = getattr(p, "_ensure_discovered", None)
            if discover is not None:
                try:
                    await discover()
                except OIDCError as exc:
                    raise HTTPException(status_code=502, detail="discovery_failed") from exc
                except Exception as exc:  # noqa: BLE001
                    log.warning("oidc discovery failed for %s: %s", provider, exc)
                    raise HTTPException(status_code=502, detail="discovery_failed") from exc

        state = _new_state()
        params = p.authorization_params(redirect_uri=redirect_uri, state=state)
        # Build the authorize URL. httpx doesn't help here because we're
        # not making a request — we're redirecting the browser.
        from urllib.parse import urlencode

        authorize_url = f"{p.authorization_url}?{urlencode(params)}"
        response = RedirectResponse(url=authorize_url, status_code=302)
        _set_state_cookie(response, provider, state, secure=secure)
        return response

    @router.get("/callback/{provider}")
    async def callback(provider: str, request: Request) -> RedirectResponse:
        """Handle the IdP callback: verify state, exchange code, issue JWT."""
        p = providers.get(provider)
        if p is None:
            raise HTTPException(status_code=404, detail=f"unknown_oidc_provider: {provider}")

        # --- CSRF: verify state cookie matches query state. ---
        query_state = request.query_params.get("state")
        cookie_state = request.cookies.get(_state_cookie_name(provider))
        if (
            not query_state
            or not cookie_state
            or not secrets.compare_digest(query_state, cookie_state)
        ):
            raise HTTPException(status_code=400, detail="invalid_state")

        code = request.query_params.get("code")
        if not code:
            raise HTTPException(status_code=400, detail="missing_code")

        # --- Exchange code for access token. ---
        try:
            redirect_uri = oidc_config.callback_url(provider)
            token_resp: TokenResponse = await p.exchange_code(code=code, redirect_uri=redirect_uri)
        except OIDCError as exc:
            log.warning("oidc token exchange failed for %s: %s", provider, exc)
            raise HTTPException(status_code=400, detail="token_exchange_failed") from exc
        except Exception as exc:  # noqa: BLE001 — network errors from httpx
            log.warning("oidc token exchange network error for %s: %s", provider, exc)
            raise HTTPException(status_code=502, detail="idp_unreachable") from exc

        # --- Fetch userinfo. ---
        try:
            info: UserInfo = await p.fetch_userinfo(token_resp.access_token)
        except OIDCError as exc:
            log.warning("oidc userinfo failed for %s: %s", provider, exc)
            raise HTTPException(status_code=400, detail="userinfo_failed") from exc
        except Exception as exc:  # noqa: BLE001
            log.warning("oidc userinfo network error for %s: %s", provider, exc)
            raise HTTPException(status_code=502, detail="idp_unreachable") from exc

        # --- Provision local user. ---
        user = user_store.get_or_create_oidc_user(
            provider=provider,
            provider_user_id=info.provider_user_id,
            email=info.email,
            username_hint=info.username,
            default_role=oidc_config.default_role,
        )
        # Persist the fresh access token (best-effort; failure isn't fatal).
        try:
            user_store.update_oauth_tokens(
                provider=provider,
                provider_user_id=info.provider_user_id,
                access_token=token_resp.access_token,
                refresh_token=token_resp.refresh_token,
                expires_at=token_resp.expires_in,
            )
        except Exception:  # noqa: BLE001
            log.warning("failed to persist oidc tokens for %s/%s", provider, info.provider_user_id)

        # --- T-121: apply group→role mapping (OIDC users only). ---
        # Local users (including the seeded admin/admin) are NEVER
        # touched by role-mapping — an IdP can't demote the local admin.
        # For OIDC users, the most privileged matching mapping wins
        # (admin > operator > viewer); no match falls back to the
        # configured default_role. The role is re-evaluated on every
        # login, so a user removed from a group is downgraded on next
        # login.
        effective_role = user.role
        if user.source == "oidc" and oidc_config.role_mappings:
            mapped = extract_role_from_groups(
                provider=provider,
                groups=info.groups,
                mappings=oidc_config.role_mappings,
                default_role=oidc_config.default_role,
            )
            if mapped != user.role:
                if user_store.set_role(user.username, mapped):
                    log.info(
                        "oidc role-mapping updated %s: %s → %s (provider=%s, groups=%s)",
                        user.username,
                        user.role,
                        mapped,
                        provider,
                        info.groups,
                    )
                    effective_role = mapped
                else:
                    log.warning(
                        "oidc role-mapping set_role failed for %s — keeping old role %s",
                        user.username,
                        user.role,
                    )
            # NOTE (T-121.1 follow-up): we deliberately do NOT downgrade an
            # existing OIDC user to default_role just because groups came
            # back empty (the IdP might have been unavailable for the
            # /user/orgs call, or the operator revoked the read:org scope).
            # Mapping only upgrades/changes the role when an explicit rule
            # matches; the "downgrade on group removal" behavior is a
            # separate card.

        # --- Issue our own JWT. (T-121: use effective_role so the token
        # reflects the just-applied mapping without requiring a second
        # login round-trip.) ---
        jwt_token = issue_access_token(user.username, effective_role, secret=secret)

        # --- Redirect to / with the JWT in a cookie. ---
        response = RedirectResponse(url="/", status_code=302)
        _set_auth_cookie(response, jwt_token, secure=secure)
        # Clear the single-use state cookie.
        _clear_state_cookie(response, provider, secure=secure)
        return response

    return router


__all__ = [
    "AUTH_COOKIE_NAME",
    "AUTH_COOKIE_TTL",
    "build_oidc_router",
]
