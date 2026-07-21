"""Tests for T-INSTALL-006: self-hosted htmx + tailwind with SRI.

Closing the CDN-without-SRI gap (same risk class T-120 closed for
Chart.js). These tests verify:

  * The vendored htmx + tailwind files are on disk and non-empty.
  * ``GET /static/vendor/<file>`` serves each file with a JS content-type.
  * The base template + login template reference the local vendored
    paths (no ``https://cdn`` / ``https://unpkg`` URLs for htmx or
    tailwind).
  * The templates include ``integrity="sha384-..."`` +
    ``crossorigin="anonymous"`` on the script tags.
  * The integrity hash in each template matches the actual sha384 of
    the served file (so a tampered wheel build fails loudly).
  * A startup warning fires when a vendored asset is missing.
"""

from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import neuralgentics.web.modules.broker_audit.data_source as broker_ds_mod
import neuralgentics.web.modules.gateway_audit.data_source as gw_ds_mod
from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"
STATIC_DIR = (
    Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "shell" / "static"
)
VENDOR_DIR = STATIC_DIR / "vendor"
TEMPLATES_DIR = STATIC_DIR.parent / "templates"

VENDOR_FILES = {
    "htmx": VENDOR_DIR / "htmx.min.js",
    "tailwind": VENDOR_DIR / "tailwind.min.js",
}

# Templates that should reference the vendored assets.
BASE_TEMPLATE = TEMPLATES_DIR / "base.html"
LOGIN_TEMPLATE = TEMPLATES_DIR / "login.html"

# Regex to extract the integrity="sha384-<b64>" attribute from a template.
_INTEGRITY_RE = re.compile(r'integrity="sha384-([A-Za-z0-9+/=]+)"')

# Regex to detect any CDN URL for htmx or tailwind (regression guard).
_CDN_RE = re.compile(
    r"https://(?:unpkg\.com/htmx\.org|cdn\.tailwindcss\.com)",
    re.IGNORECASE,
)


def _sha384_b64(path: Path) -> str:
    """Return the base64-encoded sha384 digest of ``path`` (no ``sha384-`` prefix)."""
    h = hashlib.sha384()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode("ascii")


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


@pytest.fixture(autouse=True)
def fast_poll_intervals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make both audit sources poll fast so module startup doesn't block."""
    broker_orig = broker_ds_mod.JSONLBrokerAuditSource.__init__
    monkeypatch.setattr(
        broker_ds_mod.JSONLBrokerAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: broker_orig(self, path, poll_interval),
    )
    gw_orig = gw_ds_mod.JSONLAuditSource.__init__
    monkeypatch.setattr(
        gw_ds_mod.JSONLAuditSource,
        "__init__",
        lambda self, path, poll_interval=0.2: gw_orig(self, path, poll_interval),
    )


@pytest.fixture
def empty_audit_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Empty JSONL files so the audit modules start without errors."""
    broker = tmp_path / "broker-audit.jsonl"
    broker.write_text("")
    monkeypatch.setenv("NEURALGENTICS_BROKER_AUDIT_FILE", str(broker))
    gw = tmp_path / "audit.jsonl"
    gw.write_text("")
    monkeypatch.setenv("NEURALGENTICS_AUDIT_FILE", str(gw))
    return broker, gw


# ---------------------------------------------------------------------------
# File presence + size
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name,path", list(VENDOR_FILES.items()))
def test_vendor_file_exists(name: str, path: Path) -> None:
    """Each vendored asset is on disk and non-empty."""
    assert path.is_file(), f"{name} static file missing at {path}"
    size = path.stat().st_size
    # htmx 1.9.12 min is ~48 KB; tailwind play CDN is ~400 KB. Use a
    # generous lower bound so a future patch bump doesn't trip the test,
    # but reject empty / stub / placeholder files.
    assert size > 5_000, f"{name} static file is suspiciously small ({size} bytes)"


# ---------------------------------------------------------------------------
# Served via /static/vendor/<file>
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name,path", list(VENDOR_FILES.items()))
def test_vendor_file_served(
    name: str,
    path: Path,
    empty_audit_files: tuple[Path, Path],
) -> None:
    """``GET /static/vendor/<file>`` returns 200 with a JS content-type."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get(f"/static/vendor/{path.name}")
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:200]}"
    ctype = r.headers.get("content-type", "")
    assert "javascript" in ctype, f"expected javascript content-type, got {ctype!r}"
    assert r.content == path.read_bytes(), "served body does not match on-disk file"


