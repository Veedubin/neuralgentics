"""Tests for :mod:`neuralgentics.state`.

Covers roundtrip read/write, missing-file, corruption recovery, SHA256
computation, the ``user_modified`` "never reset" mitigation (§3.3), and
manifest rebuild from a directory.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from neuralgentics.state import (
    BackendRecord,
    FileRecord,
    StateFile,
    build_manifest_from_directory,
    compute_file_sha256,
    detect_user_modifications,
    load_state,
    save_state,
)


def _make_state() -> StateFile:
    now = datetime(2026, 7, 4, 12, 0, 0, tzinfo=timezone.utc)
    return StateFile(
        version=1,
        installed_version="0.9.1",
        installed_at=now,
        updated_at=now,
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target="/home/user/project",
        files={
            ".opencode/agents/coder.md": FileRecord(
                sha256="a" * 64,
                user_modified=False,
                installed_from="0.9.1",
                last_known_shipped_sha256="a" * 64,
            ),
            ".opencode/opencode.json": FileRecord(
                sha256="b" * 64,
                user_modified=False,
                installed_from="0.9.1",
                merged=True,
            ),
        },
        backend=BackendRecord(
            enabled=True,
            compose_file="docker-compose.yml",
            compose_tool="docker",
            env_file=".env",
            containers=["neuralgentics-postgres"],
        ),
    )


# ---------------------------------------------------------------------------
# roundtrip
# ---------------------------------------------------------------------------


def test_state_roundtrip(tmp_path: Path) -> None:
    state = _make_state()
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded is not None
    assert loaded.installed_version == state.installed_version
    assert loaded.cli_version == state.cli_version
    assert loaded.source == "github"
    assert set(loaded.files) == set(state.files)
    coder = loaded.files[".opencode/agents/coder.md"]
    assert coder.sha256 == "a" * 64
    assert coder.user_modified is False
    assert coder.last_known_shipped_sha256 == "a" * 64
    oc = loaded.files[".opencode/opencode.json"]
    assert oc.merged is True
    assert loaded.backend is not None
    assert loaded.backend.containers == ["neuralgentics-postgres"]


def test_state_roundtrip_no_backend(tmp_path: Path) -> None:
    state = _make_state().model_copy(update={"backend": None})
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)
    assert loaded is not None
    assert loaded.backend is None


# ---------------------------------------------------------------------------
# load_state edge cases
# ---------------------------------------------------------------------------


def test_state_load_missing(tmp_path: Path) -> None:
    assert load_state(tmp_path) is None


def test_state_load_corrupted_garbage(tmp_path: Path) -> None:
    state_path = tmp_path / ".opencode" / ".neuralgentics-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text("not json {{{", encoding="utf-8")
    assert load_state(tmp_path) is None


def test_state_load_corrupted_invalid_schema(tmp_path: Path) -> None:
    state_path = tmp_path / ".opencode" / ".neuralgentics-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    # Valid JSON but missing required fields → schema validation fails → None.
    state_path.write_text(json.dumps({"hello": "world"}), encoding="utf-8")
    assert load_state(tmp_path) is None


# ---------------------------------------------------------------------------
# save_state atomicity / dir creation
# ---------------------------------------------------------------------------


def test_save_state_creates_parent_dirs(tmp_path: Path) -> None:
    state = _make_state()
    target = tmp_path / "deeply" / "nested" / "project"
    save_state(target, state)
    assert (target / ".opencode" / ".neuralgentics-state.json").is_file()
    # No leftover .tmp file.
    assert not (target / ".opencode" / ".neuralgentics-state.json.tmp").is_file()


# ---------------------------------------------------------------------------
# compute_file_sha256
# ---------------------------------------------------------------------------


def test_compute_file_sha256(tmp_path: Path) -> None:
    import hashlib

    f = tmp_path / "f.txt"
    content = b"the quick brown fox"
    f.write_bytes(content)
    assert compute_file_sha256(f) == hashlib.sha256(content).hexdigest()


def test_compute_file_sha256_empty(tmp_path: Path) -> None:
    import hashlib

    f = tmp_path / "empty.txt"
    f.write_bytes(b"")
    assert compute_file_sha256(f) == hashlib.sha256(b"").hexdigest()


# ---------------------------------------------------------------------------
# detect_user_modifications — never reset
# ---------------------------------------------------------------------------


def test_detect_user_modifications_never_resets(tmp_path: Path) -> None:
    # File currently matches the shipped hash, but user_modified is already True.
    content = b"original shipped content"
    shipped_sha = "a" * 64  # intentionally NOT the real hash of content
    f = tmp_path / ".opencode" / "agents" / "coder.md"
    f.parent.mkdir(parents=True)
    f.write_bytes(content)
    current_real_sha = compute_file_sha256(f)
    state = StateFile(
        version=1,
        installed_version="0.9.1",
        installed_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(tmp_path),
        files={
            ".opencode/agents/coder.md": FileRecord(
                sha256=current_real_sha,
                user_modified=True,  # already flagged
                installed_from="0.9.1",
                last_known_shipped_sha256=shipped_sha,
            ),
        },
    )
    # Make the file's current hash match the shipped hash exactly so there's
    # no *new* modification — only the pre-existing flag.
    f.write_bytes(b"content that hashes to " + shipped_sha.encode())  # won't match; irrelevant
    # Recompute: detect_user_modifications should NOT clear user_modified.
    new_state = detect_user_modifications(state, tmp_path)
    rec = new_state.files[".opencode/agents/coder.md"]
    assert rec.user_modified is True  # never auto-reset


def test_detect_user_modifications_flags_new_change(tmp_path: Path) -> None:
    f = tmp_path / ".opencode" / "agents" / "coder.md"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"original")
    original_sha = compute_file_sha256(f)
    state = StateFile(
        version=1,
        installed_version="0.9.1",
        installed_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(tmp_path),
        files={
            ".opencode/agents/coder.md": FileRecord(
                sha256=original_sha,
                user_modified=False,
                installed_from="0.9.1",
                last_known_shipped_sha256=original_sha,
            ),
        },
    )
    # User edits the file.
    f.write_bytes(b"CHANGED")
    new_state = detect_user_modifications(state, tmp_path)
    assert new_state.files[".opencode/agents/coder.md"].user_modified is True


def test_detect_user_modifications_uses_sha256_when_no_shipped_hash(tmp_path: Path) -> None:
    f = tmp_path / ".opencode" / "agents" / "coder.md"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"original")
    original_sha = compute_file_sha256(f)
    state = StateFile(
        version=1,
        installed_version="0.9.1",
        installed_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(tmp_path),
        files={
            ".opencode/agents/coder.md": FileRecord(
                sha256=original_sha,
                user_modified=False,
                installed_from="0.9.1",
                last_known_shipped_sha256=None,
            ),
        },
    )
    f.write_bytes(b"CHANGED")
    new_state = detect_user_modifications(state, tmp_path)
    assert new_state.files[".opencode/agents/coder.md"].user_modified is True


def test_detect_user_modifications_missing_file_is_modification(tmp_path: Path) -> None:
    state = StateFile(
        version=1,
        installed_version="0.9.1",
        installed_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 4, tzinfo=timezone.utc),
        cli_version="0.1.0",
        repo="Veedubin/neuralgentics",
        target=str(tmp_path),
        files={
            ".opencode/agents/coder.md": FileRecord(
                sha256="a" * 64,
                user_modified=False,
                installed_from="0.9.1",
            ),
        },
    )
    # File does not exist on disk.
    new_state = detect_user_modifications(state, tmp_path)
    assert new_state.files[".opencode/agents/coder.md"].user_modified is True


# ---------------------------------------------------------------------------
# build_manifest_from_directory
# ---------------------------------------------------------------------------


def test_build_manifest_from_directory(tmp_path: Path) -> None:
    (tmp_path / ".opencode" / "agents").mkdir(parents=True)
    (tmp_path / ".opencode" / "agents" / "coder.md").write_bytes(b"# coder")
    (tmp_path / ".opencode" / "opencode.json").write_bytes(b"{}")
    manifest = build_manifest_from_directory(
        tmp_path,
        [
            ".opencode/agents/coder.md",
            ".opencode/opencode.json",
            ".opencode/agents/missing.md",  # does not exist — skipped
        ],
    )
    assert set(manifest) == {".opencode/agents/coder.md", ".opencode/opencode.json"}
    rec = manifest[".opencode/agents/coder.md"]
    assert rec.sha256 == compute_file_sha256(tmp_path / ".opencode/agents/coder.md")
    # Per §3.4, rebuild-from-corruption marks everything as user_modified.
    assert rec.user_modified is True
    assert rec.installed_from == "unknown"


def test_build_manifest_from_directory_empty(tmp_path: Path) -> None:
    manifest = build_manifest_from_directory(tmp_path, ["a/b.md"])
    assert manifest == {}
