"""argparse-based CLI entry point for the ``neuralgentics`` command.

Subcommands: ``init``, ``update``, ``doctor``, ``version``.

This module ONLY defines the command surface (parsers, flags, routing). The
real implementations live in separate modules and are wired up by later cards
(T-IMPL-INIT-CLI-003 through T-IMPL-INIT-CLI-006). Until then, each handler
raises :class:`NotImplementedError`.

Flag tables follow §1 of the design doc.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence

from . import __version__
from .errors import NeuralgenticsError, format_error

__all__ = ["main"]


def _build_parser() -> argparse.ArgumentParser:
    """Construct the top-level argument parser with all subcommands."""
    parser = argparse.ArgumentParser(
        prog="neuralgentics",
        description="Bootstrapper CLI for the neuralgentics OpenCode plugin.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"neuralgentics {__version__}",
        help="Print the CLI version and exit.",
    )

    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")

    _add_init_subparser(subparsers)
    _add_update_subparser(subparsers)
    _add_doctor_subparser(subparsers)
    _add_version_subparser(subparsers)

    return parser


def _add_init_subparser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p = subparsers.add_parser(
        "init",
        help="Bootstrap a project directory with the neuralgentics OpenCode plugin.",
    )
    p.add_argument(
        "--version", "-v", default="latest", help="Plugin version to install (default: latest)."
    )
    p.add_argument(
        "--target",
        "-t",
        default=".",
        help="Directory to bootstrap (default: current directory).",
    )
    p.add_argument(
        "--with-backend",
        action="store_true",
        default=False,
        help="Bring up the container stack after init (compose up -d).",
    )
    p.add_argument(
        "--compose-file",
        default="auto",
        help="Which compose file to use: auto, docker, podman, or a custom path.",
    )
    p.add_argument("--env-file", default=None, help="Path to .env file for compose.")
    p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        default=False,
        help="Skip all confirmation prompts.",
    )
    p.add_argument(
        "--offline",
        action="store_true",
        default=False,
        help="Use a bundled tarball instead of downloading (not yet available).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Preview all actions without writing anything.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Overwrite existing .opencode/ files even if user-modified.",
    )
    p.add_argument(
        "--repo",
        default="Veedubin/neuralgentics",
        help="GitHub repository to download from (default: Veedubin/neuralgentics).",
    )


def _add_update_subparser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p = subparsers.add_parser(
        "update",
        help="Update an existing neuralgentics installation to a newer version.",
    )
    p.add_argument(
        "--version", "-v", default="latest", help="Version to update to (default: latest)."
    )
    p.add_argument(
        "--target",
        "-t",
        default=".",
        help="Project directory to update (default: current directory).",
    )
    p.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Overwrite user-modified files.",
    )
    p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        default=False,
        help="Skip confirmation prompts.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Preview changes without applying.",
    )
    p.add_argument(
        "--repo",
        default="Veedubin/neuralgentics",
        help="GitHub repository (default: Veedubin/neuralgentics).",
    )


def _add_doctor_subparser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p = subparsers.add_parser(
        "doctor",
        help="Diagnose the current project's neuralgentics installation.",
    )
    p.add_argument(
        "--target",
        "-t",
        default=".",
        help="Project directory to diagnose (default: current directory).",
    )
    p.add_argument(
        "--json",
        action="store_true",
        default=False,
        help="Output as JSON for scripting.",
    )


def _add_version_subparser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    p = subparsers.add_parser(
        "version",
        help="Show version information for the CLI and installed plugin.",
    )
    p.add_argument(
        "--json",
        action="store_true",
        default=False,
        help="Output as JSON.",
    )


def _cmd_init(args: argparse.Namespace) -> int:
    """Handler for ``neuralgentics init``. Not yet implemented."""
    print("init: Not yet implemented", file=sys.stderr)
    raise NotImplementedError("init is implemented in T-IMPL-INIT-CLI-003")


def _cmd_update(args: argparse.Namespace) -> int:
    """Handler for ``neuralgentics update``. Not yet implemented."""
    print("update: Not yet implemented", file=sys.stderr)
    raise NotImplementedError("update is implemented in T-IMPL-INIT-CLI-004")


def _cmd_doctor(args: argparse.Namespace) -> int:
    """Handler for ``neuralgentics doctor``. Not yet implemented."""
    print("doctor: Not yet implemented", file=sys.stderr)
    raise NotImplementedError("doctor is implemented in T-IMPL-INIT-CLI-005")


def _cmd_version(args: argparse.Namespace) -> int:
    """Handler for ``neuralgentics version``. Not yet implemented."""
    print("version: Not yet implemented", file=sys.stderr)
    raise NotImplementedError("version is implemented in T-IMPL-INIT-CLI-006")


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the ``neuralgentics`` console script.

    Parses ``argv`` (or ``sys.argv[1:]``), routes to the subcommand handler,
    and translates :class:`NeuralgenticsError` subclasses into formatted stderr
    output + the error's exit code. ``KeyboardInterrupt`` exits 130.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        # No subcommand: print help and exit 0.
        parser.print_help()
        return 0

    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "init": _cmd_init,
        "update": _cmd_update,
        "doctor": _cmd_doctor,
        "version": _cmd_version,
    }

    handler = handlers.get(args.command)
    if handler is None:  # pragma: no cover — argparse rejects unknown subcommands
        parser.print_help()
        return 0

    try:
        return handler(args)
    except NeuralgenticsError as err:
        print(format_error(err), file=sys.stderr)
        return err.exit_code
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
