"""Aggregate stats calculator for the broker-audit module (T-107).

Computes summary statistics over a list of recent
:class:`BrokerAuditEvent` objects for the stats panel at the top of the
tool-calls page:

* total_calls
* success_count + success_rate (0.0–1.0)
* avg_duration_ms
* top_tools — top 5 by call count, as ``[(tool_name, call_count), ...]``

For v0.14.0 we compute stats in Python from the recent events window
(no separate stats table, no time-series bucketing).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from neuralgentics.web.modules.broker_audit.data_source import BrokerAuditEvent


@dataclass(frozen=True, slots=True)
class BrokerAuditStats:
    """Aggregate stats over a window of broker audit events."""

    total_calls: int
    success_count: int
    success_rate: float  # 0.0–1.0
    avg_duration_ms: float
    top_tools: list[tuple[str, int]]  # [(tool_name, call_count), ...] top 5


def compute_stats(events: list[BrokerAuditEvent]) -> BrokerAuditStats:
    """Compute aggregate stats over ``events``.

    ``events`` is typically the result of ``data_source.recent(limit=N)``
    — i.e. the most recent N tool calls. The stats describe that window,
    not the full history.
    """
    total = len(events)
    if total == 0:
        return BrokerAuditStats(
            total_calls=0,
            success_count=0,
            success_rate=0.0,
            avg_duration_ms=0.0,
            top_tools=[],
        )
    success_count = sum(1 for e in events if e.success)
    success_rate = success_count / total
    avg_duration = sum(e.duration_ms for e in events) / total
    # Top 5 tools by call count. Counter.most_common(n) returns the top
    # n; ties are broken by insertion order (Python 3.7+ dicts).
    tool_counts: Counter[str] = Counter(e.tool for e in events)
    top_tools = tool_counts.most_common(5)
    return BrokerAuditStats(
        total_calls=total,
        success_count=success_count,
        success_rate=success_rate,
        avg_duration_ms=avg_duration,
        top_tools=top_tools,
    )


__all__ = ["BrokerAuditStats", "compute_stats"]
