"""Filesystem-backed data source for the policy_editor module (T-155).

Reads/writes gateway policy YAML files from the configured policies
directory. Mirrors the gateway's :go:func:`DefaultPoliciesDir`
(``~/.neuralgentics/policies``) and :go:func:`LoadPoliciesFromDir`
(neuralgentics-gateway/policy/files.go).

Safety:

  * **Atomic save** — proposed content is written to a sibling temp
    file and ``os.replace``'d onto the target. The rename is atomic on
    POSIX, so a crash mid-write never leaves a half-written policy file.
  * **One-level backup** — before saving, the prior on-disk content
    (if any) is copied to ``<name>.bak``. The history view diffs
    against this backup. Only one level of history is kept (T-156).
  * **Filename sanitization** — the name segment may not contain ``/``,
    ``\\``, ``..``, or null bytes; only ``.yaml``/``.yml`` extensions
    are accepted. Path traversal is impossible because the final path
    is always ``<policies_dir>/<sanitized_name>``.
  * **.yaml-only reads** — :go:func:`LoadPoliciesFromDir` only reads
    ``.yaml`` (not ``.yml``). The editor mirrors that on the read
    side for parity, but ACCEPTS both ``.yaml`` and ``.yml`` on save
    (the gateway ignores the ``.yml`` files, but the operator may
    want to stage one without renaming). Reads list both.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from neuralgentics.web.modules.policy_editor.schema import (
    validate_policy_yaml,
)

log = logging.getLogger("neuralgentics.web.policy_editor.data_source")

DEFAULT_POLICIES_DIR = Path.home() / ".neuralgentics" / "policies"

# Filename sanitizer: letters, digits, dash, underscore, dot, hyphen.
# Path separators and ``..`` are rejected. The gateway loads any
# *.yaml file regardless of name, but the editor must not let a user
# name a file ``../../etc/passwd``.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_VALID_EXTENSIONS: tuple[str, ...] = (".yaml", ".yml")


@dataclass
class PolicyFileInfo:
    """One row in the policy listing table."""

    name: str  # filename without extension
    filename: str  # full filename including extension
    path: Path
    size: int
    mtime: datetime
    statement_count: int
    valid: bool
    parse_error: str | None  # None when valid


@dataclass
class PolicyDocument:
    """A single policy file's content + parsed view."""

    filename: str
    raw: str  # raw YAML text on disk
    parsed: dict[str, Any] | None  # parsed dict (None when YAML is malformed)
    statements: list[dict[str, Any]]  # always a list (empty when absent/malformed)
    valid: bool
    validation_errors: list[dict[str, Any]]


@dataclass
class SaveResult:
    """Outcome of a save attempt."""

    saved: bool
    filename: str
    backup_path: Path | None  # set when a .bak was created
    validation_errors: list[dict[str, Any]]  # empty when saved=True


def sanitize_filename(name: str) -> str:
    """Sanitize a user-supplied filename (with or without extension).

    Returns the normalized filename including extension. Raises
    :class:`ValueError` when the name contains path separators, ``..``,
    null bytes, or has an unsupported extension.

    The returned path is safe to join onto the policies dir without
    escaping it.
    """
    if not name or not isinstance(name, str):
        raise ValueError("filename must be a non-empty string")
    name = name.strip()
    if "\x00" in name:
        raise ValueError("filename contains null byte")
    # Reject any path separator (forward or backward).
    if "/" in name or "\\" in name:
        raise ValueError(f"filename {name!r} contains a path separator")
    # Reject traversal attempts.
    if name == ".." or name == "." or ".." in name.split("."):
        raise ValueError(f"filename {name!r} contains '..'")
    if not _SAFE_NAME_RE.match(name):
        raise ValueError(f"filename {name!r} must match {_SAFE_NAME_RE.pattern}")
    # Ensure a valid extension. If none present, default to .yaml.
    lower = name.lower()
    if not lower.endswith(_VALID_EXTENSIONS):
        if "." in name:
            raise ValueError(f"filename {name!r} must end with .yaml or .yml")
        name = name + ".yaml"
    return name


