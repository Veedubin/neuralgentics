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
