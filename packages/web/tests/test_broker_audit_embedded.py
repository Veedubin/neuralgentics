"""Tests for the broker-audit module — embedded mode (JSONL data source).

Covers:
  * The tool-calls table renders from a JSONL file (GET /modules/broker-audit)
    and includes the stats panel.
  * Server-side filters work (tool, server, role, success).
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

import neuralgentics.web.modules.broker_audit.data_source as ds_mod
from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


@pytest.fixture(autouse=True)
def fast_poll_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make JSONLBrokerAuditSource poll every 0.2s (so tests run fast)."""
    orig = ds_mod.JSONLBrokerAuditSource.__init__
    monkeypatch.setattr(
        ds_mod.JSONLBrokerAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: orig(self, path, poll_interval),
    )


@pytest.fixture
def broker_audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Create a JSONL broker-audit file + set the env var the data source reads."""
    p = tmp_path / "broker-audit.jsonl"
    p.write_text("")
    monkeypatch.setenv("NEURALGENTICS_BROKER_AUDIT_FILE", str(p))
    return p


def _write_events(p: Path, events: list[dict[str, object]]) -> None:
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def _event(
    *,
    ts: str = "2026-07-19T12:00:00Z",
    role: str = "coder",
    server: str = "filesystem",
    tool: str = "read_file",
    success: bool = True,
    duration_ms: int = 45,
    result_size: int | None = 1234,
    error: str = "",
) -> dict[str, object]:
    return {
        "ts": ts,
        "agent_role": role,
        "server": server,
        "tool": tool,
        "args_hash": "sha256:abc",
        "success": success,
        "result_size": result_size,
        "duration_ms": duration_ms,
        "error": error,
    }


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


# ----- Test 1: JSONL load + render + stats panel -----


def test_tool_calls_table_renders_from_jsonl(broker_audit_file: Path) -> None:
    """GET /modules/broker-audit returns 200 HTML with the tool-calls table
    populated from the JSONL file, plus the stats panel."""
    _write_events(
        broker_audit_file,
        [
            _event(ts="2026-07-19T12:00:00Z", tool="read_file", server="filesystem", role="coder"),
            _event(
                ts="2026-07-19T12:01:00Z",
                tool="write_file",
                server="filesystem",
                role="coder",
                success=False,
                duration_ms=120,
                error="permission denied",
            ),
            _event(
                ts="2026-07-19T12:02:00Z",
                tool="search",
                server="github-mcp",
                role="architect",
                duration_ms=200,
            ),
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/broker-audit")
    assert r.status_code == 200
    body = r.text
    assert "<table" in body
    assert "read_file" in body
    assert "write_file" in body
    assert "github-mcp" in body
    assert "/modules/broker-audit/sse" in body
    # Stats panel: total calls, success rate, avg latency, top 5 tools.
    assert "Total calls" in body
    assert "Success rate" in body
    assert "Avg latency" in body
    assert "Top 5 tools" in body
    # 3 total calls, 2 succeeded → 66.7%
    assert "3" in body
    assert "66.7%" in body
    # Top tool is filesystem/read_file + filesystem/write_file + github-mcp/search
    # (each appears once; top 5 lists all 3). The stats panel shows call counts.
    assert "read_file" in body
    # The T-105 stub page should NOT render.
    assert "coming in T-107" not in body
    assert "Coming in T-107" not in body


# ----- Test 2: server-side filter -----


def test_tool_calls_table_filters_by_tool_server_role_success(
    broker_audit_file: Path,
) -> None:
    """GET /modules/broker-audit?tool=...&server=...&role=...&success=...
    returns only matching rows; /api/v1/broker-audit/recent honors
    since/until."""
    _write_events(
        broker_audit_file,
        [
            _event(
                ts="2026-07-19T12:00:00Z",
                tool="read_file",
                server="filesystem",
                role="coder",
                success=True,
            ),
            _event(
                ts="2026-07-19T12:01:00Z",
                tool="read_file",
                server="filesystem",
                role="architect",
                success=False,
                error="enoent",
            ),
            _event(
                ts="2026-07-19T12:02:00Z",
                tool="search",
                server="github-mcp",
                role="architect",
                success=True,
            ),
        ],
    )
    app = build_app(_config())
    with TestClient(app) as client:
        # Filter by tool — HTML
        r = client.get("/modules/broker-audit?tool=read_file")
        assert r.status_code == 200
        assert "read_file" in r.text
        assert "github-mcp" not in r.text  # excluded by tool filter
        # Filter by tool + server + success — HTML (matches the spec's
        # acceptance criterion 6: ?tool=filesystem__read_file&server=filesystem&success=true)
        r2 = client.get("/modules/broker-audit?tool=read_file&server=filesystem&success=true")
        assert r2.status_code == 200
        # Only the first event matches all three filters (success=true).
        # The matching row's role is "coder"; the failure row (also coder,
        # success=false) is excluded; the github-mcp row (server mismatch)
        # is excluded. Assert the excluded rows' signatures don't appear.
        assert "filesystem" in r2.text
        assert "enoent" not in r2.text  # success=false excluded
        assert "github-mcp" not in r2.text  # server mismatch
        # Filter by role — HTML
        r3 = client.get("/modules/broker-audit?role=architect")
        assert r3.status_code == 200
        assert "github-mcp" in r3.text
        # The coder event (role=coder) is excluded — its tool read_file
        # appears in both rows, so assert on the role string instead.
        # Count of "<td ...>coder</td>" should be 0 in the architect filter.
        assert r3.text.count(">coder<") == 0
        # API endpoint — since/until time range
        r4 = client.get("/api/v1/broker-audit/recent?since=2026-07-19T12:01:30Z")
        assert r4.status_code == 200
        data = r4.json()
        assert data["count"] == 1
        assert data["events"][0]["tool"] == "search"
        # API endpoint — success=false filter
        r5 = client.get("/api/v1/broker-audit/recent?success=false")
        assert r5.status_code == 200
        data5 = r5.json()
        assert data5["count"] == 1
        assert data5["events"][0]["error"] == "enoent"


# ----- Test 3: SSE emits on file append (real uvicorn server) -----


def test_sse_emits_event_on_file_append(broker_audit_file: Path) -> None:
    """Append to the JSONL file → SSE stream emits the new event within 2s.

    Uses a real uvicorn server because httpx.ASGITransport buffers SSE
    streaming responses and never yields incremental chunks to the client.
    """
    _write_events(
        broker_audit_file,
        [
            _event(
                ts="2026-07-19T12:00:00Z",
                tool="read_file",
                server="filesystem",
                role="coder",
            )
        ],
    )
    app = build_app(_config())

    async def _run() -> None:
        port = 18791
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        server_task = asyncio.ensure_future(server.serve())
        for _ in range(30):
            await asyncio.sleep(0.1)
            if server.started:
                break
        assert server.started, "uvicorn server failed to start"
        try:
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{port}", timeout=8.0
            ) as client:

                def writer() -> None:
                    time.sleep(1.2)
                    _write_events(
                        broker_audit_file,
                        [
                            _event(
                                ts="2026-07-19T12:06:00Z",
                                tool="write_file",
                                server="filesystem",
                                role="coder",
                            )
                        ],
                    )

                threading.Thread(target=writer, daemon=True).start()
                received: list[str] = []
                async with client.stream("GET", "/modules/broker-audit/sse") as resp:
                    assert resp.status_code == 200
                    async for line in resp.aiter_lines():
                        received.append(line)
                        if "write_file" in line:
                            break
                        if len(received) > 50:
                            break
                assert any("write_file" in line for line in received), received
                assert any(line.startswith("event: hello") for line in received), received
                assert any(line.startswith("event: tool_call") for line in received), received
        finally:
            server.should_exit = True
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(server_task, timeout=3.0)

    asyncio.run(_run())
