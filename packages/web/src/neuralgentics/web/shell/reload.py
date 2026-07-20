"""Hot-reload + enable/disable for neuralgentics-web modules (T-115).

Provides:

  * :func:`reload_module`   — re-read ``module.yaml`` from disk, re-import
    the module's Python ``module.py`` (via :func:`importlib.reload`), build
    a fresh :class:`Module` instance, and include its router under a
    versioned prefix (``/v{N}``) so the new routes live at e.g.
    ``/v2/modules/<name>`` while the prior routes stay live (FastAPI can't
    cleanly unregister routes — see T-115 scope).
  * :func:`enable_module` / :func:`disable_module` — toggle the
    :attr:`ModuleState.enabled` flag. Disabled modules' routes return 404
    via :class:`DisabledModuleMiddleware`.
  * :func:`build_admin_modules_router` — the FastAPI router for
    ``POST /api/v1/modules/{name}/reload|enable|disable``, wired with
    ``Depends(require_role("admin"))`` from T-109's RBAC layer.

Out of scope (deferred to T-115.1):
  * Unregistering routes registered in the previous import (FastAPI
    limitation — the old router stays mounted at its original paths).
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
    ``module.py``, then include the new router under ``/v{N}``.

    Returns the new :class:`ModuleState`. Raises ``HTTPException(404)`` if
    the module isn't registered, or ``HTTPException(400)`` if the module
    has no Python implementation (pure stubs can't be reloaded — there's
    no Python module object to re-import).

    The prior state is moved to :meth:`ModuleRegistry.supersede` and
    marked ``superseded_by = N``. The prior routes stay live (FastAPI
    limitation); the new routes live at ``/v{N}/...``.
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
    from neuralgentics.web.modules.loader import _find_module_class, load_module_python

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

    # 4. Build the router. Legacy modules (no build_router) fall back to
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

    # 5. Include the new router under a versioned prefix so the new routes
    #    live at /v{N}/... while the prior routes stay at their original paths.
    new_version = prior.version + 1
    versioned = APIRouter(prefix=f"/v{new_version}", tags=[f"{name}-v{new_version}"])
    versioned.include_router(module_router)
    app.include_router(versioned)

    # 6. Start background tasks (SSE drains, etc.) for the new instance.
    start_bg = getattr(instance, "start_background", None)
    if callable(start_bg):
        try:
            start_bg()
        except Exception as exc:  # noqa: BLE001
            log.warning("start_background() for %s v%d failed: %s", name, new_version, exc)

    # 7. Build the new state + supersede the prior one.
    new_state = ModuleState(
        manifest=new_manifest,
        enabled=prior.enabled,  # preserve the toggled enabled flag across reloads
        version=new_version,
        instance=instance,
        router=versioned,
    )
    registry.supersede(new_state)
    log.info("hot-reloaded module %s → v%d", name, new_version)
    return new_state


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
      * ``/v{N}/modules/{name}/...``  — versioned reload prefix
      * ``/v{N}/api/v1/{name}/...``   — versioned reload prefix (API)

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
        if path.startswith("/modules/") or path.startswith("/api/v1/") or _is_versioned(path):
            disabled_name = _disabled_module_for_path(path, self.registry)
            if disabled_name is not None:
                return StarletteJSONResponse(
                    {"error": "module_disabled", "name": disabled_name},
                    status_code=404,
                )
        response: Response = await call_next(request)
        return response


def _is_versioned(path: str) -> bool:
    """True if path is ``/v<digits>/...`` (a versioned reload prefix)."""
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
    """True if ``path`` belongs to module ``name`` under any of the
    documented patterns (unversioned or versioned)."""
    # Unversioned.
    if path == f"/modules/{name}" or path.startswith(f"/modules/{name}/"):
        return True
    if path.startswith(f"/api/v1/{name}/"):
        return True
    # Versioned: /v{N}/modules/{name}[/...] | /v{N}/api/v1/{name}/...
    if _is_versioned(path):
        # Strip the /v{N} prefix and re-check.
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
