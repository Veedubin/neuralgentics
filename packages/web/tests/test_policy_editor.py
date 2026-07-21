"""Tests for the policy_editor module (T-155 + T-156).

Covers:
  * Schema validation against the gateway's policy YAML shape.
  * Filename sanitization (path-traversal rejection).
  * Atomic save + .bak backup.
  * List/view/edit/create routes (embedded mode, auth=off).
  * Diff preview (T-156) — confirm + cancel flows.
  * History view against the .bak.

The policies directory is pointed at a tmp_path via
``NEURALGENTICS_POLICIES_DIR`` so tests don't touch the user's real
``~/.neuralgentics/policies``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.config import WebConfig
from neuralgentics.web.modules.policy_editor.data_source import (
    PolicyEditorDataSource,
    sanitize_filename,
)
from neuralgentics.web.modules.policy_editor.diff import compute_diff, diff_has_changes
from neuralgentics.web.modules.policy_editor.gateway_client import (
    GatewayStatus,
    ReloadResult,
    trigger_reload,
)
from neuralgentics.web.modules.policy_editor.schema import validate_policy_yaml

MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"

VALID_POLICY = """\
version: "2026-07-20"
statements:
  - sid: "allow-github-read"
    effect: "Allow"
    principals:
      - "nrn:neuralgentics:mcp:*"
    actions:
      - "nrn:neuralgentics:http:GET://api.github.com/*"
    resources:
      - "nrn:neuralgentics:http:GET://api.github.com/*"
"""

VALID_POLICY_V2 = """\
version: "2026-07-20"
statements:
  - sid: "allow-github-read"
    effect: "Deny"
    principals:
      - "nrn:neuralgentics:mcp:*"
    actions:
      - "nrn:neuralgentics:http:GET://api.github.com/*"
    resources:
      - "nrn:neuralgentics:http:GET://api.github.com/*"
"""


# ---------------------------------------------------------------------------
# Schema validator
# ---------------------------------------------------------------------------


def test_valid_policy_passes() -> None:
    result = validate_policy_yaml(VALID_POLICY)
    assert result.valid, result.error_messages
    assert result.parsed is not None
    assert result.parsed["statements"][0]["sid"] == "allow-github-read"


def test_missing_version_fails() -> None:
    bad = "statements: []\n"
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any(e.field == "version" for e in result.errors)


def test_missing_statements_key_fails() -> None:
    bad = 'version: "2026-07-20"\n'
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any(e.field == "statements" for e in result.errors)


def test_empty_statements_list_is_valid() -> None:
    bad = 'version: "2026-07-20"\nstatements: []\n'
    result = validate_policy_yaml(bad)
    assert result.valid, result.error_messages


def test_invalid_effect_value_fails() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Maybe"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any("effect" in e.field for e in result.errors)


def test_missing_effect_in_statement_fails() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any(e.field == "effect" for e in result.errors)


def test_bad_nrn_prefix_rejected() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    principals:
      - "arn:aws:neuralgentics:mcp:foo"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any("principals" in e.field for e in result.errors)


def test_bad_nrn_resource_type_rejected() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    actions:
      - "nrn:neuralgentics:s3:get"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any("actions" in e.field for e in result.errors)


def test_http_nrn_wildcard_method_ok() -> None:
    ok = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    actions:
      - "nrn:neuralgentics:http:*://api.github.com/**"
"""
    result = validate_policy_yaml(ok)
    assert result.valid, result.error_messages


def test_tool_nrn_wildcard_ok() -> None:
    ok = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    actions:
      - "nrn:neuralgentics:tool:**"
"""
    result = validate_policy_yaml(ok)
    assert result.valid, result.error_messages


def test_mcp_identity_with_colon_rejected() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    principals:
      - "nrn:neuralgentics:mcp:bad:name"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid


def test_invalid_audit_level_rejected() -> None:
    bad = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    condition:
      audit_level: "chatty"
"""
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any("audit_level" in e.field for e in result.errors)


def test_unknown_top_level_field_accepted() -> None:
    """Mirrors the Go loader's silent-ignore behaviour for unknown keys."""
    ok = """\
version: "2026-07-20"
statements: []
unknown_future_field: {foo: bar}
"""
    result = validate_policy_yaml(ok)
    assert result.valid, result.error_messages


def test_unknown_statement_field_accepted() -> None:
    ok = """\
version: "2026-07-20"
statements:
  - sid: "x"
    effect: "Allow"
    future_field: 123
"""
    result = validate_policy_yaml(ok)
    assert result.valid, result.error_messages


