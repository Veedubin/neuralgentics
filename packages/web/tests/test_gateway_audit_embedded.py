"""Tests for the gateway-audit module — embedded mode (JSONL data source).

Covers:
  * The audit table renders from a JSONL file (GET /modules/gateway-audit).
  * Server-side filters work (domain, status, since/until).
  * SSE emits a new event within 2s of appending to the JSONL file.

Test 1 + 2 use the sync ``fastapi.testclient.TestClient`` (which runs the
lifespan for us). Test 3 (SSE) spins up a real uvicorn server because
``httpx.ASGITransport`` buffers streaming responses and can't drive an SSE
stream to completion.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

import neuralgentics.web.modules.gateway_audit.data_source as ds_mod
from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


@pytest.fixture(autouse=True)
def fast_poll_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make JSONLAuditSource poll every 0.2s (so tests run fast)."""
    orig = ds_mod.JSONLAuditSource.__init__
    monkeypatch.setattr(
        ds_mod.JSONLAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: orig(self, path, poll_interval),
    )


@pytest.fixture
def audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Create a JSONL audit file + set the env var the data source reads."""
    p = tmp_path / "audit.jsonl"
    p.write_text("")
    monkeypatch.setenv("NEURALGENTICS_AUDIT_FILE", str(p))
    return p


def _write_events(p: Path, events: list[dict[str, object]]) -> None:
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


# ----- Test 1: JSONL load + render -----


def test_audit_table_renders_from_jsonl(audit_file: Path) -> None:
    """GET /modules/gateway-audit returns 200 HTML with the audit table
    populated from the JSONL file."""
    _write_events(
        audit_file,
        [
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/repos",
                "decision": "allowed",
                "reason": "",
                "client_ip": "10.0.0.1",
            },
            {
                "timestamp": "2026-07-19T12:01:00Z",
                "method": "POST",
                "host": "api.openai.com",
                "uri": "/v1/chat",
                "decision": "denied",
                "reason": "policy",
                "client_ip": "10.0.0.2",
            },
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/gateway-audit")
    assert r.status_code == 200
    body = r.text
    assert "<table" in body
    assert "api.github.com" in body
    assert "api.openai.com" in body
    assert "/modules/gateway-audit/sse" in body
    # The T-105 stub page should NOT render.
    assert "coming in T-106" not in body
    assert "placeholder page installed by the T-105 scaffold" not in body


# ----- Test 2: server-side filter -----


def test_audit_table_filters_by_domain_and_status(audit_file: Path) -> None:
    """GET /modules/gateway-audit?domain=github.com&status=200 returns only
    matching rows; /api/v1/gateway-audit/recent honors since/until."""
    _write_events(
        audit_file,
        [
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/r1",
                "decision": "allowed",
                "client_ip": "1.1.1.1",
                "status": 200,
            },
            {
                "timestamp": "2026-07-19T12:01:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/r2",
                "decision": "allowed",
                "client_ip": "1.1.1.2",
                "status": 500,
            },
            {
                "timestamp": "2026-07-19T12:02:00Z",
                "method": "GET",
                "host": "api.openai.com",
                "uri": "/v1",
                "decision": "allowed",
                "client_ip": "1.1.1.3",
                "status": 200,
            },
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        # Domain filter only — HTML
        r = client.get("/modules/gateway-audit?domain=github.com")
        assert r.status_code == 200
        assert "api.github.com" in r.text
        assert "api.openai.com" not in r.text
        # Domain + status filter — HTML
        r2 = client.get("/modules/gateway-audit?domain=github.com&status=200")
        assert r2.status_code == 200
        assert "/r1" in r2.text
        assert "/r2" not in r2.text  # status=500 excluded
        # API endpoint — since/until time range
        r3 = client.get("/api/v1/gateway-audit/recent?since=2026-07-19T12:01:30Z")
        assert r3.status_code == 200
        data = r3.json()
        assert data["count"] == 1
        assert data["events"][0]["host"] == "api.openai.com"


# ----- Test 3: SSE emits on file append (real uvicorn server) -----


def test_sse_emits_event_on_file_append(audit_file: Path) -> None:
    """Append to the JSONL file → SSE stream emits the new event within 2s.

    Uses a real uvicorn server because httpx.ASGITransport buffers SSE
    streaming responses and never yields incremental chunks to the client.
    """
    _write_events(
        audit_file,
        [
            {
                "timestamp": "2026-07-19T12:00:00Z",
                "method": "GET",
                "host": "api.github.com",
                "uri": "/r",
                "decision": "allowed",
                "client_ip": "1.1.1.1",
            }
        ],
    )
    app = build_app(_config())

    async def _run() -> None:
        port = 18790
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        server_task = asyncio.ensure_future(server.serve())
        # Wait for server to bind.
        for _ in range(30):
            await asyncio.sleep(0.1)
            if server.started:
                break
        assert server.started, "uvicorn server failed to start"
        try:
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{port}", timeout=5.0
            ) as client:
                # Schedule the file append 0.8s from now.
                def writer() -> None:
                    time.sleep(0.8)
                    _write_events(
                        audit_file,
                        [
                            {
                                "timestamp": "2026-07-19T12:06:00Z",
                                "method": "GET",
                                "host": "new-event.com",
                                "uri": "/new",
                                "decision": "allowed",
                                "client_ip": "5.6.7.8",
                            }
                        ],
                    )

                threading.Thread(target=writer, daemon=True).start()
                received: list[str] = []
                async with client.stream("GET", "/modules/gateway-audit/sse") as resp:
                    assert resp.status_code == 200
                    async for line in resp.aiter_lines():
                        received.append(line)
                        if "new-event.com" in line:
                            break
                        if len(received) > 50:
                            break
                assert any("new-event.com" in line for line in received), received
                assert any(line.startswith("event: hello") for line in received), received
                assert any(line.startswith("event: audit") for line in received), received
        finally:
            server.should_exit = True
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(server_task, timeout=3.0)

    asyncio.run(_run())
