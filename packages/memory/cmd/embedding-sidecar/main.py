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
    NEURALGENTICS_EMBED_DTYPE   Embedding precision: "fp32" (default), "fp16" (GPU half VRAM),
                               or "int8" (quantized, smallest; bitsandbytes on GPU, dynamic on CPU).
    EAGER                       "true" to pre-load the default model at startup (default: false).
                               Lazy-load is the default — the model loads on first request.
    IDLE_MIN                    Minutes of inactivity before unloading a model (default: 5).
    STATUS_PORT                 HTTP port for the /status endpoint (default: 50052).
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from embedding_sidecar.embed import model_manager
from embedding_sidecar.health import build_status_json
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
# Helpers
# ---------------------------------------------------------------------------


def _env_bool(name: str, default: bool) -> bool:
    """Parse a boolean env var: 'true'/'1'/'yes' → True, else False."""
    raw = os.environ.get(name, "")
    if not raw:
        return default
    return raw.strip().lower() in {"true", "1", "yes"}


# ---------------------------------------------------------------------------
# HTTP /status endpoint (stdlib, no aiohttp dependency)
# ---------------------------------------------------------------------------


class _StatusHandler(BaseHTTPRequestHandler):
    """HTTP handler that serves GET /status as JSON."""

    def do_GET(self) -> None:  # noqa: N802 — stdlib requires this name
        if self.path != "/status":
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": "not found"}')
            return
        payload = build_status_json(model_manager.status())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args: object) -> None:
        # Silence default stderr logging; route through our logger instead.
        logging.getLogger("status_http").debug(
            "HTTP %s: %s", self.address_string(), fmt % args
        )


def _start_status_server(port: int) -> ThreadingHTTPServer | None:
    """Start the HTTP /status server on the given port. Returns None on failure."""
    logger = logging.getLogger(__name__)
    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", port), _StatusHandler)
        thread = threading.Thread(
            target=httpd.serve_forever, daemon=True, name="status-http"
        )
        thread.start()
        logger.info("status endpoint listening on 0.0.0.0:%d/status", port)
        return httpd
    except OSError as exc:
        logger.warning(
            "could not start status endpoint on port %d: %s — /status disabled",
            port,
            exc,
        )
        return None


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
    parser.add_argument(
        "--quantize",
        "--embed-dtype",
        dest="embed_dtype",
        choices=["fp32", "fp16", "int8"],
        default=os.environ.get("NEURALGENTICS_EMBED_DTYPE", "fp32"),
        help=(
            "Embedding precision: fp32 (full, default), "
            "fp16 (GPU, half VRAM), int8 (quantized, smallest)"
        ),
    )
    parser.add_argument(
        "--lazy-load",
        action="store_true",
        default=not _env_bool("EAGER", False),
        help="Lazy-load model on first request, unload after idle (default)",
    )
    parser.add_argument(
        "--no-lazy-load",
        dest="lazy_load",
        action="store_false",
        help="Eager-load model at startup, keep loaded while clients connected",
    )
    parser.add_argument(
        "--idle-min",
        type=int,
        default=int(os.environ.get("IDLE_MIN", "5")),
        help="Minutes of inactivity before unloading model (default: 5)",
    )
    parser.add_argument(
        "--status-port",
        type=int,
        default=int(os.environ.get("STATUS_PORT", "50052")),
        help="HTTP port for /status endpoint (default: 50052)",
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


async def main(args: argparse.Namespace) -> None:
    """Start the gRPC server and wait for termination."""
    listen_addr = get_listen_addr()
    logger = logging.getLogger(__name__)
    logger.info(
        "starting embedding sidecar on %s (dtype=%s, lazy=%s, idle_min=%d, "
        "status_port=%d)",
        listen_addr,
        args.embed_dtype,
        args.lazy_load,
        args.idle_min,
        args.status_port,
    )

    server = await serve(listen_addr)
    logger.info("embedding sidecar started on %s", listen_addr)

    # Start the HTTP /status endpoint on a separate port
    status_httpd: ThreadingHTTPServer | None = _start_status_server(args.status_port)

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
    if status_httpd is not None:
        status_httpd.shutdown()
        logger.info("status endpoint stopped")
    # Clean shutdown of the idle-unload thread
    model_manager.shutdown()
    logger.info("model manager shut down")
    logger.info("server stopped")


if __name__ == "__main__":
    parsed = _build_parser().parse_args()
    _configure_logging(parsed.log_format)

    try:
        asyncio.run(main(parsed))
    except KeyboardInterrupt:
        sys.exit(0)
