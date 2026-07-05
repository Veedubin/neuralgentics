"""Tests for :mod:`neuralgentics.update_cmd` (``neuralgentics update``).

All network + npm calls are mocked via ``monkeypatch``. The mocking
pattern mirrors :mod:`tests.test_init`:
  - ``_patch_download`` returns a prebuilt tarball + matching checksums.
  - ``_patch_resolve_version`` returns the requested version literally.
  - ``_patch_npm`` patches ``init_cmd.subprocess.run`` + ``init_cmd.shutil.which``.
  - Pre-existing installations are seeded via :func:`save_state`.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from neuralgentics import download as dl
from neuralgentics import init_cmd, update_cmd
from neuralgentics.state import FileRecord, StateFile, save_state

REPO = "Veedubin/neuralgentics"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ns(**kw: Any) -> argparse.Namespace:
    """Build an argparse.Namespace with update defaults, overridden by ``kw``."""
    defaults = {
        "version": "latest",
        "target": Path.cwd(),
        "force": False,
        "yes": False,
        "dry_run": False,
        "repo": REPO,
    }
    defaults.update(kw)
    return argparse.Namespace(**defaults)


def _build_tarball(
    tmp_path: Path,
    *,
    version: str,
    files: dict[str, bytes],
) -> tuple[Path, Path]:
    """Build a tarball + matching checksums.txt under ``tmp_path``.

    Returns ``(tarball_path, checksums_path)``.
    """
    tarball = tmp_path / f"neuralgentics-{version}.tar.gz"
    top = f"neuralgentics-{version}"
    with tarfile.open(tarball, "w:gz") as tar:
        dir_info = tarfile.TarInfo(name=top)
        dir_info.type = tarfile.DIRTYPE
        dir_info.mode = 0o755
        tar.addfile(dir_info)
        for rel, data in files.items():
            info = tarfile.TarInfo(name=f"{top}/{rel}")
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    sha = hashlib.sha256(tarball.read_bytes()).hexdigest()
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{sha}  {tarball.name}\n", encoding="utf-8")
    return tarball, checksums


def _patch_download(
    monkeypatch: pytest.MonkeyPatch,
    *,
    tarball: Path,
    checksums: Path,
) -> None:
    """Patch ``download_tarball`` to return prebuilt files."""

    def fake_download(version: str, repo: str, *, github_token: str | None = None):
        return (tarball, checksums)

    monkeypatch.setattr(dl, "download_tarball", fake_download)
    monkeypatch.setattr(update_cmd, "download_tarball", fake_download)


def _patch_resolve_version(
    monkeypatch: pytest.MonkeyPatch,
    *,
    version: str,
) -> None:
    """Patch ``resolve_version`` to return a fixed version (no network)."""

    def fake_resolve(v: str, r: str, *, github_token: str | None = None) -> str:
        return version

    monkeypatch.setattr(dl, "resolve_version", fake_resolve)
    monkeypatch.setattr(update_cmd, "resolve_version", fake_resolve)


def _patch_npm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch ``npm`` to be on PATH and ``npm install`` to succeed.

    The update path calls :func:`init_cmd._run_npm_install`, which reads
    ``init_cmd.shutil.which`` and ``init_cmd.subprocess.run`` — both must
    be patched.
    """
    monkeypatch.setattr(init_cmd.shutil, "which", lambda _cmd: "/usr/bin/npm")

    class _FakeCompletedProcess:
        returncode = 0
        stderr = ""

    def fake_run(*args: Any, **kwargs: Any) -> _FakeCompletedProcess:
        return _FakeCompletedProcess()

    monkeypatch.setattr(init_cmd.subprocess, "run", fake_run)


def _default_tarball_files(version: str = "0.9.2") -> dict[str, bytes]:
    """Files shipped by the new-version tarball used in update tests."""
    return {
        ".opencode/agents/coder.md": b"# coder agent (v" + version.encode() + b")\n",
        ".opencode/agents/architect.md": b"# architect agent\n",
        ".opencode/skills/boomerang-orchestrator/SKILL.md": b"# orchestrator skill\n",
        ".opencode/skills/kanban-board-manager/SKILL.md": b"# kanban skill\n",
        ".opencode/opencode.json": json.dumps(
            {
                "$schema": "https://opencode.ai/config.json",
                "plugin": ["@veedubin/neuralgentics"],
                "instructions": ["AGENTS.md"],
                "provider": {"ollama-cloud": {"name": "Ollama Cloud"}},
                "mcp": {"searxng": {"type": "local", "command": ["searxng"]}},
            }
        ).encode(),
        ".opencode/package.json": json.dumps(
            {"dependencies": {"@veedubin/neuralgentics": f"^{version}"}}
        ).encode(),
        ".opencode/AGENTS.md": b"# project AGENTS.md\n",
        "docker-compose.yml": b"services: {}\n",
        "install.sh": b"#!/bin/sh\n",
    }


