"""Tests for the module.yaml manifest schema validation.

Confirms the 3 built-in manifests validate cleanly and required fields
are present. If a manifest drops a required field, model_validate raises.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from neuralgentics.web.modules.registry import ModuleManifest

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def test_all_three_builtin_manifests_validate() -> None:
    """Each built-in module.yaml parses into a valid ModuleManifest."""
    expected = {
        "gateway-audit": ("Gateway Audit", "T-106"),
        "broker-audit": ("Broker Audit", "T-107"),
        "memini-browser": ("Memory Browser", "T-108"),
    }
    for dirname, (display, coming) in expected.items():
        # Directory names use underscores (Python-valid identifiers); the
        # manifest ``name`` field uses hyphens (URL-friendly). The loader
        # matches on the manifest ``name`` field, not the directory name.
        ddir = dirname.replace("-", "_")
        p = MODULES_DIR / ddir / "module.yaml"
        assert p.exists(), f"missing manifest: {p}"
        import yaml

        raw = yaml.safe_load(p.read_text(encoding="utf-8"))
        m = ModuleManifest.model_validate(raw)
        assert m.name == dirname
        assert m.display_name == display
        assert m.to_summary()["coming_in"] == coming


def test_manifest_rejects_missing_required_field() -> None:
    """A manifest without ``name`` raises ValidationError."""
    with pytest.raises(Exception):  # noqa: B017 — pydantic.ValidationError subclass
        ModuleManifest.model_validate({"version": "0.1.0", "display_name": "x", "description": "y"})


def test_manifest_rejects_whitespace_in_name() -> None:
    """A manifest with a name containing spaces raises."""
    with pytest.raises(Exception):  # noqa: B017
        ModuleManifest.model_validate(
            {
                "name": "bad name",
                "version": "0.1.0",
                "display_name": "x",
                "description": "y",
            }
        )
