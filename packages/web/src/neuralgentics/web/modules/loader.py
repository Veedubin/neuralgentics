"""Module discovery — scan ``modules/*/module.yaml`` at startup.

Two-phase discovery:
  1. Parse every ``module.yaml`` into a :class:`ModuleManifest` (file-only).
  2. For modules that ship a Python ``module.py`` exposing a ``Module``
     subclass, instantiate it, include its FastAPI router, and record
     startup/shutdown hooks.

The shell router still serves the stub page for manifests that don't have
a Python implementation, so T-105's stubs continue to render even if the
Python class isn't present.

Module routers are included BEFORE the shell router (see :func:`build_app`)
so the module's literal ``/modules/<name>`` route wins over the shell's
``/modules/{module_name}`` catch-all.

T-115: the loader now populates :class:`ModuleState` (with the live
``Module`` instance + router) on the registry so the reload path can
supersede it. Pure stubs (no Python impl) get a state with
``instance=None`` / ``router=None``. Module loading is by file path (via
:func:`load_module_python`) so arbitrary module directories (including
test fixtures in temp dirs) work without being on ``sys.path``.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.util
import logging
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any, TypeVar

from neuralgentics.web.modules.registry import (
    ModuleManifest,
    ModuleRegistry,
    ModuleState,
    parse_manifest,
)

log = logging.getLogger("neuralgentics.web.loader")

_F = TypeVar("_F", bound=Callable[..., Any])


# --------------------------------------------------------------------------------------
# module_route — action tagger for per-module RBAC (T-111)
# --------------------------------------------------------------------------------------


def module_route(action: str) -> Callable[[_F], _F]:
    """Tag a route handler with an action name for per-module RBAC (T-111).

    Pure metadata decorator: it stores ``func.__module_action__ = action``
    and returns the function unchanged. The FastAPI router is unaffected —
    the tag is read by :func:`register_module_routes` (which can record the
    action→route mapping) and by route builders that wire
    :func:`~neuralgentics.web.auth.rbac.require_module_action` per-route.

    Backwards compatible: a route handler without ``__module_action__``
    falls back to the global role table from T-110 (``require_role``).

    Example::

        @router.get("/modules/memini-browser")
        @module_route("search")
        async def search_page(...): ...

    Args:
        action: Action name. Must match a key in the module's
            ``rbac.actions`` map (or be tolerated by permissive fallback).

    Raises:
        ValueError: if ``action`` is empty.
    """

    if not action or not action.strip():
        raise ValueError("module_route requires a non-empty action name")

    def decorator(func: _F) -> _F:
        # Stash the action on the function object. FastAPI ignores unknown
        # attributes, and the loader / route builders can read it back.
        func.__module_action__ = action  # type: ignore[attr-defined]
        return func

    return decorator


def discover_modules(modules_path: Path) -> ModuleRegistry:
    """Walk ``modules_path/*/module.yaml`` and return a populated registry.

    Invalid manifests are logged and skipped (per design doc: validation step).
    """
    registry = ModuleRegistry()
    if not modules_path.exists():
        log.warning("modules_path %s does not exist — empty registry", modules_path)
        return registry

    for child in sorted(modules_path.iterdir()):
        if not child.is_dir():
            continue
        manifest_path = child / "module.yaml"
        if not manifest_path.exists():
            continue
        try:
            manifest: ModuleManifest = parse_manifest(manifest_path)
        except Exception as exc:  # noqa: BLE001 — design says "log and skip"
            log.error("skipping module at %s: %s", manifest_path, exc)
            continue
        registry.register(manifest)
    return registry


def load_module_python(pkg_name: str, modules_path: Path) -> ModuleType | None:
    """Import (or re-import) a module's ``module.py`` by file path.

    Returns the loaded :class:`ModuleType`, or ``None`` if no ``module.py``
    exists at ``modules_path/<pkg_name>/module.py``.

    Uses :func:`importlib.util.spec_from_file_location` so the module's
    directory doesn't need to be on ``sys.path`` — this lets the reload
    path (T-115) work against arbitrary module directories (including
    test fixtures in temp dirs). The module is registered in
    ``sys.modules`` under
    ``neuralgentics.web.modules.<pkg_name>.module`` so intra-module
    imports (``from neuralgentics.web.modules.base import Module``)
    resolve correctly.

    The parent package ``neuralgentics.web.modules.<pkg_name>`` is
    imported via the normal import machinery *first* so its
    ``__init__.py`` runs before ``module.py`` execs. This avoids a
    circular-import failure where ``__init__.py`` does
    ``from .module import SomeClass`` while ``module.py`` is mid-exec
    (the sibling modules that ``module.py`` imports often trigger the
    parent package's ``__init__.py``).
    """
    file_path = modules_path / pkg_name / "module.py"
    if not file_path.exists():
        return None
    parent_pkg = f"neuralgentics.web.modules.{pkg_name}"
    # Ensure the parent package is loaded first. For the packaged
    # modules this resolves via sys.path; for temp-dir test fixtures the
    # parent package has no __init__.py on sys.path, so this is a no-op
    # (ImportError swallowed) — module.py is then loaded standalone.
    if parent_pkg not in sys.modules:
        # Temp-dir fixture: no __init__.py on sys.path. Fall through
        # and load module.py standalone (its imports of
        # neuralgentics.web.modules.base still resolve). For packaged
        # modules the normal import below resolves via sys.path.
        with contextlib.suppress(ImportError):
            importlib.import_module(parent_pkg)
    full_name = f"{parent_pkg}.module"
    # If module.py is already loaded (e.g. prior test), drop it so the
    # re-exec picks up edits. This is the reload path.
    sys.modules.pop(full_name, None)
    spec = importlib.util.spec_from_file_location(full_name, file_path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec so intra-module relative
    # imports resolve during the top-level exec.
    sys.modules[full_name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception:
        # Roll back the sys.modules entry on failure so a retry isn't
        # poisoned by a half-loaded module.
        sys.modules.pop(full_name, None)
        raise
    return mod


def _modules_path_from_config(config: Any) -> Path:
    """Re-derive the modules directory from the WebConfig (or default)."""
    modules_path = getattr(config, "modules_path", None)
    if modules_path is None:
        modules_path = Path(__file__).resolve().parent.parent / "modules"
    return Path(modules_path)


def register_module_routes(app: Any, registry: ModuleRegistry, config: Any) -> None:
    """For each discovered manifest, try to import its Python module class,
    include its FastAPI router, and record startup/shutdown hooks.

    Convention: a module ``foo_bar/`` exposes ``foo_bar.module.<CamelCase>``
    that subclasses :class:`neuralgentics.web.modules.base.Module`. The class
    is constructed via a module-level ``build(manifest, config)`` factory.

    Modules without a Python implementation (pure stubs) are skipped — the
    shell router's ``/modules/{name}`` handler renders their stub page.

    This function is **synchronous**: it only includes routers and records
    hooks. Async background tasks (SSE drains, PG listeners) are started by
    the lifespan via ``app.state.module_starters``.

    T-115: the constructed ``Module`` instance + its router are written back
    to the registry's :class:`ModuleState` so the reload path can supersede
    them. Module loading is by file path (via :func:`load_module_python`)
    so arbitrary module directories (including test fixtures) work.

    T-115.1: each route included by a module is tagged with
    ``route.module_name = manifest.name`` so :func:`reload_module` can find
    and remove the prior version's routes before including the new ones.
    """
    modules_path = _modules_path_from_config(config)

    for state in registry.all():
        manifest = state.manifest
        # Directory names use underscores (Python identifiers); manifest
        # ``name`` fields use hyphens (URL-friendly).
        pkg_name = manifest.name.replace("-", "_")
        try:
            mod = load_module_python(pkg_name, modules_path)
        except Exception as exc:  # noqa: BLE001
            log.error("error importing %s: %s", pkg_name, exc)
            continue
        if mod is None:
            # No module.py — pure stub. State already has instance=None.
            continue
        # Find a concrete Module subclass in the package.
        cls = _find_module_class(mod)
        if cls is None:
            continue
        # Construct via the module's build() factory if present.
        build_fn = getattr(mod, "build", None)
        instance: Any = None
        if callable(build_fn):
            try:
                instance = build_fn(manifest, config)
            except Exception as exc:  # noqa: BLE001
                log.error("build() for %s failed: %s", manifest.name, exc)
                continue
        else:
            try:
                instance = cls(manifest=manifest)
            except Exception as exc:  # noqa: BLE001
                log.error("instantiate %s failed: %s", manifest.name, exc)
                continue

        # T-111: inject the live registry + rbac_mode so the module's
        # build_router() can wire per-module RBAC dependencies. These are
        # set as plain instance attributes (not pydantic fields) so they
        # don't interfere with the pydantic model contract. Modules that
        # don't use per-module RBAC simply ignore them.
        instance._registry = registry
        instance._rbac_mode = getattr(config, "rbac_mode", "permissive")

        # Synchronous: include the router + register hooks. Modules expose
        # build_router() (sync) + start_background() (sync) + shutdown() (async).
        router: Any = None
        try:
            # New-style: split sync router inclusion from async startup.
            # T-111: build_router may accept optional registry + rbac_mode
            # kwargs for per-module RBAC wiring; if it doesn't, fall back to
            # the no-arg call (backwards compat with T-106/T-107/T-108 modules
            # that haven't been migrated yet).
            try:
                router = instance.build_router(
                    registry=registry,
                    rbac_mode=getattr(config, "rbac_mode", "permissive"),
                )
            except TypeError:
                router = instance.build_router()
            if router is not None:
                _include_router_tagged(app, router, manifest.name)
        except AttributeError:
            # Old-style: register_routes is async (T-105 stubs). Defer to lifespan.
            _register_legacy_async(app, instance)
            # Record the instance on the state (router stays None — the
            # legacy path includes its own router via the async starter).
            state.instance = instance
            continue

        # Record the live instance + router on the state for the reload path.
        state.instance = instance
        state.router = router

        # Register async startup + shutdown hooks for the lifespan.
        starters = list(getattr(app.state, "module_starters", []))
        starters.append(instance.start_background)
        app.state.module_starters = starters

        shutdowns = list(getattr(app.state, "module_shutdowns", []))
        shutdowns.append(instance.shutdown)
        app.state.module_shutdowns = shutdowns
        log.info("registered routes for module %s", manifest.name)


def _include_router_tagged(
    app: Any, router: Any, module_name: str, *, insert_at: int | None = None
) -> None:
    """Include ``router`` into ``app`` and tag each newly-registered route
    with ``route.module_name = module_name``.

    T-115.1: tagging lets :func:`reload_module` find the prior version's
    routes in ``app.router.routes`` and remove them before including the
    new router — closing the route-unregistration gap (the old version stays
    live at its original path).

    ``app.include_router`` flattens the sub-router's routes into
    ``app.router.routes``; we tag the tail of that list (the routes added
    by this call). The tagged attribute is a plain Python attribute on the
    route object — FastAPI ignores unknown attributes, so this is safe.

    If ``insert_at`` is provided (the reload path), the new routes are
    inserted at that index instead of appended — this preserves the
    route-precedence order (module routers precede the shell router so
    the module's literal ``/modules/<name>`` route wins over the shell's
    ``/modules/{module_name}`` catch-all).
    """
    before = len(app.router.routes)
    app.include_router(router)
    after = len(app.router.routes)
    new_routes = list(app.router.routes[before:after])
    # Tag each new route.
    for route in new_routes:
        try:
            route.module_name = module_name
        except (AttributeError, TypeError):
            # Some route types (Mount, Host) may reject setattr — skip.
            continue
    # If an insertion index was given, move the new routes there so they
    # precede the shell router (preserving route precedence).
    if insert_at is not None and new_routes:
        # Strip the newly-appended routes from the tail.
        app.router.routes[:] = app.router.routes[:before]
        # Insert them at the requested position.
        app.router.routes[insert_at:insert_at] = new_routes


def _register_legacy_async(app: Any, instance: Any) -> None:
    """Back-compat for T-105-style modules whose register_routes is async.

    Records a starter that schedules the async register_routes() and a
    no-op shutdown. Only stubs hit this path.
    """
    import asyncio

    def _starter() -> None:
        asyncio.ensure_future(instance.register_routes(app))  # noqa: RUF006

    starters = list(getattr(app.state, "module_starters", []))
    starters.append(_starter)
    app.state.module_starters = starters


def _find_module_class(mod: Any) -> Any:
    """Find the first concrete ``Module`` subclass exported by ``mod``."""
    from neuralgentics.web.modules.base import Module

    candidates = []
    for name in dir(mod):
        if name.startswith("_"):
            continue
        obj = getattr(mod, name)
        if isinstance(obj, type) and issubclass(obj, Module) and obj is not Module:
            candidates.append(obj)
    if not candidates:
        return None
    # Prefer the one whose name ends with "Module".
    for c in candidates:
        if c.__name__.endswith("Module"):
            return c
    return candidates[0]


__all__ = [
    "ModuleState",
    "discover_modules",
    "load_module_python",
    "module_route",
    "register_module_routes",
]