def default_policies_dir() -> Path:
    """Resolve the policies dir from env or fall back to the gateway default.

    Env var: ``NEURALGENTICS_POLICIES_DIR`` (matches the gateway's
    ``policy.policies_dir`` config block; the gateway default is also
    ``~/.neuralgentics/policies`` — see DefaultPoliciesDir() in files.go).
    """
    env = os.environ.get("NEURALGENTICS_POLICIES_DIR")
    if env:
        return Path(env).expanduser()
    return DEFAULT_POLICIES_DIR


class PolicyEditorDataSource:
    """Filesystem-backed policy file source.

    Constructed once by :func:`make_source_from_config` and shared by
    all routes. Stateless except for the resolved ``policies_dir`` —
    each method opens/closes the file it needs.
    """

    def __init__(self, policies_dir: Path) -> None:
        self.policies_dir = policies_dir

    # ---- Listing ----

    def list_policies(self) -> list[PolicyFileInfo]:
        """List all policy files in the policies dir.

        Mirrors :go:func:`LoadPoliciesFromDir`: only ``*.yaml`` files
        are loaded by the gateway, but we surface ``*.yml`` too so the
        editor can warn the user (the gateway will silently ignore
        them).
        """
        if not self.policies_dir.is_dir():
            return []
        infos: list[PolicyFileInfo] = []
        for entry in sorted(self.policies_dir.iterdir()):
            if not entry.is_file():
                continue
            lower = entry.name.lower()
            if not lower.endswith(_VALID_EXTENSIONS):
                continue
            # Skip our own .bak backups (history view uses a separate API).
            if lower.endswith(".bak"):
                continue
            try:
                st = entry.stat()
            except OSError as exc:
                log.warning("stat %s failed: %s", entry, exc)
                continue
            raw = entry.read_text(encoding="utf-8")
            stmt_count, valid, parse_err = self._summarize(raw)
            stem = entry.name
            # Strip the extension for the display "name".
            for ext in _VALID_EXTENSIONS:
                if lower.endswith(ext):
                    stem = entry.name[: -len(ext)]
                    break
            infos.append(
                PolicyFileInfo(
                    name=stem,
                    filename=entry.name,
                    path=entry,
                    size=st.st_size,
                    mtime=datetime.fromtimestamp(st.st_mtime, tz=UTC),
                    statement_count=stmt_count,
                    valid=valid,
                    parse_error=parse_err,
                )
            )
        return infos

    def _summarize(self, raw: str) -> tuple[int, bool, str | None]:
        """Return (statement_count, valid, parse_error)."""
        try:
            parsed: Any = yaml.safe_load(raw)
        except yaml.YAMLError as exc:
            return 0, False, str(exc)
        if parsed is None:
            return 0, False, "empty file"
        if not isinstance(parsed, dict):
            return 0, False, "top level must be a mapping"
        stmts = parsed.get("statements")
        if not isinstance(stmts, list):
            return 0, False, "statements must be a list"
        result = validate_policy_yaml(raw)
        if not result.valid:
            return len(stmts), False, result.errors[0].message if result.errors else "invalid"
        return len(stmts), True, None

    # ---- Read one ----

    def read(self, filename: str) -> PolicyDocument | None:
        """Read one policy file. Returns None if it doesn't exist."""
        safe = sanitize_filename(filename)
        p = self.policies_dir / safe
        if not p.is_file():
            return None
        raw = p.read_text(encoding="utf-8")
        result = validate_policy_yaml(raw)
        parsed = result.parsed
        stmts: list[dict[str, Any]] = []
        if isinstance(parsed, dict):
            s = parsed.get("statements")
            if isinstance(s, list):
                stmts = [x for x in s if isinstance(x, dict)]
        return PolicyDocument(
            filename=safe,
            raw=raw,
            parsed=parsed,
            statements=stmts,
            valid=result.valid,
            validation_errors=[e.to_dict() for e in result.errors],
        )

    # ---- Write / save ----

    def save(self, filename: str, content: str) -> SaveResult:
        """Validate + atomically save ``content`` to ``filename``.

        Returns a :class:`SaveResult` with ``saved=False`` when
        validation fails (no file is written in that case).

        Atomicity: the content is written to a sibling temp file, then
        ``os.replace``'d onto the target path. The prior content (if
        any) is copied to ``<filename>.bak`` BEFORE the rename.

        A successful save also writes the ``.bak`` so the history
        view can diff against it.
        """
        safe = sanitize_filename(filename)
        # Validate BEFORE touching the disk.
        result = validate_policy_yaml(content)
        if not result.valid:
            return SaveResult(
                saved=False,
                filename=safe,
                backup_path=None,
                validation_errors=[e.to_dict() for e in result.errors],
            )

        target = self.policies_dir / safe
        # Ensure dir exists (operator may point at a fresh dir).
        self.policies_dir.mkdir(parents=True, exist_ok=True)

        backup_path: Path | None = None
        if target.is_file():
            backup_path = target.with_suffix(target.suffix + ".bak")
            shutil.copy2(target, backup_path)

        # Atomic write: temp file in the SAME directory + os.replace.
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, target)
        log.info("saved policy %s (backup=%s)", target, backup_path)
        return SaveResult(
            saved=True,
            filename=safe,
            backup_path=backup_path,
            validation_errors=[],
        )

    # ---- Create new ----

    def create(self, filename: str, template: str) -> SaveResult:
        """Create a new policy file with the given template text.

        Refuses (saved=False, no validation_errors) if the target file
        already exists. The template is NOT validated — the caller
        (route handler) is expected to pass a known-good template.
        """
        safe = sanitize_filename(filename)
        target = self.policies_dir / safe
        if target.is_file():
            return SaveResult(
                saved=False,
                filename=safe,
                backup_path=None,
                validation_errors=[],
            )
        # No backup (file didn't exist). Validate the template so a
        # caller can't stage an invalid file.
        result = validate_policy_yaml(template)
        if not result.valid:
            return SaveResult(
                saved=False,
                filename=safe,
                backup_path=None,
                validation_errors=[e.to_dict() for e in result.errors],
            )
        self.policies_dir.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(template, encoding="utf-8")
        os.replace(tmp, target)
        return SaveResult(
            saved=True,
            filename=safe,
            backup_path=None,
            validation_errors=[],
        )

    # ---- History ----

    def read_backup(self, filename: str) -> str | None:
        """Return the .bak content for a policy, or None if no backup exists."""
        safe = sanitize_filename(filename)
        target = self.policies_dir / safe
        bak = target.with_suffix(target.suffix + ".bak")
        if not bak.is_file():
            return None
        return bak.read_text(encoding="utf-8")

    def has_backup(self, filename: str) -> bool:
        safe = sanitize_filename(filename)
        target = self.policies_dir / safe
        bak = target.with_suffix(target.suffix + ".bak")
        return bak.is_file()

    # ---- Delete (not exposed in the UI in T-155; available for tests) ----

    def delete(self, filename: str) -> bool:
        safe = sanitize_filename(filename)
        target = self.policies_dir / safe
        if not target.is_file():
            return False
        target.unlink()
        # Also remove the .bak so a recreate doesn't see a stale backup.
        bak = target.with_suffix(target.suffix + ".bak")
        if bak.is_file():
            with contextlib.suppress(OSError):
                bak.unlink()
        return True


def make_source_from_config(config: Any) -> PolicyEditorDataSource:
    """Build the data source from a WebConfig (or any object with an
    ``extra`` dict).

    Resolution order (mirrors the gateway_audit module's
    make_source_from_config):

      1. ``NEURALGENTICS_POLICIES_DIR`` env var.
      2. ``config.extra['policies_dir']``.
      3. Default ``~/.neuralgentics/policies``.
    """
    policies_dir = default_policies_dir()
    extra = getattr(config, "extra", {})
    if isinstance(extra, dict) and "policies_dir" in extra:
        policies_dir = Path(str(extra["policies_dir"])).expanduser()
    return PolicyEditorDataSource(policies_dir)


__all__ = [
    "DEFAULT_POLICIES_DIR",
    "PolicyDocument",
    "PolicyEditorDataSource",
    "PolicyFileInfo",
    "SaveResult",
    "default_policies_dir",
    "make_source_from_config",
    "sanitize_filename",
]
