"""Module discovery — scan ``modules/*/module.yaml`` at startup."""

from __future__ import annotations

import logging
from pathlib import Path

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
