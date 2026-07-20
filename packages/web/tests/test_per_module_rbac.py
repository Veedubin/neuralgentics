"""Per-module RBAC override tests (T-111).

Verifies that a module's ``module.yaml`` can override the global role
table via the optional ``rbac`` block, and that ``--rbac-mode`` controls
whether a missing action falls back to the global role (permissive) or
denies with 403 (strict).

Coverage:

  * ``test_per_module_rbac_allows_viewer_with_override`` — module declares
    ``view_memory: [viewer, operator, admin]``; viewer is allowed.
  * ``test_per_module_rbac_denies_viewer_with_override`` — module declares
    ``adjust_trust: [admin]``; viewer is denied (403).
  * ``test_per_module_rbac_strict_mode_denies_missing_action`` — strict
    mode + an action NOT declared in ``rbac.actions`` → 403.
  * ``test_per_module_rbac_permissive_mode_falls_back`` — permissive mode
    + an action NOT declared in ``rbac.actions`` → falls back to the
    fallback_roles (T-110 backwards compat).
  * ``test_module_route_action_decorator`` — assert ``__module_action__``
    is set on the function by :func:`module_route`.
  * ``test_hot_reload_picks_up_rbac_changes`` — change ``module.yaml`` to
    require ``admin`` for the action, hot-reload, assert viewer is now
    denied.
  * ``test_module_wide_required_role_floor`` — ``rbac.required_role``
    denies a viewer even if the action table would allow viewer.
  * ``test_default_manifest_reproduces_t110_behavior`` — a module with
    no ``rbac`` block keeps the T-110 global role behavior (backwards
    compat regression guard).

A throwaway ``permodrbac`` module is written to a temp dir so the tests
don't touch the packaged modules. The module exposes one read endpoint
``GET /modules/permodrbac`` tagged with action ``read`` and one write
endpoint ``POST /modules/permodrbac/write`` tagged with action ``write``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from neuralgentics.web.app import build_app
from neuralgentics.web.auth.jwt import issue_access_token
from neuralgentics.web.auth.users import UserStore
from neuralgentics.web.config import AuthConfig, WebConfig
from neuralgentics.web.modules.loader import module_route

SECRET = "per-module-rbac-test-secret-32-bytes-long"
MODULES_DIR = Path(__file__).resolve().parent.parent / "src" / "neuralgentics" / "web" / "modules"


# --------------------------------------------------------------------------------------
# Fixtures + helpers
# --------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mock_memini_backend() -> Any:
    """Force the memini-browser to use the in-memory mock backend."""
    os.environ["NEURALGENTICS_MEMINI_BACKEND"] = "mock"
    yield
    os.environ.pop("NEURALGENTICS_MEMINI_BACKEND", None)


@pytest.fixture(autouse=True)
def _audit_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Empty JSONL audit files for both audit modules."""
    gw = tmp_path / "audit.jsonl"
    gw.write_text("")
    monkeypatch.setenv("NEURALGENTICS_AUDIT_FILE", str(gw))
    bk = tmp_path / "broker-audit.jsonl"
    bk.write_text("")
    monkeypatch.setenv("NEURALGENTICS_BROKER_AUDIT_FILE", str(bk))
    return gw


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "per-module-rbac-users.db"


def _tok(role: str) -> str:
    return issue_access_token(role, role, secret=SECRET)


def _team_config(db_path: Path, *, rbac_mode: str = "permissive") -> WebConfig:
    cfg = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9877,
        modules_path=MODULES_DIR,
        rbac_mode=rbac_mode,  # type: ignore[arg-type]
    )
    cfg.auth = AuthConfig(
        auth_mode="jwt",
        jwt_secret=SECRET,
        db_path=db_path,
        refresh_rotation=True,
    )
    return cfg


# --------------------------------------------------------------------------------------
# module_route decorator unit test (no app needed)
# --------------------------------------------------------------------------------------


def test_module_route_action_decorator() -> None:
    """``module_route('foo')`` sets ``func.__module_action__ = 'foo'``."""

    @module_route("search")
    async def handler() -> None:
        return None

    assert getattr(handler, "__module_action__", None) == "search"


def test_module_route_rejects_empty_action() -> None:
    """Empty action names raise ValueError."""
    with pytest.raises(ValueError):
        module_route("")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        module_route("   ")


# --------------------------------------------------------------------------------------
# Real-module tests against the packaged memini-browser manifest (which
# declares the T-111 ``rbac`` block reproducing T-110 behavior).
# --------------------------------------------------------------------------------------


