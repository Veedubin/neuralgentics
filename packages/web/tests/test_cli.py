"""Tests for the ``neuralgentics-web`` console-script entry point (T-132).

Covers:
  * ``neuralgentics-web --help`` — exit 0, help text present
  * ``neuralgentics-web --version`` — exit 0, version string present
  * ``python -m neuralgentics.web --help`` — still works (backward compat)
  * ``neuralgentics-web --mode=embedded --port=9999`` — args are passed
    through to the underlying app runner (verified by mocking
    ``run_app`` so we never actually start uvicorn).
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any
from unittest import mock

import pytest

from neuralgentics.web import __version__, cli

# --- subprocess helpers -------------------------------------------------


def _run(args: list[str], *, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    """Run a command via ``sys.executable -m`` or the console script.

    Captures stdout+stderr combined so help/version text can be asserted.
    """
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _console_script_path() -> str | None:
    """Return the path to the installed ``neuralgentics-web`` script, or None.

    Uses ``shutil.which`` so the test skips cleanly if the package isn't
    installed with its console_scripts entry point active (e.g. running
    from source without ``pip install -e .``).
    """
    import shutil

    return shutil.which("neuralgentics-web")


# --- T-132 acceptance tests ---------------------------------------------


def test_cli_help() -> None:
    """``neuralgentics-web --help`` exits 0 and prints the CLI surface."""
    script = _console_script_path()
    if script is None:
        pytest.skip(
            "neuralgentics-web console script not on PATH (install with: uv pip install -e .)"
        )
    result = _run([script, "--help"])
    assert result.returncode == 0, result.stderr
    out = result.stdout + result.stderr
    # argparse prints help to stdout; --mode is the headline flag from build_parser
    assert "--mode" in out
    assert "--port" in out
    assert "--version" in out
    # Prog name reflects the console script (not ``python -m ...``)
    assert "neuralgentics-web" in out


def test_cli_version() -> None:
    """``neuralgentics-web --version`` exits 0 and prints the version."""
    script = _console_script_path()
    if script is None:
        pytest.skip("neuralgentics-web console script not on PATH")
    result = _run([script, "--version"])
    assert result.returncode == 0, result.stderr
    out = (result.stdout + result.stderr).strip()
    assert __version__ in out
    assert "neuralgentics-web" in out


def test_python_m_still_works() -> None:
    """``python -m neuralgentics.web --help`` still exits 0 (backward compat)."""
    result = _run([sys.executable, "-m", "neuralgentics.web", "--help"])
    assert result.returncode == 0, result.stderr
    out = result.stdout + result.stderr
    assert "--mode" in out
    assert "--port" in out


def test_cli_passes_through_args() -> None:
    """``neuralgentics-web --mode=embedded --port=9999`` reaches ``run_app``.

    We mock ``run_app`` so uvicorn never actually binds the port, then
    assert the parsed config reflects the flags the CLI was given.
    """
    captured: dict[str, Any] = {}

    with mock.patch("neuralgentics.web.cli._run_from_args", autospec=True) as fake_run:
        # We want to exercise the full parse → run path, but stop short of
        # uvicorn. So we patch the inner ``run_app`` call by replacing
        # ``_run_from_args`` with a stub that records the args namespace.
        def _stub(args: Any) -> int:
            captured["args"] = args
            return 0

        fake_run.side_effect = _stub
        rc = cli.main(["--mode=embedded", "--port=9999"])

    assert rc == 0
    args = captured["args"]
    assert args.mode == "embedded"
    assert args.port == 9999
    fake_run.assert_called_once()


def test_cli_passes_through_args_to_run_app() -> None:
    """End-to-end-ish: args flow all the way to ``run_app`` (mocked).

    This is the stronger version of ``test_cli_passes_through_args`` —
    instead of stubbing ``_run_from_args``, we let it run for real and
    only patch ``run_app`` (the uvicorn call) so we can inspect the
    ``WebConfig`` that was constructed from the parsed args.
    """
    captured: dict[str, Any] = {}

    def _fake_run_app(app: Any, config: Any) -> None:
        captured["app"] = app
        captured["config"] = config

    with mock.patch("neuralgentics.web.__main__.run_app", side_effect=_fake_run_app):
        rc = cli.main(["--mode=embedded", "--port=9999"])

    assert rc == 0
    config = captured["config"]
    assert config.mode == "embedded"
    assert config.port == 9999
