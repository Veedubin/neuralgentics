"""Module base class — what every neuralgentics-web module implements.

A stub module only needs a ``module.yaml`` and an ``__init__.py``.
Full modules (T-106+) provide route handlers, SSE channels, etc.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from neuralgentics.web.modules.registry import ModuleManifest


class ModuleContext(BaseModel):
    """Context passed to a module's render/handler functions.

    Carries the request, current user (team-server), and mode info.
    """

    mode: str = "embedded"
    user: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class Module(BaseModel):
    """Base class for a neuralgentics-web module.

    Subclasses override ``render`` and (optionally) ``register_routes``.
    For v0.1 / T-105, stubs are not required to subclass this — the registry
    can render a placeholder purely from the manifest.
    """

    manifest: ModuleManifest

    model_config = {"arbitrary_types_allowed": True}

    async def render(self, ctx: ModuleContext) -> str:
        """Return rendered HTML for this module's default page."""
        return (
            "<div class='module-stub'>"
            f"<h2>{self.manifest.display_name}</h2>"
            f"<p>{self.manifest.description}</p>"
            "<p class='coming-soon'>Coming in T-10X</p>"
            "</div>"
        )

    async def register_routes(self, app: Any) -> None:
        """Register HTTP routes with a FastAPI app. Override for real modules."""
        return None
