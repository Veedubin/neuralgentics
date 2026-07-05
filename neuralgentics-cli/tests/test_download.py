"""Tests for :mod:`neuralgentics.download` (download + verify + extract).

All network access is mocked — no real GitHub calls. We monkeypatch the
internal helpers rather than pulling in ``pytest-httpx`` to avoid adding a
dev dependency.
"""

from __future__ import annotations

import hashlib
import os
import tarfile
from pathlib import Path

import pytest

from neuralgentics import download as dl
from neuralgentics.download import (
    download_tarball,
    extract_tarball,
    resolve_version,
    verify_sha256,
)
from neuralgentics.errors import (
    ExtractionFailed,
    NetworkError,
    Sha256Mismatch,
    VersionNotFound,
)

# ---------------------------------------------------------------------------
# resolve_version
# ---------------------------------------------------------------------------


def test_resolve_version_latest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Point the cache at an isolated dir so we don't touch the real cache.
    cache_file = tmp_path / "version_cache.json"
    monkeypatch.setattr(dl, "_CACHE_FILE", cache_file)
    monkeypatch.setattr(dl, "_CACHE_DIR", cache_file.parent)

    def fake_fetch(repo: str, token: str | None) -> str:
        assert repo == "Veedubin/neuralgentics"
        return "v0.9.1"

    monkeypatch.setattr(dl, "_fetch_latest_tag", fake_fetch)
    assert resolve_version("latest", "Veedubin/neuralgentics") == "0.9.1"
    # Second call should hit the cache (fake_fetch would raise if called again).
    call_count = {"n": 0}
    orig_fake = fake_fetch

    def counting_fake(repo: str, token: str | None) -> str:
        call_count["n"] += 1
        return orig_fake(repo, token)

    monkeypatch.setattr(dl, "_fetch_latest_tag", counting_fake)
    assert resolve_version("latest", "Veedubin/neuralgentics") == "0.9.1"
    assert call_count["n"] == 0  # cache hit, no API call


def test_resolve_version_explicit() -> None:
    assert resolve_version("0.9.0", "Veedubin/neuralgentics") == "0.9.0"


def test_resolve_version_invalid() -> None:
    with pytest.raises(VersionNotFound):
        resolve_version("abc", "Veedubin/neuralgentics")


def test_resolve_version_invalid_partial() -> None:
    with pytest.raises(VersionNotFound):
        resolve_version("0.9", "Veedubin/neuralgentics")


# ---------------------------------------------------------------------------
# download_tarball
# ---------------------------------------------------------------------------


def test_download_tarball_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Redirect the per-pid temp dir into our tmp_path to avoid polluting /tmp.
    fake_tmp = tmp_path / "dl"
    monkeypatch.setattr(dl, "Path", _FakePathMaker(tmp_dir=fake_tmp))

    written: dict[str, bytes] = {}

    def fake_stream(url: str, dest: Path, headers: dict[str, str]) -> None:
        written[url] = b""
        # Ensure parent exists.
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"DUMMY-TARBALL" if "tar.gz" in url else b"sha  name")

    monkeypatch.setattr(dl, "_stream_download", fake_stream)

    tarball, checksums = download_tarball("0.9.1", "Veedubin/neuralgentics")
    assert tarball.is_file()
    assert checksums.is_file()
    assert tarball.read_bytes() == b"DUMMY-TARBALL"
    assert checksums.read_bytes() == b"sha  name"


def test_download_tarball_invalid_version_raises() -> None:
    with pytest.raises(VersionNotFound):
        download_tarball("not-a-version", "Veedubin/neuralgentics")


def test_download_tarball_cleans_up_on_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_tmp = tmp_path / "dl"
    monkeypatch.setattr(dl, "Path", _FakePathMaker(tmp_dir=fake_tmp))

    def boom(url: str, dest: Path, headers: dict[str, str]) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"partial")
        raise NetworkError("boom")

    monkeypatch.setattr(dl, "_stream_download", boom)
    with pytest.raises(NetworkError):
        download_tarball("0.9.1", "Veedubin/neuralgentics")
    # The temp dir for this pid/version should have been cleaned up.
    # (Only the leaf dir we created; parent may persist.)
    leaf = fake_tmp / f"neuralgentics-{os.getpid()}-0.9.1"
    assert not leaf.exists(), f"cleanup failed: {leaf} still exists"


