"""Soft-import helpers for optional dependencies.

The web package is standalone-installable: ``pip install neuralgentics-web``
works without ``memini-ai`` or ``asyncpg`` installed. These helpers wrap the
deferred imports of optional deps so that users who try to use a feature
that needs one of them get a clear, actionable error instead of a bare
``ImportError``.

* ``asyncpg`` is in the ``[team-server]`` extra.
* ``memini-ai`` is intentionally NOT a web dependency — users install it
  separately when they want the memini-browser's embedded (SDK) backend.
"""

from __future__ import annotations

from typing import Any


def import_asyncpg() -> Any:
    """Import ``asyncpg`` or raise a clear RuntimeError.

    Used by the gateway-audit / broker-audit / memini-browser PG backends,
    which are only active in team-server mode. The error message points the
    user at the ``[team-server]`` extra.
    """
    try:
        import asyncpg
    except ImportError as exc:
        raise RuntimeError(
            "asyncpg is not installed. The team-server PG backends "
            "(gateway-audit, broker-audit, memini-browser PG fallback) "
            "require asyncpg. Install it with: "
            "pip install neuralgentics-web[team-server]"
        ) from exc
    return asyncpg


__all__ = ["import_asyncpg"]