def test_malformed_yaml_fails_clean() -> None:
    bad = "version: '2026\nstatements: [\n"
    result = validate_policy_yaml(bad)
    assert not result.valid
    assert any(e.field == "yaml" for e in result.errors)


def test_non_mapping_top_level_fails() -> None:
    result = validate_policy_yaml("- 1\n- 2\n")
    assert not result.valid
    assert any(e.field == "yaml" for e in result.errors)


# ---------------------------------------------------------------------------
# Filename sanitizer
# ---------------------------------------------------------------------------


def test_sanitize_adds_yaml_extension() -> None:
    assert sanitize_filename("mcp-foo") == "mcp-foo.yaml"


def test_sanitize_keeps_yaml_extension() -> None:
    assert sanitize_filename("mcp-foo.yaml") == "mcp-foo.yaml"


def test_sanitize_keeps_yml_extension() -> None:
    assert sanitize_filename("mcp-foo.yml") == "mcp-foo.yml"


def test_sanitize_rejects_path_separator() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("foo/bar.yaml")


def test_sanitize_rejects_backslash() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("foo\\bar.yaml")


def test_sanitize_rejects_dotdot() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("../etc/passwd.yaml")


def test_sanitize_rejects_empty() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("")


def test_sanitize_rejects_bad_extension() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("foo.txt")


def test_sanitize_rejects_null_byte() -> None:
    with pytest.raises(ValueError):
        sanitize_filename("foo\x00bar.yaml")


# ---------------------------------------------------------------------------
# Diff helper (T-156)
# ---------------------------------------------------------------------------


def test_compute_diff_identical_returns_empty() -> None:
    assert compute_diff("a\nb\n", "a\nb\n") == []


def test_compute_diff_addition() -> None:
    lines = compute_diff("a\n", "a\nb\n")
    assert diff_has_changes(lines)
    assert any(ln.kind == "add" and ln.text == "b" for ln in lines)


def test_compute_diff_deletion() -> None:
    lines = compute_diff("a\nb\n", "a\n")
    assert diff_has_changes(lines)
    assert any(ln.kind == "del" and ln.text == "b" for ln in lines)


def test_diff_has_changes_false_for_context_only() -> None:
    lines = compute_diff("a\n", "a\n")
    assert not diff_has_changes(lines)


# ---------------------------------------------------------------------------
# Data source (atomic save + .bak)
# ---------------------------------------------------------------------------


