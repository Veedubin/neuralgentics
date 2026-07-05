"""``neuralgentics version`` command (§1.4 of the design doc).

Prints the CLI version, the installed plugin version (from the state file
when present), and — when ``--check-update`` is set — the latest available
release on GitHub.

Public API: :func:`run_version`.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import __version__
from .download import resolve_version
from .state import load_state

__all__ = ["run_version"]

#: GitHub API endpoint for the latest release (§1.4 / §2).
_GITHUB_API = "https://api.github.com"


def run_version(args: argparse.Namespace) -> int:
    """Entry point for ``neuralgentics version``. Always returns 0."""
    json_output = bool(getattr(args, "json", False) or getattr(args, "json_output", False))
    check_update = bool(getattr(args, "check_update", False))

    target_raw = getattr(args, "target", ".")
    target = Path(str(target_raw)).resolve()

    state = load_state(target)
    installed_plugin_version: str | None = None
    install_path: str | None = None
    repo = "Veedubin/neuralgentics"
    installed_at: str | None = None
    if state is not None:
        installed_plugin_version = state.installed_version
        install_path = str(target / ".opencode")
        repo = state.repo
        installed_at = state.installed_at.isoformat() if state.installed_at is not None else None

    latest: str | None = None
    latest_checked_at: str | None = None
    update_message: str | None = None
    if check_update:
        latest, latest_checked_at, update_message = _check_latest(repo, installed_plugin_version)

    if json_output:
        payload = {
            "cli_version": __version__,
            "installed_plugin_version": installed_plugin_version,
            "install_path": install_path,
            "latest_available": latest,
            "latest_checked_at": latest_checked_at,
        }
        print(json.dumps(payload, indent=2))
    else:
        print(f"neuralgentics CLI: {__version__}")
        if installed_plugin_version is not None:
            print(f"Installed plugin: {installed_plugin_version} (at {install_path})")
            if installed_at is not None:
                print(f"Installed at: {installed_at}")
        else:
            print("Installed plugin: (not installed in this directory)")
        if check_update:
            if latest is None:
                print(update_message or "(offline — run `neuralgentics update --dry-run` to check)")
            elif installed_plugin_version is not None and _is_newer(
                latest, installed_plugin_version
            ):
                print(
                    f"Update available: {latest} (you have {installed_plugin_version}). "
                    "Run `neuralgentics update`."
                )
            else:
                print(f"Latest available: {latest}")
    return 0


def _check_latest(repo: str, installed: str | None) -> tuple[str | None, str | None, str | None]:
    """Query GitHub for the latest release tag.

    Returns ``(latest_version, latest_checked_at_iso, update_message)``. On
    any failure, ``latest_version`` is ``None`` and ``update_message``
    explains why.
    """
    url = f"{_GITHUB_API}/repos/{repo}/releases/latest"
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with httpx.Client(follow_redirects=True, timeout=30.0) as client:
            resp = client.get(url, headers=headers)
    except httpx.HTTPError:
        return (None, None, "(offline — run `neuralgentics update --dry-run` to check)")
    if resp.status_code != 200:
        return (None, None, "(offline — run `neuralgentics update --dry-run` to check)")
    try:
        body = resp.json()
    except json.JSONDecodeError:
        return (None, None, "(offline — run `neuralgentics update --dry-run` to check)")
    tag = body.get("tag_name")
    if not isinstance(tag, str):
        return (None, None, "(offline — run `neuralgentics update --dry-run` to check)")
    latest = tag.lstrip("v")
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    _ = installed  # currently unused; kept for future comparison logic.
    _ = resolve_version  # import kept for parity with init/update; not invoked here.
    return (latest, checked_at, None)


def _is_newer(latest: str, current: str) -> bool:
    """Return ``True`` if ``latest`` is a newer semver than ``current``."""
    try:
        latest_parts = tuple(int(p) for p in latest.split("."))
        current_parts = tuple(int(p) for p in current.split("."))
    except (ValueError, TypeError):
        return False
    if len(latest_parts) != 3 or len(current_parts) != 3:
        return False
    return latest_parts > current_parts
