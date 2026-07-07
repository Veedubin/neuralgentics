"""Tests for :mod:`neuralgentics.merge`.

Covers every edge case in §4.5 of the init-cli design doc plus the
real-world fixture described in the card's acceptance criteria.
"""

from __future__ import annotations

import json

import pytest

from neuralgentics.errors import OpenCodeJsonInvalid
from neuralgentics.merge import (
    INSTRUCTIONS_REFERENCE,
    PLUGIN_REFERENCE,
    format_diff_for_display,
    merge_opencode_json,
    merge_opencode_json_with_diff,
    parse_opencode_json,
    serialize_opencode_json,
)

# ---------------------------------------------------------------------------
# merge_opencode_json — core algorithm
# ---------------------------------------------------------------------------


def test_merge_empty_user(real_shipped_opencode_json: dict) -> None:
    """Empty user → all shipped values come through (§4.5 'no existing file')."""
    result = merge_opencode_json({}, real_shipped_opencode_json)
    # Provider from shipped comes through (user had none to preserve).
    assert result["provider"] == real_shipped_opencode_json["provider"]
    assert result["plugin"] == real_shipped_opencode_json["plugin"]
    assert result["instructions"] == real_shipped_opencode_json["instructions"]
    assert result["mcp"] == real_shipped_opencode_json["mcp"]
    assert result["lsp"] == real_shipped_opencode_json["lsp"]
    assert result["formatter"] == real_shipped_opencode_json["formatter"]
    assert result["small_model"] == "ollama/gemma4:31b-cloud"


def test_merge_empty_shipped(real_user_opencode_json: dict) -> None:
    """Empty shipped → user is preserved entirely."""
    result = merge_opencode_json(real_user_opencode_json, {})
    assert result == real_user_opencode_json


def test_merge_does_not_mutate_inputs(
    real_user_opencode_json: dict, real_shipped_opencode_json: dict
) -> None:
    user_snapshot = json.loads(json.dumps(real_user_opencode_json))
    shipped_snapshot = json.loads(json.dumps(real_shipped_opencode_json))
    merge_opencode_json(real_user_opencode_json, real_shipped_opencode_json)
    assert real_user_opencode_json == user_snapshot
    assert real_shipped_opencode_json == shipped_snapshot


def test_merge_preserves_provider(
    real_user_opencode_json: dict, real_shipped_opencode_json: dict
) -> None:
    result = merge_opencode_json(real_user_opencode_json, real_shipped_opencode_json)
    # User's ollama provider wins; shipped ollama-cloud is NOT merged in.
    assert "ollama" in result["provider"]
    assert "ollama-cloud" not in result["provider"]
    assert result["provider"]["ollama"]["options"]["baseURL"] == "http://localhost:11434/v1"


def test_merge_adds_plugin_idempotent() -> None:
    shipped = {"plugin": [PLUGIN_REFERENCE]}
    user = {"plugin": [PLUGIN_REFERENCE]}
    result = merge_opencode_json(user, shipped)
    assert result["plugin"] == [PLUGIN_REFERENCE]


def test_merge_adds_plugin_when_missing() -> None:
    shipped = {"plugin": [PLUGIN_REFERENCE]}
    user = {"plugin": ["other-plugin"]}
    result = merge_opencode_json(user, shipped)
    assert result["plugin"] == ["other-plugin", PLUGIN_REFERENCE]


def test_merge_adds_instructions_idempotent() -> None:
    shipped = {"instructions": [INSTRUCTIONS_REFERENCE]}
    user = {"instructions": [INSTRUCTIONS_REFERENCE]}
    result = merge_opencode_json(user, shipped)
    assert result["instructions"] == [INSTRUCTIONS_REFERENCE]


def test_merge_adds_instructions_when_missing() -> None:
    shipped = {"instructions": [INSTRUCTIONS_REFERENCE]}
    user = {"instructions": ["OTHER.md"]}
    result = merge_opencode_json(user, shipped)
    assert result["instructions"] == ["OTHER.md", INSTRUCTIONS_REFERENCE]


def test_merge_preserves_user_mcp() -> None:
    shipped = {"mcp": {"foo": {"command": ["shipped"]}}}
    user = {"mcp": {"foo": {"command": ["user"]}}}
    result = merge_opencode_json(user, shipped)
    assert result["mcp"]["foo"] == {"command": ["user"]}


def test_merge_adds_new_mcp() -> None:
    shipped = {"mcp": {"foo": {"command": ["shipped"]}, "bar": {"command": ["shipped-bar"]}}}
    user = {"mcp": {"foo": {"command": ["user"]}}}
    result = merge_opencode_json(user, shipped)
    assert result["mcp"]["foo"] == {"command": ["user"]}
    assert result["mcp"]["bar"] == {"command": ["shipped-bar"]}