def test_default_manifest_reproduces_t110_behavior(db_path: Path) -> None:
    """The packaged memini-browser manifest declares ``rbac.actions`` that
    reproduce the T-110 global role table. A viewer can read, an operator
    can adjust trust, and only an admin can forget — exactly as before.

    This is the backwards-compat regression guard: if the manifest's
    ``rbac`` block drifts from T-110, this test fails.
    """
    UserStore(db_path)
    app = build_app(_team_config(db_path))
    with TestClient(app) as client:
        # Viewer can read (search / view_memory actions allow viewer).
        r = client.get(
            "/modules/memini-browser",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
        assert r.status_code == 200, r.text

        # Viewer cannot adjust trust (adjust_trust action: operator+ only).
        r = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
        assert r.status_code == 403, r.text

        # Operator can adjust trust.
        r = client.post(
            "/modules/memini-browser/memory/mem-001/trust",
            data={"signal": "user_confirmed"},
            headers={"Authorization": f"Bearer {_tok('operator')}"},
            follow_redirects=False,
        )
        assert r.status_code == 303, r.text

        # Viewer cannot forget (forget action: admin only).
        r = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
        assert r.status_code == 403, r.text

        # Operator cannot forget.
        r = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('operator')}"},
        )
        assert r.status_code == 403, r.text

        # Admin can forget.
        r = client.post(
            "/modules/memini-browser/memory/mem-001/forget",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
            follow_redirects=False,
        )
        assert r.status_code == 303, r.text


