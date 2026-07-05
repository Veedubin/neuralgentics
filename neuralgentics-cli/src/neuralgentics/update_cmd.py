"""``neuralgentics update`` command (§1.2 of the design doc).

Updates an existing neuralgentics installation in place:
  1. Load the state file (error if missing).
  2. Compare installed vs. requested version (no-op if same; downgrade
     blocked without ``--force``).
  3. Detect user modifications to the current manifest.
  4. Download + verify + extract the new tarball.
  5. Place files, skipping user-modified ones (unless ``--force``).
  6. Re-run ``npm install``.
  7. Update the state file with the new version + refreshed manifest.
  8. Print a summary of what was applied vs. skipped.

Public API: :func:`run_update`.
"""

from __future__ import annotations

import argparse
import logging
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .download import (
    download_tarball,
    extract_tarball,
    resolve_version,
    verify_sha256,
)
from .errors import TargetNotDirectory
from .init_cmd import _classify_destination, _iter_files, _merge_opencode_json, _run_npm_install
from .state import (
    FileRecord,
    StateFile,
    compute_file_sha256,
    detect_user_modifications,
    load_state,
    save_state,
)

__all__ = ["run_update"]

log = logging.getLogger(__name__)

#: Regex for a valid ``X.Y.Z`` semver.
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def run_update(args: argparse.Namespace) -> int:
    """Entry point for ``neuralgentics update``. Returns the process exit code."""
    target = _coerce_target(args.target)
    if not target.is_dir():
        raise TargetNotDirectory(f"{target} is not a directory.")

    # 1. Load state file.
    state = load_state(target)
    if state is None:
        print(
            f"No neuralgentics installation found at {target}/.opencode/. "
            "Run `neuralgentics init` first.",
            file=sys.stderr,
        )
        return 1

    # 2. Resolve requested version.
    requested = resolve_version(args.version, args.repo)
    if not _SEMVER_RE.match(requested):
        raise ValueError(f"Resolved version {requested!r} is not X.Y.Z.")  # noqa: TRY004

    # 3. Already at version?
    if state.installed_version == requested:
        print(f"Already at version {requested}.")
        return 0

    # 4. Downgrade check.
    if _is_downgrade(state.installed_version, requested) and not bool(args.force):
        print(
            f"Refusing to downgrade from v{state.installed_version} to v{requested}. "
            "Use --force to override.",
            file=sys.stderr,
        )
        return 1

    # 5. Detect user modifications to the current manifest.
    state = detect_user_modifications(state, target)

    if bool(getattr(args, "dry_run", False)):
        print(f"WOULD update {target} from v{state.installed_version} to v{requested}.")
        modified = [p for p, r in state.files.items() if r.user_modified]
        print(f"WOULD skip {len(modified)} user-modified files (use --force to overwrite).")
        return 0

    # 6. Download + extract new tarball.
    extract_dir = _download_and_extract(requested, args.repo)

    # 7. Place files, honoring user_modified + --force.
    applied, skipped = _place_files_update(
        extract_dir,
        target,
        state,
        requested,
        force=bool(args.force),
    )

    # 8. Re-run npm install.
    _run_npm_install(target / ".opencode")

    # 9. Update state file.
    _update_state(state, target, requested, extract_dir, applied, skipped, args.repo)

    # 10. Print summary.
    print(
        f"Updated from v{state.installed_version} to v{requested}. "
        f"Skipped {skipped} user-modified files (use --force to overwrite). "
        f"Applied {applied} changes."
    )
    return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_target(raw: object) -> Path:
    """Coerce the argparse ``--target`` value into an absolute :class:`Path`."""
    if isinstance(raw, Path):
        return raw.resolve()
    return Path(str(raw)).resolve()


def _is_downgrade(installed: str, requested: str) -> bool:
    """Return ``True`` if ``requested`` is strictly older than ``installed``."""
    return _parse_semver(requested) < _parse_semver(installed)


def _parse_semver(v: str) -> tuple[int, int, int]:
    parts = v.split(".")
    if len(parts) != 3:
        raise ValueError(f"Invalid semver: {v!r}")
    return (int(parts[0]), int(parts[1]), int(parts[2]))


def _download_and_extract(version: str, repo: str) -> Path:
    """Download, verify, and extract the tarball to a temp dir."""
    tarball_path, checksums_path = download_tarball(version, repo)
    verify_sha256(tarball_path, checksums_path)
    extract_dir = Path(tempfile.mkdtemp(prefix=f"neuralgentics-update-{version}-"))
    extract_tarball(tarball_path, extract_dir)
    return extract_dir


def _place_files_update(
    extract_dir: Path,
    target: Path,
    state: StateFile,
    new_version: str,
    *,
    force: bool,
) -> tuple[int, int]:
    """Place files from ``extract_dir`` into ``target``, honoring user mods.

    Returns ``(applied_count, skipped_count)``.
    """
    applied = 0
    skipped = 0
    for src in sorted(_iter_files(extract_dir)):
        rel = src.relative_to(extract_dir).as_posix()
        dest_rel = _classify_destination(rel)
        if dest_rel is None:
            log.warning("Skipping unrecognised tarball entry: %s", rel)
            continue
        dest = target / dest_rel

        existing = state.files.get(dest_rel)
        if existing is not None and existing.user_modified and not force:
            log.warning(
                "Skipping user-modified file %s (use --force to overwrite).",
                dest_rel,
            )
            skipped += 1
            continue

        if dest_rel == ".opencode/opencode.json":
            _merge_opencode_json(src, dest, force=force)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        applied += 1
    return applied, skipped


def _update_state(
    state: StateFile,
    target: Path,
    new_version: str,
    extract_dir: Path,
    applied: int,
    skipped: int,
    repo: str,
) -> None:
    """Refresh the manifest and save the state file with the new version."""
    # Build a fresh manifest from the files that exist on disk now.
    new_files: dict[str, FileRecord] = dict(state.files)
    for src in sorted(_iter_files(extract_dir)):
        rel = src.relative_to(extract_dir).as_posix()
        dest_rel = _classify_destination(rel)
        if dest_rel is None:
            continue
        dest = target / dest_rel
        if not dest.is_file():
            continue
        shipped_sha = compute_file_sha256(src)
        current_sha = compute_file_sha256(dest)
        old_record = state.files.get(dest_rel)
        # Preserve user_modified flag if the file was skipped (still modified).
        if old_record is not None and old_record.user_modified and skipped > 0:
            user_modified: bool = old_record.user_modified
        else:
            user_modified = False
        new_files[dest_rel] = FileRecord(
            sha256=current_sha,
            user_modified=user_modified,
            installed_from=new_version,
            last_known_shipped_sha256=shipped_sha,
            merged=old_record.merged if old_record is not None else None,
        )

    now = datetime.now(timezone.utc).replace(microsecond=0)
    updated = state.model_copy(
        update={
            "installed_version": new_version,
            "updated_at": now,
            "repo": repo,
            "files": new_files,
        }
    )
    save_state(target, updated)
