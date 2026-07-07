"""argparse-based CLI entry point for the ``neuralgentics`` command.

Single-command bootstrap: pass ``--init`` (or the positional alias ``init``)
to download + place the neuralgentics OpenCode plugin into ``--target``.
The real implementation lives in :mod:`neuralgentics.init_cmd`.

Flag tables follow §1 of the design doc; ``update``/``doctor``/``version``
subcommands were removed in v0.1.1 — they never had working handlers and the
user wanted a one-command bootstrap.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from . import __version__
from .errors import NeuralgenticsError, format_error
from .init_cmd import run_init

__all__ = ["main"]

#: Sentinel value produced by ``--version`` with no argument. Distinguishes
#: ``neuralgentics --version`` (print CLI version, exit 0) from
#: ``neuralgentics --version 0.9.1`` (install plugin v0.9.1).
_CLI_VERSION_SENTINEL = "__cli__"


def _build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser.

    The parser is flat (no subcommands). ``--version`` and the positional
    ``init`` are both optional; bare ``neuralgentics`` prints help + exits 0.
    """
    parser = argparse.ArgumentParser(
        prog="neuralgentics",
        description="Bootstrapper CLI for the neuralgentics OpenCode plugin.",
    )

    # --init: boolean flag that triggers the bootstrap flow.
    parser.add_argument(
        "--init",
        action="store_true",
        default=False,
        help="Bootstrap the target directory with the neuralgentics plugin.",
    )

    # --version: bare → print CLI version + exit 0; with an argument → the
    # plugin version to install (default: "latest"). A ``nargs="?"`` +
    # ``const`` sentinel distinguishes the two cases after parsing.
    parser.add_argument(
        "--version",
        nargs="?",
        const=_CLI_VERSION_SENTINEL,
        default="latest",
        help=(
            "With no argument: print the CLI version and exit. "
            "With an argument: the plugin version to install (default: latest)."
        ),
    )

    # Positional alias: ``neuralgentics init`` is equivalent to ``--init``.
    parser.add_argument(
        "command",
        nargs="?",
        choices=["init"],
        default=None,
        help="Alias for --init.",
    )

    parser.add_argument(
        "--target",
        "-t",
        default=".",
        help="Directory to bootstrap (default: current directory).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Overwrite existing .opencode/ files even if user-modified.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Preview all actions without writing anything.",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        default=False,
        help="Skip all confirmation prompts.",
    )
    parser.add_argument(
        "--repo",
        default="Veedubin/neuralgentics",
        help="GitHub repository to download from (default: Veedubin/neuralgentics).",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        default=False,
        help="Use a bundled tarball instead of downloading (not yet available).",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the ``neuralgentics`` console script.

    Parses ``argv`` (or ``sys.argv[1:]``). When ``--init`` is set (or the
    positional ``init`` alias is present), dispatches to
    :func:`neuralgentics.init_cmd.run_init`. Translates
    :class:`NeuralgenticsError` subclasses into formatted stderr output + the
    error's exit code. ``KeyboardInterrupt`` exits 130.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    # --version with no argument: print the CLI version and exit 0.
    # (``const`` sentinel is only set when the flag was passed bare.)
    if args.version == _CLI_VERSION_SENTINEL:
        print(f"neuralgentics {__version__}")
        return 0

    # init requested via --init or the positional ``init`` alias.
    init_requested = args.init or (args.command == "init")
    if not init_requested:
        # No command: print help and exit 0.
        parser.print_help()
        return 0

    # Normalize: run_init reads ``args.init`` via getattr, so set it for parity
    # with callers that build a Namespace directly.
    args.init = True

    try:
        return run_init(args)
    except NeuralgenticsError as err:
        print(format_error(err), file=sys.stderr)
        return err.exit_code
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