# ---------------------------------------------------------------------------
# Templates reference local paths, no CDN URLs
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("template_path", [BASE_TEMPLATE, LOGIN_TEMPLATE])
def test_template_no_cdn_urls_for_htmx_or_tailwind(template_path: Path) -> None:
    """No ``https://unpkg.com/htmx.org`` or ``https://cdn.tailwindcss.com`` in templates.

    Regression guard for T-INSTALL-006: someone re-introducing a CDN
    script tag would trip this test.
    """
    assert template_path.is_file(), f"template missing: {template_path}"
    text = template_path.read_text(encoding="utf-8")
    matches = _CDN_RE.findall(text)
    assert not matches, (
        f"template {template_path.name} still references a CDN for htmx/tailwind: "
        f"{matches!r}. T-INSTALL-006 vendored these assets — use "
        f"/static/vendor/htmx.min.js and /static/vendor/tailwind.min.js instead."
    )


def test_base_template_references_local_htmx() -> None:
    """base.html references /static/vendor/htmx.min.js."""
    text = BASE_TEMPLATE.read_text(encoding="utf-8")
    assert "/static/vendor/htmx.min.js" in text, (
        "base.html does not reference the vendored htmx file"
    )


def test_base_template_references_local_tailwind() -> None:
    """base.html references /static/vendor/tailwind.min.js."""
    text = BASE_TEMPLATE.read_text(encoding="utf-8")
    assert "/static/vendor/tailwind.min.js" in text, (
        "base.html does not reference the vendored tailwind file"
    )


def test_login_template_references_local_tailwind() -> None:
    """login.html references /static/vendor/tailwind.min.js."""
    text = LOGIN_TEMPLATE.read_text(encoding="utf-8")
    assert "/static/vendor/tailwind.min.js" in text, (
        "login.html does not reference the vendored tailwind file"
    )


# ---------------------------------------------------------------------------
# SRI integrity attributes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("template_path", [BASE_TEMPLATE, LOGIN_TEMPLATE])
def test_template_has_integrity_attribute(template_path: Path) -> None:
    """Each template includes at least one ``integrity="sha384-..."`` attribute."""
    text = template_path.read_text(encoding="utf-8")
    matches = _INTEGRITY_RE.findall(text)
    assert matches, (
        f'no integrity="sha384-..." attribute in {template_path.name}; '
        f"the template may have regressed to a CDN script tag without SRI"
    )


@pytest.mark.parametrize("template_path", [BASE_TEMPLATE, LOGIN_TEMPLATE])
def test_template_has_crossorigin(template_path: Path) -> None:
    """Each template includes ``crossorigin="anonymous"`` on script tags."""
    text = template_path.read_text(encoding="utf-8")
    assert 'crossorigin="anonymous"' in text, (
        f'missing crossorigin="anonymous" in {template_path.name}'
    )


# ---------------------------------------------------------------------------
# Integrity hash matches the actual file
# ---------------------------------------------------------------------------


def test_base_template_htmx_integrity_matches() -> None:
    """The htmx integrity hash in base.html matches the actual sha384 of the file."""
    text = BASE_TEMPLATE.read_text(encoding="utf-8")
    # Find the htmx script tag and extract its integrity hash.
    htmx_block = re.search(r'<script[^>]*src="/static/vendor/htmx\.min\.js"[^>]*>', text, re.DOTALL)
    assert htmx_block is not None, "base.html has no script tag for vendored htmx"
    m = _INTEGRITY_RE.search(htmx_block.group(0))
    assert m is not None, "htmx script tag has no integrity attribute"
    template_hash = m.group(1)
    file_hash = _sha384_b64(VENDOR_FILES["htmx"])
    assert template_hash == file_hash, (
        f"htmx integrity hash mismatch: template={template_hash!r} "
        f"file={file_hash!r}. Either the vendored file was tampered/replaced, "
        f"or the template's integrity attribute was not updated to match."
    )


