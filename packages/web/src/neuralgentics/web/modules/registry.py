"""Manifest schema + registry for discovered modules.

A manifest is the parsed ``module.yaml`` (Grafana-style plugin manifest).
The registry holds all manifests discovered at startup.

T-115 extends this with :class:`ModuleState` — a runtime wrapper that
tracks ``enabled``, ``loaded_at``, ``version`` (incremented on each
reload), and the live :class:`~neuralgentics.web.modules.base.Module`
instance + its FastAPI router. The registry now stores ``ModuleState``
objects; ``ModuleManifest`` remains the parsed-yaml shape.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
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


class RbacSpec(BaseModel):
    """Per-module RBAC overrides (T-111).

    A module's ``module.yaml`` may declare an optional ``rbac`` block that
    overrides the global role table from T-110 for that module's routes.

    Two knobs:

      * ``required_role`` — module-wide floor. If set, any user whose role
        is below this floor is denied on EVERY route in the module,
        regardless of per-action overrides. The floor is compared by the
        :data:`~neuralgentics.web.auth.rbac.ROLE_RANK` ordering
        (viewer < operator < admin), so ``required_role: admin`` means
        only admins may use the module at all.

      * ``actions`` — per-action role allow-list keyed by the action name
        a route declares via :func:`~neuralgentics.web.modules.loader.module_route`.
        If an action is absent from the map, the request falls back to the
        global role table (permissive mode) or is denied with 403 (strict
        mode, selected by ``--rbac-mode`` on the CLI).

    Both fields are optional; a module with no ``rbac`` block keeps the
    pure-global T-110 behavior unchanged (backwards compat).
    """

    required_role: str | None = None
    actions: dict[str, list[str]] = Field(default_factory=dict)

    @field_validator("required_role")
    @classmethod
    def _valid_required_role(cls, v: str | None) -> str | None:
        if v is None:
            return None
        # Import locally to avoid a registry→auth circular at import time
        # (auth.users imports nothing from modules, but rbac imports users;
        # keeping the validator lazy avoids the cycle on cold import).
        from neuralgentics.web.auth.rbac import ROLES

        if v not in ROLES:
            raise ValueError(f"rbac.required_role {v!r} not in {ROLES}")
        return v

    @field_validator("actions")
    @classmethod
    def _valid_action_roles(cls, v: dict[str, list[str]]) -> dict[str, list[str]]:
        from neuralgentics.web.auth.rbac import ROLES

        for action, roles in v.items():
            if not action:
                raise ValueError("rbac.actions has an empty action name")
            if not roles:
                raise ValueError(f"rbac.actions.{action} lists no roles")
            bad = set(roles) - set(ROLES)
            if bad:
                raise ValueError(
                    f"rbac.actions.{action} has unknown role(s): {sorted(bad)}; valid: {ROLES}"
                )
        return v


class ModuleManifest(BaseModel):
    """Parsed ``module.yaml`` for one module.

    Modeled on Grafana's plugin.json: name/version/display_name/description/
    author + routes/api_endpoints/sse_channels/data_sources.

    ``enabled`` defaults to ``True``; manifests may explicitly disable a
    module by setting ``enabled: false`` in ``module.yaml``.

    T-111: the optional ``rbac`` block holds per-module role overrides
    (:class:`RbacSpec`). A manifest with no ``rbac`` block keeps the
    pure-global T-110 behavior unchanged.
    """

    name: str
    version: str
    display_name: str
    description: str
    author: str = "Veedubin"
    license: str = "MIT"
    enabled: bool = True
    routes: list[RouteSpec] = Field(default_factory=list)
    api_endpoints: list[ApiEndpointSpec] = Field(default_factory=list)
    sse_channels: list[dict[str, Any]] = Field(default_factory=list)
    data_sources: list[dict[str, Any]] = Field(default_factory=list)
    rbac: RbacSpec = Field(default_factory=RbacSpec)

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
            "rbac": {
                "required_role": self.rbac.required_role,
                "actions": dict(self.rbac.actions),
            },
            "stub": True,
            "coming_in": _stub_target(self.name),
        }


def _stub_target(name: str) -> str:
    """Map each v0.1 stub module to its real-implementation card id."""
    return {
        "gateway-audit": "T-106",
        "broker-audit": "T-107",
        "memini-browser": "T-108",
        "policy-editor": "T-155",
    }.get(name, "future card")


class ModuleState:
    """Runtime state for one discovered module (T-115).

    Wraps the parsed :class:`ModuleManifest` with the live ``Module``
    instance + its FastAPI router, plus reload metadata:

      * ``enabled``       — if False, the module's routes return 404.
      * ``loaded_at``     — UTC timestamp of the last load/reload.
      * ``version``       — incremented on each successful reload
                            (starts at 1 for the initial load).
      * ``superseded_by`` — ``version`` of the state that replaced this
                            one, or ``None`` if this is the current state.
      * ``instance``      — the live ``Module`` instance (or ``None`` for
                            pure stubs with no Python implementation).
      * ``router``        — the FastAPI router included into the app
                            (or ``None`` for pure stubs).

    The registry stores the *current* state per module name; superseded
    states are kept in :attr:`ModuleRegistry._superseded` so the old
    routes remain live (FastAPI can't unregister routes cleanly) but
    callers can see the supersession chain.
    """

    def __init__(
        self,
        manifest: ModuleManifest,
        *,
        enabled: bool | None = None,
        version: int = 1,
        instance: Any = None,
        router: Any = None,
        loaded_at: datetime | None = None,
    ) -> None:
        self.manifest = manifest
        # ``enabled`` defaults to the manifest's value; callers may override
        # (e.g. enable/disable toggles the flag without re-reading the yaml).
        self.enabled: bool = manifest.enabled if enabled is None else enabled
        self.version: int = version
        self.instance: Any = instance
        self.router: Any = router
        self.loaded_at: datetime = loaded_at or datetime.now(UTC)
        self.superseded_by: int | None = None

    @property
    def name(self) -> str:
        return self.manifest.name

    def to_summary(self) -> dict[str, Any]:
        """JSON-serializable summary for /api/v1/modules (T-115 adds
        ``enabled`` / ``version`` / ``loaded_at`` / ``superseded_by``)."""
        base = self.manifest.to_summary()
        base.update(
            {
                "enabled": self.enabled,
                "runtime_version": self.version,
                "loaded_at": self.loaded_at.isoformat(),
                "superseded_by": self.superseded_by,
                "has_python_impl": self.instance is not None,
            }
        )
        return base


class ModuleRegistry:
    """Holds all discovered module states. Built once at startup by the
    loader; mutated at runtime by :mod:`neuralgentics.web.shell.reload`.

    The current state per module name lives in ``_by_name``; prior states
    (replaced by a reload) are kept in ``_superseded`` so the supersession
    chain is queryable and old routes remain addressable (FastAPI can't
    cleanly unregister routes — see T-115 scope).
    """

    def __init__(self) -> None:
        self._by_name: dict[str, ModuleState] = {}
        self._superseded: dict[str, list[ModuleState]] = {}

    def register(self, manifest: ModuleManifest) -> None:
        """Register a manifest as a fresh :class:`ModuleState` (version 1)."""
        if manifest.name in self._by_name:
            log.warning("module %s already registered — overwriting", manifest.name)
        state = ModuleState(manifest=manifest)
        self._by_name[manifest.name] = state
        log.info("registered module %s v%s", manifest.name, manifest.version)

    def register_state(self, state: ModuleState) -> None:
        """Register an already-constructed :class:`ModuleState`.

        Used by the loader (which builds the ``Module`` instance + router)
        and by the reload path (which supersedes the prior state).
        """
        if state.name in self._by_name:
            log.warning("module %s already registered — overwriting", state.name)
        self._by_name[state.name] = state

    def supersede(self, new_state: ModuleState) -> None:
        """Replace the current state for ``new_state.name`` with
        ``new_state``; the prior state is moved to ``_superseded`` and
        marked ``superseded_by = new_state.version``.

        The prior state's routes remain live (FastAPI limitation); callers
        can discover the supersession chain via :meth:`supersession_chain`.
        """
        prior = self._by_name.get(new_state.name)
        if prior is not None:
            prior.superseded_by = new_state.version
            self._superseded.setdefault(new_state.name, []).append(prior)
        self._by_name[new_state.name] = new_state
        log.info(
            "superseded module %s v%d → v%d",
            new_state.name,
            prior.version if prior else 0,
            new_state.version,
        )

    def all(self) -> list[ModuleState]:
        return sorted(self._by_name.values(), key=lambda s: s.name)

    def get(self, name: str) -> ModuleState | None:
        return self._by_name.get(name)

    def supersession_chain(self, name: str) -> list[ModuleState]:
        """Prior states for ``name`` in load order (oldest first)."""
        return list(self._superseded.get(name, []))

    def __len__(self) -> int:
        return len(self._by_name)

    def summaries(self) -> list[dict[str, Any]]:
        return [s.to_summary() for s in self.all()]


def parse_manifest(path: Path) -> ModuleManifest:
    """Parse and validate one ``module.yaml`` file."""
    if not path.exists():
        raise FileNotFoundError(f"module.yaml not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict):
        raise ValueError(f"module.yaml at {path} must be a mapping at top level")
    return ModuleManifest.model_validate(raw)


__all__ = [
    "ApiEndpointSpec",
    "ModuleManifest",
    "ModuleRegistry",
    "ModuleState",
    "RbacSpec",
    "RouteSpec",
    "parse_manifest",
]
