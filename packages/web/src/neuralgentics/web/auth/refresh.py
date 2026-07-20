"""OIDC access-token refresh loop + force-refresh helper (T-122).

Closes the gap left by T-112 (real OIDC, but no refresh-token rotation
for the IdP access tokens — only our own JWT rotates). The IdP access
token from GitHub/Google expires in ~1h; after that the gateway/web
can't make API calls with it (e.g. to fetch org membership for T-121's
group mapping). This module:

  * :func:`refresh_due_tokens` — find links whose stored access token
    is about to expire, call the provider's ``refresh_token()``, and
    persist the new access token + expiry. Failed refreshes mark the
    link revoked (user must re-login).
  * :func:`start_refresh_loop` — an ``asyncio`` task that wakes every
    :data:`REFRESH_INTERVAL_SECONDS` (5 min) and calls
    :func:`refresh_due_tokens` with a :data:`REFRESH_LEAD_SECONDS`
    (10 min) horizon. Started by the team-server lifespan; cancelled
    on shutdown.
  * :func:`get_valid_access_token` — force-refresh helper for the
    "got 401 from the IdP API → try refreshing once before failing"
    pattern. Returns a fresh access token or ``None`` if the link is
    revoked/missing.

All DB access goes through :class:`~neuralgentics.web.auth.users.UserStore`
(SQLite, sync) — the refresher calls it from inside an ``asyncio``
loop via :func:`asyncio.to_thread` so the sync SQLite calls don't
block the event loop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from neuralgentics.web.auth.oidc import OIDCError, RefreshResponse
from neuralgentics.web.auth.oidc_config import OIDCConfig
from neuralgentics.web.auth.users import UserStore

if TYPE_CHECKING:
    from neuralgentics.web.auth.oidc import OIDCProvider

log = logging.getLogger("neuralgentics.web.auth.refresh")

# Background loop wakes up every 5 minutes. Tuned so that a token with
# a 1h lifetime is refreshed well before expiry (the 10-min lead gives
# the loop ~2 chances to refresh before the token actually expires).
REFRESH_INTERVAL_SECONDS: int = 5 * 60

# A link is considered "about to expire" if its stored expires_at is
# within this many seconds of NOW. 10 min matches the card spec and
# gives a comfortable margin for IdP latency + retry.
REFRESH_LEAD_SECONDS: int = 10 * 60


async def _refresh_one(
    *,
    provider: OIDCProvider,
    link: dict[str, object],
    store: UserStore,
) -> bool:
    """Refresh one link. Returns True on success, False on failure.

    On failure the link is marked revoked (the refresh grant was
    rejected — typically the user revoked access on the IdP side, or
    the refresh token expired). The user must re-login before their
    access token is trusted again.
    """
    p_name = str(link["provider"])
    p_uid = str(link["provider_user_id"])
    rt = link.get("refresh_token")
    if not isinstance(rt, str) or not rt:
        # No refresh token to exchange (GitHub OAuth Apps, or a prior
        # callback that didn't get one). Skip — nothing we can do. The
        # background loop's query filters these out, but we double-check
        # here in case of a race.
        log.debug("refresh: skipping %s/%s — no stored refresh token", p_name, p_uid)
        return False
    try:
        resp: RefreshResponse = await provider.refresh_token(rt)
    except OIDCError as exc:
        log.warning(
            "refresh: %s rejected refresh for %s (%s) — marking revoked: %s",
            p_name,
            link.get("username"),
            p_uid,
            exc,
        )
        await asyncio.to_thread(
            store.mark_oauth_link_revoked, provider=p_name, provider_user_id=p_uid
        )
        return False
    except Exception as exc:  # noqa: BLE001 — network errors from httpx
        log.warning(
            "refresh: %s refresh network error for %s (%s): %s — leaving link as-is",
            p_name,
            link.get("username"),
            p_uid,
            exc,
        )
        # Don't mark revoked on transient errors — the next loop tick
        # will retry. Only a positive rejection from the IdP (OIDCError)
        # marks the link revoked.
        return False

    new_expiry = int(time.time()) + int(resp.expires_in)
    # If the IdP rotated the refresh token, persist the new one;
    # otherwise keep the old one (rt).
    new_rt = resp.refresh_token if resp.refresh_token is not None else rt
    await asyncio.to_thread(
        store.refresh_update_oauth_link,
        provider=p_name,
        provider_user_id=p_uid,
        access_token=resp.access_token,
        refresh_token=new_rt,
        expires_at=new_expiry,
    )
    log.info(
        "refresh: %s/%s (%s) refreshed — new expiry in %ds",
        p_name,
        link.get("username"),
        p_uid,
        resp.expires_in,
    )
    return True


async def refresh_due_tokens(*, store: UserStore, oidc_config: OIDCConfig) -> int:
    """Refresh all links whose access token is about to expire.

    Returns the number of links successfully refreshed. Failed
    refreshes (link marked revoked) and skipped links (no refresh
    token) don't count toward the return value.

    Safe to call concurrently — the SQLite lock serializes the
    ``list_expiring_oauth_links`` query, and each refresh is an
    independent HTTP call + DB update. The background loop calls this
    once per tick; tests call it directly.
    """
    if not oidc_config.enabled:
        return 0
    links = await asyncio.to_thread(store.list_expiring_oauth_links, REFRESH_LEAD_SECONDS)
    if not links:
        return 0
    refreshed = 0
    for link in links:
        p_name = str(link["provider"])
        provider = oidc_config.providers.get(p_name)
        if provider is None:
            # Provider was removed from config after the link was
            # created. Skip — nothing to refresh against.
            log.warning("refresh: provider %s no longer configured — skipping", p_name)
            continue
        ok = await _refresh_one(provider=provider, link=link, store=store)
        if ok:
            refreshed += 1
    return refreshed


async def start_refresh_loop(
    *, store: UserStore, oidc_config: OIDCConfig, stop_event: asyncio.Event | None = None
) -> None:
    """Run the refresh loop forever (until cancelled or ``stop_event`` is set).

    Started by the team-server lifespan as an ``asyncio`` task. The
    lifespan cancels the task on shutdown; alternatively, pass a
    ``stop_event`` and the loop exits cleanly when it's set (used by
    tests so they don't have to deal with CancelledError).
    """
    if not oidc_config.enabled:
        log.info("refresh loop: OIDC disabled — loop is a no-op")
        return
    log.info(
        "refresh loop: started (interval=%ds, lead=%ds)",
        REFRESH_INTERVAL_SECONDS,
        REFRESH_LEAD_SECONDS,
    )
    while True:
        try:
            await refresh_due_tokens(store=store, oidc_config=oidc_config)
        except Exception:  # noqa: BLE001 — never let the loop die on a tick error
            log.exception("refresh loop: tick failed (will retry next interval)")
        # Wait for the interval, but bail out early if the stop event fires.
        try:
            if stop_event is not None:
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=REFRESH_INTERVAL_SECONDS)
                    # stop_event was set — exit cleanly.
                    log.info("refresh loop: stop event set — exiting")
                    return
                except TimeoutError:
                    pass
            else:
                await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            log.info("refresh loop: cancelled — exiting")
            raise


async def get_valid_access_token(
    *,
    username: str,
    provider_name: str,
    store: UserStore,
    oidc_config: OIDCConfig,
) -> str | None:
    """Return a fresh access token for ``(username, provider_name)``.

    Force-refresh-on-401 pattern: the caller made an IdP API call with
    the stored access token and got 401. This helper:

      1. Loads the link row.
      2. If the link is revoked or missing → return None (user must
         re-login; the caller surfaces a 401 to the browser).
      3. If the stored access token hasn't expired yet → return it
         (the 401 was probably for a different reason — scope lost,
         endpoint changed — but we hand back what we have).
      4. If the stored access token has expired (or is about to) →
         refresh once via ``provider.refresh_token()``.
      5. If the refresh succeeds → return the new access token.
      6. If the refresh fails → mark the link revoked and return None.

    The caller is responsible for actually retrying the failed IdP API
    call with the returned token. This helper only guarantees the
    token is fresh-as-of-now; it doesn't retry the upstream call.
    """
    if not oidc_config.enabled:
        return None
    provider = oidc_config.providers.get(provider_name)
    if provider is None:
        return None
    link = await asyncio.to_thread(store.get_oauth_link, username=username, provider=provider_name)
    if link is None:
        return None
    access_token = link.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        return None
    # If the token is still valid (with a small skew), return it as-is.
    exp = link.get("expires_at")
    now = int(time.time())
    if isinstance(exp, int) and exp > now + 30:
        return access_token
    # Expired or about to expire — refresh once.
    rt = link.get("refresh_token")
    if not isinstance(rt, str) or not rt:
        # No refresh token (GitHub OAuth Apps) — can't refresh. Return
        # the stale token; the caller's 401 will surface to the user.
        return access_token
    p_uid = str(link["provider_user_id"])
    try:
        resp: RefreshResponse = await provider.refresh_token(rt)
    except OIDCError as exc:
        log.warning(
            "force-refresh: %s rejected refresh for %s — marking revoked: %s",
            provider_name,
            username,
            exc,
        )
        await asyncio.to_thread(
            store.mark_oauth_link_revoked, provider=provider_name, provider_user_id=p_uid
        )
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning("force-refresh: %s network error for %s: %s", provider_name, username, exc)
        # Transient — return the stale token (the caller may still 401,
        # but we don't burn the link on a network blip).
        return access_token
    new_expiry = now + int(resp.expires_in)
    new_rt = resp.refresh_token if resp.refresh_token is not None else rt
    await asyncio.to_thread(
        store.refresh_update_oauth_link,
        provider=provider_name,
        provider_user_id=p_uid,
        access_token=resp.access_token,
        refresh_token=new_rt,
        expires_at=new_expiry,
    )
    return resp.access_token


__all__ = [
    "REFRESH_INTERVAL_SECONDS",
    "REFRESH_LEAD_SECONDS",
    "refresh_due_tokens",
    "start_refresh_loop",
    "get_valid_access_token",
]
