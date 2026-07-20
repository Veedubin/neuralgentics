"""Manifest schema + registry for discovered modules.

A manifest is the parsed ``module.yaml`` (Grafana-style plugin manifest).
The registry holds all manifests discovered at startup.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

log = logging.getLogger("neuralgentics.web.modules")


class RouteSpec(BaseModel):
    """One HTTP route a module declares."""

    path: str
    method: str = "GET"
    handler: str | None = None
    template: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)


class ApiEndpointSpec(BaseModel):
    """One API endpoint a module declares."""

    path: str
    method: str = "GET"
    handler: str = "stub"


class ModuleManifest(BaseModel):
    """Parsed ``module.yaml`` for one module.

    Modeled on Grafana's plugin.json: name/version/display_name/description/
    author + routes/api_endpoints/sse_channels/data_sources.
    """

    name: str
    version: str
    display_name: str
    description: str
    author: str = "Veedubin"
    license: str = "MIT"
    routes: list[RouteSpec] = Field(default_factory=list)
    api_endpoints: list[ApiEndpointSpec] = Field(default_factory=list)
    sse_channels: list[dict[str, Any]] = Field(default_factory=list)
    data_sources: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name_no_spaces(cls, v: str) -> str:
        if " " in v or "\t" in v:
            raise ValueError("module name must not contain whitespace")
        return v

    def to_summary(self) -> dict[str, Any]:
        """Compact JSON-serializable summary for /api/v1/modules."""
        return {
            "name": self.name,
            "version": self.version,
            "display_name": self.display_name,
            "description": self.description,
            "author": self.author,
            "license": self.license,
            "routes_count": len(self.routes),
            "api_endpoints_count": len(self.api_endpoints),
            "sse_channels": list(self.sse_channels),
            "data_sources": list(self.data_sources),
            "stub": True,
            "coming_in": _stub_target(self.name),
        }


def _stub_target(name: str) -> str:
    """Map each v0.1 stub module to its real-implementation card id."""
    return {
        "gateway-audit": "T-106",
        "broker-audit": "T-107",
        "memini-browser": "T-108",
    }.get(name, "future card")


class ModuleRegistry:
    """Holds all discovered manifests. Built once at startup by the loader."""

    def __init__(self) -> None:
        self._by_name: dict[str, ModuleManifest] = {}

    def register(self, manifest: ModuleManifest) -> None:
        if manifest.name in self._by_name:
            log.warning("module %s already registered — overwriting", manifest.name)
        self._by_name[manifest.name] = manifest
        log.info("registered module %s v%s", manifest.name, manifest.version)

    def all(self) -> list[ModuleManifest]:
        return sorted(self._by_name.values(), key=lambda m: m.name)

    def get(self, name: str) -> ModuleManifest | None:
        return self._by_name.get(name)

    def __len__(self) -> int:
        return len(self._by_name)

    def summaries(self) -> list[dict[str, Any]]:
        return [m.to_summary() for m in self.all()]


def parse_manifest(path: Path) -> ModuleManifest:
    """Parse and validate one ``module.yaml`` file."""
    if not path.exists():
        raise FileNotFoundError(f"module.yaml not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict):
        raise ValueError(f"module.yaml at {path} must be a mapping at top level")
    return ModuleManifest.model_validate(raw)
