"""RBAC dependency for FastAPI routes (T-109, wired into real routes T-110,
per-module overrides T-111).

Usage (global, T-110)::

    @router.post("/memory/{memory_id}/trust")
    async def adjust_trust(..., user: User = Depends(require_role("admin", "operator"))):
        ...

Usage (per-module action, T-111)::

    from neuralgentics.web.modules.loader import module_route

    @router.get("/modules/memini-browser")
    @module_route("search")
    async def search_page(...,
        user: User | None = Depends(require_module_action(
            module_name="memini-browser",
            action="search",
            registry=registry,
            rbac_mode="permissive",
        )),
    ): ...

The dependency reads ``request.state.user`` — populated by
:class:`~neuralgentics.web.auth.middleware.AuthMiddleware` — and raises
HTTP 401/403 if the user isn't present or lacks the required role.

``--auth=off`` (embedded mode, or team-server with explicit ``--auth=off``)
sets ``request.state.user = None``. The dependency treats ``None`` as an
anonymous pass-through so dev/embedded mode never 401s on RBAC-gated
routes — the network boundary (localhost bind) is the security boundary
in that mode, not the role check. Only an actually-resolved :class:`User`
goes through the role gate.

T-111 per-module RBAC:

  * A module's ``module.yaml`` may declare an optional ``rbac`` block
    (:class:`~neuralgentics.web.modules.registry.RbacSpec`) with a
    module-wide ``required_role`` floor and/or a per-action role table.
  * :func:`require_module_action` resolves the action's role list from
    the live registry (so hot-reload of ``module.yaml`` is picked up
    without a process restart).
  * ``rbac_mode="permissive"`` (default, backwards compat): a missing
    action in the manifest falls back to the global role table supplied
    to :func:`require_module_action` (the T-110 ``allowed_roles``).
  * ``rbac_mode="strict"``: a missing action in the manifest denies the
    request with 403. Useful for production deployments that want the
    manifest to be the single source of truth for who-can-do-what.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException, Request

from neuralgentics.web.auth.users import User

if TYPE_CHECKING:
    from neuralgentics.web.modules.registry import ModuleRegistry

# Three roles for v0.14.x. T-111 extends this with a per-module override
# table; the global roles remain the fallback / default.
ROLES: tuple[str, ...] = ("admin", "operator", "viewer")

# Ordering used by the module-wide ``required_role`` floor. Higher rank
# means more privilege. A ``required_role: operator`` floor admits operator
# and admin but denies viewer.
ROLE_RANK: dict[str, int] = {"viewer": 0, "operator": 1, "admin": 2}

RbacMode = Literal["permissive", "strict"]


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


def require_module_action(
    *,
    module_name: str,
    action: str,
    registry: ModuleRegistry,
    fallback_roles: tuple[str, ...] = ("admin", "operator", "viewer"),
    rbac_mode: RbacMode = "permissive",
) -> Callable[..., User | None]:
    """Build a FastAPI dependency that enforces per-module RBAC for one
    action (T-111).

    Resolution order at request time:

      1. ``request.state.user is None`` (auth=off / embedded) → return
         ``None`` (anonymous pass-through; same bypass as
         :func:`require_role`).
      2. Look up the module's :class:`ModuleState` in ``registry``. If the
         module is unknown, fall back to ``fallback_roles`` (defensive —
         shouldn't happen in normal operation).
      3. If the manifest declares ``rbac.required_role``, enforce the
         module-wide floor first: a user whose role rank is below the
         floor is denied with 403 regardless of the per-action table.
      4. If the manifest declares ``rbac.actions[action]``, the user's
         role must be in that list (403 otherwise).
      5. If the action is NOT in ``rbac.actions``:
           * ``rbac_mode="permissive"`` → fall back to ``fallback_roles``
             (T-110 backwards compat).
           * ``rbac_mode="strict"``      → 403 (manifest is the single
             source of truth; missing action = deny).

    Args:
        module_name: Manifest name (hyphenated, e.g. ``"memini-browser"``).
        action: Action name tagged on the route via
            :func:`~neuralgentics.web.modules.loader.module_route`.
        registry: The live :class:`ModuleRegistry` (re-read each request
            so hot-reload of ``module.yaml`` is picked up immediately).
        fallback_roles: Global role list used when the manifest doesn't
            declare the action AND mode is permissive. Default admits
            any authenticated user (matches T-110 read endpoints).
        rbac_mode: ``"permissive"`` (default) or ``"strict"``.

    Raises:
        HTTPException(401) — no ``user`` attribute / not a User.
        HTTPException(403) — user's role below the floor, not in the
            action's list, or (strict mode) action missing from manifest.
    """

    if not fallback_roles:
        raise ValueError("fallback_roles must list at least one role")
    bad = set(fallback_roles) - set(ROLES)
    if bad:
        raise ValueError(f"unknown fallback role(s): {sorted(bad)}; valid: {ROLES}")

    def dependency(request: Request) -> User | None:
        if not hasattr(request.state, "user"):
            raise HTTPException(status_code=401, detail="not_authenticated")
        user: object | None = getattr(request.state, "user", None)
        if user is None:
            # auth=off path: anonymous pass-through.
            return None
        if not isinstance(user, User):
            raise HTTPException(status_code=401, detail="not_authenticated")

        # Resolve the module's RBAC spec from the live registry. If the
        # module isn't registered (defensive — shouldn't happen in normal
        # operation), fall back to the global role list.
        state = registry.get(module_name)
        if state is None:
            allowed = fallback_roles
        else:
            spec = state.manifest.rbac
            # (3) Module-wide floor.
            floor = spec.required_role
            if floor is not None and ROLE_RANK.get(user.role, -1) < ROLE_RANK[floor]:
                raise HTTPException(
                    status_code=403,
                    detail=f"forbidden: module {module_name} requires {floor}+",
                )
            # (4) Per-action table.
            if action in spec.actions:
                allowed = tuple(spec.actions[action])
            else:
                # (5) Missing action → permissive fallback or strict deny.
                if rbac_mode == "strict":
                    raise HTTPException(
                        status_code=403,
                        detail=(
                            f"forbidden: action {action!r} not declared in "
                            f"module {module_name} rbac.actions (strict mode)"
                        ),
                    )
                allowed = fallback_roles

        if user.role not in allowed:
            raise HTTPException(status_code=403, detail="forbidden")
        return user

    return dependency


__all__ = ["ROLES", "ROLE_RANK", "RbacMode", "require_module_action", "require_role"]