def test_merge_preserves_user_lsp() -> None:
    shipped = {"lsp": {"python": {"command": "shipped-lsp"}}}
    user = {"lsp": {"python": {"command": "user-lsp"}}}
    result = merge_opencode_json(user, shipped)
    assert result["lsp"]["python"] == {"command": "user-lsp"}


def test_merge_preserves_user_formatter() -> None:
    shipped = {"formatter": {"python": {"command": "shipped-fmt"}}}
    user = {"formatter": {"python": {"command": "user-fmt"}}}
    result = merge_opencode_json(user, shipped)
    assert result["formatter"]["python"] == {"command": "user-fmt"}


def test_merge_adds_missing_scalars() -> None:
    shipped = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": True,
        "tool_output": "stream",
        "compaction": {"enabled": True},
        "small_model": "ollama/gemma4:31b-cloud",
    }
    user = {"plugin": []}
    result = merge_opencode_json(user, shipped)
    for key in ("$schema", "autoupdate", "tool_output", "compaction", "small_model"):
        assert key in result
    assert result["$schema"] == shipped["$schema"]
    assert result["small_model"] == shipped["small_model"]


def test_merge_does_not_overwrite_existing_scalars() -> None:
    shipped = {"$schema": "shipped-schema", "small_model": "shipped-model"}
    user = {"$schema": "user-schema", "small_model": "user-model"}
    result = merge_opencode_json(user, shipped)
    assert result["$schema"] == "user-schema"
    assert result["small_model"] == "user-model"


def test_merge_does_not_remove_extras(
    real_user_opencode_json: dict, real_shipped_opencode_json: dict
) -> None:
    """User-only top-level key (not in shipped) is preserved."""
    result = merge_opencode_json(real_user_opencode_json, real_shipped_opencode_json)
    assert result["custom_key"] == "user-only-value"


# ---------------------------------------------------------------------------
# merge_opencode_json_with_diff
# ---------------------------------------------------------------------------


def test_merge_with_diff_empty(real_shipped_opencode_json: dict) -> None:
    """Merging shipped with itself → no diff."""
    result, changes = merge_opencode_json_with_diff(
        real_shipped_opencode_json, real_shipped_opencode_json
    )
    assert changes == []
    assert result == real_shipped_opencode_json


def test_merge_with_diff_plugin_added() -> None:
    shipped = {"plugin": [PLUGIN_REFERENCE]}
    user = {"plugin": ["other"]}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert f"Added {PLUGIN_REFERENCE!r} to plugin array" in changes


def test_merge_with_diff_instructions_added() -> None:
    shipped = {"instructions": [INSTRUCTIONS_REFERENCE]}
    user = {"instructions": ["OTHER.md"]}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert f"Added {INSTRUCTIONS_REFERENCE!r} to instructions array" in changes


def test_merge_with_diff_mcp_added() -> None:
    shipped = {"mcp": {"searxng": {"command": ["x"]}}}
    user = {"mcp": {"foo": {"command": ["y"]}}}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert "Added MCP server 'searxng'" in changes


def test_merge_with_diff_lsp_added() -> None:
    shipped = {"lsp": {"python": {"command": "x"}}}
    user = {}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert "Added LSP server 'python'" in changes


def test_merge_with_diff_formatter_added() -> None:
    shipped = {"formatter": {"python": {"command": "x"}}}
    user = {}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert "Added formatter 'python'" in changes


def test_merge_with_diff_scalar_added() -> None:
    shipped = {"small_model": "ollama/gemma4:31b-cloud", "$schema": "x"}
    user = {}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    assert "Set small_model" in changes
    assert "Set $schema" in changes


def test_merge_with_diff_preserves_user_mcp_no_change() -> None:
    shipped = {"mcp": {"foo": {"command": ["shipped"]}}}
    user = {"mcp": {"foo": {"command": ["user"]}}}
    _, changes = merge_opencode_json_with_diff(user, shipped)
    # User already has 'foo' → no change recorded.
    assert changes == []


# ---------------------------------------------------------------------------
# format_diff_for_display
# ---------------------------------------------------------------------------


def test_format_diff_for_display_empty() -> None:
    assert format_diff_for_display([]) == ""


def test_format_diff_for_display_multiple() -> None:
    out = format_diff_for_display(["Added foo", "Set bar"])
    assert out == "  + Added foo\n  + Set bar"


# ---------------------------------------------------------------------------
# parse / serialize
# ---------------------------------------------------------------------------