def _seed_state(
    target: Path,
    *,
    installed_version: str,
    files: dict[str, FileRecord] | None = None,
) -> StateFile:
    """Write a state file at ``target`` describing a prior installation."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    state = StateFile(
        installed_version=installed_version,
        installed_at=now,
        updated_at=now,
        cli_version="0.1.0",
        repo=REPO,
        target=str(target.resolve()),
        files=files or {},
    )
    save_state(target, state)
    return state


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_update_no_state_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Empty target (no prior init): clean error message + return code 1."""
    target = tmp_path / "project"
    target.mkdir()
    _patch_resolve_version(monkeypatch, version="0.9.1")

    rc = update_cmd.run_update(_ns(target=target, version="0.9.1"))
    assert rc == 1
    err = capsys.readouterr().err
    assert "No neuralgentics installation found" in err
    assert "neuralgentics init" in err


def test_update_already_at_version(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """State at 0.9.1, request 0.9.1: return 0 + "Already at version" message."""
    target = tmp_path / "project"
    target.mkdir()
    _seed_state(target, installed_version="0.9.1")
    _patch_resolve_version(monkeypatch, version="0.9.1")

    rc = update_cmd.run_update(_ns(target=target, version="0.9.1"))
    assert rc == 0
    out = capsys.readouterr().out
    assert "Already at version 0.9.1" in out


def test_update_skips_user_modified(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A file marked ``user_modified=True`` is NOT overwritten during update."""
    target = tmp_path / "project"
    (target / ".opencode/agents").mkdir(parents=True)
    user_coder = b"# USER-EDITED coder\n"
    coder_path = target / ".opencode/agents/coder.md"
    coder_path.write_bytes(user_coder)

    user_sha = hashlib.sha256(user_coder).hexdigest()
    shipped_sha = hashlib.sha256(b"# coder agent (v0.9.1)\n").hexdigest()
    files = {
        ".opencode/agents/coder.md": FileRecord(
            sha256=user_sha,
            user_modified=True,
            installed_from="0.9.1",
            last_known_shipped_sha256=shipped_sha,
        ),
    }
    _seed_state(target, installed_version="0.9.1", files=files)

    new_files = _default_tarball_files(version="0.9.2")
    tarball, checksums = _build_tarball(tmp_path, version="0.9.2", files=new_files)
    _patch_download(monkeypatch, tarball=tarball, checksums=checksums)
    _patch_resolve_version(monkeypatch, version="0.9.2")
    _patch_npm(monkeypatch)

    rc = update_cmd.run_update(_ns(target=target, version="0.9.2"))
    assert rc == 0

    # The user-modified file MUST be preserved unchanged.
    assert coder_path.read_bytes() == user_coder
    out = capsys.readouterr().out
    assert "Skipped 1 user-modified" in out


def test_update_force_overwrites_user_modified(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """``--force`` overwrites a file marked ``user_modified=True``."""
    target = tmp_path / "project"
    (target / ".opencode/agents").mkdir(parents=True)
    user_coder = b"# USER-EDITED coder\n"
    coder_path = target / ".opencode/agents/coder.md"
    coder_path.write_bytes(user_coder)

    user_sha = hashlib.sha256(user_coder).hexdigest()
    shipped_sha = hashlib.sha256(b"# coder agent (v0.9.1)\n").hexdigest()
    files = {
        ".opencode/agents/coder.md": FileRecord(
            sha256=user_sha,
            user_modified=True,
            installed_from="0.9.1",
            last_known_shipped_sha256=shipped_sha,
        ),
    }
    _seed_state(target, installed_version="0.9.1", files=files)

    new_version = "0.9.2"
    new_coder = b"# coder agent (v" + new_version.encode() + b")\n"
    new_files = _default_tarball_files(version=new_version)
    tarball, checksums = _build_tarball(tmp_path, version=new_version, files=new_files)
    _patch_download(monkeypatch, tarball=tarball, checksums=checksums)
    _patch_resolve_version(monkeypatch, version=new_version)
    _patch_npm(monkeypatch)

    rc = update_cmd.run_update(_ns(target=target, version=new_version, force=True))
    assert rc == 0

    # The user-modified file is overwritten with the shipped content.
    assert coder_path.read_bytes() == new_coder


def test_update_version_downgrade_blocked(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """State at 0.9.1, request 0.9.0 without --force: error + return 1."""
    target = tmp_path / "project"
    target.mkdir()
    _seed_state(target, installed_version="0.9.1")
    _patch_resolve_version(monkeypatch, version="0.9.0")

    rc = update_cmd.run_update(_ns(target=target, version="0.9.0"))
    assert rc == 1
    err = capsys.readouterr().err
    assert "Refusing to downgrade" in err
    assert "0.9.1" in err
    assert "0.9.0" in err
    assert "--force" in err
