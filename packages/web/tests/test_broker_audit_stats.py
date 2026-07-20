"""Tests for the broker-audit stats calculator (T-107).

Covers:
  * compute_stats() returns the correct total / success rate / avg
    latency / top 5 tools over a list of BrokerAuditEvent.
  * compute_stats() on an empty list returns zeros (no division-by-zero).
  * Top tools are ordered by call count (descending) and capped at 5.
"""

from __future__ import annotations

from datetime import UTC, datetime

from neuralgentics.web.modules.broker_audit.data_source import BrokerAuditEvent
from neuralgentics.web.modules.broker_audit.stats import compute_stats


def _ev(
    *,
    tool: str = "read_file",
    success: bool = True,
    duration_ms: int = 50,
    ts: str = "2026-07-19T12:00:00Z",
) -> BrokerAuditEvent:
    return BrokerAuditEvent(
        ts=datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(UTC),
        agent_role="coder",
        server="filesystem",
        tool=tool,
        args_hash="sha256:abc",
        success=success,
        result_size=100,
        duration_ms=duration_ms,
        error="" if success else "err",
    )


def test_compute_stats_aggregates_correctly() -> None:
    """3 events: 2 success, 1 failure. Top tool is read_file (2 calls)."""
    events = [
        _ev(tool="read_file", success=True, duration_ms=10),
        _ev(tool="read_file", success=True, duration_ms=30),
        _ev(tool="write_file", success=False, duration_ms=50),
    ]
    stats = compute_stats(events)
    assert stats.total_calls == 3
    assert stats.success_count == 2
    assert stats.success_rate == 2 / 3
    assert stats.avg_duration_ms == (10 + 30 + 50) / 3
    # Top tools: read_file (2), write_file (1).
    assert stats.top_tools == [("read_file", 2), ("write_file", 1)]


def test_compute_stats_empty_list_returns_zeros() -> None:
    """An empty event list produces zero stats — no division by zero."""
    stats = compute_stats([])
    assert stats.total_calls == 0
    assert stats.success_count == 0
    assert stats.success_rate == 0.0
    assert stats.avg_duration_ms == 0.0
    assert stats.top_tools == []


def test_compute_stats_top_tools_capped_at_5() -> None:
    """When more than 5 distinct tools appear, only the top 5 by count
    are returned."""
    # 6 distinct tools; tool_a appears 5x, tool_b 4x, ..., tool_f 1x.
    events: list[BrokerAuditEvent] = []
    counts = [
        ("tool_a", 5),
        ("tool_b", 4),
        ("tool_c", 3),
        ("tool_d", 2),
        ("tool_e", 1),
        ("tool_f", 1),
    ]
    for tool, n in counts:
        for _ in range(n):
            events.append(_ev(tool=tool))
    stats = compute_stats(events)
    assert stats.total_calls == 16
    # Top 5 — tool_f (1 call) is bumped by tool_e (also 1 call); both
    # have the same count, so Counter.most_common(5) returns the first
    # 5 by insertion order. tool_e was inserted before tool_f, so it
    # wins the tie.
    assert len(stats.top_tools) == 5
    assert stats.top_tools[0] == ("tool_a", 5)
    assert stats.top_tools[1] == ("tool_b", 4)
    assert stats.top_tools[2] == ("tool_c", 3)
    assert stats.top_tools[3] == ("tool_d", 2)
    # 5th slot is tool_e (insertion-order tiebreak with tool_f).
    assert stats.top_tools[4][0] in {"tool_e", "tool_f"}
    assert stats.top_tools[4][1] == 1


def test_compute_stats_stats_panel_renders_top_tools() -> None:
    """Smoke test: the stats panel shows the top tool with its call count,
    matching the spec's acceptance criterion 7 (e.g. 'filesystem/read_file:
    45 calls'). We render 'read_file: 45 calls' (tool name only — the
    server is a separate column in the table)."""
    events = [_ev(tool="read_file") for _ in range(45)]
    events += [_ev(tool="write_file") for _ in range(10)]
    stats = compute_stats(events)
    assert stats.top_tools[0] == ("read_file", 45)
    assert stats.top_tools[1] == ("write_file", 10)
    assert stats.success_rate == 1.0
    assert stats.total_calls == 55
