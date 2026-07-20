"""T-134 — Standalone-installability tests for neuralgentics-web.

These tests guard the invariant that ``pip install neuralgentics-web`` works
on its own, WITHOUT ``memini-ai`` or ``asyncpg`` installed:

* ``test_no_neuralgentics_imports_outside_web`` — no ``neuralgentics.X``
  (X != ``web``) imports anywhere in the source tree. Those would pull in
  sibling packages (broker, orchestrator, memory) and break standalone
  install.
* ``test_no_required_memini_ai_imports`` — the web imports cleanly in a
  fresh subprocess that has ``memini_ai`` blocked. The memini-browser's
  SDK backend is a SOFT import — it raises a clear RuntimeError only when
  actually used, not at module load.
* ``test_no_required_asyncpg_imports`` — same idea for ``asyncpg``: the
  web imports cleanly with asyncpg blocked. asyncpg is only needed by the
  team-server PG backends and is in the ``[team-server]`` extra.
* ``test_pyproject_lists_all_runtime_deps`` — AST-walk every ``import X``
  / ``from X import Y`` in ``src/`` and assert each third-party top-level
  package is declared in ``pyproject.toml``'s ``dependencies`` (or in an
  ``optional-dependencies`` extra, with a soft-import guard in the code).
* ``test_pyproject_optional_deps_have_correct_extras`` — for each declared
  extra, assert it covers the optional imports its features need.
  Specifically: ``[team-server]`` includes ``asyncpg``.
* ``test_soft_import_error_messages_are_actionable`` — when ``memini_ai``
  and ``asyncpg`` are blocked, actually exercising the soft-import paths
  raises RuntimeError with an install-hint message.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

SRC_ROOT = Path(__file__).resolve().parent.parent / "src"
PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"

# Modules that are part of the Python standard library or the
# ``neuralgentics.web`` namespace itself — never counted as third-party.
_STDLIB_PREFIXES: set[str] = set(sys.stdlib_module_names) | {
    "neuralgentics",
    "memini_ai",  # optional separate install — intentionally NOT a web dep
}


# ---------------------------------------------------------------------------
# 1. No neuralgentics.X imports outside the web namespace
# ---------------------------------------------------------------------------


def test_no_neuralgentics_imports_outside_web() -> None:
    """No ``import neuralgentics.X`` / ``from neuralgentics.X`` where X != web.

    Such an import would pull in a sibling package (broker, orchestrator,
    memory, ...) and break ``pip install neuralgentics-web`` standalone.
    """
    forbidden: list[str] = []
    for py in SRC_ROOT.rglob("*.py"):
        rel = py.relative_to(SRC_ROOT)
        text = py.read_text(encoding="utf-8")
        try:
            tree = ast.parse(text, filename=str(py))
        except SyntaxError as exc:  # pragma: no cover — defensive
            pytest.fail(f"SyntaxError parsing {rel}: {exc}")
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for n in node.names:
                    if n.name == "neuralgentics" or n.name.startswith("neuralgentics."):
                        sub = n.name.split(".", 2)[1] if "." in n.name else ""
                        if sub != "web":
                            forbidden.append(f"{rel}:{node.lineno} import {n.name}")
            elif (
                isinstance(node, ast.ImportFrom)
                and node.module
                and (node.module == "neuralgentics" or node.module.startswith("neuralgentics."))
            ):
                sub = node.module.split(".", 2)[1] if "." in node.module else ""
                if sub != "web":
                    forbidden.append(f"{rel}:{node.lineno} from {node.module} import ...")
    assert not forbidden, (
        "neuralgentics-web must be standalone — found imports from sibling "
        "neuralgentics packages:\n  " + "\n  ".join(forbidden)
    )


# ---------------------------------------------------------------------------
# 2 & 3. Web imports cleanly with memini_ai / asyncpg blocked
# ---------------------------------------------------------------------------


def _run_subprocess_with_blocked(modules_to_block: tuple[str, ...]) -> tuple[int, str]:
    """Run a fresh Python subprocess that blocks the given modules.

    Uses ``sys.meta_path`` filtering so the modules raise ImportError even
    if they happen to be installed in the subprocess's environment. Returns
    ``(returncode, combined_stdout_stderr)``.
    """
    blocker = textwrap.dedent(
        f"""
        import importlib.abc, importlib.machinery, sys

        _BLOCKED = {modules_to_block!r}

        class _Blocker(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                top = name.split(".", 1)[0]
                if top in _BLOCKED:
                    raise ImportError(
                        f"blocked by T-134 standalone test: {{name}}"
                    )
                return None

        # Insert at the FRONT of meta_path so we win over the real finders.
        sys.meta_path.insert(0, _Blocker())

        # Now import the web package top-level + every submodule we ship.
        import neuralgentics.web  # noqa: F401
        import neuralgentics.web.app  # noqa: F401
        import neuralgentics.web.cli  # noqa: F401
        import neuralgentics.web.config  # noqa: F401
        import neuralgentics.web.modes.embedded  # noqa: F401
        import neuralgentics.web.modes.team_server  # noqa: F401
        import neuralgentics.web.modules.loader  # noqa: F401
        import neuralgentics.web.modules.registry  # noqa: F401
        import neuralgentics.web.modules.memini_browser.memini_client  # noqa: F401
        import neuralgentics.web.modules.gateway_audit.data_source  # noqa: F401
        import neuralgentics.web.modules.broker_audit.data_source  # noqa: F401
        import neuralgentics.web.shell.routes  # noqa: F401
        import neuralgentics.web.auth.routes  # noqa: F401
        print("IMPORT_OK")
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", blocker],
        capture_output=True,
        text=True,
        cwd=str(SRC_ROOT.parent),
        env={**os.environ, "PYTHONPATH": str(SRC_ROOT)},
        timeout=30,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_no_required_memini_ai_imports() -> None:
    """``import neuralgentics.web`` (and all submodules) succeeds without memini_ai."""
    rc, out = _run_subprocess_with_blocked(("memini_ai",))
    assert rc == 0, (
        "neuralgentics-web should import cleanly without memini-ai installed.\n"
        f"Subprocess output:\n{out}"
    )
    assert "IMPORT_OK" in out


def test_no_required_asyncpg_imports() -> None:
    """``import neuralgentics.web`` (and all submodules) succeeds without asyncpg."""
    rc, out = _run_subprocess_with_blocked(("asyncpg",))
    assert rc == 0, (
        "neuralgentics-web should import cleanly without asyncpg installed "
        "(asyncpg is in the [team-server] extra).\n"
        f"Subprocess output:\n{out}"
    )
    assert "IMPORT_OK" in out


# ---------------------------------------------------------------------------
# 4. pyproject.toml declares every runtime third-party import
# ---------------------------------------------------------------------------


def _collect_third_party_imports() -> set[str]:
    """Return the set of third-party top-level package names imported in src/."""
    found: set[str] = set()
    for py in SRC_ROOT.rglob("*.py"):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except SyntaxError:  # pragma: no cover
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for n in node.names:
                    top = n.name.split(".", 1)[0]
                    if top not in _STDLIB_PREFIXES:
                        found.add(top)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                top = node.module.split(".", 1)[0]
                if top not in _STDLIB_PREFIXES:
                    found.add(top)
    return found


def _parse_pyproject_deps() -> tuple[set[str], dict[str, set[str]]]:
    """Parse dependencies + optional-dependencies from pyproject.toml.

    Returns ``(runtime_deps, extras)`` where ``extras`` maps
    ``extra_name -> {deps}``. Uses a tiny TOML-ish parser so we don't need
    Python 3.11+ ``tomllib`` at runtime (the test suite runs on 3.12+ but
    we keep this self-contained).
    """
    try:
        import tomllib  # type: ignore[import-not-found]
    except ModuleNotFoundError:  # pragma: no cover — 3.12+ always has tomllib
        import tomli as tomllib  # type: ignore[import-not-found,unused-ignore]

    with PYPROJECT.open("rb") as fh:
        data = tomllib.load(fh)
    runtime = {
        d.split(">")[0].split("<")[0].split("=")[0].split("[")[0].strip()
        for d in data["project"].get("dependencies", [])
    }
    extras: dict[str, set[str]] = {}
    for extra_name, deps in data["project"].get("optional-dependencies", {}).items():
        extras[extra_name] = {
            d.split(">")[0].split("<")[0].split("=")[0].split("[")[0].strip() for d in deps
        }
    return runtime, extras


# Distribution-name → import-name mapping. pyproject lists the PACKAGE
# name on PyPI; the source imports the module name. We map the few that
# differ.
_DIST_TO_IMPORT = {
    "pyjwt": "jwt",
    "pyyaml": "yaml",
    "sse-starlette": "sse_starlette",
    "python-multipart": "multipart",
    "pydantic-settings": "pydantic_settings",
    "pytest-asyncio": "pytest_asyncio",
}


def _normalize_for_lookup(dep_name: str) -> str:
    """Convert a PyPI distribution name to its likely import name."""
    key = dep_name.lower().replace("-", "_")
    return _DIST_TO_IMPORT.get(dep_name.lower(), key)


def test_pyproject_lists_all_runtime_deps() -> None:
    """Every third-party top-level import in src/ is declared in pyproject.toml.

    A dep may be declared either in ``dependencies`` or in one of the
    ``optional-dependencies`` extras (with the source code using a
    soft-import guard). Imports that are not declared anywhere are a
    standalone-install bug.
    """
    runtime, extras = _parse_pyproject_deps()
    all_declared = set(runtime)
    for extra_deps in extras.values():
        all_declared |= extra_deps

    # Map declared distribution names → import names.
    declared_imports = {_normalize_for_lookup(d) for d in all_declared}

    found = _collect_third_party_imports()
    # ``starlette`` is a transitive dep of fastapi — not declared directly
    # but always present when fastapi is installed. We don't require it to
    # be listed.
    found -= {"starlette"}

    missing = {f for f in found if f not in declared_imports}
    assert not missing, (
        "These third-party imports are not declared in pyproject.toml "
        "(neither in dependencies nor any optional-dependencies extra):\n  "
        + "\n  ".join(sorted(missing))
    )


# ---------------------------------------------------------------------------
# 5. optional-dependencies extras cover the imports they enable
# ---------------------------------------------------------------------------


def test_pyproject_optional_deps_have_correct_extras() -> None:
    """The ``[team-server]`` extra includes asyncpg (the only optional runtime dep).

    asyncpg is the one import in src/ that's gated behind a soft-import
    guard AND lives in an extra. memini_ai is intentionally NOT in any
    extra — it's a separate product the user installs themselves.
    """
    _runtime, extras = _parse_pyproject_deps()

    assert "team-server" in extras, "expected a [team-server] extra"
    team_server_imports = {_normalize_for_lookup(d) for d in extras["team-server"]}
    assert "asyncpg" in team_server_imports, (
        "[team-server] extra must include asyncpg — the team-server PG "
        "backends (gateway-audit, broker-audit, memini-browser PG fallback) "
        "all import it via the soft-import guard."
    )


# ---------------------------------------------------------------------------
# 6. Soft-import error messages are actionable
# ---------------------------------------------------------------------------


def test_soft_import_error_messages_are_actionable() -> None:
    """When memini_ai/asyncpg are blocked, exercising the soft-import paths
    raises RuntimeError with an install-hint message (not a bare ImportError).
    """
    script = textwrap.dedent(
        """
        import importlib.abc, sys, asyncio

        _BLOCKED = ("memini_ai", "asyncpg")

        class _Blocker(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                top = name.split(".", 1)[0]
                if top in _BLOCKED:
                    raise ImportError(f"blocked: {name}")
                return None

        sys.meta_path.insert(0, _Blocker())

        from neuralgentics.web._softimports import import_asyncpg
        from neuralgentics.web.modules.memini_browser.memini_client import (
            SDKMeminiClient,
        )

        # asyncpg helper
        try:
            import_asyncpg()
            print("ASYNCPG_NO_ERROR")
        except RuntimeError as exc:
            print("ASYNCPG_RUNTIME_ERROR:", str(exc))
        except ImportError:
            print("ASYNCPG_BARE_IMPORTERROR")

        # memini_ai SDK path
        async def _try_sdk():
            try:
                await SDKMeminiClient.create()
                print("SDK_NO_ERROR")
            except RuntimeError as exc:
                print("SDK_RUNTIME_ERROR:", str(exc))
            except ImportError:
                print("SDK_BARE_IMPORTERROR")

        asyncio.run(_try_sdk())
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=str(SRC_ROOT.parent),
        env={**os.environ, "PYTHONPATH": str(SRC_ROOT)},
        timeout=30,
    )
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, f"Subprocess failed:\n{out}"
    assert "ASYNCPG_RUNTIME_ERROR:" in out, (
        f"Expected RuntimeError from import_asyncpg(), got:\n{out}"
    )
    assert "pip install neuralgentics-web[team-server]" in out, (
        f"asyncpg error should mention the [team-server] extra. Got:\n{out}"
    )
    assert "SDK_RUNTIME_ERROR:" in out, (
        f"Expected RuntimeError from SDKMeminiClient.create(), got:\n{out}"
    )
    assert "memini-ai is not installed" in out, (
        f"SDK error should explain memini-ai is optional. Got:\n{out}"
    )
    assert "ASYNCPG_BARE_IMPORTERROR" not in out and "SDK_BARE_IMPORTERROR" not in out, (
        f"Soft imports must raise RuntimeError, not bare ImportError. Got:\n{out}"
    )


# ---------------------------------------------------------------------------
# 7. Defense against accidental future re-introduction (regex sweep)
# ---------------------------------------------------------------------------


def test_no_bare_deferred_asyncpg_or_memini_ai_imports() -> None:
    """No bare ``import asyncpg`` / ``from memini_ai...`` outside soft-import guards.

    The asyncpg helper (``neuralgentics.web._softimports.import_asyncpg``) and
    the SDKMeminiClient try/except are the ONLY sanctioned patterns. A bare
    ``import asyncpg`` or ``from memini_ai.X import Y`` anywhere else would
    leak the optional dep into module load and break standalone install.
    """
    bad: list[str] = []
    # Sanctioned locations for ``import asyncpg``:
    #   - _softimports.py (the helper itself)
    #   - modes/team_server.py (has its own try/except ImportError block)
    sanctioned_asyncpg = {
        Path("neuralgentics/web/_softimports.py"),
        Path("neuralgentics/web/modes/team_server.py"),
    }
    # memini_ai is only ever imported inside SDKMeminiClient.create()'s
    # try/except in memini_client.py — no other location is allowed.
    sanctioned_memini: set[Path] = {
        Path("neuralgentics/web/modules/memini_browser/memini_client.py"),
    }

    asyncpg_re = re.compile(r"^\s*import asyncpg\b|^\s*from asyncpg\b")
    memini_re = re.compile(r"^\s*import memini_ai\b|^\s*from memini_ai\b")

    for py in SRC_ROOT.rglob("*.py"):
        rel = py.relative_to(SRC_ROOT)
        for lineno, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
            if asyncpg_re.match(line) and rel not in sanctioned_asyncpg:
                bad.append(f"{rel}:{lineno}: {line.strip()}")
            if memini_re.match(line) and rel not in sanctioned_memini:
                bad.append(f"{rel}:{lineno}: {line.strip()}")
    assert not bad, (
        "Found bare deferred imports of optional deps outside sanctioned "
        "soft-import guards:\n  " + "\n  ".join(bad)
    )
