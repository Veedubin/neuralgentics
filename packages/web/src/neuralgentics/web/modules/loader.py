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
"""

from __future__ import annotations

import importlib
import logging
from pathlib import Path
from typing import Any

from neuralgentics.web.modules.registry import ModuleManifest, ModuleRegistry, parse_manifest

log = logging.getLogger("neuralgentics.web.loader")


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
    """
    for manifest in registry.all():
        # Directory names use underscores (Python identifiers); manifest
        # ``name`` fields use hyphens (URL-friendly).
        pkg_name = manifest.name.replace("-", "_")
        module_path = f"neuralgentics.web.modules.{pkg_name}.module"
        try:
            mod = importlib.import_module(module_path)
        except ModuleNotFoundError:
            # No Python implementation — pure stub. Fine.
            continue
        except Exception as exc:  # noqa: BLE001
            log.error("error importing %s: %s", module_path, exc)
            continue
        # Find a concrete Module subclass in the package.
        cls = _find_module_class(mod)
        if cls is None:
            continue
        # Construct via the module's build() factory if present.
        build_fn = getattr(mod, "build", None)
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

        # Synchronous: include the router + register hooks. Modules expose
        # build_router() (sync) + start_background() (sync) + shutdown() (async).
        try:
            # New-style: split sync router inclusion from async startup.
            router = instance.build_router()
            if router is not None:
                app.include_router(router)
        except AttributeError:
            # Old-style: register_routes is async (T-105 stubs). Defer to lifespan.
            _register_legacy_async(app, instance)
            continue

        # Register async startup + shutdown hooks for the lifespan.
        starters = list(getattr(app.state, "module_starters", []))
        starters.append(instance.start_background)
        app.state.module_starters = starters

        shutdowns = list(getattr(app.state, "module_shutdowns", []))
        shutdowns.append(instance.shutdown)
        app.state.module_shutdowns = shutdowns
        log.info("registered routes for module %s", manifest.name)


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


__all__ = ["discover_modules", "register_module_routes"]
