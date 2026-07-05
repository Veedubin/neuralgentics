"""``neuralgentics doctor`` command (§1.3 of the design doc).

Diagnoses the current project's neuralgentics installation by running a
series of checks and printing a plain-text or JSON report.

Exit codes:
  * ``0`` — all checks pass (only INFO-level findings at worst).
  * ``1`` — one or more WARNING-level findings, no ERROR-level findings.
  * ``2`` — one or more ERROR-level findings.

Public API: :func:`run_doctor`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from . import __version__
from .merge import PLUGIN_REFERENCE
from .state import StateFile, load_state

__all__ = ["run_doctor"]

CheckStatus = Literal["ok", "warning", "error"]


@dataclass
class CheckResult:
    """One doctor check result."""

    name: str
    status: CheckStatus
    message: str


def run_doctor(args: argparse.Namespace) -> int:
    """Entry point for ``neuralgentics doctor``. Returns the process exit code."""
    target_raw = getattr(args, "target", ".")
    target = Path(str(target_raw)).resolve()
    json_output = bool(getattr(args, "json", False) or getattr(args, "json_output", False))

    results = _run_all_checks(target)

    if json_output:
        overall = _overall_status(results)
        payload = {
            "status": overall,
            "checks": [asdict(r) for r in results],
        }
        print(json.dumps(payload, indent=2))
    else:
        _print_text_report(results)

    has_error = any(r.status == "error" for r in results)
    has_warning = any(r.status == "warning" for r in results)
    if has_error:
        return 2
    if has_warning:
        return 1
    return 0


# ---------------------------------------------------------------------------
# Check runner
# ---------------------------------------------------------------------------


def _run_all_checks(target: Path) -> list[CheckResult]:
    """Run every doctor check in order, returning the result list."""
    results: list[CheckResult] = []

    results.append(_check_opencode_on_path())
    results.append(_check_dot_opencode_exists(target))
    results.append(_check_opencode_json_valid(target))
    results.append(_check_plugin_in_opencode_json(target))
    results.append(_check_instructions_includes_agents_md(target))

    state = load_state(target)
    results.append(_check_state_file_present(target))
    results.append(_check_state_file_valid(target, state))

    results.append(_check_agents_md_exists(target))
    results.append(_check_agents_directory_populated(target))
    results.append(_check_skills_directory_populated(target))
    results.append(_check_node_modules_installed(target))
    results.append(_check_npm_on_path())

    if state is not None and state.backend is not None and state.backend.enabled:
        results.append(_check_docker_or_podman_available())
        port = 6000
        # Best-effort port extraction; backend record has no port field, so we
        # use the documented default of 6000.
        results.append(_check_backend_reachable(port))
        results.append(_check_installed_version(state))
    else:
        # Still emit an installed-version info line when a state file exists.
        if state is not None:
            results.append(_check_installed_version(state))

    return results


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------


def _check_opencode_on_path() -> CheckResult:
    found = shutil.which("opencode")
    if found:
        return CheckResult("opencode_on_path", "ok", f"opencode found at {found}")
    return CheckResult(
        "opencode_on_path",
        "error",
        "opencode is not on PATH. Install it: curl -fsSL https://opencode.ai/install.sh | bash",
    )


def _check_dot_opencode_exists(target: Path) -> CheckResult:
    dot = target / ".opencode"
    if dot.is_dir():
        return CheckResult("dot_opencode_exists", "ok", f"{dot} exists")
    return CheckResult(
        "dot_opencode_exists",
        "error",
        f"{dot} does not exist. Run `neuralgentics init` first.",
    )


def _check_opencode_json_valid(target: Path) -> CheckResult:
    path = target / ".opencode" / "opencode.json"
    if not path.is_file():
        return CheckResult(
            "opencode_json_valid",
            "error",
            f"{path} does not exist.",
        )
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return CheckResult(
            "opencode_json_valid",
            "error",
            f"{path} is not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})",
        )
    return CheckResult("opencode_json_valid", "ok", f"{path} is valid JSON")


def _check_plugin_in_opencode_json(target: Path) -> CheckResult:
    path = target / ".opencode" / "opencode.json"
    if not path.is_file():
        return CheckResult(
            "plugin_in_opencode_json",
            "error",
            f"{path} does not exist — cannot check plugin array.",
        )
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return CheckResult(
            "plugin_in_opencode_json",
            "error",
            f"{path} is not valid JSON — cannot check plugin array.",
        )
    plugins = cfg.get("plugin") if isinstance(cfg, dict) else None
    if not isinstance(plugins, list):
        return CheckResult(
            "plugin_in_opencode_json",
            "error",
            "opencode.json has no 'plugin' array.",
        )
    if PLUGIN_REFERENCE in plugins:
        return CheckResult(
            "plugin_in_opencode_json",
            "ok",
            f"{PLUGIN_REFERENCE} present in plugin array",
        )
    return CheckResult(
        "plugin_in_opencode_json",
        "error",
        f"{PLUGIN_REFERENCE} not found in plugin array",
    )


def _check_instructions_includes_agents_md(target: Path) -> CheckResult:
    path = target / ".opencode" / "opencode.json"
    if not path.is_file():
        return CheckResult(
            "instructions_includes_agents_md",
            "error",
            f"{path} does not exist — cannot check instructions array.",
        )
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return CheckResult(
            "instructions_includes_agents_md",
            "error",
            f"{path} is not valid JSON — cannot check instructions array.",
        )
    instructions = cfg.get("instructions") if isinstance(cfg, dict) else None
    if not isinstance(instructions, list):
        return CheckResult(
            "instructions_includes_agents_md",
            "error",
            "opencode.json has no 'instructions' array.",
        )
    if "AGENTS.md" in instructions:
        return CheckResult(
            "instructions_includes_agents_md",
            "ok",
            "AGENTS.md present in instructions array",
        )
    return CheckResult(
        "instructions_includes_agents_md",
        "error",
        "AGENTS.md not found in instructions array",
    )


def _check_state_file_present(target: Path) -> CheckResult:
    path = target / ".opencode" / ".neuralgentics-state.json"
    if path.is_file():
        return CheckResult("state_file_present", "ok", f"{path} exists")
    return CheckResult(
        "state_file_present",
        "warning",
        f"{path} does not exist (may be a manual install).",
    )


def _check_state_file_valid(target: Path, state: StateFile | None) -> CheckResult:
    path = target / ".opencode" / ".neuralgentics-state.json"
    if not path.is_file():
        return CheckResult(
            "state_file_valid",
            "warning",
            f"{path} does not exist.",
        )
    if state is None:
        return CheckResult(
            "state_file_valid",
            "warning",
            f"{path} is present but could not be parsed (corrupted or wrong schema).",
        )
    return CheckResult("state_file_valid", "ok", "state file parses correctly")


def _check_agents_md_exists(target: Path) -> CheckResult:
    path = target / ".opencode" / "AGENTS.md"
    if path.is_file():
        return CheckResult("agents_md_exists", "ok", f"{path} exists")
    return CheckResult(
        "agents_md_exists",
        "error",
        f"{path} does not exist.",
    )


def _check_agents_directory_populated(target: Path) -> CheckResult:
    agents_dir = target / ".opencode" / "agents"
    if not agents_dir.is_dir():
        return CheckResult(
            "agents_directory_populated",
            "error",
            f"{agents_dir} does not exist.",
        )
    count = sum(1 for p in agents_dir.iterdir() if p.is_file())
    if count >= 1:
        return CheckResult(
            "agents_directory_populated",
            "ok",
            f"{count} agent file(s) in {agents_dir}",
        )
    return CheckResult(
        "agents_directory_populated",
        "error",
        f"{agents_dir} is empty.",
    )


def _check_skills_directory_populated(target: Path) -> CheckResult:
    skills_dir = target / ".opencode" / "skills"
    if not skills_dir.is_dir():
        return CheckResult(
            "skills_directory_populated",
            "error",
            f"{skills_dir} does not exist.",
        )
    count = sum(1 for p in skills_dir.iterdir() if p.is_dir())
    if count >= 1:
        return CheckResult(
            "skills_directory_populated",
            "ok",
            f"{count} skill directory(ies) in {skills_dir}",
        )
    return CheckResult(
        "skills_directory_populated",
        "error",
        f"{skills_dir} has no skill subdirectories.",
    )


def _check_node_modules_installed(target: Path) -> CheckResult:
    path = target / ".opencode" / "node_modules" / "@veedubin" / "neuralgentics"
    if path.is_dir():
        return CheckResult(
            "node_modules_installed",
            "ok",
            f"{path} exists",
        )
    return CheckResult(
        "node_modules_installed",
        "error",
        f"{path} does not exist (run `npm install` in .opencode/).",
    )


def _check_npm_on_path() -> CheckResult:
    if shutil.which("npm") is not None:
        return CheckResult("npm_on_path", "ok", "npm found on PATH")
    return CheckResult(
        "npm_on_path",
        "warning",
        "npm is not on PATH. Install Node.js 20+ from https://nodejs.org/.",
    )


def _check_docker_or_podman_available() -> CheckResult:
    if shutil.which("docker") is not None or (
        shutil.which("podman") is not None and shutil.which("podman-compose") is not None
    ):
        return CheckResult(
            "docker_or_podman_available",
            "ok",
            "docker or podman-compose is on PATH",
        )
    return CheckResult(
        "docker_or_podman_available",
        "warning",
        "Neither docker nor podman-compose is on PATH (needed for --with-backend).",
    )


def _check_backend_reachable(port: int) -> CheckResult:
    try:
        with socket.create_connection(("localhost", port), timeout=2.0):
            return CheckResult(
                "backend_reachable",
                "ok",
                f"backend reachable on localhost:{port}",
            )
    except OSError as exc:
        return CheckResult(
            "backend_reachable",
            "warning",
            f"backend not reachable on localhost:{port}: {exc}",
        )


def _check_installed_version(state: StateFile) -> CheckResult:
    return CheckResult(
        "installed_version",
        "ok",
        f"installed plugin version: {state.installed_version}",
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _overall_status(results: list[CheckResult]) -> CheckStatus:
    if any(r.status == "error" for r in results):
        return "error"
    if any(r.status == "warning" for r in results):
        return "warning"
    return "ok"


def _should_use_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _print_text_report(results: list[CheckResult]) -> None:
    use_color = _should_use_color()
    name_width = max(len(r.name) for r in results) if results else 10
    status_width = 7
    print(f"{'CHECK':<{name_width}}  {'STATUS':<{status_width}}  MESSAGE")
    print(f"{'-' * name_width}  {'-' * status_width}  {'-' * 7}")
    for r in results:
        status_str = r.status.upper()
        if use_color:
            if r.status == "ok":
                status_str = f"\033[32m{status_str}\033[0m"
            elif r.status == "warning":
                status_str = f"\033[33m{status_str}\033[0m"
            elif r.status == "error":
                status_str = f"\033[31m{status_str}\033[0m"
        print(f"{r.name:<{name_width}}  {status_str:<{status_width}}  {r.message}")
    print()
    passed = sum(1 for r in results if r.status == "ok")
    warnings = sum(1 for r in results if r.status == "warning")
    errors = sum(1 for r in results if r.status == "error")
    print(f"{passed} checks passed, {warnings} warnings, {errors} errors")
    # Supress unused-warning for __version__ import (kept for diagnostics).
    _ = __version__
