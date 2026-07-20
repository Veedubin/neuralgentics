"""Entry point: ``python -m neuralgentics.web``.

Dispatches to embedded or team-server mode based on --mode flag.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Sequence

from neuralgentics.web.app import build_app, run_app
from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web")


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m neuralgentics.web",
        description="neuralgentics-web — modular web UI shell",
    )
    p.add_argument(
        "--mode",
        choices=("embedded", "team-server"),
        default="embedded",
        help="Run mode (default: embedded)",
    )
    p.add_argument("--port", type=int, default=None, help="Override listen port")
    p.add_argument("--host", type=str, default=None, help="Override bind host")
    p.add_argument(
        "--db-url",
        type=str,
        default=None,
        help="PostgreSQL DSN (team-server mode only)",
    )
    p.add_argument(
        "--modules-path",
        type=str,
        default=None,
        help="Override modules directory (default: built-in modules)",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    config = WebConfig.from_args(
        mode=args.mode,
        port=args.port,
        host=args.host,
        db_url=args.db_url,
        modules_path=args.modules_path,
    )
    log.info(
        "starting neuralgentics-web %s in %s mode",
        __import__("neuralgentics.web", fromlist=["__version__"]).__version__,
        config.mode,
    )
    app = build_app(config)
    run_app(app, config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