def test_parse_invalid_json() -> None:
    with pytest.raises(OpenCodeJsonInvalid) as exc_info:
        parse_opencode_json("{not valid json")
    assert exc_info.value.exit_code == 3
    assert "not valid JSON" in str(exc_info.value)


def test_parse_non_object_json() -> None:
    with pytest.raises(OpenCodeJsonInvalid):
        parse_opencode_json("[1, 2, 3]")


def test_parse_valid_json() -> None:
    parsed = parse_opencode_json('{"a": 1}')
    assert parsed == {"a": 1}


def test_serialize_roundtrip() -> None:
    text = '{"b": 2, "a": 1, "plugin": ["x"]}\n'
    parsed_once = parse_opencode_json(text)
    serialized = serialize_opencode_json(parsed_once)
    parsed_twice = parse_opencode_json(serialized)
    assert parsed_twice == parsed_once


def test_serialize_is_sorted_and_indented() -> None:
    out = serialize_opencode_json({"b": 1, "a": 2})
    # Keys sorted alphabetically, 2-space indent, trailing newline.
    assert out == '{\n  "a": 2,\n  "b": 1\n}\n'


# ---------------------------------------------------------------------------
# Real-world fixture (the most important test)
# ---------------------------------------------------------------------------


def test_real_opencode_json_fixture(
    real_user_opencode_json: dict, real_shipped_opencode_json: dict
) -> None:
    """Merge a realistic user config with the shipped config and verify
    the exact expected output structure."""
    result, changes = merge_opencode_json_with_diff(
        real_user_opencode_json, real_shipped_opencode_json
    )

    # 1. Plugin: user had one entry; shipped adds neuralgentics (idempotent on
    #    the shared one).
    assert PLUGIN_REFERENCE in result["plugin"]
    assert "@franlol/opencode-md-table-formatter@latest" in result["plugin"]
    # No duplicates.
    assert len(result["plugin"]) == len(set(result["plugin"]))

    # 2. Instructions: both have AGENTS.md → single entry.
    assert result["instructions"] == [INSTRUCTIONS_REFERENCE]

    # 3. Provider: user's 'ollama' preserved; shipped 'ollama-cloud' NOT added.
    assert "ollama" in result["provider"]
    assert "ollama-cloud" not in result["provider"]

    # 4. MCP: user's searxng preserved (user version wins), my-custom kept,
    #    memini-ai-dev added from shipped.
    assert result["mcp"]["searxng"]["command"] == ["docker", "run", "searxng"]
    assert "my-custom" in result["mcp"]
    assert "memini-ai-dev" in result["mcp"]

    # 5. LSP: user's python preserved (user version wins).
    assert result["lsp"]["python"]["command"] == "ruff-lsp"

    # 6. Formatter: user had none → shipped python formatter added.
    assert result["formatter"] == {"python": {"command": "black"}}

    # 7. Scalars: user was missing autoupdate/tool_output/compaction/small_model.
    assert result["autoupdate"] is True
    assert result["tool_output"] == "stream"
    assert result["compaction"] == {"enabled": True}
    assert result["small_model"] == "ollama/gemma4:31b-cloud"
    # $schema was present in user → preserved.
    assert result["$schema"] == "https://opencode.ai/config.json"

    # 8. User-only custom_key preserved.
    assert result["custom_key"] == "user-only-value"

    # 9. Diff records the additions (not the preserves).
    assert f"Added {PLUGIN_REFERENCE!r} to plugin array" in changes
    assert "Added MCP server 'memini-ai-dev'" in changes
    assert "Added formatter 'python'" in changes
    assert "Set autoupdate" in changes
    assert "Set tool_output" in changes
    assert "Set compaction" in changes
    assert "Set small_model" in changes
    # Things that were preserved (no diff entries).
    assert "Set $schema" not in changes  # user already had it
    assert "Added MCP server 'searxng'" not in changes  # user already had it
    assert "Added LSP server 'python'" not in changes  # user already had it

    # 10. Idempotency: merging the result again yields the same dict + empty diff.
    result2, changes2 = merge_opencode_json_with_diff(result, real_shipped_opencode_json)
    assert result2 == result
    assert changes2 == []


# ---------------------------------------------------------------------------
# Idempotency on full merge
# ---------------------------------------------------------------------------


def test_merge_idempotent_full(
    real_user_opencode_json: dict, real_shipped_opencode_json: dict
) -> None:
    """Running merge twice produces identical output."""
    once = merge_opencode_json(real_user_opencode_json, real_shipped_opencode_json)
    twice = merge_opencode_json(once, real_shipped_opencode_json)
    assert once == twice
