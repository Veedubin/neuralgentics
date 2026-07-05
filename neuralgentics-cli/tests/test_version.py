"""Tests for :mod:`neuralgentics.version_cmd` (``neuralgentics version``)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pytest

from neuralgentics import version_cmd
from neuralgentics.state import FileRecord, StateFile, save_state


def _ns(**kw: Any) -> argparse.Namespace:
    defaults = {
        "target": ".",
        "json": False,
        "json_output": False,
        "check_update": False,
    }
    defaults.update(kw)
    return argparse.Namespace(**defaults)


def _write_state(target: Path, *, installed_version: str = "0.9.1") -> None:
    state = StateFile(
        installed_version=installed_version,
        installed_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        updated_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(target),
        files={
            ".opencode/agents/coder.md": FileRecord(sha256="x", installed_from=installed_version)
        },
    )
    save_state(target, state)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_version_prints_cli_version(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    target = tmp_path / "project"
    target.mkdir()
    rc = version_cmd.run_version(_ns(target=target))
    assert rc == 0
    out = capsys.readouterr().out
    assert "neuralgentics CLI:" in out
    from neuralgentics import __version__

    assert __version__ in out


def test_version_prints_installed_version(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _write_state(target, installed_version="0.9.1")
    rc = version_cmd.run_version(_ns(target=target))
    assert rc == 0
    out = capsys.readouterr().out
    assert "0.9.1" in out
    assert "Installed plugin" in out


def test_version_no_state_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    target = tmp_path / "project"
    target.mkdir()
    rc = version_cmd.run_version(_ns(target=target))
    assert rc == 0
    out = capsys.readouterr().out
    assert "not installed" in out


def test_version_check_update_available(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _write_state(target, installed_version="0.9.1")

    # Mock httpx.Client to return a newer version.
    class _FakeResp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"tag_name": "v0.9.2"}

    class _FakeClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> _FakeClient:
            return self

        def __exit__(self, *a: Any) -> None:
            pass

        def get(self, url: str, headers: Any = None) -> _FakeResp:
            return _FakeResp()

    monkeypatch.setattr(version_cmd.httpx, "Client", _FakeClient)

    rc = version_cmd.run_version(_ns(target=target, check_update=True))
    assert rc == 0
    out = capsys.readouterr().out
    assert "Update available" in out
    assert "0.9.2" in out


def test_version_check_update_not_available(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _write_state(target, installed_version="0.9.2")

    class _FakeResp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"tag_name": "v0.9.2"}

    class _FakeClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> _FakeClient:
            return self

        def __exit__(self, *a: Any) -> None:
            pass

        def get(self, url: str, headers: Any = None) -> _FakeResp:
            return _FakeResp()

    monkeypatch.setattr(version_cmd.httpx, "Client", _FakeClient)

    rc = version_cmd.run_version(_ns(target=target, check_update=True))
    assert rc == 0
    out = capsys.readouterr().out
    assert "Update available" not in out
    assert "Latest available: 0.9.2" in out


def test_version_check_update_offline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _write_state(target, installed_version="0.9.1")

    class _BoomClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            raise version_cmd.httpx.HTTPError("no network")

    monkeypatch.setattr(version_cmd.httpx, "Client", _BoomClient)

    rc = version_cmd.run_version(_ns(target=target, check_update=True))
    assert rc == 0
    out = capsys.readouterr().out
    assert "offline" in out


def test_version_json_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _write_state(target, installed_version="0.9.1")

    rc = version_cmd.run_version(_ns(target=target, json=True))
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert "cli_version" in payload
    assert payload["installed_plugin_version"] == "0.9.1"
    assert payload["install_path"] is not None
    assert payload["latest_available"] is None  # check_update not set


def test_version_is_newer_helper() -> None:
    assert version_cmd._is_newer("0.9.2", "0.9.1") is True
    assert version_cmd._is_newer("0.9.1", "0.9.1") is False
    assert version_cmd._is_newer("0.9.0", "0.9.1") is False
    assert version_cmd._is_newer("notaversion", "0.9.1") is False
