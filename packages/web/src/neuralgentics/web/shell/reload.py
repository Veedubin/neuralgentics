"""Hot-reload + enable/disable for neuralgentics-web modules (T-115 / T-115.1).

Provides:

  * :func:`reload_module`   — re-read ``module.yaml`` from disk, re-import
    the module's Python ``module.py`` (via :func:`importlib.reload`), build
    a fresh :class:`Module` instance, include its router at the **same
    paths** as the prior version (the prior routes are removed from
    ``app.router.routes`` first), and invalidate the cached OpenAPI schema.
  * :func:`enable_module` / :func:`disable_module` — toggle the
    :attr:`ModuleState.enabled` flag. Disabled modules' routes return 404
    via :class:`DisabledModuleMiddleware`.
  * :func:`build_admin_modules_router` — the FastAPI router for
    ``POST /api/v1/modules/{name}/reload|enable|disable``, wired with
    ``Depends(require_role("admin"))`` from T-109's RBAC layer.

T-115.1 (route-unregistration gap, BREAK FIX):
  Prior to T-115.1, the old routes stayed live after a reload because
  FastAPI has no public API to unregister routes — the old version kept
  responding at its original path, so an admin who reloaded to ship a
  bug fix would think the fix was live while the OLD broken code was
  still being served. T-115.1 fixes this by:

    1. Tagging every route a module registers with ``route.module_name``
       (done in :func:`loader._include_router_tagged`).
    2. On reload, finding all routes tagged with the module name,
       snapshotting them, removing them from ``app.router.routes``,
       including the new router (re-tagged), and only then superseding
       the registry state. If the new router fails to build/include,
       the snapshot is restored — the old routes stay live (transactional).
    3. Invalidating ``app.openapi_schema = None`` so the schema regenerates.

In-flight requests on the removed routes are **not killed**: removing a
route from the list only prevents new requests from matching it; already-
dispatched handlers run to completion (the route object is still alive in
memory until GC). This is the documented behavior we rely on.

SSE streams owned by the prior module instance receive a "goodbye" frame
before being closed: the prior instance's ``shutdown()`` coroutine is
scheduled as a fire-and-forget background task, and the SSE handlers
check for a ``Goodbye`` sentinel pushed into their subscriber queue by
``Broadcaster.stop()`` (added in T-115.1 to the gateway/broker audit
broadcasters).

Out of scope:
  * Live code edits to shared dependencies (auth, etc.) — would require a
    process restart anyway.
  * Module dependency resolution (if module A imports module B, reloading
    B requires reloading A first).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import JSONResponse as StarletteJSONResponse
from starlette.responses import Response

from neuralgentics.web.auth.rbac import require_role
from neuralgentics.web.auth.users import User
from neuralgentics.web.modules.registry import (
    ModuleManifest,
    ModuleRegistry,
    ModuleState,
    parse_manifest,
)

log = logging.getLogger("neuralgentics.web.shell.reload")


# --------------------------------------------------------------------------------------
# Reload / enable / disable
# --------------------------------------------------------------------------------------


def _modules_path_for(registry: ModuleRegistry, config: Any = None) -> Path:
    """Re-derive the modules directory from the config, or fall back to the
    packaged ``modules/`` dir.

    The config (WebConfig) carries ``modules_path``; if absent we use the
    default packaged path next to this package.
    """
    if config is not None:
        mp = getattr(config, "modules_path", None)
        if mp is not None:
            return Path(mp)
    return Path(__file__).resolve().parent.parent / "modules"


def reload_module(name: str, app: Any, registry: ModuleRegistry, config: Any) -> ModuleState:
    """Re-read ``module.yaml`` from disk + re-import the module's Python
    ``module.py``, then **replace** the prior routes with the new ones at
    the same paths (T-115.1 — closes the route-unregistration gap).

    Transactional: the new instance + router are built first; only if both
    succeed are the old routes removed and the new routes included. If the
    new router fails to build or include, the old routes stay live and the
    exception propagates as an ``HTTPException(500)``.

    In-flight requests on the removed old routes complete normally
    (removing a route from ``app.router.routes`` only prevents *new*
    matches; already-dispatched handlers run to completion).

    SSE streams owned by the prior instance receive a goodbye frame via
    the prior ``shutdown()`` coroutine, which is scheduled as a
    fire-and-forget background task.

    Returns the new :class:`ModuleState`. Raises ``HTTPException(404)`` if
    the module isn't registered, or ``HTTPException(400)`` if the module
    has no Python implementation (pure stubs can't be reloaded — there's
    no Python module object to re-import).
    """
    prior = registry.get(name)
    if prior is None:
        raise HTTPException(status_code=404, detail=f"unknown module: {name}")
    if prior.instance is None:
        raise HTTPException(
            status_code=400,
            detail=f"module {name} has no Python implementation — nothing to reload",
        )

    modules_path = _modules_path_for(registry, config)
    pkg_dir_name = name.replace("-", "_")
    manifest_path = modules_path / pkg_dir_name / "module.yaml"
    if not manifest_path.exists():
        raise HTTPException(
            status_code=500,
            detail=f"module.yaml for {name} not found at {manifest_path}",
        )

    # 1. Re-read the manifest from disk.
    try:
        new_manifest: ModuleManifest = parse_manifest(manifest_path)
    except Exception as exc:  # noqa: BLE001 — surface as 400
        raise HTTPException(status_code=400, detail=f"manifest parse failed: {exc}") from exc
    if new_manifest.name != name:
        raise HTTPException(
            status_code=400,
            detail=f"manifest name mismatch: {new_manifest.name!r} != {name!r}",
        )

    # 2. Re-import the Python module object by file path. This re-executes
    #    the module's top-level code, picking up edits to module.py and
    #    (because intra-module imports resolve via sys.modules) any
    #    sibling edits that the module's own imports pull in.
    from neuralgentics.web.modules.loader import (
        _find_module_class,
        _include_router_tagged,
        load_module_python,
    )

    pkg_name = name.replace("-", "_")
    try:
        mod = load_module_python(pkg_name, modules_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f"re-import of {pkg_name} failed: {exc}",
        ) from exc
    if mod is None:
        raise HTTPException(
            status_code=500,
            detail=f"module.py for {name} not found at {modules_path / pkg_name / 'module.py'}",
        )

    # 3. Find the Module subclass + build via the factory (same path as
    #    the loader's register_module_routes).
    cls = _find_module_class(mod)
    if cls is None:
        raise HTTPException(
            status_code=500,
            detail=f"no Module subclass found in {modules_path / pkg_name / 'module.py'}",
        )
    build_fn = getattr(mod, "build", None)
    try:
        instance: Any = (
            build_fn(new_manifest, config) if callable(build_fn) else cls(manifest=new_manifest)
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"build() failed: {exc}") from exc

    # 4. Build the new router. Legacy modules (no build_router) fall back to
    #    the async register_routes path; we can't hot-reload those cleanly
    #    (they register routes via a lifespan-time coroutine), so we 400.
    build_router_fn = getattr(instance, "build_router", None)
    if not callable(build_router_fn):
        raise HTTPException(
            status_code=400,
            detail=(
                f"module {name} uses the legacy async register_routes contract — "
                "hot-reload requires the sync build_router() API"
            ),
        )
    try:
        module_router = build_router_fn()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"build_router() failed: {exc}") from exc

    # 5. T-115.1: TRANSACTIONAL ROUTE REPLACEMENT.
    #    (a) Snapshot the prior routes tagged with this module name +
    #        the insertion index (position of the first removed route).
    #    (b) Remove them from app.router.routes.
    #    (c) Include the new router (re-tagged) at the SAME index so the
    #        new routes win over the shell router's /modules/{name}
    #        catch-all (module routers are included BEFORE the shell
    #        router at startup; the reload must preserve that order).
    #    (d) Invalidate the cached OpenAPI schema.
    #    If (c) raises, restore the snapshot so the old routes stay live.
    removed, insert_at = _remove_module_routes(app, name)
    try:
        _include_router_tagged(app, module_router, name, insert_at=insert_at)
    except Exception as exc:  # noqa: BLE001
        # Restore the snapshot — old routes go back live.
        app.router.routes[insert_at:insert_at] = removed
        raise HTTPException(
            status_code=500,
            detail=f"include_router() for reloaded {name} failed: {exc}",
        ) from exc
    # OpenAPI schema is cached on the app — invalidate so it regenerates
    # with the new routes (and without the removed ones).
    app.openapi_schema = None

    # 6. Start background tasks (SSE drains, etc.) for the new instance.
    start_bg = getattr(instance, "start_background", None)
    if callable(start_bg):
        try:
            start_bg()
        except Exception as exc:  # noqa: BLE001
            log.warning("start_background() for %s failed: %s", name, exc)

    # 7. T-115.1: schedule the prior instance's shutdown() as a
    #    fire-and-forget background task. This sends a goodbye frame to
    #    any active SSE subscribers on the prior broadcaster and cancels
    #    the prior drain task. In-flight requests on the removed routes
    #    are NOT killed — they complete naturally (the route object is
    #    still alive in memory; only the list entry was removed).
    _schedule_prior_shutdown(app, prior.instance)

    # 8. Build the new state + supersede the prior one. The new version
    #    increments (so the supersession chain is queryable), but the new
    #    routes live at the SAME unversioned paths as the old ones (no
    #    /v{N} prefix) — that's the whole point of T-115.1.
    new_version = prior.version + 1
    new_state = ModuleState(
        manifest=new_manifest,
        enabled=prior.enabled,  # preserve the toggled enabled flag across reloads
        version=new_version,
        instance=instance,
        router=module_router,
    )
    registry.supersede(new_state)
    log.info("hot-reloaded module %s → v%d (routes replaced in-place)", name, new_version)
    return new_state


def _remove_module_routes(app: Any, module_name: str) -> tuple[list[Any], int]:
    """Remove every route in ``app.router.routes`` tagged with
    ``module_name`` (set by :func:`loader._include_router_tagged`).

    Returns ``(removed, insert_at)`` where ``removed`` is the list of
    removed routes in registration order and ``insert_at`` is the index
    of the first removed route (so the caller can re-insert the new
    routes at the same position, preserving route precedence — module
    routers are included BEFORE the shell router at startup, and the
    reload must preserve that order so the module's literal
    ``/modules/<name>`` route wins over the shell's
    ``/modules/{module_name}`` catch-all).

    Routes without a ``module_name`` attribute (shell routes, admin
    router, auth routes) are left untouched. Returns ``( [], 0 )`` if no
    routes were removed (defensive — callers should handle this).
    """
    kept: list[Any] = []
    removed: list[Any] = []
    insert_at = -1
    for i, route in enumerate(app.router.routes):
        if getattr(route, "module_name", None) == module_name:
            if insert_at == -1:
                insert_at = i
            removed.append(route)
        else:
            kept.append(route)
    # Mutate the list in place (FastAPI holds a reference to it).
    app.router.routes[:] = kept
    if insert_at == -1:
        # No routes were removed — insert at the front (module routes
        # should precede the shell router, matching startup behavior).
        return [], 0
    return removed, insert_at


def _schedule_prior_shutdown(app: Any, prior_instance: Any) -> None:
    """Schedule ``prior_instance.shutdown()`` as a fire-and-forget task.

    T-115.1: the prior module's SSE broadcaster pushes a goodbye sentinel
    to each subscriber queue in its ``stop()``; the SSE handler sees the
    sentinel, emits a goodbye frame, and breaks out. The prior drain task
    is cancelled and its resources released.

    We use ``asyncio.ensure_future`` against the running loop (if any) so
    the shutdown happens asynchronously without blocking the reload
    response. If no loop is running (e.g. synchronous test path), the
    coroutine is scheduled on the app's lifespan loop via
    ``app.state`` — but in practice the TestClient lifespan starts a loop
    so this branch is rare.
    """
    shutdown_fn = getattr(prior_instance, "shutdown", None)
    if not callable(shutdown_fn):
        return
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — best-effort: schedule when the lifespan loop
        # starts. Stored on app.state.prior_shutdowns, drained by the
        # lifespan. (Rare path; the common path is the running-loop branch.)
        pend = list(getattr(app.state, "pending_prior_shutdowns", []))
        pend.append(shutdown_fn)
        app.state.pending_prior_shutdowns = pend
        return
    loop.create_task(_safe_shutdown(shutdown_fn))


async def _safe_shutdown(shutdown_fn: Any) -> None:
    """Run ``shutdown_fn()`` swallowing exceptions — fire-and-forget."""
    try:
        await shutdown_fn()
    except Exception:  # noqa: BLE001
        log.exception("prior module shutdown error during reload")


def enable_module(name: str, registry: ModuleRegistry) -> ModuleState:
    """Enable a module (its routes will respond again)."""
    s = registry.get(name)
    if s is None:
        raise HTTPException(status_code=404, detail=f"unknown module: {name}")
    s.enabled = True
    log.info("enabled module %s", name)
    return s


def disable_module(name: str, registry: ModuleRegistry) -> ModuleState:
    """Disable a module (its routes will return 404 via middleware)."""
    s = registry.get(name)
    if s is None:
        raise HTTPException(status_code=404, detail=f"unknown module: {name}")
    s.enabled = False
    log.info("disabled module %s", name)
    return s


# --------------------------------------------------------------------------------------
# Admin API router (POST /api/v1/modules/{name}/reload|enable|disable)
# --------------------------------------------------------------------------------------


def build_admin_modules_router(registry: ModuleRegistry, app: Any, config: Any) -> APIRouter:
    """Construct the admin-only module-management router.

    All three endpoints require ``Depends(require_role("admin"))`` —
    operators and viewers get 403, unauthenticated requests get 401
    (surfaced by the auth middleware before the dependency runs).
    """
    router = APIRouter(prefix="/api/v1/modules", tags=["admin-modules"])

    @router.post("/{module_name}/reload")
    async def reload_route(
        module_name: str,
        user: User = Depends(require_role("admin")),
    ) -> JSONResponse:
        _ = user  # noqa: F841 — RBAC gate only
        state = reload_module(module_name, app, registry, config)
        return JSONResponse(state.to_summary())

    @router.post("/{module_name}/enable")
    async def enable_route(
        module_name: str,
        user: User = Depends(require_role("admin")),
    ) -> JSONResponse:
        _ = user  # noqa: F841 — RBAC gate only
        state = enable_module(module_name, registry)
        return JSONResponse(state.to_summary())

    @router.post("/{module_name}/disable")
    async def disable_route(
        module_name: str,
        user: User = Depends(require_role("admin")),
    ) -> JSONResponse:
        _ = user  # noqa: F841 — RBAC gate only
        state = disable_module(module_name, registry)
        return JSONResponse(state.to_summary())

    return router


# --------------------------------------------------------------------------------------
# DisabledModuleMiddleware — 404 for disabled modules' routes
# --------------------------------------------------------------------------------------


class DisabledModuleMiddleware(BaseHTTPMiddleware):
    """Return 404 for any route belonging to a disabled module (T-115).

    Path patterns covered (per module ``name``):

      * ``/modules/{name}``           — module HTML page
      * ``/modules/{name}/...``       — sub-routes (sse, memory detail, etc.)
      * ``/api/v1/{name}/...``        — module JSON API endpoints

    T-115.1: the versioned-prefix patterns (``/v{N}/modules/{name}/...``)
    are gone — reload now replaces routes in-place at the unversioned
    paths, so there are no ``/v{N}`` routes to 404. The middleware's
    versioned-path branches are kept as no-ops for backwards compatibility
    with any stale clients that still hit ``/v{N}/...`` URLs (they 404
    naturally because no route is registered there).

    The middleware reads the registry from ``app.state.registry`` (set by
    :func:`build_app`). If the registry is missing or the module is
    enabled, the request passes through.
    """

    def __init__(self, app: Any, registry: ModuleRegistry) -> None:
        super().__init__(app)
        self.registry = registry

    async def dispatch(self, request: StarletteRequest, call_next: Any) -> Response:
        path = request.url.path
        # Short-circuit: only inspect paths that look module-related.
        # Versioned paths (/v{N}/...) are left to fall through to the
        # normal 404 path — no routes are registered there post-T-115.1.
        if path.startswith("/modules/") or path.startswith("/api/v1/"):
            disabled_name = _disabled_module_for_path(path, self.registry)
            if disabled_name is not None:
                return StarletteJSONResponse(
                    {"error": "module_disabled", "name": disabled_name},
                    status_code=404,
                )
        response: Response = await call_next(request)
        return response


def _is_versioned(path: str) -> bool:
    """True if path is ``/v<digits>/...`` (a versioned reload prefix).

    T-115.1: kept for backwards-compat detection of stale ``/v{N}/...``
    URLs. No routes are registered under these prefixes post-T-115.1
    (reload replaces in-place), so a request to a versioned path naturally
    404s via the normal no-route-match path.
    """
    if not path.startswith("/v"):
        return False
    rest = path[2:]
    slash = rest.find("/")
    if slash == -1:
        return rest.isdigit()
    return rest[:slash].isdigit()


def _disabled_module_for_path(path: str, registry: ModuleRegistry) -> str | None:
    """Return the name of the disabled module that owns ``path``, or None.

    Iterates the registry's disabled states and checks the path patterns
    listed in :class:`DisabledModuleMiddleware`. Cheap: the registry is
    tiny (a handful of modules) and only disabled ones are checked.
    """
    for state in registry.all():
        if state.enabled:
            continue
        name = state.name
        if _path_belongs_to_module(path, name):
            return name
    return None


def _path_belongs_to_module(path: str, name: str) -> bool:
    """True if ``path`` belongs to module ``name``.

    T-115.1: only the unversioned patterns are checked — the versioned
    patterns are gone (reload replaces in-place). The ``_is_versioned``
    branch is retained for the rare case of a stale client still hitting
    a ``/v{N}/modules/{name}/...`` URL; it resolves to the unversioned
    suffix after stripping the prefix.
    """
    # Unversioned.
    if path == f"/modules/{name}" or path.startswith(f"/modules/{name}/"):
        return True
    if path.startswith(f"/api/v1/{name}/"):
        return True
    # Versioned: /v{N}/modules/{name}[/...] | /v{N}/api/v1/{name}/...
    # Stale-client back-compat — no routes are registered here post-T-115.1.
    if _is_versioned(path):
        slash = path.find("/", 2)  # first slash after /v{N}
        if slash == -1:
            return False
        suffix = path[slash:]
        return (
            suffix == f"/modules/{name}"
            or suffix.startswith(f"/modules/{name}/")
            or suffix.startswith(f"/api/v1/{name}/")
        )
    return False


__all__ = [
    "DisabledModuleMiddleware",
    "build_admin_modules_router",
    "disable_module",
    "enable_module",
    "reload_module",
]
