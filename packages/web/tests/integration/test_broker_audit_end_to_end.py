"""T-113.1 — End-to-end broker-audit producer → consumer integration test.

This test proves that the records emitted by the Go broker audit writer
(``packages/broker-go/.../audit`` — the T-113 producer) are parsed
correctly by the Python consumer
(``packages/web/.../broker_audit/data_source.py::BrokerAuditEvent`` —
the T-107 consumer).

Producer side (Go):
    The Go test ``TestEmitForIntegration`` (in
    ``packages/broker-go/.../audit/emit_for_integration_test.go``) uses
    the REAL production code path — ``audit.BuildRecord`` →
    ``AuditWriter.Write`` → ``Close`` → ``json.Encoder.Encode`` — to
    write two records to a JSONL file whose path is supplied via the
    ``NEURALGENTICS_AUDIT_EMIT_PATH`` env var. The two records exercise
    both the success=false + error<>"" + result_size=nil branch and the
    success=true + result_size<>nil + args_hash<>"" + error="" branch
    (the ``omitempty`` branches the consumer must tolerate).

    The broker binary (``cmd/broker``) has no JSON-RPC stdin loop, so a
    true broker subprocess is not possible without writing one. The Go
    test IS the real producer serialization path — the bytes the
    consumer parses are exactly what ``json.Encoder.Encode(&AuditRecord)``
    produces on a record built by ``BuildRecord``.

Consumer side (Python):
    ``JSONLBrokerAuditSource`` reads the file, ``BrokerAuditEvent.from_jsonl_line``
    parses each line, and we assert every field is populated with the
    expected value and type.

Field mapping (Go name → JSON key → Python field):
    TS         → "ts"          → ts: datetime
    AgentRole  → "agent_role"  → agent_role: str
    Server     → "server"      → server: str
    Tool       → "tool"        → tool: str
    ArgsHash   → "args_hash"   → args_hash: str | None   (Go omitempty → "" omitted)
    Success    → "success"     → success: bool
    ResultSize → "result_size" → result_size: int | None (Go omitempty → nil omitted)
    DurationMS → "duration_ms" → duration_ms: int
    Error      → "error"       → error: str              (Go omitempty → "" omitted; default "")

All nine fields align. No field-name fixes were required.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from neuralgentics.web.modules.broker_audit.data_source import (
    BrokerAuditEvent,
    JSONLBrokerAuditSource,
)

# Repo root (packages/web/tests/integration/../../../.. = repo root).
REPO_ROOT = Path(__file__).resolve().parents[4]
BROKER_GO_DIR = REPO_ROOT / "packages" / "broker-go"
AUDIT_PKG_REL = "src/neuralgentics/broker/audit"

# Env var the Go emit helper reads.
EMIT_PATH_ENV = "NEURALGENTICS_AUDIT_EMIT_PATH"


def _go_available() -> bool:
    return shutil.which("go") is not None


pytestmark = pytest.mark.skipif(
    not _go_available(),
    reason="go toolchain not on PATH; required to run the Go producer helper",
)


def _run_go_producer(jsonl_path: Path) -> None:
    """Run the Go emit helper to produce two real audit records at ``jsonl_path``.

    Uses the production ``audit.BuildRecord`` + ``AuditWriter`` code path.
    """
    env = dict(os.environ)
    env[EMIT_PATH_ENV] = str(jsonl_path)
    # -count=1 disables result caching so the producer always runs.
    proc = subprocess.run(
        [
            "go",
            "test",
            "-run",
            "TestEmitForIntegration",
            "-count=1",
            "./" + AUDIT_PKG_REL,
        ],
        cwd=str(BROKER_GO_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(
            f"Go producer helper failed (rc={proc.returncode}):\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )
    if not jsonl_path.exists():
        pytest.fail(
            f"Go producer helper did not write {jsonl_path}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )


def test_broker_audit_end_to_end(tmp_path: Path) -> None:
    """Real Go producer → real Python consumer field-by-field check.

    1. Run the Go producer to emit two records (one failing, one
       succeeding) to a temp JSONL file.
    2. Read the file with ``JSONLBrokerAuditSource``.
    3. Parse the latest line(s) as ``BrokerAuditEvent``.
    4. Assert all nine fields are populated correctly on both records.
    """
    jsonl = tmp_path / "audit.jsonl"
    _run_go_producer(jsonl)

    source = JSONLBrokerAuditSource(jsonl, poll_interval=0.2)
    source._load_existing()  # noqa: SLF001 — sync load is fine for a one-shot test
    events_list = list(source._events)  # noqa: SLF001

    # The producer emits exactly 2 records.
    assert len(events_list) == 2, (
        f"expected 2 records from producer, got {len(events_list)}; "
        f"file contents:\n{jsonl.read_text()}"
    )

    # The producer emits the failure record first, then the success
    # record (in chronological order). JSONLBrokerAuditSource._events
    # preserves file order.
    fail_rec, succ_rec = events_list

    # ---- Record 1: failure path (success=false, error<>"", result_size=nil) ----
    assert isinstance(fail_rec, BrokerAuditEvent)
    assert fail_rec.ts == datetime(2026, 7, 20, 5, 1, 14, tzinfo=UTC)
    assert fail_rec.agent_role == "coder"
    assert fail_rec.server == "filesystem"
    assert fail_rec.tool == "read_file"
    # args_hash is "sha256:<16-byte hex>" — producer always emits it
    # when args != nil.
    assert fail_rec.args_hash is not None
    assert fail_rec.args_hash.startswith("sha256:")
    assert len(fail_rec.args_hash) == len("sha256:") + 32  # 16 bytes hex = 32 chars
    assert fail_rec.success is False
    # result_size omitted by Go omitempty (ResultSize == nil) → consumer default None
    assert fail_rec.result_size is None
    assert fail_rec.duration_ms == 50
    assert fail_rec.error == "server not running: connection refused"

    # ---- Record 2: success path (success=true, result_size<>nil, error="") ----
    assert isinstance(succ_rec, BrokerAuditEvent)
    assert succ_rec.ts == datetime(2026, 7, 20, 5, 1, 15, tzinfo=UTC)
    assert succ_rec.agent_role == "orchestrator"
    assert succ_rec.server == "memory"
    assert succ_rec.tool == "search"
    assert succ_rec.args_hash is not None
    assert succ_rec.args_hash.startswith("sha256:")
    assert succ_rec.success is True
    # result_size is the byte length of the JSON-encoded result map.
    # {"content":"hello world","tokens":11} = 37 bytes (we pinned this
    # in the Go helper; verify the consumer sees the same value).
    assert succ_rec.result_size == 37
    assert succ_rec.duration_ms == 120
    # Go omitempty means error="" is omitted; consumer default is "".
    assert succ_rec.error == ""

    # ---- Field type checks (the spec's "field types are correct" gate) ----
    for ev in (fail_rec, succ_rec):
        assert isinstance(ev.ts, datetime)
        assert isinstance(ev.agent_role, str)
        assert isinstance(ev.server, str)
        assert isinstance(ev.tool, str)
        assert isinstance(ev.success, bool)
        assert isinstance(ev.duration_ms, int)
        assert isinstance(ev.error, str)
        # args_hash and result_size are Optional — must be str/int or None.
        assert ev.args_hash is None or isinstance(ev.args_hash, str)
        assert ev.result_size is None or isinstance(ev.result_size, int)
