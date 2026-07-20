"""neuralgentics-web CLI — entry point for the ``neuralgentics-web`` command.

T-132: ``pip install neuralgentics-web`` now provides a
``neuralgentics-web`` console script. This thin wrapper reuses the
existing argument parser and runner from ``__main__`` and only layers
its own ``--version`` flag on top — keeping a single source of truth for
the CLI surface.

Backward compatibility: ``python -m neuralgentics.web`` continues to
work unchanged because ``__main__.main`` is untouched.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence

from neuralgentics.web import __version__
from neuralgentics.web.__main__ import _run_from_args, build_parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser("neuralgentics-web")
    parser.add_argument(
        "--version",
        action="version",
        version=f"neuralgentics-web {__version__}",
    )
    args = parser.parse_args(argv)
    return _run_from_args(args)


if __name__ == "__main__":
    sys.exit(main())
