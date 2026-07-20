"""RBAC dependency for FastAPI routes (T-109).

Usage::

    @router.post("/memory/{memory_id}/trust")
    async def adjust_trust(..., user: User = Depends(require_role("admin", "operator"))):
        ...

The dependency reads ``request.state.user`` — populated by
:class:`~neuralgentics.web.auth.middleware.AuthMiddleware` — and raises
HTTP 401/403 if the user isn't present or lacks the required role.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, Request

from neuralgentics.web.auth.users import User

# Three roles for v0.14.x. Global only — per-module RBAC is a future card.
ROLES: tuple[str, ...] = ("admin", "operator", "viewer")


def require_role(*allowed_roles: str) -> Callable[..., User]:
    """Build a FastAPI dependency that enforces ``allowed_roles``.

    Raises:
        HTTPException(401) — no authenticated user on ``request.state``.
        HTTPException(403) — user's role not in ``allowed_roles``.
    """

    if not allowed_roles:
        raise ValueError("require_role requires at least one role")
    bad = set(allowed_roles) - set(ROLES)
    if bad:
        raise ValueError(f"unknown role(s): {sorted(bad)}; valid: {ROLES}")

    def dependency(request: Request) -> User:
        user: object | None = getattr(request.state, "user", None)
        if not isinstance(user, User):
            raise HTTPException(status_code=401, detail="not_authenticated")
        if user.role not in allowed_roles:
            raise HTTPException(status_code=403, detail="forbidden")
        return user

    return dependency


__all__ = ["require_role", "ROLES"]
