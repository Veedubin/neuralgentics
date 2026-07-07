"""Tests for the error model and CLI scaffolding.

Covers:
- Every :class:`NeuralgenticsError` subclass has the expected ``exit_code``
  and a non-empty ``remediation``.
- :func:`format_error` produces the ``[ERROR] ...\\nSuggestion: ...`` format.
- ``cli.main()`` with no args prints help and exits 0.
- ``cli.main(["--version"])`` prints the CLI version and exits 0.
- ``cli.main(["--init"])`` dispatches to ``init_cmd.run_init``.
"""

from __future__ import annotations

import argparse
import sys

import pytest

from neuralgentics import __version__, cli
from neuralgentics.errors import (
    ComposeNotFound,
    ComposeUpFailed,
    ExtractionFailed,
    MergeConflict,
    NetworkError,
    NeuralgenticsError,
    NpmInstallFailed,
    NpmNotFound,
    OfflineNoBundle,
    OpenCodeJsonInvalid,
    OpencodeNotFound,
    PermissionDenied,
    Sha256Mismatch,
    TarballCorrupt,
    TargetNotDirectory,
    VersionNotFound,
    format_error,
)

# (class, expected exit code)
ERROR_CLASSES: list[tuple[type[NeuralgenticsError], int]] = [
    (OpencodeNotFound, 4),
    (NpmNotFound, 5),
    (NetworkError, 6),
    (Sha256Mismatch, 7),
    (TarballCorrupt, 8),
    (ExtractionFailed, 9),
    (OpenCodeJsonInvalid, 3),
    (MergeConflict, 10),
    (ComposeNotFound, 11),
    (ComposeUpFailed, 12),
    (NpmInstallFailed, 13),
    (VersionNotFound, 14),
    (OfflineNoBundle, 15),
    (PermissionDenied, 16),
    (TargetNotDirectory, 17),
]


@pytest.mark.parametrize(("err_cls", "exit_code"), ERROR_CLASSES)
def test_error_exit_codes(err_cls: type[NeuralgenticsError], exit_code: int) -> None:
    err = err_cls("boom")
    assert err.exit_code == exit_code


@pytest.mark.parametrize(("err_cls", "exit_code"), ERROR_CLASSES)
def test_error_remediation_nonempty(err_cls: type[NeuralgenticsError], exit_code: int) -> None:
    err = err_cls("boom")
    assert isinstance(err.remediation, str)
    assert err.remediation.strip(), f"{err_cls.__name__} has empty remediation"


def test_error_remediation_override() -> None:
    err = NetworkError("oops", remediation="Try again later.")
    assert err.remediation == "Try again later."


def test_error_is_exception() -> None:
    assert issubclass(NeuralgenticsError, Exception)


def test_format_error_format() -> None:
    err = NetworkError("Failed to download https://example.com/x: 404 Not Found")
    out = format_error(err)
    assert out.startswith("[ERROR] ")
    assert "Failed to download" in out
    assert "\nSuggestion: " in out
    assert out.endswith(err.remediation)


def test_format_error_uses_override_remediation() -> None:
    err = NetworkError("oops", remediation="custom hint")
    assert format_error(err).endswith("custom hint")


def test_format_error_no_trailing_newline() -> None:
    err = OpencodeNotFound("nope")
    assert not format_error(err).endswith("\n")


def test_cli_version_constant() -> None:
    assert __version__ == "0.1.0"


def test_cli_no_args_prints_help_and_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    rc = cli.main([])
    out = capsys.readouterr()
    assert rc == 0
    assert "usage:" in out.out.lower() or "usage:" in out.err.lower()


def test_cli_version_flag_prints_version_and_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    rc = cli.main(["--version"])
    assert rc == 0
    out = capsys.readouterr()
    assert f"neuralgentics {__version__}" in out.out


def test_cli_init_dispatches_to_run_init(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``cli.main(["--init"])`` calls ``init_cmd.run_init``."""
    calls: list[argparse.Namespace] = []

    def fake_run_init(args: argparse.Namespace) -> int:
        calls.append(args)
        return 0

    monkeypatch.setattr(cli, "run_init", fake_run_init)
    rc = cli.main(["--init"])
    assert rc == 0
    assert len(calls) == 1
    assert calls[0].init is True


def test_cli_unknown_positional_errors(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        cli.main(["definitely-not-a-command"])
    out = capsys.readouterr()
    assert "usage:" in out.err.lower() or "invalid choice" in out.err.lower()


def test_cli_keyboard_interrupt_exits_130(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def raise_kb(args: argparse.Namespace) -> int:
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "run_init", raise_kb)
    rc = cli.main(["--init"])
    assert rc == 130
    out = capsys.readouterr()
    assert "Interrupted." in out.err


def test_cli_neuralgentics_error_returns_exit_code(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def raise_err(args: argparse.Namespace) -> int:
        raise OpencodeNotFound("missing")

    monkeypatch.setattr(cli, "run_init", raise_err)
    rc = cli.main(["--init"])
    assert rc == 4
    out = capsys.readouterr()
    assert "[ERROR]" in out.err
    assert "Suggestion:" in out.err


def test_init_has_all_expected_flags() -> None:
    parser = cli._build_parser()
    # Flat parser: gather flag strings directly from parser actions.
    flag_strings: set[str] = set()
    for a in parser._actions:  # noqa: SLF001
        flag_strings.update(a.option_strings)
    expected = {
        "--init",
        "--version",
        "--target",
        "--yes",
        "--offline",
        "--dry-run",
        "--force",
        "--repo",
        "--help",
    }
    assert expected.issubset(flag_strings), f"missing flags: {expected - flag_strings}"


def test_init_does_not_have_dead_flags() -> None:
    parser = cli._build_parser()
    flag_strings: set[str] = set()
    for a in parser._actions:  # noqa: SLF001
        flag_strings.update(a.option_strings)
    dead = {"--with-backend", "--compose-file", "--env-file"}
    assert flag_strings.isdisjoint(dead), f"dead flags still present: {dead & flag_strings}"


def test_sys_entrypoint_importable() -> None:
    # Ensure the console-script target resolves.
    from neuralgentics.cli import main  # noqa: F401

    assert callable(main)


# Quiet ruff about sys import being "unused" if no test uses it directly.
_ = sys
