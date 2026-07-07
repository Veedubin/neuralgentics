"""Tests for :mod:`neuralgentics.cli` — the ``main`` entry point.

These tests cover the single-flag CLI dispatch logic that was previously
untested (which is why the broken ``NotImplementedError`` stubs shipped in
v0.1.0). The real init work is mocked via ``monkeypatch`` so no network or
disk I/O happens here — the dispatch surface is what's under test.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from neuralgentics import __version__, cli, init_cmd
from neuralgentics import download as dl
from neuralgentics.errors import NeuralgenticsError
from neuralgentics.init_cmd import run_init

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capture_run_init(
    monkeypatch: pytest.MonkeyPatch,
    *,
    return_code: int = 0,
    raise_error: NeuralgenticsError | None = None,
) -> list[argparse.Namespace]:
    """Replace ``init_cmd.run_init`` with a recorder.

    Returns the list of Namespace objects it was called with. When
    ``raise_error`` is set, the fake raises that error instead of returning.
    """
    calls: list[argparse.Namespace] = []

    def fake_run_init(args: argparse.Namespace) -> int:
        calls.append(args)
        if raise_error is not None:
            raise raise_error
        return return_code

    monkeypatch.setattr(cli, "run_init", fake_run_init)
    # Also patch the name imported into cli's namespace.
    monkeypatch.setattr(run_init, "__wrapped__", fake_run_init, raising=False)
    return calls


def _make_error(exit_code: int = 7) -> NeuralgenticsError:
    """Build a concrete NeuralgenticsError for error-passthrough tests."""
    err = NeuralgenticsError("boom", remediation="try harder")
    err.exit_code = exit_code
    return err


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCliMainInit:
    """Cover the ``main`` entry point's dispatch behaviour."""

    def test_init_flag_dispatches(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        calls = _capture_run_init(monkeypatch, return_code=0)
        rc = cli.main(["--init", "--dry-run"])
        assert rc == 0
        assert len(calls) == 1
        ns = calls[0]
        assert ns.init is True
        assert ns.dry_run is True

    def test_init_flag_returns_run_init_code(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _capture_run_init(monkeypatch, return_code=3)
        rc = cli.main(["--init"])
        assert rc == 3

    def test_positional_init_alias_dispatches(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        calls = _capture_run_init(monkeypatch, return_code=0)
        rc = cli.main(["init", "--dry-run"])
        assert rc == 0
        assert len(calls) == 1
        assert calls[0].init is True
        assert calls[0].dry_run is True

    def test_no_args_prints_help_exits_zero(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # No dispatch should happen.
        calls = _capture_run_init(monkeypatch)
        rc = cli.main([])
        assert rc == 0
        assert calls == []
        out = capsys.readouterr().out
        assert "usage" in out.lower()

    def test_bare_version_prints_cli_version(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        calls = _capture_run_init(monkeypatch)
        rc = cli.main(["--version"])
        assert rc == 0
        assert calls == []
        out = capsys.readouterr().out
        assert out.strip() == f"neuralgentics {__version__}"

    def test_version_with_arg_is_passed_through(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # ``--version 0.9.1`` is the plugin version, not the CLI version.
        calls = _capture_run_init(monkeypatch, return_code=0)
        rc = cli.main(["--init", "--version", "0.9.1"])
        assert rc == 0
        assert len(calls) == 1
        assert calls[0].version == "0.9.1"

    def test_error_is_caught_and_returned(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        err = _make_error(exit_code=14)
        _capture_run_init(monkeypatch, raise_error=err)
        rc = cli.main(["--init"])
        assert rc == 14
        captured = capsys.readouterr()
        assert "boom" in captured.err
        assert "try harder" in captured.err

    def test_keyboard_interrupt_exits_130(
        self,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        def raising_run_init(args: argparse.Namespace) -> int:
            raise KeyboardInterrupt

        monkeypatch.setattr(cli, "run_init", raising_run_init)
        rc = cli.main(["--init"])
        assert rc == 130
        assert "Interrupted" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Sanity: the parser itself is well-formed (no dispatch).
# ---------------------------------------------------------------------------


def test_parser_accepts_all_pass_through_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All pass-through flags parse without error and land on the Namespace."""
    calls = _capture_run_init(monkeypatch)
    cli.main(
        [
            "--init",
            "--version",
            "0.9.1",
            "--target",
            "/tmp/opencode/coder-test",
            "--force",
            "--dry-run",
            "--yes",
            "--repo",
            "Veedubin/neuralgentics",
            "--offline",
        ]
    )
    assert len(calls) == 1
    ns = calls[0]
    assert ns.version == "0.9.1"
    assert ns.target == "/tmp/opencode/coder-test"
    assert ns.force is True
    assert ns.dry_run is True
    assert ns.yes is True
    assert ns.repo == "Veedubin/neuralgentics"
    assert ns.offline is True


def test_cli_init_creates_missing_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """`neuralgentics --init --target /new/path --yes` works and creates the path.

    End-to-end at the cli.main level: the real run_init runs, but with all
    network/npm/PATH calls mocked so it stays hermetic.
    """
    target = tmp_path / "brand-new" / "project"
    # Build a tarball to serve.
    files = {
        ".opencode/agents/coder.md": b"# coder\n",
        ".opencode/opencode.json": json.dumps(
            {"plugin": ["@veedubin/neuralgentics"], "instructions": ["AGENTS.md"]}
        ).encode(),
        ".opencode/package.json": json.dumps(
            {"dependencies": {"@veedubin/neuralgentics": "^0.9.1"}}
        ).encode(),
    }
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    top = "neuralgentics-0.9.1"
    with tarfile.open(tarball, "w:gz") as tar:
        di = tarfile.TarInfo(name=top)
        di.type = tarfile.DIRTYPE
        di.mode = 0o755
        tar.addfile(di)
        for rel, data in files.items():
            info = tarfile.TarInfo(name=f"{top}/{rel}")
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    sha = hashlib.sha256(tarball.read_bytes()).hexdigest()
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{sha}  {tarball.name}\n", encoding="utf-8")

    def fake_download(version, repo, *, github_token=None):
        return (tarball, checksums)

    def fake_resolve(v, r, *, github_token=None):
        return "0.9.1"

    monkeypatch.setattr(dl, "download_tarball", fake_download)
    monkeypatch.setattr(init_cmd, "download_tarball", fake_download)
    monkeypatch.setattr(dl, "resolve_version", fake_resolve)
    monkeypatch.setattr(init_cmd, "resolve_version", fake_resolve)

    def fake_which(cmd):
        return "/usr/bin/" + cmd

    monkeypatch.setattr(init_cmd.shutil, "which", fake_which)

    class _Ok:
        returncode = 0
        stderr = ""

    monkeypatch.setattr(init_cmd.subprocess, "run", lambda *a, **k: _Ok())

    rc = cli.main(["--init", "--target", str(target), "--yes", "--version", "0.9.1"])
    assert rc == 0
    assert target.is_dir()
    assert (target / ".opencode" / "opencode.json").is_file()
