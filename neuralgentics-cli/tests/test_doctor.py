"""Tests for :mod:`neuralgentics.doctor_cmd` (``neuralgentics doctor``)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pytest

from neuralgentics import doctor_cmd
from neuralgentics.state import BackendRecord, FileRecord, StateFile, save_state


def _ns(**kw: Any) -> argparse.Namespace:
    defaults = {"target": ".", "json": False, "json_output": False}
    defaults.update(kw)
    return argparse.Namespace(**defaults)


def _setup_full_installation(target: Path) -> None:
    """Create a complete fake neuralgentics installation under ``target``."""
    oc = target / ".opencode"
    (oc / "agents").mkdir(parents=True)
    (oc / "agents" / "coder.md").write_text("# coder\n", encoding="utf-8")
    (oc / "skills").mkdir(parents=True)
    (oc / "skills" / "boomerang-orchestrator").mkdir()
    (oc / "skills" / "boomerang-orchestrator" / "SKILL.md").write_text("# x\n", encoding="utf-8")
    (oc / "AGENTS.md").write_text("# AGENTS\n", encoding="utf-8")
    (oc / "node_modules" / "@veedubin" / "neuralgentics").mkdir(parents=True)
    (oc / "node_modules" / "@veedubin" / "neuralgentics" / "package.json").write_text(
        "{}", encoding="utf-8"
    )
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["@veedubin/neuralgentics"],
        "instructions": ["AGENTS.md"],
        "provider": {"ollama": {"name": "Local"}},
    }
    (oc / "opencode.json").write_text(json.dumps(cfg), encoding="utf-8")
    # State file
    state = StateFile(
        installed_version="0.9.1",
        installed_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        updated_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(target),
        files={".opencode/agents/coder.md": FileRecord(sha256="x", installed_from="0.9.1")},
    )
    save_state(target, state)


def _patch_opencode_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch shutil.which so opencode + npm are on PATH."""
    orig = doctor_cmd.shutil.which

    def fake_which(cmd: str) -> str | None:
        if cmd == "opencode":
            return "/usr/local/bin/opencode"
        if cmd == "npm":
            return "/usr/bin/npm"
        return orig(cmd)

    monkeypatch.setattr(doctor_cmd.shutil, "which", fake_which)


def _patch_no_opencode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor_cmd.shutil, "which", lambda _cmd: None)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_doctor_all_green(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 0


def test_doctor_opencode_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_no_opencode(monkeypatch)

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 2  # opencode_on_path is ERROR severity


def test_doctor_plugin_missing_from_opencode_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)
    # Rewrite opencode.json WITHOUT the plugin.
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["some-other-plugin"],
        "instructions": ["AGENTS.md"],
    }
    (target / ".opencode" / "opencode.json").write_text(json.dumps(cfg), encoding="utf-8")

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 2


def test_doctor_invalid_opencode_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)
    (target / ".opencode" / "opencode.json").write_text("{ this is not json", encoding="utf-8")

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 2


def test_doctor_json_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)

    rc = doctor_cmd.run_doctor(_ns(target=target, json=True))
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert "status" in payload
    assert payload["status"] == "ok"
    assert isinstance(payload["checks"], list)
    assert len(payload["checks"]) > 0
    names = {c["name"] for c in payload["checks"]}
    assert "opencode_on_path" in names
    for c in payload["checks"]:
        assert set(c.keys()) == {"name", "status", "message"}
        assert c["status"] in ("ok", "warning", "error")


def test_doctor_state_file_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)
    (target / ".opencode" / ".neuralgentics-state.json").unlink()

    rc = doctor_cmd.run_doctor(_ns(target=target))
    # Missing state file is WARNING, not ERROR → exit 1.
    assert rc == 1


def test_doctor_state_file_corrupted(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)
    (target / ".opencode" / ".neuralgentics-state.json").write_text(
        "not json {{{", encoding="utf-8"
    )

    rc = doctor_cmd.run_doctor(_ns(target=target))
    # Corrupted state file is WARNING → exit 1.
    assert rc == 1


def test_doctor_no_dot_opencode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _patch_opencode_on_path(monkeypatch)
    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 2


def test_doctor_with_backend_in_state_runs_backend_checks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)
    # Rewrite state with backend enabled.
    state = StateFile(
        installed_version="0.9.1",
        installed_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        updated_at="2026-07-04T12:00:00+00:00",  # type: ignore[arg-type]
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(target),
        files={".opencode/agents/coder.md": FileRecord(sha256="x", installed_from="0.9.1")},
        backend=BackendRecord(
            enabled=True,
            compose_file="docker-compose.yml",
            compose_tool="docker",
            containers=["neuralgentics-postgres"],
        ),
    )
    save_state(target, state)
    # Mock socket to make backend_reachable pass.

    class _FakeSocket:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> _FakeSocket:
            return self

        def __exit__(self, *a: Any) -> None:
            pass

    monkeypatch.setattr(doctor_cmd.socket, "create_connection", _FakeSocket)

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 0


def test_doctor_text_output_includes_summary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "project"
    target.mkdir()
    _setup_full_installation(target)
    _patch_opencode_on_path(monkeypatch)

    rc = doctor_cmd.run_doctor(_ns(target=target))
    assert rc == 0
    out = capsys.readouterr().out
    assert "checks passed" in out
