"""Tests for :mod:`neuralgentics.compose`."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from neuralgentics import compose
from neuralgentics.errors import ComposeNotFound, ComposeUpFailed

# ---------------------------------------------------------------------------
# detect_compose_tool
# ---------------------------------------------------------------------------


def test_detect_compose_tool_docker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only docker on PATH → returns (docker, docker-compose.yml)."""

    def fake_which(cmd: str) -> str | None:
        if cmd == "docker":
            return "/usr/bin/docker"
        return None

    monkeypatch.setattr(compose.shutil, "which", fake_which)
    assert compose.detect_compose_tool() == ("docker", "docker-compose.yml")


def test_detect_compose_tool_podman(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both docker and podman available → podman wins."""

    def fake_which(cmd: str) -> str | None:
        return {
            "docker": "/usr/bin/docker",
            "podman": "/usr/bin/podman",
            "podman-compose": "/usr/bin/podman-compose",
        }.get(cmd)

    monkeypatch.setattr(compose.shutil, "which", fake_which)
    assert compose.detect_compose_tool() == ("podman-compose", "podman-compose.yml")


def test_detect_compose_tool_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neither on PATH → returns None."""
    monkeypatch.setattr(compose.shutil, "which", lambda _cmd: None)
    assert compose.detect_compose_tool() is None


# ---------------------------------------------------------------------------
# run_compose_up
# ---------------------------------------------------------------------------


class _FakeCompletedProcess:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_run_compose_up_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services: {}\n", encoding="utf-8")

    monkeypatch.setattr(
        compose.shutil,
        "which",
        lambda cmd: {
            "docker": "/usr/bin/docker",
        }.get(cmd),
    )

    captured: dict[str, Any] = {}

    def fake_run(cmd: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["cmd"] = cmd
        return _FakeCompletedProcess(0, stdout="ok", stderr="")

    monkeypatch.setattr(compose.subprocess, "run", fake_run)
    compose.run_compose_up(compose_file)
    assert "up" in captured["cmd"]
    assert "-d" in captured["cmd"]
    assert str(compose_file) in captured["cmd"]


def test_run_compose_up_with_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    env_file = tmp_path / ".env"
    compose_file.write_text("services: {}\n", encoding="utf-8")
    env_file.write_text("FOO=bar\n", encoding="utf-8")

    monkeypatch.setattr(
        compose.shutil,
        "which",
        lambda cmd: {
            "docker": "/usr/bin/docker",
        }.get(cmd),
    )

    captured: dict[str, Any] = {}

    def fake_run(cmd: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["cmd"] = cmd
        return _FakeCompletedProcess(0)

    monkeypatch.setattr(compose.subprocess, "run", fake_run)
    compose.run_compose_up(compose_file, env_file=env_file)
    assert "--env-file" in captured["cmd"]
    assert str(env_file) in captured["cmd"]


def test_run_compose_up_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    compose_file.write_text("services: {}\n", encoding="utf-8")

    monkeypatch.setattr(
        compose.shutil,
        "which",
        lambda cmd: {
            "docker": "/usr/bin/docker",
        }.get(cmd),
    )

    def fake_run(cmd: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        return _FakeCompletedProcess(1, stderr="boom")

    monkeypatch.setattr(compose.subprocess, "run", fake_run)
    with pytest.raises(ComposeUpFailed):
        compose.run_compose_up(compose_file)


def test_run_compose_up_no_tool(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    compose_file = tmp_path / "docker-compose.yml"
    monkeypatch.setattr(compose.shutil, "which", lambda _cmd: None)
    with pytest.raises(ComposeNotFound):
        compose.run_compose_up(compose_file)


# ---------------------------------------------------------------------------
# is_backend_running
# ---------------------------------------------------------------------------


def test_is_backend_running_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        compose.subprocess,
        "run",
        lambda cmd, **kw: _FakeCompletedProcess(0, stdout="Up 2 hours\n"),
    )
    assert compose.is_backend_running("docker") is True


def test_is_backend_running_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        compose.subprocess,
        "run",
        lambda cmd, **kw: _FakeCompletedProcess(0, stdout=""),
    )
    assert compose.is_backend_running("docker") is False


def test_is_backend_running_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        compose.subprocess,
        "run",
        lambda cmd, **kw: _FakeCompletedProcess(1, stderr="err"),
    )
    assert compose.is_backend_running("docker") is False


# ---------------------------------------------------------------------------
# setup_env_file
# ---------------------------------------------------------------------------


def test_setup_env_file_creates(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    example = tmp_path / "compose.example.env"
    example.write_text("NEURALGENTICS_DB_PASSWORD=changeme\n", encoding="utf-8")
    compose.setup_env_file(tmp_path)
    env = tmp_path / ".env"
    assert env.is_file()
    assert env.read_text(encoding="utf-8") == "NEURALGENTICS_DB_PASSWORD=changeme\n"
    out = capsys.readouterr().out
    assert "Created .env" in out


def test_setup_env_file_skips_if_exists(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    example = tmp_path / "compose.example.env"
    example.write_text("A=1\n", encoding="utf-8")
    env = tmp_path / ".env"
    env.write_text("USER_CONTENT\n", encoding="utf-8")
    compose.setup_env_file(tmp_path)
    # .env must NOT be overwritten.
    assert env.read_text(encoding="utf-8") == "USER_CONTENT\n"
    assert capsys.readouterr().out == ""


def test_setup_env_file_no_example(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    compose.setup_env_file(tmp_path)
    assert not (tmp_path / ".env").exists()
    assert capsys.readouterr().out == ""


# Sanity: compose module never exposes destructive helpers.
def test_compose_has_no_destructive_helpers() -> None:
    for forbidden in ("down", "rm", "prune", "rmi", "stop"):
        assert not hasattr(compose, forbidden), f"compose module must not expose {forbidden!r}"
    _ = subprocess  # noqa: F841 — imported for parity; ensure stdlib reachable.
