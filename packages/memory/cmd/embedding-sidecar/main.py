"""Embedding sidecar entry point.

Starts the gRPC embedding service, typically via:
    uv run python -m embedding_sidecar.main
Or directly:
    python -m embedding_sidecar.main
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

from embedding_sidecar.server import serve

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def get_listen_addr() -> str:
    """Determine listen address from environment or default.

    Supports:
      - NEURAL_EMBED_ADDR=unix:///tmp/neuralgentics-embed.sock  (Unix domain socket)
      - NEURAL_EMBED_ADDR=localhost:50051                         (TCP)
    """
    return os.environ.get("NEURAL_EMBED_ADDR", "unix:///tmp/neuralgentics-embed.sock")


async def main() -> None:
    """Start the gRPC server and wait for termination."""
    listen_addr = get_listen_addr()
    logger.info("starting embedding sidecar on %s", listen_addr)

    server = await serve(listen_addr)
    logger.info("embedding sidecar started on %s", listen_addr)

    # Graceful shutdown
    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        logger.info("received shutdown signal")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    await stop_event.wait()
    logger.info("shutting down...")
    await server.stop(grace=5)
    logger.info("server stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
