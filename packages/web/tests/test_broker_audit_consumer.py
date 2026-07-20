"""T-113.1 — Consumer-side unit tests for the broker-audit JSONL source.

These tests feed the consumer (``BrokerAuditEvent.from_jsonl_line`` +
``JSONLBrokerAuditSource``) records shaped exactly like the real Go
producer emits them, and assert the parser handles:

  * a real producer-shaped record (all 9 fields),
  * the omitempty branches (args_hash/result_size/error omitted),
  * malformed/garbage lines (consumer must not crash),
  * correct Python types on every field.

They do NOT spawn the Go producer — that's the job of
``tests/integration/test_broker_audit_end_to_end.py``. These tests are
pure-Python and fast.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from neuralgentics.web.modules.broker_audit.data_source import (
    BrokerAuditEvent,
    JSONLBrokerAuditSource,
)

# ---- A real producer-shaped record (matches what the Go audit writer emits) ----
REAL_SUCCESS_RECORD = (
    '{"ts":"2026-07-20T05:01:15Z","agent_role":"orchestrator",'
    '"server":"memory","tool":"search",'
    '"args_hash":"sha256:96780c036a8123d5389f2883041c9c4f",'
    '"success":true,"result_size":37,"duration_ms":120}'
)
REAL_FAILURE_RECORD = (
    '{"ts":"2026-07-20T05:01:14Z","agent_role":"coder",'
    '"server":"filesystem","tool":"read_file",'
    '"args_hash":"sha256:0dd76449f23e50866e0369207d7d2a07",'
    '"success":false,"duration_ms":50,'
    '"error":"server not running: connection refused"}'
)
# Go omitempty: when args=nil → ArgsHash="" → field omitted; when
# result=nil → ResultSize=nil → field omitted; when error="" → field
# omitted. The consumer must tolerate all three being absent.
REAL_OMITEMPTY_RECORD = (
    '{"ts":"2026-07-20T05:01:16Z","agent_role":"explorer",'
    '"server":"catalog","tool":"list","success":true,"duration_ms":3}'
)


def test_jsonl_source_parses_real_record(tmp_path: Path) -> None:
    """Feed a real producer-shaped record, assert it parses into a
    BrokerAuditEvent with every field populated correctly."""
    p = tmp_path / "audit.jsonl"
    p.write_text(REAL_SUCCESS_RECORD + "\n", encoding="utf-8")

    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001 — sync one-shot load
    events = list(src._events)  # noqa: SLF001
    assert len(events) == 1
    ev = events[0]
    assert ev.ts == datetime(2026, 7, 20, 5, 1, 15, tzinfo=UTC)
    assert ev.agent_role == "orchestrator"
    assert ev.server == "memory"
    assert ev.tool == "search"
    assert ev.args_hash == "sha256:96780c036a8123d5389f2883041c9c4f"
    assert ev.success is True
    assert ev.result_size == 37
    assert ev.duration_ms == 120
    assert ev.error == ""


def test_jsonl_source_parses_omitempty_record(tmp_path: Path) -> None:
    """The Go producer omits args_hash/result_size/error when empty.
    The consumer's pydantic defaults (None, None, "") must apply."""
    p = tmp_path / "audit.jsonl"
    p.write_text(REAL_OMITEMPTY_RECORD + "\n", encoding="utf-8")

    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001
    events = list(src._events)  # noqa: SLF001
    assert len(events) == 1
    ev = events[0]
    assert ev.args_hash is None  # omitted → default
    assert ev.result_size is None  # omitted → default
    assert ev.error == ""  # omitted → default


def test_jsonl_source_skips_malformed_lines(tmp_path: Path) -> None:
    """The consumer must not crash on garbage lines — it logs a warning
    and skips them, still parsing the well-formed lines around them."""
    p = tmp_path / "audit.jsonl"
    lines = [
        REAL_SUCCESS_RECORD,
        "",  # blank line
        "not json at all {{{",
        "{bad json",
        REAL_FAILURE_RECORD,
        "   ",  # whitespace-only
        REAL_OMITEMPTY_RECORD,
    ]
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")

    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001 — logs warnings on bad lines
    events = list(src._events)  # noqa: SLF001

    # 3 well-formed records, 3 garbage + 1 blank → 3 events kept.
    assert len(events) == 3
    assert events[0].tool == "search"
    assert events[1].tool == "read_file"
    assert events[2].tool == "list"


