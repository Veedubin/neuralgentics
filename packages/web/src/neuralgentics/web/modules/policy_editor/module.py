"""The policy_editor module (T-155 + T-156).

Provides a YAML editor for gateway policy files with server-side
validation mirroring the Go loader, atomic save + .bak backup, a diff
preview before save (T-156), and a one-level history view.

The data source is filesystem-only — the policies directory is
configured via ``NEURALGENTICS_POLICIES_DIR`` (default
``~/.neuralgentics/policies``, matching the gateway's
:go:func:`DefaultPoliciesDir`).
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import PrivateAttr

from neuralgentics.web.modules.base import Module
from neuralgentics.web.modules.policy_editor.data_source import (
    PolicyEditorDataSource,
    make_source_from_config,
)
from neuralgentics.web.modules.policy_editor.routes import build_router
from neuralgentics.web.modules.registry import ModuleManifest

log = logging.getLogger("neuralgentics.web.policy_editor")


class PolicyEditorModule(Module):
    """Full policy_editor module.

    Constructed by :func:`register_module_routes` after module discovery.
    Owns a single :class:`PolicyEditorDataSource`. No background tasks
    (everything is request-scoped file IO), so ``start_background`` and
    ``shutdown`` are no-ops.
    """

    _data_source: PolicyEditorDataSource = PrivateAttr()

    def __init__(self, manifest: ModuleManifest, data_source: PolicyEditorDataSource) -> None:
        super().__init__(manifest=manifest)
        self._data_source = data_source

    @property
    def data_source(self) -> PolicyEditorDataSource:
        return self._data_source

    def build_router(self, **kwargs: Any) -> Any:
        """Sync: return the FastAPI router for this module.

        Accepts optional ``registry=`` + ``rbac_mode=`` kwargs for
        per-module RBAC (T-111); unknown kwargs are ignored for backwards
        compat.
        """
        return build_router(self._data_source, **kwargs)

    def start_background(self) -> None:
        """No-op — the module has no background tasks."""

    async def shutdown(self) -> None:
        """No-op — the module holds no long-lived resources."""

    async def render(self, ctx: Any) -> str:
        """Default render — delegates to the GET /modules/policy-editor route."""
        return "<!-- policy_editor renders via its own router -->"


__all__ = ["PolicyEditorModule", "build"]


def build(manifest: ModuleManifest, config: Any) -> PolicyEditorModule:
    """Factory called by :func:`register_module_routes` to construct the
    module with a data source derived from the WebConfig."""
    data_source = make_source_from_config(config)
    return PolicyEditorModule(manifest, data_source)
