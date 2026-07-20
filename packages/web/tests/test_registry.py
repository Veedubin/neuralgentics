"""Tests for the ModuleRegistry.

Covers:
  * Registering manifests populates the registry.
  * summaries() returns JSON-serializable dicts for /api/v1/modules.
"""

from __future__ import annotations

from pathlib import Path

from neuralgentics.web.modules.loader import discover_modules
from neuralgentics.web.modules.registry import ModuleManifest, ModuleRegistry

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _sample_manifest() -> ModuleManifest:
    return ModuleManifest(
        name="test-module",
        version="0.0.1",
        display_name="Test Module",
        description="for tests",
        routes=[],
        api_endpoints=[],
    )


def test_register_and_lookup() -> None:
    """Registering one manifest puts it under its name."""
    reg = ModuleRegistry()
    reg.register(_sample_manifest())
    assert reg.get("test-module") is not None
    assert reg.get("nonexistent") is None
    assert len(reg) == 1


def test_summaries_returns_dicts_for_all_modules() -> None:
    """After discovering built-ins, summaries() yields 3 dicts."""
    reg = discover_modules(MODULES_DIR)
    summaries = reg.summaries()
    assert len(summaries) == 3
    for s in summaries:
        assert "name" in s
        assert "version" in s
        assert "coming_in" in s
        assert s["stub"] is True
