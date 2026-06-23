"""Embedding sidecar entry point.

Starts the gRPC embedding service, typically via:
    uv run python -m embedding_sidecar.main
Or directly:
    python -m embedding_sidecar.main

Environment variables:
    NEURAL_EMBED_ADDR          Listen address (default: unix:///tmp/neuralgentics-embed.sock)
                               Use "localhost:50051" for TCP instead of Unix socket.
    NEURALGENTICS_EMBED_DEVICE  Device for embedding models: "cpu", "cuda", or unset for auto.
                               Default behaviour (unset) lets SentenceTransformer auto-detect.
                               Set to "cpu" when GPU VRAM is contention-prone (other ML processes).
                               Set to "cuda" for GPU-accelerated batch inference when VRAM is free.
    NOTIFY_SOCKET              Set by systemd when WatchdogSec is configured. Enables sd_notify
                               watchdog keep-alive and READY=1 notification.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import sys
import threading
import time

from embedding_sidecar.server import serve

# ---------------------------------------------------------------------------
# sd_notify support
# ---------------------------------------------------------------------------
NOTIFY_SOCKET = os.environ.get("NOTIFY_SOCKET")

_WATCHDOG_INTERVAL_SECONDS = 10


def _sd_notify(message: str) -> None:
    """Send a notification to systemd via the NOTIFY_SOCKET unix datagram."""
    if not NOTIFY_SOCKET:
        return
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.connect(NOTIFY_SOCKET)
        sock.sendall(message.encode())
        sock.close()
    except Exception as exc:
        logging.warning("sd_notify failed: %s", exc)


def _watchdog_loop() -> None:
    """Periodically send WATCHDOG=1 to systemd to prove the sidecar is alive."""
    while True:
        time.sleep(_WATCHDOG_INTERVAL_SECONDS)
        _sd_notify("WATCHDOG=1")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_TEXT_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


class _JsonFormatter(logging.Formatter):
    """Minimal JSON log formatter using only the stdlib."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {
                "ts": self.formatTime(record),
                "level": record.levelname,
                "msg": record.getMessage(),
                "logger": record.name,
            }
        )


def _configure_logging(log_format: str) -> None:
    """Set up root logger with the chosen format."""
    handler = logging.StreamHandler()
    if log_format == "json":
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(_TEXT_LOG_FORMAT))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


# ---------------------------------------------------------------------------
# Argparse
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Neuralgentics embedding sidecar — gRPC embedding service",
    )
    parser.add_argument(
        "--log-format",
        choices=["text", "json"],
        default="text",
        help="Log output format: 'text' (default) or 'json' for structured logs",
    )
    return parser


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


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
    logger = logging.getLogger(__name__)
    logger.info("starting embedding sidecar on %s", listen_addr)

    server = await serve(listen_addr)
    logger.info("embedding sidecar started on %s", listen_addr)

    # Notify systemd that the service is ready and start watchdog keep-alive
    _sd_notify("READY=1")
    if NOTIFY_SOCKET:
        watchdog_thread = threading.Thread(target=_watchdog_loop, daemon=True)
        watchdog_thread.start()
        logger.info(
            "sd_notify watchdog enabled (interval=%ds)", _WATCHDOG_INTERVAL_SECONDS
        )

    # Graceful shutdown
    stop_event = asyncio.Event()

    def _signal_handler(sig_name: str) -> None:
        logger.info("received %s, shutting down", sig_name)
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig, name in ((signal.SIGINT, "SIGINT"), (signal.SIGTERM, "SIGTERM")):
        loop.add_signal_handler(sig, _signal_handler, name)

    await stop_event.wait()
    logger.info("shutting down...")
    await server.stop(grace=5)
    logger.info("server stopped")


if __name__ == "__main__":
    args = _build_parser().parse_args()
    _configure_logging(args.log_format)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
