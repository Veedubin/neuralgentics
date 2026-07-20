"""neuralgentics.web.modules — discovery + registry + manifest schema."""

from neuralgentics.web.modules.loader import discover_modules
from neuralgentics.web.modules.registry import (
    ApiEndpointSpec,
    ModuleManifest,
    ModuleRegistry,
    RouteSpec,
    parse_manifest,
)

__all__ = [
    "ApiEndpointSpec",
    "ModuleManifest",
    "ModuleRegistry",
    "RouteSpec",
    "discover_modules",
    "parse_manifest",
]
