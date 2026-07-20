"""Tests for self-hosted Chart.js with SRI (T-120).

Closing the honest gap from T-118 (Chart.js via CDN with no SRI). These
tests verify:

  * The static file is on disk and non-empty.
  * ``GET /static/chart.umd.min.js`` serves the file with a JS content-type.
  * Both charts templates (broker-audit, gateway-audit) include an
    ``integrity="sha384-..."`` attribute and ``crossorigin="anonymous"``.
  * The integrity hash in the template matches the actual sha384 of the
    served file (so a tampered wheel build fails loudly).

We do not exercise Playwright here — the optional
``test_chart_loads_in_browser`` is covered by a separate marker if a
browser is available; see the ``playwright`` optional dependency in
``pyproject.toml``.
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
CHARTJS_FILE = STATIC_DIR / "chart.umd.min.js"

# Templates that load Chart.js. The static dir's parent is ``shell``; the
# modules live two levels up from the static dir (``web/modules/...``).
WEB_ROOT = STATIC_DIR.parent.parent
CHARTS_TEMPLATES = [
    WEB_ROOT / "modules" / "broker_audit" / "templates" / "charts.html",
    WEB_ROOT / "modules" / "gateway_audit" / "templates" / "charts.html",
]

# Regex to extract the integrity="sha384-<b64>" attribute from a template.
_INTEGRITY_RE = re.compile(r'integrity="sha384-([A-Za-z0-9+/=]+)"')


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


def test_static_file_exists() -> None:
    """The self-hosted Chart.js file is on disk and non-empty."""
    assert CHARTJS_FILE.is_file(), f"Chart.js static file missing at {CHARTJS_FILE}"
    size = CHARTJS_FILE.stat().st_size
    # The canonical Chart.js 4.4.0 UMD bundle is ~200 KB. Allow a generous
    # lower bound so a future patch bump doesn't trip the test, but reject
    # empty / stub / placeholder files.
    assert size > 50_000, f"Chart.js static file is suspiciously small ({size} bytes)"


def test_static_file_served(empty_audit_files: tuple[Path, Path]) -> None:
    """``GET /static/chart.umd.min.js`` returns 200 with a JS content-type."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/static/chart.umd.min.js")
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:200]}"
    ctype = r.headers.get("content-type", "")
    assert "javascript" in ctype, f"expected javascript content-type, got {ctype!r}"
    # Body is non-empty and matches the on-disk file.
    body = r.content
    assert len(body) > 50_000, f"served body is suspiciously small ({len(body)} bytes)"
    assert body == CHARTJS_FILE.read_bytes(), "served body does not match on-disk file"


@pytest.mark.parametrize("template_path", CHARTS_TEMPLATES)
def test_template_has_sri(template_path: Path) -> None:
    """Each charts template includes ``integrity="sha384-..."``."""
    assert template_path.is_file(), f"template missing: {template_path}"
    text = template_path.read_text(encoding="utf-8")
    m = _INTEGRITY_RE.search(text)
    assert m is not None, (
        f'no integrity="sha384-..." attribute in {template_path.name}; '
        f"the template may have regressed to the CDN script tag"
    )
    assert len(m.group(1)) > 0, "integrity attribute present but hash is empty"


@pytest.mark.parametrize("template_path", CHARTS_TEMPLATES)
def test_template_has_crossorigin(template_path: Path) -> None:
    """Each charts template includes ``crossorigin="anonymous"``."""
    text = template_path.read_text(encoding="utf-8")
    assert 'crossorigin="anonymous"' in text, (
        f'missing crossorigin="anonymous" in {template_path.name}'
    )


@pytest.mark.parametrize("template_path", CHARTS_TEMPLATES)
def test_sri_hash_matches(template_path: Path) -> None:
    """The integrity hash in the template matches the actual sha384 of the file."""
    text = template_path.read_text(encoding="utf-8")
    m = _INTEGRITY_RE.search(text)
    assert m is not None, f"no integrity attribute in {template_path.name}"
    template_hash = m.group(1)
    file_hash = _sha384_b64(CHARTJS_FILE)
    assert template_hash == file_hash, (
        f"integrity hash mismatch in {template_path.name}: "
        f"template={template_hash!r} file={file_hash!r}. "
        f"Either the static file was tampered/replaced, or the template's "
        f"integrity attribute was not updated to match the file."
    )


def test_chartjs_served_via_rendered_page(empty_audit_files: tuple[Path, Path]) -> None:
    """The rendered broker-audit charts HTML references the local file (not CDN).

    Smoke test that the Jinja2 template actually renders the new script tag
    (catches a regression where someone edits the template to remove the
    ``head_extra`` block).
    """
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/broker-audit/charts")
    assert r.status_code == 200
    body = r.text
    assert "/static/chart.umd.min.js" in body, (
        "rendered page does not reference the local Chart.js file"
    )
    assert "cdn.jsdelivr.net" not in body, "rendered page still references the CDN"
    assert 'integrity="sha384-' in body


def test_startup_warns_when_chartjs_missing(
    empty_audit_files: tuple[Path, Path],
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the static file is missing at startup, log a loud warning (not crash).

    This exercises the ``_check_chartjs_present`` startup check added in
    T-120. We monkeypatch the path to a non-existent file so we don't have
    to actually delete the real asset.
    """
    from neuralgentics.web import app as app_mod

    fake_path = Path("/nonexistent/chart.umd.min.js")
    monkeypatch.setattr(app_mod, "CHARTJS_STATIC_PATH", fake_path)
    with caplog.at_level("WARNING", logger="neuralgentics.web.app"):
        app = build_app(_config())
    # build_app returns successfully even when the file is missing.
    assert app is not None
    # At least one WARNING record mentions Chart.js.
    warnings = [r for r in caplog.records if r.levelname == "WARNING" and "Chart.js" in r.message]
    assert warnings, (
        f"expected a WARNING about missing Chart.js, got records: "
        f"{[(r.levelname, r.message[:80]) for r in caplog.records]}"
    )
