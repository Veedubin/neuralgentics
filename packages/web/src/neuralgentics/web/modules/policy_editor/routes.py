"""FastAPI routes for the policy_editor module (T-155 + T-156).

All routes share the ``/modules/policy-editor`` prefix and swap their
partials into the page's ``#policy-editor-body`` target via htmx. The
list page is the only full HTML page (extends base.html); every other
route returns a partial that swaps into the body.

Endpoints:

  * ``GET  /modules/policy-editor``                          — list page
  * ``GET  /modules/policy-editor/new``                       — new-policy form
  * ``GET  /modules/policy-editor/{filename}``                — view one
  * ``GET  /modules/policy-editor/{filename}/edit``           — edit form
  * ``GET  /modules/policy-editor/{filename}/history``        — diff vs .bak (T-156)
  * ``POST /modules/policy-editor/{filename}/validate``       — inline validation
  * ``POST /modules/policy-editor/{filename}/preview``        — diff preview (T-156)
  * ``POST /modules/policy-editor/{filename}/save``          — confirmed save
  * ``POST /modules/policy-editor/create``                   — create new file

RBAC: every action requires the ``manage_policy`` action; the module's
``module.yaml`` declares it for ``operator`` + ``admin`` only. The
fallback (when the manifest has no rbac.actions entry) is the same two
roles.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from jinja2 import ChoiceLoader, Environment, FileSystemLoader

from neuralgentics.web.auth.rbac import RbacMode, require_module_action
from neuralgentics.web.auth.users import User
from neuralgentics.web.modules.loader import module_route
from neuralgentics.web.modules.policy_editor.data_source import (
    PolicyEditorDataSource,
    sanitize_filename,
)
from neuralgentics.web.modules.policy_editor.diff import compute_diff, diff_has_changes
from neuralgentics.web.modules.policy_editor.gateway_client import trigger_reload
from neuralgentics.web.modules.policy_editor.schema import validate_policy_yaml
from neuralgentics.web.modules.registry import ModuleRegistry

log = logging.getLogger("neuralgentics.web.policy_editor.routes")

MODULE_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
SHELL_TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "shell" / "templates"

DEFAULT_TEMPLATE_NAME = "new_policy.yaml"

_MODULE_NAME = "policy-editor"
# Roles allowed to manage policies (operator + admin). The list page is
# read-only; the editor allows writes. We gate everything on the same
# action for simplicity — read access to a policy's contents is itself
# sensitive (it reveals what's allowed/denied).
_MANAGE_ROLES: tuple[str, ...] = ("admin", "operator")


def _make_templates() -> Jinja2Templates:
    """Jinja2 templates that resolve the module's templates first, then
    the shell's (so ``{% extends "base.html" %}`` works)."""
    env = Environment(
        loader=ChoiceLoader(
            [
                FileSystemLoader(str(MODULE_TEMPLATES_DIR)),
                FileSystemLoader(str(SHELL_TEMPLATES_DIR)),
            ]
        ),
        autoescape=True,
    )
    return Jinja2Templates(env=env)


TEMPLATES = _make_templates()


def _load_default_template() -> str:
    """Load the bundled new-policy template text."""
    p = MODULE_TEMPLATES_DIR / DEFAULT_TEMPLATE_NAME
    return p.read_text(encoding="utf-8")


def _dep(
    action: str, fallback: tuple[str, ...], *, registry: ModuleRegistry | None, rbac_mode: RbacMode
) -> Any:
    """Build the RBAC dependency for one action, mirroring gateway_audit."""
    if registry is not None:
        return require_module_action(
            module_name=_MODULE_NAME,
            action=action,
            registry=registry,
            fallback_roles=fallback,
            rbac_mode=rbac_mode,
        )
    from neuralgentics.web.auth.rbac import require_role

    return require_role(*fallback)


