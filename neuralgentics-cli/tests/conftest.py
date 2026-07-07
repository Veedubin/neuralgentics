"""Shared pytest fixtures for the neuralgentics CLI test suite."""

from __future__ import annotations

from copy import deepcopy

import pytest


@pytest.fixture
def real_shipped_opencode_json() -> dict:
    """A minimal config mirroring ``neuralgentics/.opencode/opencode.json``.

    Includes the five structural pieces the merge cares about: ``plugin``,
    ``instructions``, ``provider``, ``mcp``/``lsp``/``formatter``, and a few
    top-level scalars.
    """
    return {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": True,
        "tool_output": "stream",
        "compaction": {"enabled": True},
        "small_model": "ollama/gemma4:31b-cloud",
        "plugin": ["@veedubin/neuralgentics", "@franlol/opencode-md-table-formatter@latest"],
        "instructions": ["AGENTS.md"],
        "provider": {
            "ollama-cloud": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama Cloud",
                "options": {"baseURL": "https://ollama.com/v1"},
                "models": {"kimi-k2.6:cloud": {"name": "Kimi K2.6 (Cloud)"}},
            }
        },
        "mcp": {
            "searxng": {
                "type": "local",
                "command": ["uv", "run", "searxng"],
                "environment": {"SEARXNG_URL": "http://localhost:8888"},
            },
            "memini-ai-dev": {
                "type": "local",
                "command": ["uv", "run", "memini-ai"],
            },
        },
        "lsp": {
            "python": {"command": "pylsp"},
        },
        "formatter": {
            "python": {"command": "black"},
        },
    }


@pytest.fixture
def real_user_opencode_json() -> dict:
    """A pre-existing user config with a custom provider + one MCP server."""
    return {
        "$schema": "https://opencode.ai/config.json",
        "plugin": ["@franlol/opencode-md-table-formatter@latest"],
        "instructions": ["AGENTS.md"],
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Local Ollama",
                "options": {"baseURL": "http://localhost:11434/v1"},
                "models": {"llama3:8b": {"name": "Llama 3 8B"}},
            }
        },
        "mcp": {
            "searxng": {
                "type": "local",
                "command": ["docker", "run", "searxng"],
            },
            "my-custom": {
                "type": "local",
                "command": ["./my-server"],
            },
        },
        "lsp": {
            "python": {"command": "ruff-lsp"},
        },
        "custom_key": "user-only-value",
    }


@pytest.fixture
def deep_copy():
    """Expose ``copy.deepcopy`` as a fixture for convenience."""
    return deepcopy