def test_field_types_are_correct(tmp_path: Path) -> None:
    """Each BrokerAuditEvent field has the expected Python type, for
    both the success and failure producer shapes."""
    p = tmp_path / "audit.jsonl"
    p.write_text(
        REAL_SUCCESS_RECORD + "\n" + REAL_FAILURE_RECORD + "\n",
        encoding="utf-8",
    )
    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001
    events = list(src._events)  # noqa: SLF001
    assert len(events) == 2

    for ev in events:
        assert isinstance(ev, BrokerAuditEvent)
        assert isinstance(ev.ts, datetime)
        assert isinstance(ev.agent_role, str)
        assert isinstance(ev.server, str)
        assert isinstance(ev.tool, str)
        assert isinstance(ev.success, bool)
        assert isinstance(ev.duration_ms, int)
        assert isinstance(ev.error, str)
        assert ev.args_hash is None or isinstance(ev.args_hash, str)
        assert ev.result_size is None or isinstance(ev.result_size, int)


def test_from_jsonl_line_timestamp_alias() -> None:
    """The consumer tolerates ``timestamp`` as an alias for ``ts``
    (parity with the gateway-audit event shape)."""
    raw = json.loads(REAL_SUCCESS_RECORD)
    del raw["ts"]
    raw["timestamp"] = "2026-07-20T05:01:15Z"
    ev = BrokerAuditEvent.from_jsonl_line(json.dumps(raw))
    assert ev.ts == datetime(2026, 7, 20, 5, 1, 15, tzinfo=UTC)


def test_row_tuple_shape() -> None:
    """BrokerAuditEvent.row_tuple() returns the 8-column compact tuple
    the HTML table renders."""
    ev = BrokerAuditEvent.from_jsonl_line(REAL_SUCCESS_RECORD)
    row = ev.row_tuple()
    assert len(row) == 8
    assert row[0] == "2026-07-20 05:01:15"  # ts, UTC, strftime
    assert row[1] == "orchestrator"
    assert row[2] == "memory"
    assert row[3] == "search"
    assert row[4] == "✓"  # success
    assert row[5] == "120ms"
    assert row[6] == "37"
    assert row[7] == ""  # error


def test_failure_row_tuple_marks_x() -> None:
    """Failure records show ✗ and the error string in the last column."""
    ev = BrokerAuditEvent.from_jsonl_line(REAL_FAILURE_RECORD)
    row = ev.row_tuple()
    assert row[4] == "✗"
    assert row[6] == "—"  # result_size is None
    assert row[7] == "server not running: connection refused"


def test_jsonl_source_polls_new_appends(tmp_path: Path) -> None:
    """_poll_new() returns events appended after the initial load."""
    p = tmp_path / "audit.jsonl"
    p.write_text(REAL_SUCCESS_RECORD + "\n", encoding="utf-8")

    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001
    assert len(src._events) == 1  # noqa: SLF001

    # Append a new record.
    with p.open("a", encoding="utf-8") as fh:
        fh.write(REAL_FAILURE_RECORD + "\n")

    new = src._poll_new()  # noqa: SLF001
    assert len(new) == 1
    assert new[0].tool == "read_file"
    assert len(src._events) == 2  # noqa: SLF001


def test_jsonl_source_handles_truncated_file(tmp_path: Path) -> None:
    """If the file shrinks (rotated/truncated), the source resets."""
    p = tmp_path / "audit.jsonl"
    p.write_text(REAL_SUCCESS_RECORD + "\n" + REAL_FAILURE_RECORD + "\n", encoding="utf-8")
    src = JSONLBrokerAuditSource(p, poll_interval=0.2)
    src._load_existing()  # noqa: SLF001
    assert len(src._events) == 2  # noqa: SLF001

    # Truncate and write a single fresh record.
    p.write_text(REAL_OMITEMPTY_RECORD + "\n", encoding="utf-8")
    new = src._poll_new()  # noqa: SLF001 — detects shrink, resets, reads fresh
    assert len(new) == 1
    assert new[0].tool == "list"
    assert len(src._events) == 1  # noqa: SLF001
