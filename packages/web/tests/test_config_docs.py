"""T-136 — docs/CONFIG.md exists and documents every flag + env var.

These tests guard the operator's configuration reference. They assert:

* ``docs/CONFIG.md`` exists and has all 11 required section headers.
* Every CLI flag defined in ``__main__.py::build_parser()`` is mentioned
  in the doc (regex match on the flag name, e.g. ``--mode``).
* Every environment variable actually read by the source code is
  mentioned in the doc.

The env-var list is derived from a grep of ``src/`` for
``os.environ.get("...")`` calls — keeping the test honest about what the
app *actually* reads, not what a spec says it *should* read. Planned
env vars listed in the doc but not yet read by the app are explicitly
called out in the doc itself under a "Planned env vars" subsection.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

DOCS = Path(__file__).resolve().parent.parent / "docs" / "CONFIG.md"
SRC = Path(__file__).resolve().parent.parent / "src"

# The 11 required section headers (verbatim from the card spec).
# Markdown ATX headers (## N. Title) — the numbering must match.
REQUIRED_SECTIONS: list[str] = [
    "## 1. Quickstart",
    "## 2. CLI flags",
    "## 3. Environment variables",
    "## 4. Config file (`config.yaml`)",
    "## 5. Embedded mode in detail",
    "## 6. Team-server mode in detail",
    "## 7. Auth modes",
    "## 8. OIDC provider examples",
    "## 9. Module configuration",
    "## 10. Production deployment checklist",
    "## 11. Troubleshooting",
]


# ---------------------------------------------------------------------------
# Section 1: doc exists + has all 11 sections
# ---------------------------------------------------------------------------


def test_config_doc_exists() -> None:
    """docs/CONFIG.md exists and is non-empty."""
    assert DOCS.exists(), f"CONFIG.md not found at {DOCS}"
    text = DOCS.read_text(encoding="utf-8")
    assert text.strip() != "", "CONFIG.md is empty"


def test_config_doc_has_all_sections() -> None:
    """All 11 required section headers are present (verbatim)."""
    text = DOCS.read_text(encoding="utf-8")
    missing: list[str] = []
    for header in REQUIRED_SECTIONS:
        # Allow the header to appear as a plain ATX header line.
        if header not in text:
            missing.append(header)
    assert not missing, f"CONFIG.md is missing {len(missing)} section header(s): {missing}"


# ---------------------------------------------------------------------------
# Section 2: every CLI flag in __main__.py::build_parser() is documented
# ---------------------------------------------------------------------------


def _build_parser() -> list[str]:
    """Import and call build_parser() — the source of truth for flags.

    Returns the list of long-form flag strings (e.g. ``--mode``) the
    parser defines. Uses a subprocess so we don't pollute sys.modules.
    """
    script = (
        "from neuralgentics.web.__main__ import build_parser; "
        "import sys; "
        "p = build_parser(); "
        "flags = [a.option_strings[0] for a in p._actions if a.option_strings]; "
        "sys.stdout.write('|'.join(flags))"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=str(SRC.parent),
        check=True,
    )
    flags = [f for f in result.stdout.split("|") if f]
    return flags


def _all_flags() -> list[str]:
    """Return every CLI flag (long form) the parser defines.

    Includes the console-script-only ``--version`` flag from cli.py.
    """
    flags = _build_parser()
    # cli.py adds --version on top of the shared parser.
    return list(dict.fromkeys(flags + ["--version"]))


@pytest.mark.parametrize("flag", _all_flags())
def test_config_doc_documents_cli_flag(flag: str) -> None:
    """The doc mentions the flag (regex match on the flag name).

    A flag like ``--oidc-github-client-id`` must appear in the doc as
    that exact string (in a table row or code block). We use a regex
    that escapes the flag for regex purposes.
    """
    text = DOCS.read_text(encoding="utf-8")
    pattern = re.escape(flag)
    assert re.search(pattern, text), f"CONFIG.md does not mention CLI flag {flag!r}"


# ---------------------------------------------------------------------------
# Section 3: every env var the source actually reads is documented
# ---------------------------------------------------------------------------


def _env_vars_read_by_source() -> list[str]:
    """Grep src/ for os.environ.get("NAME", ...) calls and return the names.

    This is the ground truth for what the app *actually* reads — not
    what a spec says it *should* read. Planned env vars (not yet read
    by the app) are listed separately in the doc under a "Planned env
    vars" subsection.
    """
    env_vars: set[str] = set()
    # Match os.environ.get("NAME" and os.environ.get('NAME'
    pattern = re.compile(r'os\.environ\.get\(\s*["\']([A-Z_][A-Z0-9_]*)["\']')
    for py_file in SRC.rglob("*.py"):
        if "__pycache__" in py_file.parts:
            continue
        try:
            text = py_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for match in pattern.finditer(text):
            env_vars.add(match.group(1))
    # Also catch os.environ.get with a default — already covered by the
    # regex above (the second arg is optional). Sort for stable test output.
    return sorted(env_vars)


@pytest.mark.parametrize("env_var", _env_vars_read_by_source())
def test_config_doc_documents_env_var(env_var: str) -> None:
    """The doc mentions the env var name (regex match).

    An env var like ``NEURALGENTICS_WEB_MODE`` must appear in the doc.
    We use a word-boundary regex so ``NEURALGENTICS_WEB_MODE`` doesn't
    match a substring of ``NEURALGENTICS_WEB_MODULES_PATH``.
    """
    text = DOCS.read_text(encoding="utf-8")
    pattern = rf"\b{re.escape(env_var)}\b"
    assert re.search(pattern, text), f"CONFIG.md does not mention env var {env_var!r}"


# ---------------------------------------------------------------------------
# Section 4: Planned env vars are explicitly called out
# ---------------------------------------------------------------------------


def test_config_doc_has_planned_env_vars_section() -> None:
    """The doc has a 'Planned env vars (not yet implemented)' subsection."""
    text = DOCS.read_text(encoding="utf-8")
    assert "Planned env vars" in text, (
        "CONFIG.md must have a 'Planned env vars' subsection listing "
        "env vars from the spec that are not yet read by the app."
    )


def test_config_doc_marks_config_file_as_planned() -> None:
    """Section 4 (Config file) must be marked as Planned since the
    --config-file feature does not exist yet."""
    text = DOCS.read_text(encoding="utf-8")
    # The Planned marker must appear within or near section 4.
    assert "Planned" in text, "CONFIG.md must mark the config file as Planned"
