"""RBAC dependency for FastAPI routes (T-109, wired into real routes T-110).

Usage::

    @router.post("/memory/{memory_id}/trust")
    async def adjust_trust(..., user: User = Depends(require_role("admin", "operator"))):
        ...

The dependency reads ``request.state.user`` — populated by
:class:`~neuralgentics.web.auth.middleware.AuthMiddleware` — and raises
HTTP 401/403 if the user isn't present or lacks the required role.

``--auth=off`` (embedded mode, or team-server with explicit ``--auth=off``)
sets ``request.state.user = None``. The dependency treats ``None`` as an
anonymous pass-through so dev/embedded mode never 401s on RBAC-gated
routes — the network boundary (localhost bind) is the security boundary
in that mode, not the role check. Only an actually-resolved :class:`User`
goes through the role gate.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, Request

from neuralgentics.web.auth.users import User

# Three roles for v0.14.x. Global only — per-module RBAC is a future card.
ROLES: tuple[str, ...] = ("admin", "operator", "viewer")


def require_role(*allowed_roles: str) -> Callable[..., User | None]:
    """Build a FastAPI dependency that enforces ``allowed_roles``.

    Behavior:
      * ``request.state.user is None`` → return ``None`` (auth=off bypass).
        This is the ``--auth=off`` / embedded-mode path: the middleware
        explicitly sets ``user = None`` to signal "no auth", and the role
        gate steps aside. The localhost bind is the security boundary.
      * ``request.state.user`` is a :class:`User` → enforce the role check
        (403 if the user's role isn't in ``allowed_roles``).
      * ``request.state.user`` is missing entirely (no attribute) → 401.
        This shouldn't happen (the middleware always sets it) but is
        defensive against a misconfigured middleware stack.

    Raises:
        HTTPException(401) — no ``user`` attribute on ``request.state``.
        HTTPException(403) — user's role not in ``allowed_roles``.
    """

    if not allowed_roles:
        raise ValueError("require_role requires at least one role")
    bad = set(allowed_roles) - set(ROLES)
    if bad:
        raise ValueError(f"unknown role(s): {sorted(bad)}; valid: {ROLES}")

    def dependency(request: Request) -> User | None:
        # ``request.state.user`` may be unset if no middleware ran at all.
        # ``hasattr`` on a Starlette ``State`` is reliable (it uses __dict__).
        if not hasattr(request.state, "user"):
            raise HTTPException(status_code=401, detail="not_authenticated")
        user: object | None = getattr(request.state, "user", None)
        # auth=off path: middleware set user=None → anonymous pass-through.
        if user is None:
            return None
        if not isinstance(user, User):
            # Something other than a User or None landed on state.user —
            # treat as unauthenticated (defensive; shouldn't happen).
            raise HTTPException(status_code=401, detail="not_authenticated")
        if user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="forbidden")
        return user

    return dependency


__all__ = ["require_role", "ROLES"]
