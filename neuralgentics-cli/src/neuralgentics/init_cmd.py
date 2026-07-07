"""``neuralgentics init`` command (§1.1 of the design doc).

Bootstraps a project directory with the neuralgentics OpenCode plugin by:
  1. Resolving the requested plugin version (``latest`` or ``X.Y.Z``).
  2. Downloading + verifying the GitHub release tarball.
  3. Extracting + placing files per the §1.1 file-placement table.
  4. Merging ``opencode.json`` (preserves user's provider/mcp/lsp/formatter).
  5. Running ``npm install --no-audit --no-fund`` in ``.opencode/``.
  6. Writing the state file (§3) with the file manifest.
  7. Printing a plain-text success summary.

Public API: :func:`run_init`.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .download import (
    download_tarball,
    extract_tarball,
    resolve_version,
    verify_sha256,
)
from .errors import (
    NpmInstallFailed,
    NpmNotFound,
    OfflineNoBundle,
    OpencodeNotFound,
    TargetNotDirectory,
)
from .merge import (
    merge_opencode_json_with_diff,
    parse_opencode_json,
    serialize_opencode_json,
)
from .state import FileRecord, StateFile, compute_file_sha256, save_state

__all__ = ["run_init"]

log = logging.getLogger(__name__)

#: Plugin entry added to the ``plugin`` array (kept in sync with merge.py).
_PLUGIN_REFERENCE = "@veedubin/neuralgentics"

#: Regex for a valid ``X.Y.Z`` semver.
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")

#: Top-level files that are copied only if they don't already exist.
_COPY_IF_ABSENT: tuple[str, ...] = (
    "docker-compose.yml",
    "podman-compose.yml",
    "compose.example.env",
    "install.sh",
)

#: Top-level directory prefixes that are copied recursively (overwriting).
_COPY_TREE_PREFIXES: tuple[str, ...] = (
    ".opencode/agents/",
    ".opencode/skills/",
    "docker/",
    "node_modules/@veedubin/neuralgentics/",
)

#: Files that are merged (not copied) when they already exist.
_MERGE_FILES: tuple[str, ...] = (
    ".opencode/opencode.json",
    ".opencode/package.json",
)

#: Files that are copied only if absent (warn + skip if present).
_COPY_IF_ABSENT_WARN: tuple[str, ...] = (
    ".opencode/AGENTS.md",
    ".opencode/.gitignore",
    ".opencode/package-lock.json",
)


def run_init(args: argparse.Namespace) -> int:
    """Entry point for ``neuralgentics init``. Returns the process exit code."""
    target = _coerce_target(args.target)
    version = _resolve_version(args)
    dry_run = bool(getattr(args, "dry_run", False))

    # 1. Validate target is a directory.
    if not target.is_dir():
        raise TargetNotDirectory(f"{target} is not a directory.")

    # 2. Check opencode is on PATH.
    if shutil.which("opencode") is None:
        raise OpencodeNotFound(
            "opencode is not installed or not on PATH.",
        )

    # 3. Version already resolved above; validate it's X.Y.Z.
    if not _SEMVER_RE.match(version):
        raise ValueError(f"Resolved version {version!r} is not X.Y.Z.")  # noqa: TRY004

    if dry_run:
        # Dry-run: validate only, do not download or write anything.
        _print_dry_run_summary(target, version, args.repo)
        return 0

    # 4-5. Download + verify + extract.
    extract_dir = _download_and_extract(version, args.repo)

    # 5. Place files per the §1.1 table.
    manifest = _place_files(extract_dir, target, version, force=bool(args.force))

    # 6. Run npm install.
    _run_npm_install(target / ".opencode")

    # 7. --with-backend (compose.py is T-IMPL-INIT-CLI-006).
    if getattr(args, "with_backend", False):
        raise NotImplementedError("Backend bring-up is T-IMPL-INIT-CLI-006")

    # 8. Write state file.
    _write_state(target, version, manifest, args.repo)

    # 9. Print summary.
    _print_success_summary(target, version, extract_dir)
    return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_target(raw: object) -> Path:
    """Coerce the argparse ``--target`` value into an absolute :class:`Path`."""
    if isinstance(raw, Path):
        return raw.resolve()
    return Path(str(raw)).resolve()


def _resolve_version(args: argparse.Namespace) -> str:
    """Resolve the requested version, honoring ``--offline`` conflicts."""
    if getattr(args, "offline", False) and args.version == "latest":
        # §1.1 conflict: --offline + latest needs a bundled tarball we don't ship yet.
        raise OfflineNoBundle(
            "Offline mode requires a bundled tarball, which is not available in this version.",
        )
    return resolve_version(args.version, args.repo)


def _download_and_extract(version: str, repo: str) -> Path:
    """Download, verify, and extract the tarball to a temp dir.

    The extracted tree is kept alive (in a per-call mkdtemp dir) long enough
    for :func:`_place_files` to copy from it. Callers do not need to clean up
    — the OS reaps ``$TMPDIR`` on reboot.
    """
    tarball_path, checksums_path = download_tarball(version, repo)
    verify_sha256(tarball_path, checksums_path)
    extract_dir = Path(tempfile.mkdtemp(prefix=f"neuralgentics-extract-{version}-"))
    extract_tarball(tarball_path, extract_dir)
    return extract_dir


def _place_files(
    extract_dir: Path,
    target: Path,
    version: str,
    *,
    force: bool,
) -> dict[str, FileRecord]:
    """Walk ``extract_dir`` and place every file per the §1.1 table.

    Returns the manifest of placed files (rel path → :class:`FileRecord`).
    """
    manifest: dict[str, FileRecord] = {}
    opencode_dir = target / ".opencode"
    opencode_dir.mkdir(parents=True, exist_ok=True)

    for src in sorted(_iter_files(extract_dir)):
        rel = src.relative_to(extract_dir).as_posix()
        dest_rel = _classify_destination(rel)
        if dest_rel is None:
            log.warning("Skipping unrecognised tarball entry: %s", rel)
            continue

        dest = target / dest_rel

        if dest_rel == ".opencode/opencode.json":
            _merge_opencode_json(src, dest, force=force)
            merged = True
        elif dest_rel == ".opencode/package.json":
            _merge_package_json(src, dest, force=force)
            merged = False
        elif dest_rel in _COPY_IF_ABSENT_WARN:
            if dest.exists() and not force:
                log.warning("%s already exists; skipping (use --force to overwrite).", dest_rel)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            merged = False
        elif dest_rel in _COPY_IF_ABSENT:
            if dest.exists() and not force:
                log.info("%s already exists; skipping.", dest_rel)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            merged = False
        else:
            # Copy tree entry (agents/, skills/, docker/, node_modules/...).
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists() and not force:
                # For tree entries we overwrite unconditionally — they're
                # shipped artifacts, not user-editable. (User edits live in
                # opencode.json + AGENTS.md, which are handled above.)
                pass
            shutil.copy2(src, dest)
            merged = False

        sha = compute_file_sha256(dest)
        shipped_sha = compute_file_sha256(src)
        manifest[dest_rel] = FileRecord(
            sha256=sha,
            user_modified=False,
            installed_from=version,
            last_known_shipped_sha256=shipped_sha,
            merged=merged if dest_rel == ".opencode/opencode.json" else None,
        )
    return manifest


def _classify_destination(rel: str) -> str | None:
    """Map a tarball-relative path to its destination relative to ``target``.

    Returns ``None`` for unrecognised files (caller logs + skips).
    """
    # Exact-match files.
    if rel in _COPY_IF_ABSENT or rel in _COPY_IF_ABSENT_WARN or rel in _MERGE_FILES:
        return rel
    # Tree-prefix matches.
    for prefix in _COPY_TREE_PREFIXES:
        if rel.startswith(prefix):
            return rel
    # Anything else under .opencode/ that isn't explicitly listed above is
    # treated as a copy-tree entry (e.g. .opencode/skills/<name>/SKILL.md).
    if rel.startswith(".opencode/"):
        return rel
    return None


def _merge_opencode_json(src: Path, dest: Path, *, force: bool) -> None:
    """Merge the shipped ``opencode.json`` into the user's existing one."""
    shipped_text = src.read_text(encoding="utf-8")
    shipped = parse_opencode_json(shipped_text)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(serialize_opencode_json(shipped), encoding="utf-8")
        return
    user_text = dest.read_text(encoding="utf-8")
    user = parse_opencode_json(user_text)
    merged, changes = merge_opencode_json_with_diff(user, shipped)
    if not changes:
        # Idempotent: nothing to do.
        return
    dest.write_text(serialize_opencode_json(merged), encoding="utf-8")