def test_per_module_rbac_allows_viewer_with_override(tmp_path: Path) -> None:
    """Module declares ``view_memory: [viewer, operator, admin]``; viewer
    is allowed (the manifest override is what admits the viewer, not the
    global fallback)."""

    modules_dir = _write_override_module(
        tmp_path,
        actions={
            "read": ["viewer", "operator", "admin"],
        },
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir))
    with TestClient(app) as client:
        r = client.get(
            "/modules/permodrbac",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert r.status_code == 200, r.text


def test_per_module_rbac_denies_viewer_with_override(tmp_path: Path) -> None:
    """Module declares ``write: [admin]``; viewer is denied (403) even
    though the global fallback would admit viewer+."""

    modules_dir = _write_override_module(
        tmp_path,
        actions={
            "read": ["viewer", "operator", "admin"],
            "write": ["admin"],
        },
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir))
    with TestClient(app) as client:
        r = client.post(
            "/modules/permodrbac/write",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert r.status_code == 403, r.text

    # Admin is allowed.
    with TestClient(build_app(_team_config_for_dir(db, modules_dir))) as client:
        r = client.post(
            "/modules/permodrbac/write",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
    assert r.status_code == 200, r.text


def test_per_module_rbac_strict_mode_denies_missing_action(tmp_path: Path) -> None:
    """Strict mode + an action NOT declared in ``rbac.actions`` → 403.

    The module declares only ``read``; the ``write`` action is absent.
    In strict mode the request is denied even though the global fallback
    (``admin,operator,viewer``) would admit the admin.
    """

    modules_dir = _write_override_module(
        tmp_path,
        actions={
            "read": ["viewer", "operator", "admin"],
        },
        # write action intentionally absent
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir, rbac_mode="strict"))
    with TestClient(app) as client:
        r = client.post(
            "/modules/permodrbac/write",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
    assert r.status_code == 403, r.text


def test_per_module_rbac_permissive_mode_falls_back(tmp_path: Path) -> None:
    """Permissive mode + an action NOT declared in ``rbac.actions`` →
    falls back to the global fallback_roles (T-110 backwards compat).

    The ``write`` route's fallback is ``("admin", "operator", "viewer")``
    so a viewer is admitted even though the manifest doesn't list the
    action.
    """

    modules_dir = _write_override_module(
        tmp_path,
        actions={
            "read": ["viewer", "operator", "admin"],
        },
        # write action intentionally absent → permissive falls back
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir, rbac_mode="permissive"))
    with TestClient(app) as client:
        r = client.post(
            "/modules/permodrbac/write",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert r.status_code == 200, r.text


def test_module_wide_required_role_floor(tmp_path: Path) -> None:
    """``rbac.required_role: operator`` denies a viewer on EVERY route in
    the module, even if the per-action table would allow viewer.

    The ``read`` action lists ``[viewer, operator, admin]```, but the
    module-wide floor is ``operator`` — so the viewer is denied before
    the action table is even consulted.
    """

    modules_dir = _write_override_module(
        tmp_path,
        required_role="operator",
        actions={
            "read": ["viewer", "operator", "admin"],
        },
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir))
    with TestClient(app) as client:
        r = client.get(
            "/modules/permodrbac",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert r.status_code == 403, r.text

    # Operator passes the floor and the action table.
    with TestClient(build_app(_team_config_for_dir(db, modules_dir))) as client:
        r = client.get(
            "/modules/permodrbac",
            headers={"Authorization": f"Bearer {_tok('operator')}"},
        )
    assert r.status_code == 200, r.text


def test_hot_reload_picks_up_rbac_changes(tmp_path: Path) -> None:
    """Change ``module.yaml`` to require ``admin`` for the ``read`` action,
    hot-reload, assert a viewer that was previously allowed is now denied
    (403). This proves the per-module RBAC dependency reads the live
    registry, not a snapshot taken at load time.
    """

    modules_dir = _write_override_module(
        tmp_path,
        actions={
            "read": ["viewer", "operator", "admin"],
        },
    )
    db = tmp_path / "users.db"
    UserStore(db)
    app = build_app(_team_config_for_dir(db, modules_dir))
    with TestClient(app) as client:
        # Baseline: viewer can read.
        r = client.get(
            "/modules/permodrbac",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
        assert r.status_code == 200, r.text

        # Edit module.yaml on disk: tighten read to admin-only.
        _write_override_module(
            tmp_path,
            actions={
                "read": ["admin"],
            },
        )

        # Hot-reload via the admin endpoint.
        rr = client.post(
            "/api/v1/modules/permodrbac/reload",
            headers={"Authorization": f"Bearer {_tok('admin')}"},
        )
        assert rr.status_code == 200, rr.text

        # Viewer is now denied (403) — the live registry picked up the
        # tightened manifest.
        r = client.get(
            "/modules/permodrbac",
            headers={"Authorization": f"Bearer {_tok('viewer')}"},
        )
    assert r.status_code == 403, r.text


# --------------------------------------------------------------------------------------
# Manifest schema validation tests
# --------------------------------------------------------------------------------------


def test_rbac_spec_rejects_unknown_role() -> None:
    """``rbac.required_role: superuser`` raises ValidationError."""
    from pydantic import ValidationError

    from neuralgentics.web.modules.registry import RbacSpec

    with pytest.raises(ValidationError):
        RbacSpec.model_validate({"required_role": "superuser"})


def test_rbac_spec_rejects_unknown_action_role() -> None:
    """``rbac.actions.read: [viewer, superuser]`` raises ValidationError."""
    from pydantic import ValidationError

    from neuralgentics.web.modules.registry import RbacSpec

    with pytest.raises(ValidationError):
        RbacSpec.model_validate({"actions": {"read": ["viewer", "superuser"]}})


def test_rbac_spec_rejects_empty_action_name() -> None:
    """``rbac.actions."": [...]`` raises ValidationError."""
    from pydantic import ValidationError

    from neuralgentics.web.modules.registry import RbacSpec

    with pytest.raises(ValidationError):
        RbacSpec.model_validate({"actions": {"": ["viewer"]}})


def test_rbac_spec_rejects_empty_action_roles() -> None:
    """``rbac.actions.read: []`` raises ValidationError."""
    from pydantic import ValidationError

    from neuralgentics.web.modules.registry import RbacSpec

    with pytest.raises(ValidationError):
        RbacSpec.model_validate({"actions": {"read": []}})


def test_rbac_spec_defaults_are_no_override() -> None:
    """A default RbacSpec has no required_role and no actions (pure
    permissive fallback = T-110 behavior)."""
    from neuralgentics.web.modules.registry import RbacSpec

    spec = RbacSpec()
    assert spec.required_role is None
    assert spec.actions == {}


# --------------------------------------------------------------------------------------
# CLI flag test
# --------------------------------------------------------------------------------------


def test_rbac_mode_cli_flag_accepted() -> None:
    """``--rbac-mode strict`` is accepted by the arg parser and threaded
    into the WebConfig."""
    from neuralgentics.web.__main__ import _parse_args

    args = _parse_args(["--mode", "embedded", "--rbac-mode", "strict"])
    assert args.rbac_mode == "strict"


def test_rbac_mode_env_var_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``NEURALGENTICS_WEB_RBAC_MODE=strict`` is picked up by from_args."""
    from neuralgentics.web.config import WebConfig

    monkeypatch.setenv("NEURALGENTICS_WEB_RBAC_MODE", "strict")
    cfg = WebConfig.from_args(
        mode="embedded",
        port=None,
        host=None,
        db_url=None,
        modules_path=str(MODULES_DIR),
    )
    assert cfg.rbac_mode == "strict"


def test_rbac_mode_invalid_rejected() -> None:
    """An invalid ``--rbac-mode`` value raises ValueError."""
    from neuralgentics.web.config import WebConfig

    with pytest.raises(ValueError):
        WebConfig.from_args(
            mode="embedded",
            port=None,
            host=None,
            db_url=None,
            modules_path=str(MODULES_DIR),
            rbac_mode="paranoid",
        )


# --------------------------------------------------------------------------------------
# Fixture: a temp module that uses per-module RBAC
# --------------------------------------------------------------------------------------


def _team_config_for_dir(
    db_path: Path, modules_dir: Path, *, rbac_mode: str = "permissive"
) -> WebConfig:
    cfg = WebConfig(
        mode="team-server",
        host="127.0.0.1",
        port=9877,
        modules_path=modules_dir,
        rbac_mode=rbac_mode,  # type: ignore[arg-type]
    )
    cfg.auth = AuthConfig(
        auth_mode="jwt",
        jwt_secret=SECRET,
        db_path=db_path,
        refresh_rotation=True,
    )
    return cfg


_MODULE_PY = """\
\"\"\"Per-module RBAC test module (T-111).\"\"\"

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from neuralgentics.web.auth.rbac import RbacMode, require_module_action
from neuralgentics.web.auth.users import User
from neuralgentics.web.modules.base import Module
from neuralgentics.web.modules.loader import module_route
from neuralgentics.web.modules.registry import ModuleManifest, ModuleRegistry


class PerModRbacModule(Module):
    \"\"\"A module exposing a read + a write route, both tagged with
    actions and gated by per-module RBAC.\"\"\"

    _registry: ModuleRegistry
    _rbac_mode: str

    def __init__(self, manifest: ModuleManifest) -> None:
        super().__init__(manifest=manifest)
        # Filled in by the loader after construction (T-111 injection).
        self._registry = None  # type: ignore[assignment]
        self._rbac_mode = "permissive"

    def build_router(self, **kwargs: Any) -> Any:
        registry = kwargs.get("registry", self._registry)
        rbac_mode = kwargs.get("rbac_mode", self._rbac_mode)
        if registry is None:
            # Defensive: build_app always injects the registry. If a test
            # constructs the module directly, fall back to permissive
            # global-role gating.
            from neuralgentics.web.auth.rbac import require_role

            read_dep = require_role("admin", "operator", "viewer")
            write_dep = require_role("admin", "operator", "viewer")
        else:
            read_dep = require_module_action(
                module_name="permodrbac",
                action="read",
                registry=registry,
                fallback_roles=("admin", "operator", "viewer"),
                rbac_mode=rbac_mode,
            )
            write_dep = require_module_action(
                module_name="permodrbac",
                action="write",
                registry=registry,
                fallback_roles=("admin", "operator", "viewer"),
                rbac_mode=rbac_mode,
            )

        router = APIRouter(tags=["permodrbac"])

        @router.get("/modules/permodrbac")
        @module_route("read")
        async def read_page(
            user: User | None = Depends(read_dep),
        ) -> JSONResponse:
            _ = user
            return JSONResponse({"ok": True, "action": "read"})

        @router.post("/modules/permodrbac/write")
        @module_route("write")
        async def write_page(
            user: User | None = Depends(write_dep),
        ) -> JSONResponse:
            _ = user
            return JSONResponse({"ok": True, "action": "write"})

        return router

    def start_background(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None


def build(manifest: ModuleManifest, config: Any) -> PerModRbacModule:
    return PerModRbacModule(manifest=manifest)


__all__ = ["PerModRbacModule", "build"]
"""

_INIT_PY = '"""permodrbac package"""\n'


def _write_override_module(
    tmp_path: Path,
    *,
    actions: dict[str, list[str]],
    required_role: str | None = None,
) -> Path:
    """Write (or overwrite) the ``permodrbac`` module to a temp ``modules/``
    dir under ``tmp_path`` and return the modules dir.

    The module exposes one read endpoint (action ``read``) and one write
    endpoint (action ``write``). The ``module.yaml`` ``rbac`` block is
    built from ``actions`` and ``required_role``.
    """
    modules_dir = tmp_path / "modules"
    pkg = modules_dir / "permodrbac"
    pkg.mkdir(parents=True, exist_ok=True)

    # Build the rbac YAML block.
    rbac_lines: list[str] = ["rbac:"]
    if required_role is not None:
        rbac_lines.append(f"  required_role: {required_role}")
    if actions:
        rbac_lines.append("  actions:")
        for action, roles in actions.items():
            rbac_lines.append(f"    {action}: [{', '.join(roles)}]")
    if not actions and required_role is None:
        # Empty rbac block (no override).
        rbac_lines = ["rbac: {}"]
    rbac_yaml = "\n".join(rbac_lines)

    yaml = f"""\
name: permodrbac
version: 0.1.0
display_name: "Per-Module RBAC Test"
description: "throwaway module for T-111 per-module RBAC tests"
author: Veedubin
license: MIT
{rbac_yaml}
routes:
  - path: /modules/permodrbac
    method: GET
    template: stub.html
api_endpoints: []
sse_channels: []
data_sources: []
"""
    (pkg / "module.yaml").write_text(yaml)
    (pkg / "module.py").write_text(_MODULE_PY)
    (pkg / "__init__.py").write_text(_INIT_PY)
    return modules_dir
