"""SSE broadcaster for the gateway-audit module.

A small fan-out hub: one producer (the data source's ``subscribe()``)
feeds N SSE subscribers. Each subscriber gets its own
:class:`asyncio.Queue`; the broadcaster drains them on push.

We keep the design explicit rather than relying on sse-starlette's
built-in fanout because (a) we want a clean shutdown, (b) the data
source is pluggable (JSONL or PG), and (c) it makes multi-subscriber
tests trivial.

T-115.1: ``stop()`` pushes a :data:`GOODBYE` sentinel into every
subscriber queue before cancelling the drain task. The SSE handler
(:func:`gateway_audit.routes.sse_stream`) checks for the sentinel and
emits a ``goodbye`` event frame before breaking out — so clients get a
clean disconnect signal instead of a TCP drop when the module is
hot-reloaded or the app shuts down.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

from neuralgentics.web.modules.gateway_audit.data_source import AuditEvent

log = logging.getLogger("neuralgentics.web.gateway_audit.sse")


@dataclass(frozen=True)
class Goodbye:
    """Sentinel pushed to subscriber queues by :meth:`AuditBroadcaster.stop`.

    The SSE handler checks ``isinstance(event, Goodbye)`` and emits a
    ``goodbye`` event frame before breaking out of the stream.
    """


class AuditBroadcaster:
    """Fan-out hub for audit events to SSE subscribers.

    Lifecycle:
      1. ``start(source)`` — spawns a background task that reads
         ``source.subscribe()`` and pushes each event to every queue.
      2. ``subscribe()`` — returns a queue the caller can await; the
         broadcaster pushes new events into it. Backpressure-safe (bounded).
      3. ``stop()`` — pushes a :data:`Goodbye` sentinel to every subscriber,
         cancels the background task, and drains queues.
    """

    QUEUE_MAX = 256

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[AuditEvent | Goodbye]] = set()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self, source_iter: AsyncIterator[AuditEvent]) -> None:
        """Spawn the background drain task feeding from ``source_iter``."""
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.ensure_future(self._drain(source_iter))

    async def _drain(self, source_iter: AsyncIterator[AuditEvent]) -> None:
        log.info("audit broadcaster started")
        try:
            async for event in source_iter:
                for q in list(self._subscribers):
                    try:
                        q.put_nowait(event)
                    except asyncio.QueueFull:
                        # subscriber too slow — drop the oldest and push new
                        with contextlib.suppress(asyncio.QueueEmpty):
                            q.get_nowait()
                        with contextlib.suppress(asyncio.QueueFull):
                            q.put_nowait(event)
                if self._stop_event.is_set():
                    break
        except asyncio.CancelledError:
            log.info("audit broadcaster cancelled")
            raise
        except Exception:  # noqa: BLE001
            log.exception("audit broadcaster error")
        finally:
            log.info("audit broadcaster stopped")

    def subscribe(self) -> asyncio.Queue[AuditEvent | Goodbye]:
        """Register a new subscriber and return its queue."""
        q: asyncio.Queue[AuditEvent | Goodbye] = asyncio.Queue(maxsize=self.QUEUE_MAX)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[AuditEvent | Goodbye]) -> None:
        self._subscribers.discard(q)

    async def stop(self) -> None:
        """T-115.1: push a :data:`Goodbye` sentinel to every subscriber so
        the SSE handler can emit a goodbye frame before the stream closes,
        then cancel the drain task and clear subscribers.
        """
        self._stop_event.set()
        # Push goodbye to each subscriber (best-effort — drop oldest if full).
        for q in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(Goodbye())
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._subscribers.clear()


__all__ = ["AuditBroadcaster", "Goodbye"]