def test_data_source_save_creates_file(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    result = ds.save("foo.yaml", VALID_POLICY)
    assert result.saved
    assert (tmp_path / "foo.yaml").is_file()
    assert result.backup_path is None  # file didn't exist before


def test_data_source_save_creates_backup_on_overwrite(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    ds.save("foo.yaml", VALID_POLICY)
    result = ds.save("foo.yaml", VALID_POLICY_V2)
    assert result.saved
    assert result.backup_path is not None
    assert result.backup_path.is_file()
    # Backup should hold the ORIGINAL content (v1), not v2.
    assert "Allow" in result.backup_path.read_text()
    # Current file holds v2.
    assert "Deny" in (tmp_path / "foo.yaml").read_text()


def test_data_source_save_rejects_invalid_yaml(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    result = ds.save("foo.yaml", "not: valid: yaml:\n  - [")
    assert not result.saved
    assert result.validation_errors
    assert not (tmp_path / "foo.yaml").exists()


def test_data_source_create_rejects_existing(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    ds.create("foo.yaml", VALID_POLICY)
    result = ds.create("foo.yaml", VALID_POLICY)
    assert not result.saved


def test_data_source_list_picks_up_files(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    ds.save("a.yaml", VALID_POLICY)
    ds.save("b.yaml", VALID_POLICY)
    infos = ds.list_policies()
    names = sorted(i.filename for i in infos)
    assert names == ["a.yaml", "b.yaml"]
    assert all(i.valid for i in infos)
    assert all(i.statement_count == 1 for i in infos)


def test_data_source_list_skips_bak_files(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    ds.save("a.yaml", VALID_POLICY)
    ds.save("a.yaml", VALID_POLICY_V2)  # creates a.yaml.bak
    infos = ds.list_policies()
    assert sorted(i.filename for i in infos) == ["a.yaml"]


def test_data_source_read_returns_none_when_missing(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    assert ds.read("nope.yaml") is None


def test_data_source_has_backup(tmp_path: Path) -> None:
    ds = PolicyEditorDataSource(tmp_path)
    ds.save("a.yaml", VALID_POLICY)
    assert not ds.has_backup("a.yaml")
    ds.save("a.yaml", VALID_POLICY_V2)
    assert ds.has_backup("a.yaml")
    assert ds.read_backup("a.yaml") is not None


# ---------------------------------------------------------------------------
# Routes (embedded mode, auth=off so RBAC gate is a pass-through)
# ---------------------------------------------------------------------------


@pytest.fixture
def policies_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the data source at a fresh tmp dir."""
    d = tmp_path / "policies"
    d.mkdir()
    monkeypatch.setenv("NEURALGENTICS_POLICIES_DIR", str(d))
    return d


def _config() -> WebConfig:
    return WebConfig(mode="embedded", host="127.0.0.1", port=9876, modules_path=MODULES_DIR)


def test_list_page_renders_empty(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor")
    assert r.status_code == 200
    assert "Policy Editor" in r.text
    assert "No policy files found" in r.text


def test_list_page_shows_existing_file(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor")
    assert r.status_code == 200
    assert "mcp-test.yaml" in r.text
    assert "valid" in r.text


def test_view_page_renders_statements(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/mcp-test.yaml")
    assert r.status_code == 200
    assert "allow-github-read" in r.text
    assert "api.github.com" in r.text


def test_view_page_404_for_missing(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/nope.yaml")
    assert r.status_code == 404


def test_view_page_400_for_bad_filename(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        # The sanitizer rejects names with bad extensions; the route
        # surfaces the ValueError as a 400.
        r = client.get("/modules/policy-editor/bad.txt")
    assert r.status_code == 400


def test_edit_page_renders_textarea(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/mcp-test.yaml/edit")
    assert r.status_code == 200
    assert "<textarea" in r.text
    assert "allow-github-read" in r.text


def test_validate_endpoint_returns_inline_errors(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/foo.yaml/validate",
            data={"content": "not: valid: yaml:\n  - ["},
        )
    assert r.status_code == 200
    assert "validation error" in r.text.lower() or "yaml parse" in r.text.lower()


def test_validate_endpoint_returns_success(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/foo.yaml/validate",
            data={"content": VALID_POLICY},
        )
    assert r.status_code == 200
    assert "valid" in r.text.lower()


def test_preview_blocks_invalid_yaml(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/foo.yaml/preview",
            data={"content": "version: '2026'\nstatements: [{effect: Maybe}]"},
        )
    assert r.status_code == 200
    assert "Save blocked" in r.text


def test_preview_shows_diff_for_valid_change(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/mcp-test.yaml/preview",
            data={"content": VALID_POLICY_V2},
        )
    assert r.status_code == 200
    assert "Confirm save" in r.text
    # Should include a "Del" of the Allow line and an "Add" of the Deny line.
    assert "Deny" in r.text
    assert "Allow" in r.text


def test_save_writes_file_after_confirm(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/mcp-test.yaml/save",
            data={"content": VALID_POLICY_V2},
        )
    assert r.status_code == 200
    assert "Saved" in r.text
    # File on disk was updated.
    on_disk = (policies_dir / "mcp-test.yaml").read_text()
    assert "Deny" in on_disk
    # Backup was created with the original.
    bak = policies_dir / "mcp-test.yaml.bak"
    assert bak.is_file()
    assert "Allow" in bak.read_text()


def test_save_rejects_invalid(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/foo.yaml/save",
            data={"content": "version: '2026'\nstatements: [{effect: Maybe}]"},
        )
    assert r.status_code == 200
    assert "Save blocked" in r.text
    # File was NOT written.
    assert not (policies_dir / "foo.yaml").exists()


def test_create_new_policy(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/create",
            data={"filename": "mcp-new", "template": "default"},
        )
    assert r.status_code == 200
    assert "Saved" in r.text
    assert (policies_dir / "mcp-new.yaml").is_file()


def test_create_rejects_duplicate(policies_dir: Path) -> None:
    (policies_dir / "dup.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/create",
            data={"filename": "dup", "template": "default"},
        )
    assert r.status_code == 200
    assert not r.text.count("Saved")  # not saved
    # The original file is untouched.
    assert "Allow" in (policies_dir / "dup.yaml").read_text()


def test_create_rejects_bad_filename(policies_dir: Path) -> None:
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/create",
            data={"filename": "../escape", "template": "default"},
        )
    assert r.status_code == 200
    assert "Save blocked" in r.text or "must" in r.text
    assert not (policies_dir.parent / "escape.yaml").exists()


def test_history_view_no_backup(policies_dir: Path) -> None:
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/mcp-test.yaml/history")
    assert r.status_code == 200
    assert "No backup exists" in r.text


def test_history_view_with_backup(policies_dir: Path) -> None:
    ds = PolicyEditorDataSource(policies_dir)
    ds.save("mcp-test.yaml", VALID_POLICY)
    ds.save("mcp-test.yaml", VALID_POLICY_V2)  # creates .bak with v1
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/mcp-test.yaml/history")
    assert r.status_code == 200
    # The history diff shows the Allow line removed and the Deny line added.
    assert "Deny" in r.text


def test_cancel_returns_to_editor_with_content(policies_dir: Path) -> None:
    """The diff page's "Cancel" link targets the edit endpoint; the editor
    re-reads the file from disk (so content is preserved by virtue of
    not having been saved yet)."""
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        # Cancel = GET the edit page again.
        r = client.get("/modules/policy-editor/mcp-test.yaml/edit")
    assert r.status_code == 200
    assert "allow-github-read" in r.text  # original content preserved


def test_save_atomic_no_tmp_file_left(policies_dir: Path) -> None:
    """After a successful save, no .tmp file should remain in the dir."""
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)
    app = build_app(_config())
    with TestClient(app) as client:
        client.post(
            "/modules/policy-editor/mcp-test.yaml/save",
            data={"content": VALID_POLICY_V2},
        )
    tmp_files = list(policies_dir.glob("*.tmp"))
    assert tmp_files == [], tmp_files


# ---------------------------------------------------------------------------
# Gateway reload + status (T-157)
# ---------------------------------------------------------------------------


def test_trigger_reload_noop_when_gateway_url_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When NEURALGENTICS_GATEWAY_URL is unset, trigger_reload returns a
    no-op result and never makes a network call."""
    monkeypatch.delenv("NEURALGENTICS_GATEWAY_URL", raising=False)
    result = trigger_reload()
    assert result.ok
    assert result.loaded == 0
    assert result.error is not None
    assert "unset" in result.error.lower()


def test_trigger_reload_handles_unreachable_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A connection error returns ok=False with a human-readable error,
    not an exception."""
    # Point at a port that refuses connections (the loopback port 1
    # is reserved and refuses connections on Linux).
    monkeypatch.setenv("NEURALGENTICS_GATEWAY_URL", "http://127.0.0.1:1")
    result = trigger_reload()
    assert not result.ok
    assert result.error is not None
    assert "unreachable" in result.error.lower() or "connect" in result.error.lower()


def test_trigger_reload_reports_success_from_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the gateway returns 200 with a loaded count, trigger_reload
    surfaces it in the result."""
    import httpx

    import neuralgentics.web.modules.policy_editor.gateway_client as gc

    def fake_post(url: str, **kwargs: object) -> httpx.Response:
        assert url.endswith("/api/v1/policies/reload")
        return httpx.Response(
            200,
            json={
                "loaded": 3,
                "statements": 12,
                "reloaded_at": "2026-07-20T12:00:00Z",
                "errors": [],
            },
        )

    monkeypatch.setattr(gc.httpx, "post", fake_post)
    monkeypatch.setenv("NEURALGENTICS_GATEWAY_URL", "http://gateway.test")
    result = trigger_reload()
    assert result.ok
    assert result.loaded == 3
    assert result.statements == 12
    assert result.error is None


def test_trigger_reload_surfaces_gateway_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the gateway returns 200 but errors[] is non-empty (kept-last
    -good-set), trigger_reload returns ok=False with the message."""
    import httpx

    import neuralgentics.web.modules.policy_editor.gateway_client as gc

    def fake_post(url: str, **kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "loaded": 0,
                "statements": 0,
                "reloaded_at": "2026-07-20T12:00:00Z",
                "errors": ["reload failed: invalid YAML at a.yaml:5"],
            },
        )

    monkeypatch.setattr(gc.httpx, "post", fake_post)
    monkeypatch.setenv("NEURALGENTICS_GATEWAY_URL", "http://gateway.test")
    result = trigger_reload()
    assert not result.ok
    assert "invalid YAML" in (result.error or "")


def test_fetch_status_reports_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("NEURALGENTICS_GATEWAY_URL", raising=False)
    status = _fetch_status_safe()
    assert not status.reachable


def test_fetch_status_parses_gateway_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    import neuralgentics.web.modules.policy_editor.gateway_client as gc

    def fake_get(url: str, **kwargs: object) -> httpx.Response:
        assert url.endswith("/api/v1/policies/status")
        return httpx.Response(
            200,
            json={
                "enabled": True,
                "files": [{"name": "a.yaml", "statements": 2}],
                "statements": 2,
                "default_decision": "deny",
                "watch_enabled": True,
                "watch_interval_seconds": 2.0,
                "last_reload": "2026-07-20T12:00:00Z",
                "gateway_policies_dir": "/home/u/.neuralgentics/policies",
            },
        )

    monkeypatch.setattr(gc.httpx, "get", fake_get)
    monkeypatch.setenv("NEURALGENTICS_GATEWAY_URL", "http://gateway.test")
    status = _fetch_status_safe()
    assert status.reachable
    assert status.enabled
    assert status.statements == 2
    assert status.default_decision == "deny"
    assert status.watch_enabled
    assert status.watch_interval_seconds == 2.0
    assert status.last_reload == "2026-07-20T12:00:00Z"
    assert status.gateway_policies_dir.endswith("policies")
    assert status.files is not None and len(status.files) == 1


def _fetch_status_safe() -> GatewayStatus:
    """Helper: import fetch_status lazily to avoid module-load side effects."""
    from neuralgentics.web.modules.policy_editor.gateway_client import fetch_status

    return fetch_status()


# ---- Routes that exercise the gateway client ----


def test_save_route_shows_gateway_reload_result(
    policies_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The save partial surfaces the gateway reload outcome (T-157)."""
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)

    # Stub trigger_reload to return a known-good result without
    # monkeypatching httpx (cleaner than the MockTransport dance for
    # the route-level test).
    import neuralgentics.web.modules.policy_editor.routes as routes_mod

    def fake_reload() -> ReloadResult:
        return ReloadResult(ok=True, loaded=3, statements=12)

    monkeypatch.setattr(routes_mod, "trigger_reload", fake_reload)

    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/mcp-test.yaml/save",
            data={"content": VALID_POLICY_V2},
        )
    assert r.status_code == 200
    assert "gateway reloaded" in r.text
    assert "3 files" in r.text
    assert "12 statements" in r.text


def test_save_route_shows_gateway_failure(
    policies_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A gateway reload failure is surfaced but the save still succeeds."""
    (policies_dir / "mcp-test.yaml").write_text(VALID_POLICY)

    import neuralgentics.web.modules.policy_editor.routes as routes_mod

    def fake_reload() -> ReloadResult:
        return ReloadResult(ok=False, error="gateway unreachable: connection refused")

    monkeypatch.setattr(routes_mod, "trigger_reload", fake_reload)

    app = build_app(_config())
    with TestClient(app) as client:
        r = client.post(
            "/modules/policy-editor/mcp-test.yaml/save",
            data={"content": VALID_POLICY_V2},
        )
    assert r.status_code == 200
    # Save succeeded (disk is source of truth).
    assert "Saved" in r.text
    # Reload failure surfaced.
    assert "gateway reload failed" in r.text
    assert "unreachable" in r.text


def test_gateway_status_route_unreachable(
    policies_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the gateway is unreachable, the status panel shows it."""
    monkeypatch.delenv("NEURALGENTICS_GATEWAY_URL", raising=False)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/gateway-status")
    assert r.status_code == 200
    assert "gateway unreachable" in r.text


def test_gateway_status_route_reachable(
    policies_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the gateway responds, the status panel shows the loaded set."""
    import neuralgentics.web.modules.policy_editor.gateway_client as gc

    def fake_fetch() -> GatewayStatus:
        return GatewayStatus(
            reachable=True,
            enabled=True,
            files=[{"name": "a.yaml", "statements": 2}],
            statements=2,
            default_decision="allow",
            watch_enabled=True,
            watch_interval_seconds=2.0,
            last_reload="2026-07-20T12:00:00Z",
            gateway_policies_dir="/home/u/.neuralgentics/policies",
        )

    monkeypatch.setattr(gc, "fetch_status", fake_fetch)
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor/gateway-status")
    assert r.status_code == 200
    assert "2" in r.text and "statements" in r.text
    assert "default: allow" in r.text
    assert "watcher on" in r.text


def test_list_page_includes_gateway_status_panel(policies_dir: Path) -> None:
    """The list page mounts the gateway status panel with hx-trigger polling."""
    app = build_app(_config())
    with TestClient(app) as client:
        r = client.get("/modules/policy-editor")
    assert r.status_code == 200
    assert "gateway-status-panel" in r.text
    assert "every 5s" in r.text
    assert "/modules/policy-editor/gateway-status" in r.text
