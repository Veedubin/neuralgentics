"""Tests for module discovery loader.

Covers:
  * Discover all 3 built-in modules from the packaged modules/ dir.
  * A manifest file can be parsed standalone.
"""

from __future__ import annotations

from pathlib import Path

from neuralgentics.web.modules.loader import discover_modules
from neuralgentics.web.modules.registry import parse_manifest

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def test_discover_finds_three_builtin_modules() -> None:
    """The 3 v0.1 stub modules (gateway-audit, broker-audit, memini-browser) load."""
    registry = discover_modules(MODULES_DIR)
    names = sorted(m.name for m in registry.all())
    assert names == ["broker-audit", "gateway-audit", "memini-browser"], names
    assert len(registry) == 3


def test_parse_manifest_round_trip() -> None:
    """Parsing one module.yaml produces a valid ModuleManifest.

    Note: directory names use underscores (Python-valid), manifest ``name``
    fields use hyphens (URL-friendly). The loader matches on the manifest
    ``name`` field, not the directory name.
    """
    p = MODULES_DIR / "gateway_audit" / "module.yaml"
    m = parse_manifest(p)
    assert m.name == "gateway-audit"
    # gateway-audit is the first real module (T-106); bumped to 0.14.0.
    assert m.version == "0.14.0"
    assert m.display_name == "Gateway Audit"
    # Real module declares two routes (page + SSE) and one API endpoint.
    assert len(m.routes) == 2
    assert m.routes[0].path == "/modules/gateway-audit"
    assert m.routes[0].method == "GET"
    assert m.routes[1].path == "/modules/gateway-audit/sse"
    assert m.api_endpoints[0].handler == "recent"
    # broker-audit is the second real module (T-107); bumped to 0.14.0
    # with two routes (page + SSE) and one API endpoint.
    broker_p = MODULES_DIR / "broker_audit" / "module.yaml"
    bm = parse_manifest(broker_p)
    assert bm.name == "broker-audit"
    assert bm.version == "0.14.0"
    assert bm.display_name == "Broker Audit"
    assert len(bm.routes) == 2
    assert bm.routes[0].path == "/modules/broker-audit"
    assert bm.routes[1].path == "/modules/broker-audit/sse"
    assert bm.api_endpoints[0].handler == "recent"
    # memini-browser is still a T-105 stub.
    memini_p = MODULES_DIR / "memini_browser" / "module.yaml"
    mm = parse_manifest(memini_p)
    assert mm.version == "0.1.0"
    assert len(mm.routes) == 1
