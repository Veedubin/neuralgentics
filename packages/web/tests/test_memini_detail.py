"""Tests for the memini-browser module — memory detail + trust adjust.

Covers acceptance criteria 5 (memory detail E2E) + 6 (trust adjust E2E):
  * GET /modules/memini-browser/memory/mem-001 returns 200 HTML with the
    full content, metadata, trust score, and relationships.
  * POST /modules/memini-browser/memory/mem-001/trust with
    {"signal": "user_confirmed"} records the adjustment in the mock
    backend's audit trail, then redirect-303 back to the detail page.
    Reloading the detail page shows the trust score went UP.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


def _config() -> WebConfig:
    os.environ["NEURALGENTICS_MEMINI_BACKEND"] = "mock"
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def _get_client_memory_state(app: Any, memory_id: str) -> dict[str, object]:
    """Pull the live mock client out of the running app to inspect state."""
    # The module's MeminiClient is stored on the MeminiBrowserModule, which
    # is constructed at app-build time and held by the loader. We reach in
    # via the registry's module list and find the memini-browser instance.
    from neuralgentics.web.modules.memini_browser.memini_client import MockMeminiClient

    for starter in getattr(app.state, "module_starters", []):
        # start_background is a bound method; its __self__ is the module.
        module = getattr(starter, "__self__", None)
        if module is None:
            continue
        if type(module).__name__ == "MeminiBrowserModule":
            client = module.client
            assert isinstance(client, MockMeminiClient)
            return client._memories[memory_id].model_dump()
    raise AssertionError("MeminiBrowserModule not found in app.state.module_starters")


def test_memory_detail_page_renders_full_content() -> None:
    """GET /modules/memini-browser/memory/mem-001 returns 200 HTML with the
    full content, all metadata, trust score, and relationships."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/memini-browser/memory/mem-001")
    assert r.status_code == 200
    body = r.text
    # Full content (not just the 200-char preview).
    assert "Authentication uses JWT tokens with RS256 signing." in body
    # Metadata keys + values.
    assert "source_type" in body
    assert "session" in body
    assert "topic" in body
    assert "jwt" in body
    # Trust score badge — mem-001 starts at 0.85 (green).
    assert "0.85" in body
    # The trust adjust form is present.
    assert 'name="signal"' in body
    assert "user_confirmed" in body
    # Relationships section (mem-001 → mem-002 RELATED_TO).
    assert "mem-002" in body
    assert "RELATED_TO" in body
    # Link to the graph view.
    assert "/modules/memini-browser/memory/mem-001/graph" in body


def test_trust_adjust_increases_score_and_audits() -> None:
    """POST /modules/memini-browser/memory/mem-001/trust with
    {"signal":"user_confirmed"} records the adjustment in the mock audit
    trail, raises the trust score by 0.10, and redirect-303s back to the
    detail page. A follow-up GET on the detail page shows the new score."""
    app = build_app(_config())
    with TestClient(app) as client:
        # Sanity: starting trust is 0.85.
        r0 = client.get("/modules/memini-browser/memory/mem-001")
        assert r0.status_code == 200
        assert "0.85" in r0.text
        # POST the trust adjustment. The form is urlencoded.
        r = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed", "reason": "verified by user"},
            follow_redirects=False,
        )
        # Form POST returns a 303 See Other redirect to the detail page.
        assert r.status_code == 303
        assert "/modules/memini-browser/memory/mem-001" in r.headers["location"]
        # Reload the detail page (following the redirect this time).
        r2 = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed", "reason": "verified again"},
            follow_redirects=True,
        )
        assert r2.status_code == 200
        # Trust should now be 0.85 + 0.10 + 0.10 = 1.05 → clamped to 1.00.
        assert "1.00" in r2.text
        # The flash message mentions the signal + new trust.
        assert "user_confirmed" in r2.text
    # Verify the audit trail recorded BOTH adjustments.
    state = _get_client_memory_state(app, "mem-001")
    # Trust went up to 1.00 (clamped from 1.05).
    assert state["trust_score"] == 1.0
    # Pull the audit list out of the running client.
    for starter in getattr(app.state, "module_starters", []):
        module = getattr(starter, "__self__", None)
        if module is None:
            continue
        if type(module).__name__ == "MeminiBrowserModule":
            audit = module.client.trust_audit
            mem_audits = [a for a in audit if a["memory_id"] == "mem-001"]
            assert len(mem_audits) == 2
            assert all(a["signal"] == "user_confirmed" for a in mem_audits)
            assert mem_audits[0]["new_trust"] == 0.95
            assert mem_audits[1]["new_trust"] == 1.0  # clamped from 1.05
            return
    raise AssertionError("audit trail not found")
