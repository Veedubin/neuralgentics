"""Backend bring-up via ``docker compose`` / ``podman-compose`` (§5 of the design doc).

This module ONLY ever runs ``up -d`` — it NEVER runs ``down``, ``rm``,
``prune``, ``rmi``, ``volume rm``, ``network rm``, or any other destructive
subcommand. See the Container Deletion Policy in ``neuralgentics/AGENTS.md``
and §5.5 of the init-cli design doc.

Public API:

- :func:`detect_compose_tool` — return ``(tool, compose_file)`` for the best
  available container runtime, or ``None`` if neither docker nor
  podman-compose is on ``$PATH``.
- :func:`run_compose_up` — run ``{tool} compose -f {file} up -d`` (with an
  optional ``--env-file``). Raises :class:`ComposeUpFailed` on non-zero
  exit, :class:`ComposeNotFound` when no tool is available.
- :func:`is_backend_running` — return ``True`` if the
  ``neuralgentics-postgres`` container is up according to ``{tool} ps``.
- :func:`setup_env_file` — copy ``compose.example.env`` to ``.env`` when the
  former exists and the latter does not. Prints a message telling the user
  to edit it and re-run. Does NOT run ``compose up``.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .errors import ComposeNotFound, ComposeUpFailed

__all__ = [
    "detect_compose_tool",
    "is_backend_running",
    "run_compose_up",
    "setup_env_file",
]

#: The container name we look for when checking if the backend is already up.
_BACKEND_CONTAINER = "neuralgentics-postgres"


def detect_compose_tool() -> tuple[str, str] | None:
    """Detect the best available compose tool.

    Returns ``(tool, compose_file)`` where ``tool`` is ``"docker"`` or
    ``"podman-compose"`` and ``compose_file`` is the filename
    (``"docker-compose.yml"`` or ``"podman-compose.yml"``). Returns ``None``
    if neither docker nor podman-compose is on ``$PATH``.

    Detection order (per §5.1): podman wins if BOTH ``podman`` and
    ``podman-compose`` are available; otherwise docker wins if ``docker`` is
    available.
    """
    if shutil.which("podman") is not None and shutil.which("podman-compose") is not None:
        return ("podman-compose", "podman-compose.yml")
    if shutil.which("docker") is not None:
        return ("docker", "docker-compose.yml")
    return None


def run_compose_up(compose_file: Path, env_file: Path | None = None) -> None:
    """Run ``{tool} compose -f {compose_file} up -d``.

    ``tool`` is auto-detected via :func:`detect_compose_tool`. If
    ``env_file`` is provided, it is forwarded as ``--env-file {env_file}``.

    Raises :class:`ComposeNotFound` when no tool is available.
    Raises :class:`ComposeUpFailed` when the command exits non-zero.
    """
    detected = detect_compose_tool()
    if detected is None:
        raise ComposeNotFound("Neither docker nor podman-compose found on PATH.")
    tool, _ = detected

    cmd: list[str] = [tool, "compose", "-f", str(compose_file)]
    if env_file is not None:
        cmd += ["--env-file", str(env_file)]
    cmd.append("up")
    cmd.append("-d")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ComposeUpFailed(
            f"compose up failed (exit {result.returncode}): {result.stderr.strip()}",
        )


def is_backend_running(tool: str) -> bool:
    """Return ``True`` if the ``neuralgentics-postgres`` container is up.

    Runs ``{tool} ps --filter name=neuralgentics-postgres --format '{{.Status}}'``
    and returns ``True`` if any non-empty output is produced. Read-only —
    never starts, stops, or removes anything.
    """
    result = subprocess.run(
        [tool, "ps", "--filter", f"name={_BACKEND_CONTAINER}", "--format", "{{.Status}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def setup_env_file(target: Path) -> None:
    """Copy ``{target}/compose.example.env`` to ``{target}/.env`` if needed.

    Skipped silently when ``compose.example.env`` is absent or ``.env``
    already exists. When the copy is performed, prints a message instructing
    the user to edit the new ``.env`` and re-run ``neuralgentics init
    --with-backend``. Does NOT run ``compose up`` — that is a separate step.
    """
    example = target / "compose.example.env"
    env = target / ".env"
    if not example.is_file() or env.is_file():
        return
    shutil.copy2(example, env)
    print(
        "Created .env from compose.example.env. "
        "Edit it to set your database password and embedding device, "
        "then re-run `neuralgentics init --with-backend`."
    )