class _FakePathMaker:
    """A stand-in for ``pathlib.Path`` that redirects ``/tmp/...`` roots."""

    def __init__(self, *, tmp_dir: Path) -> None:
        self._tmp_dir = tmp_dir

    def __call__(self, *args: object) -> Path:
        first = args[0] if args else "."
        if isinstance(first, str) and first == "/tmp":
            return self._tmp_dir / args[1] if len(args) > 1 else self._tmp_dir
        return Path(*args)  # type: ignore[arg-type]

    def __getattr__(self, name: str) -> object:
        # Delegate class-style attribute access (e.g. Path.home) to real Path.
        return getattr(Path, name)


# ---------------------------------------------------------------------------
# verify_sha256
# ---------------------------------------------------------------------------


def test_verify_sha256_match(tmp_path: Path) -> None:
    content = b"hello world"
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    tarball.write_bytes(content)
    expected = hashlib.sha256(content).hexdigest()
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{expected}  {tarball.name}\n", encoding="utf-8")
    # Should not raise.
    verify_sha256(tarball, checksums)


def test_verify_sha256_mismatch(tmp_path: Path) -> None:
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    tarball.write_bytes(b"hello world")
    wrong = "0" * 64
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{wrong}  {tarball.name}\n", encoding="utf-8")
    with pytest.raises(Sha256Mismatch):
        verify_sha256(tarball, checksums)


def test_verify_sha256_missing_entry(tmp_path: Path) -> None:
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    tarball.write_bytes(b"x")
    checksums = tmp_path / "checksums.txt"
    checksums.write_text("aaaa  some-other-file.tar.gz\n", encoding="utf-8")
    with pytest.raises(Sha256Mismatch):
        verify_sha256(tarball, checksums)


# ---------------------------------------------------------------------------
# extract_tarball
# ---------------------------------------------------------------------------


def _make_tarball(tarball: Path, *, top: str, entries: dict[str, bytes]) -> None:
    """Create a gzipped tarball whose members live under ``top/``."""
    with tarfile.open(tarball, "w:gz") as tar:
        # Add the top-level directory entry.
        dir_info = tarfile.TarInfo(name=top)
        dir_info.type = tarfile.DIRTYPE
        dir_info.mode = 0o755
        tar.addfile(dir_info)
        for rel, data in entries.items():
            info = tarfile.TarInfo(name=f"{top}/{rel}")
            info.size = len(data)
            info.mode = 0o644
            import io

            tar.addfile(info, io.BytesIO(data))


def test_extract_tarball(tmp_path: Path) -> None:
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    _make_tarball(
        tarball,
        top="neuralgentics-0.9.1",
        entries={
            ".opencode/agents/coder.md": b"# coder\n",
            ".opencode/agents/architect.md": b"# architect\n",
            ".opencode/opencode.json": b"{}",
            "docker-compose.yml": b"services: {}\n",
        },
    )
    dest = tmp_path / "dest"
    extract_tarball(tarball, dest)
    assert (dest / ".opencode/agents/coder.md").is_file()
    assert (dest / ".opencode/agents/coder.md").read_bytes() == b"# coder\n"
    assert (dest / ".opencode/agents/architect.md").is_file()
    assert (dest / "docker-compose.yml").is_file()
    # The top-level dir should have been stripped (not present under dest).
    assert not (dest / "neuralgentics-0.9.1").exists()


def test_extract_tarball_missing_required_file(tmp_path: Path) -> None:
    tarball = tmp_path / "neuralgentics-0.9.1.tar.gz"
    _make_tarball(
        tarball,
        top="neuralgentics-0.9.1",
        entries={
            "README.md": b"hi",
        },
    )
    dest = tmp_path / "dest"
    with pytest.raises(ExtractionFailed):
        extract_tarball(tarball, dest)


def test_extract_tarball_traversal_blocked(tmp_path: Path) -> None:
    import io

    tarball = tmp_path / "evil.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        # Top dir
        dir_info = tarfile.TarInfo(name="neuralgentics-0.9.1")
        dir_info.type = tarfile.DIRTYPE
        tar.addfile(dir_info)
        # Member that escapes via ".." after stripping one component.
        info = tarfile.TarInfo(name="neuralgentics-0.9.1/../../evil.txt")
        info.size = len(b"pwned")
        tar.addfile(info, io.BytesIO(b"pwned"))
    dest = tmp_path / "dest"
    with pytest.raises((Exception,)):  # noqa: B017 — we accept any rejection
        extract_tarball(tarball, dest)
    assert not (dest / "evil.txt").exists()
    assert not (tmp_path / "evil.txt").exists()


# ---------------------------------------------------------------------------
# extract.py re-export
# ---------------------------------------------------------------------------


def test_extract_module_reexports() -> None:
    from neuralgentics import extract

    assert extract.extract_tarball is dl.extract_tarball