def test_base_template_tailwind_integrity_matches() -> None:
    """The tailwind integrity hash in base.html matches the actual sha384 of the file."""
    text = BASE_TEMPLATE.read_text(encoding="utf-8")
    tw_block = re.search(
        r'<script[^>]*src="/static/vendor/tailwind\.min\.js"[^>]*>', text, re.DOTALL
    )
    assert tw_block is not None, "base.html has no script tag for vendored tailwind"
    m = _INTEGRITY_RE.search(tw_block.group(0))
    assert m is not None, "tailwind script tag has no integrity attribute"
    template_hash = m.group(1)
    file_hash = _sha384_b64(VENDOR_FILES["tailwind"])
    assert template_hash == file_hash, (
        f"tailwind integrity hash mismatch: template={template_hash!r} "
        f"file={file_hash!r}. Either the vendored file was tampered/replaced, "
        f"or the template's integrity attribute was not updated to match."
    )


def test_login_template_tailwind_integrity_matches() -> None:
    """The tailwind integrity hash in login.html matches the actual sha384 of the file."""
    text = LOGIN_TEMPLATE.read_text(encoding="utf-8")
    tw_block = re.search(
        r'<script[^>]*src="/static/vendor/tailwind\.min\.js"[^>]*>', text, re.DOTALL
    )
    assert tw_block is not None, "login.html has no script tag for vendored tailwind"
    m = _INTEGRITY_RE.search(tw_block.group(0))
    assert m is not None, "tailwind script tag has no integrity attribute"
    template_hash = m.group(1)
    file_hash = _sha384_b64(VENDOR_FILES["tailwind"])
    assert template_hash == file_hash


# ---------------------------------------------------------------------------
# Rendered page references local assets (end-to-end smoke)
# ---------------------------------------------------------------------------


def test_rendered_index_page_references_local_assets(
    empty_audit_files: tuple[Path, Path],
) -> None:
    """The rendered shell index HTML references local vendored assets, not CDN."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert "/static/vendor/htmx.min.js" in body, "rendered index does not reference local htmx"
    assert "/static/vendor/tailwind.min.js" in body, (
        "rendered index does not reference local tailwind"
    )
    assert "unpkg.com/htmx.org" not in body, "rendered index still references htmx CDN"
    assert "cdn.tailwindcss.com" not in body, "rendered index still references tailwind CDN"


def test_rendered_login_page_references_local_tailwind(
    empty_audit_files: tuple[Path, Path],
) -> None:
    """The rendered login page references local tailwind, not CDN.

    Uses team-server mode because embedded mode does not mount the
    ``/auth/*`` router (``/auth/login`` would 404 in embedded mode).
    """
    config = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9000,
        modules_path=MODULES_DIR,
        auth=__import__(
            "neuralgentics.web.config",
            fromlist=["AuthConfig"],
        ).AuthConfig(
            auth_mode="jwt",
            db_path=Path("/tmp/test-vendor-login-users.db"),
            jwt_secret="vendor-test-secret",
        ),
    )
    app = build_app(config)
    with TestClient(app) as client:
        r = client.get("/auth/login")
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:200]}"
    body = r.text
    assert "/static/vendor/tailwind.min.js" in body, (
        "rendered login does not reference local tailwind"
    )
    assert "cdn.tailwindcss.com" not in body, "rendered login still references tailwind CDN"


# ---------------------------------------------------------------------------
# Startup warning when a vendored asset is missing
# ---------------------------------------------------------------------------


def test_startup_warns_when_vendor_asset_missing(
    empty_audit_files: tuple[Path, Path],
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a vendored asset is missing at startup, log a loud warning (not crash).

    Mirrors the T-120 ``_check_chartjs_present`` startup check. We
    monkeypatch VENDOR_ASSETS to point at non-existent paths so we don't
    have to actually delete the real files.
    """
    from neuralgentics.web import app as app_mod

    fake_assets = (
        ("htmx", Path("/nonexistent/htmx.min.js")),
        ("tailwind", Path("/nonexistent/tailwind.min.js")),
    )
    monkeypatch.setattr(app_mod, "VENDOR_ASSETS", fake_assets)
    with caplog.at_level("WARNING", logger="neuralgentics.web.app"):
        app = build_app(_config())
    assert app is not None
    warnings = [
        r
        for r in caplog.records
        if r.levelname == "WARNING" and ("htmx" in r.message or "tailwind" in r.message)
    ]
    assert warnings, (
        f"expected WARNINGs about missing htmx/tailwind, got records: "
        f"{[(r.levelname, r.message[:80]) for r in caplog.records]}"
    )
