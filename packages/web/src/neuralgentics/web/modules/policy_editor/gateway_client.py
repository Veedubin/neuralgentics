"""Gateway policy API client (T-157).

Talks to the gateway's policy reload + status HTTP endpoints (mounted
on the gateway's dashboard listener — see
neuralgentics-gateway/policyapi/api.go). The web editor calls this after
a successful save to ask the gateway to pick up the new YAML
immediately, rather than waiting up to ``policy.watch.interval`` for
the watcher's next poll.

Configuration is via env vars:

  * ``NEURALGENTICS_GATEWAY_URL`` — gateway base URL (e.g.
    ``http://127.0.0.1:9091``). When unset, the client is a no-op: the
    web editor silently falls back to the watcher's poll cadence. The
    disk save still succeeds — disk is the source of truth.
  * ``NEURALGENTICS_GATEWAY_POLICY_TOKEN`` — optional bearer token for
    the gateway's ``policy_api.auth_token``. When unset, no
    ``Authorization`` header is sent (the gateway default is auth
    disabled).

All network calls use a short timeout so an unreachable or slow
gateway never blocks a save response. Errors are returned in the
result, never raised — the editor surfaces them in the save partial
but the save itself is already on disk.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("neuralgentics.web.policy_editor.gateway_client")

# Short timeout so an unreachable gateway never blocks the save
# response. The gateway is on localhost in the common case; 2s is
# generous for a reload that touches a handful of YAML files.
_TIMEOUT_SECONDS = 2.0


@dataclass
class ReloadResult:
    """Outcome of a POST /api/v1/policies/reload call.

    ``ok`` is False whenever the call could not complete or the gateway
    reported errors. ``loaded`` / ``statements`` are populated on
    success; ``error`` carries a human-readable message on failure.
    """

    ok: bool
    loaded: int = 0
    statements: int = 0
    error: str | None = None


@dataclass
class GatewayStatus:
    """Snapshot of the gateway's currently-loaded policy set.

    ``reachable`` is False when the gateway is unreachable or the policy
    subsystem is disabled. When True, the other fields reflect the
    gateway's live state.
    """

    reachable: bool
    enabled: bool = False
    files: list[dict[str, Any]] | None = None
    statements: int = 0
    default_decision: str = ""
    watch_enabled: bool = False
    watch_interval_seconds: float = 0.0
    last_reload: str | None = None
    gateway_policies_dir: str = ""
    error: str | None = None


def _gateway_url() -> str | None:
    """Return the gateway base URL from env, or None when unset."""
    url = os.environ.get("NEURALGENTICS_GATEWAY_URL")
    if url:
        return url.rstrip("/")
    return None


def _gateway_token() -> str | None:
    """Return the optional bearer token from env, or None."""
    return os.environ.get("NEURALGENTICS_GATEWAY_POLICY_TOKEN")


def _auth_headers() -> dict[str, str]:
    """Build the Authorization header when a token is configured."""
    tok = _gateway_token()
    if tok:
        return {"Authorization": f"Bearer {tok}"}
    return {}


def trigger_reload() -> ReloadResult:
    """POST /api/v1/policies/reload to the gateway.

    When ``NEURALGENTICS_GATEWAY_URL`` is unset, returns a no-op result
    (``ok=True`` with a marker message) so the editor can show
    "gateway reload skipped (NEURALGENTICS_GATEWAY_URL unset)" without
    distinguishing it from a real failure. The disk save already
    succeeded; the watcher will pick up the file on its next tick.
    """
    base = _gateway_url()
    if base is None:
        return ReloadResult(
            ok=True, error="NEURALGENTICS_GATEWAY_URL unset; relying on watcher poll"
        )
    url = f"{base}/api/v1/policies/reload"
    try:
        resp = httpx.post(url, headers=_auth_headers(), timeout=_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        log.warning("gateway reload request failed: %s", exc)
        return ReloadResult(ok=False, error=f"gateway unreachable: {exc}")
    if resp.status_code != 200:
        return ReloadResult(
            ok=False, error=f"gateway returned {resp.status_code}: {resp.text[:200]}"
        )
    try:
        body = resp.json()
    except ValueError as exc:
        return ReloadResult(ok=False, error=f"gateway returned non-JSON: {exc}")
    errors = body.get("errors") or []
    if errors:
        return ReloadResult(
            ok=False,
            error="; ".join(str(e) for e in errors),
        )
    return ReloadResult(
        ok=True,
        loaded=int(body.get("loaded", 0)),
        statements=int(body.get("statements", 0)),
    )


def fetch_status() -> GatewayStatus:
    """GET /api/v1/policies/status from the gateway.

    Returns a :class:`GatewayStatus` with ``reachable=False`` when the
    gateway URL is unset or the request fails — the editor renders a
    graceful "gateway unreachable" panel.
    """
    base = _gateway_url()
    if base is None:
        return GatewayStatus(reachable=False, error="NEURALGENTICS_GATEWAY_URL unset")
    url = f"{base}/api/v1/policies/status"
    try:
        resp = httpx.get(url, headers=_auth_headers(), timeout=_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        log.debug("gateway status request failed: %s", exc)
        return GatewayStatus(reachable=False, error=f"gateway unreachable: {exc}")
    if resp.status_code != 200:
        return GatewayStatus(reachable=False, error=f"gateway returned {resp.status_code}")
    try:
        body = resp.json()
    except ValueError as exc:
        return GatewayStatus(reachable=False, error=f"non-JSON: {exc}")
    last = body.get("last_reload")
    return GatewayStatus(
        reachable=True,
        enabled=bool(body.get("enabled", False)),
        files=body.get("files") or [],
        statements=int(body.get("statements", 0)),
        default_decision=str(body.get("default_decision", "")),
        watch_enabled=bool(body.get("watch_enabled", False)),
        watch_interval_seconds=float(body.get("watch_interval_seconds", 0.0)),
        last_reload=str(last) if last else None,
        gateway_policies_dir=str(body.get("gateway_policies_dir", "")),
    )


__all__ = ["GatewayStatus", "ReloadResult", "fetch_status", "trigger_reload"]