def _safe_filename_or_400(filename: str) -> str:
    """Sanitize a path param. Raises 400 on bad names."""
    try:
        return sanitize_filename(filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def build_router(
    data_source: PolicyEditorDataSource,
    *,
    registry: ModuleRegistry | None = None,
    rbac_mode: RbacMode = "permissive",
) -> APIRouter:
    """Construct the policy_editor APIRouter.

    T-111: when ``registry`` is provided, routes use per-module RBAC via
    :func:`require_module_action`; otherwise they fall back to the global
    :func:`require_role` table.
    """
    router = APIRouter(prefix="", tags=["policy-editor"])
    templates = TEMPLATES

    # ---- List ----

    @router.get("/modules/policy-editor", response_class=HTMLResponse)
    @module_route("view_list")
    async def policy_list(
        request: Request,
        user: User | None = Depends(
            _dep("view_list", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841 — RBAC gate only
        policies = [
            p.__dict__ | {"has_backup": data_source.has_backup(p.filename)}
            for p in data_source.list_policies()
        ]
        return templates.TemplateResponse(
            request,
            "policy_list.html",
            {
                "policies": policies,
                "policies_dir": str(data_source.policies_dir),
                "title": "Policy Editor",
                "mode": getattr(request.app.state, "mode", "embedded"),
            },
        )

    # ---- Gateway status (T-157) ----
    # Registered BEFORE the {filename} route so /modules/policy-editor/gateway-status
    # is not captured as a filename="gateway-status" view request.

    @router.get("/modules/policy-editor/gateway-status", response_class=HTMLResponse)
    @module_route("view_list")
    async def policy_gateway_status(
        request: Request,
        user: User | None = Depends(
            _dep("view_list", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        """Poll the gateway for its currently-loaded policy set.

        Returns a partial that swaps into the ``#gateway-status`` panel
        on the list page every 5s via htmx. Pull-based (no SSE) per the
        T-157 pragmatic scope. Falls back gracefully when the gateway
        is unreachable.
        """
        _ = user  # noqa: F841
        from neuralgentics.web.modules.policy_editor.gateway_client import fetch_status

        status = fetch_status()
        return templates.TemplateResponse(
            request,
            "_gateway_status.html",
            {"status": status},
        )

    # ---- New ----

    @router.get("/modules/policy-editor/new", response_class=HTMLResponse)
    @module_route("create_policy")
    async def policy_new(
        request: Request,
        user: User | None = Depends(
            _dep("create_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        return templates.TemplateResponse(
            request,
            "policy_new.html",
            {
                "template_content": _load_default_template(),
                "title": "New Policy",
            },
        )

    # ---- View ----

    @router.get("/modules/policy-editor/{filename}", response_class=HTMLResponse)
    @module_route("view_policy")
    async def policy_view(
        request: Request,
        filename: str,
        user: User | None = Depends(
            _dep("view_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        safe = _safe_filename_or_400(filename)
        policy = data_source.read(safe)
        if policy is None:
            raise HTTPException(status_code=404, detail=f"policy file not found: {safe}")
        return templates.TemplateResponse(
            request,
            "policy_view.html",
            {
                "policy": policy,
                "has_backup": data_source.has_backup(safe),
                "title": f"View {safe}",
            },
        )

    # ---- Edit ----

    @router.get("/modules/policy-editor/{filename}/edit", response_class=HTMLResponse)
    @module_route("edit_policy")
    async def policy_edit(
        request: Request,
        filename: str,
        user: User | None = Depends(
            _dep("edit_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        safe = _safe_filename_or_400(filename)
        policy = data_source.read(safe)
        if policy is None:
            raise HTTPException(status_code=404, detail=f"policy file not found: {safe}")
        return templates.TemplateResponse(
            request,
            "policy_edit.html",
            {
                "policy": policy,
                "title": f"Edit {safe}",
            },
        )

    # ---- History (T-156) ----

    @router.get("/modules/policy-editor/{filename}/history", response_class=HTMLResponse)
    @module_route("view_history")
    async def policy_history(
        request: Request,
        filename: str,
        user: User | None = Depends(
            _dep("view_history", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        safe = _safe_filename_or_400(filename)
        policy = data_source.read(safe)
        if policy is None:
            raise HTTPException(status_code=404, detail=f"policy file not found: {safe}")
        backup = data_source.read_backup(safe)
        backup_name = safe + ".bak"
        if backup is None:
            diff_lines: list[Any] = []
        else:
            diff_lines = compute_diff(
                backup,
                policy.raw,
                fromfile=backup_name,
                tofile=safe,
            )
        return templates.TemplateResponse(
            request,
            "policy_history.html",
            {
                "filename": safe,
                "backup_filename": backup_name,
                "backup_content": backup,
                "diff_lines": diff_lines,
                "title": f"History {safe}",
            },
        )

    # ---- Validate (inline, no save) ----

    @router.post("/modules/policy-editor/{filename}/validate", response_class=HTMLResponse)
    @module_route("edit_policy")
    async def policy_validate(
        request: Request,
        filename: str,
        content: str = Form(...),
        user: User | None = Depends(
            _dep("edit_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        _safe_filename_or_400(filename)
        result = validate_policy_yaml(content)
        return templates.TemplateResponse(
            request,
            "_validation.html",
            {"errors": [e.to_dict() for e in result.errors]},
        )

    # ---- Preview (T-156): diff confirmation step before save ----

    @router.post("/modules/policy-editor/{filename}/preview", response_class=HTMLResponse)
    @module_route("edit_policy")
    async def policy_preview(
        request: Request,
        filename: str,
        content: str = Form(...),
        user: User | None = Depends(
            _dep("edit_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        safe = _safe_filename_or_400(filename)
        # Validate FIRST — never show a diff for invalid YAML.
        result = validate_policy_yaml(content)
        if not result.valid:
            return templates.TemplateResponse(
                request,
                "_save_result.html",
                {
                    "saved": False,
                    "filename": safe,
                    "errors": [e.to_dict() for e in result.errors],
                    "error": None,
                },
            )
        # Compute the diff vs. the on-disk content (or empty if the file
        # doesn't exist yet, though the edit form normally implies it does).
        current = ""
        policy = data_source.read(safe)
        if policy is not None:
            current = policy.raw
        diff_lines = compute_diff(
            current, content, fromfile=f"current ({safe})", tofile=f"proposed ({safe})"
        )
        add_count = sum(1 for ln in diff_lines if ln.kind == "add")
        del_count = sum(1 for ln in diff_lines if ln.kind == "del")
        return templates.TemplateResponse(
            request,
            "policy_diff.html",
            {
                "filename": safe,
                "diff_lines": diff_lines,
                "add_count": add_count,
                "del_count": del_count,
                "proposed_content": content,
                "has_changes": diff_has_changes(diff_lines),
                "title": f"Confirm save {safe}",
            },
        )

    # ---- Save (confirmed) ----

    @router.post("/modules/policy-editor/{filename}/save", response_class=HTMLResponse)
    @module_route("edit_policy")
    async def policy_save(
        request: Request,
        filename: str,
        content: str = Form(...),
        user: User | None = Depends(
            _dep("edit_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        safe = _safe_filename_or_400(filename)
        result = data_source.save(safe, content)
        # T-157: after a successful save, ask the gateway to pick up
        # the new YAML immediately. Best-effort — the disk save is
        # already the source of truth; if the gateway is unreachable
        # the watcher poll will catch it within ~2s. Errors are
        # surfaced in the save partial so the operator knows the
        # gateway may be stale until the next poll.
        gateway_reload = trigger_reload() if result.saved else None
        return templates.TemplateResponse(
            request,
            "_save_result.html",
            {
                "saved": result.saved,
                "filename": result.filename,
                "backup_path": result.backup_path,
                "errors": result.validation_errors,
                "error": None,
                "gateway_reload": gateway_reload,
            },
        )

    # ---- Create ----

    @router.post("/modules/policy-editor/create", response_class=HTMLResponse)
    @module_route("create_policy")
    async def policy_create(
        request: Request,
        filename: str = Form(...),
        template: str = Form("default"),
        content: str | None = Form(None),
        user: User | None = Depends(
            _dep("create_policy", _MANAGE_ROLES, registry=registry, rbac_mode=rbac_mode)
        ),
    ) -> HTMLResponse:
        _ = user  # noqa: F841
        # If the form didn't send a content field (e.g. the user picked the
        # default template and the textarea was readonly), use the bundled
        # template text.
        template_text = content if content else _load_default_template()
        _ = template  # accepted for future expansion; only "default" today
        try:
            result = data_source.create(filename, template_text)
        except ValueError as exc:
            return templates.TemplateResponse(
                request,
                "_save_result.html",
                {
                    "saved": False,
                    "filename": filename,
                    "backup_path": None,
                    "errors": [],
                    "error": str(exc),
                    "gateway_reload": None,
                },
            )
        gateway_reload = trigger_reload() if result.saved else None
        return templates.TemplateResponse(
            request,
            "_save_result.html",
            {
                "saved": result.saved,
                "filename": result.filename,
                "backup_path": result.backup_path,
                "errors": result.validation_errors,
                "error": None if result.saved else "file already exists or template invalid",
                "gateway_reload": gateway_reload,
            },
        )

    return router


__all__ = ["build_router"]