def _merge_package_json(src: Path, dest: Path, *, force: bool) -> None:
    """Merge the shipped ``package.json`` into the user's existing one.

    Union of ``dependencies`` maps; user's version wins on key conflict.
    """
    shipped = json.loads(src.read_text(encoding="utf-8"))
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(shipped, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return
    user = json.loads(dest.read_text(encoding="utf-8"))
    user_deps = user.get("dependencies", {})
    shipped_deps = shipped.get("dependencies", {})
    merged_deps = {**shipped_deps, **user_deps}  # user wins
    user["dependencies"] = merged_deps
    dest.write_text(json.dumps(user, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run_npm_install(opencode_dir: Path) -> None:
    """Run ``npm install --no-audit --no-fund`` in ``opencode_dir``."""
    if shutil.which("npm") is None:
        raise NpmNotFound("npm is not installed or not on PATH.")
    result = subprocess.run(
        ["npm", "install", "--no-audit", "--no-fund"],
        cwd=str(opencode_dir),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise NpmInstallFailed(
            f"npm install failed in {opencode_dir}: {result.stderr.strip()}",
        )


def _write_state(
    target: Path,
    version: str,
    manifest: dict[str, FileRecord],
    repo: str,
) -> None:
    """Build + save the state file (§3)."""
    now = datetime.now(timezone.utc).replace(microsecond=0)
    state = StateFile(
        installed_version=version,
        installed_at=now,
        updated_at=now,
        cli_version=__version__,
        repo=repo,
        target=str(target),
        files=manifest,
    )
    save_state(target, state)


def _print_success_summary(target: Path, version: str, extract_dir: Path) -> None:
    """Print the plain-text success summary (§9.4 + task brief)."""
    agents = len(list((extract_dir / ".opencode" / "agents").glob("*.md")))
    skills = 0
    skills_dir = extract_dir / ".opencode" / "skills"
    if skills_dir.is_dir():
        skills = sum(1 for p in skills_dir.iterdir() if p.is_dir())
    state_path = target / ".opencode" / ".neuralgentics-state.json"
    use_color = _should_use_color()
    check = "\u2713" if use_color else "OK"
    print(
        f"{check} neuralgentics v{version} initialized in {target}\n"
        f"\n"
        f"Plugin:  {target}/.opencode/node_modules/@veedubin/neuralgentics/ (after `npm install`)\n"
        f"Config:  {target}/.opencode/opencode.json\n"
        f"Agents:  {agents} personas\n"
        f"Skills:  {skills} skills\n"
        f"State:   {state_path}\n"
        f"\n"
        f"Next: opencode\n"
        f"\n"
        f"Alternative install: curl -fsSL "
        f"https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash"
    )


def _print_dry_run_summary(target: Path, version: str, repo: str) -> None:
    """Print what WOULD happen (no files written, no downloads)."""
    print(f"WOULD initialize neuralgentics v{version} in {target}")
    print(f"WOULD download tarball from github.com/{repo}/releases/download/v{version}/")
    print("WOULD extract + place .opencode/agents/, .opencode/skills/, opencode.json (merged)")
    print("WOULD run: npm install --no-audit --no-fund")
    print("WOULD write state file.")


def _should_use_color() -> bool:
    """Return ``True`` if ANSI color is appropriate (per §1.1 + NO_COLOR)."""
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _iter_files(root: Path) -> Iterator[Path]:
    """Yield every regular file under ``root`` (sorted, deterministic)."""
    for p in sorted(root.rglob("*")):
        if p.is_file():
            yield p
