"""OIDC configuration (T-112).

Holds the configured providers + redirect base URL + default role for
new OIDC users. Built from CLI flags in :mod:`neuralgentics.web.config`
and passed to :func:`~neuralgentics.web.auth.oidc_routes.build_oidc_router`.

When no providers are configured, OIDC is disabled and the team-server
falls back to the T-109 local-login-only behavior (the stub's behavior
becomes "OIDC disabled, local login only" — exactly what the card asks
for).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from neuralgentics.web.auth.oidc import (
    GenericOIDCProvider,
    GitHubProvider,
    GoogleProvider,
    OIDCProvider,
)


@dataclass
class OIDCConfig:
    """Resolved OIDC configuration. Empty ``providers`` = OIDC disabled."""

    redirect_base: str = ""
    """Base URL for callbacks (e.g. ``https://neuralgentics.example.com``).
    The callback URL is ``{redirect_base}/auth/callback/{provider}``."""

    default_role: str = "viewer"
    """Role assigned to new OIDC users on first login."""

    providers: dict[str, OIDCProvider] = field(default_factory=dict)
    """Configured providers keyed by name (``github``, ``google``, custom)."""

    @property
    def enabled(self) -> bool:
        """True if at least one provider is configured."""
        return bool(self.providers)

    def callback_url(self, provider_name: str) -> str:
        """Build the redirect URI for ``provider_name``."""
        if not self.redirect_base:
            raise ValueError("oidc redirect_base not set")
        return f"{self.redirect_base.rstrip('/')}/auth/callback/{provider_name}"

    @classmethod
    def from_cli(
        cls,
        *,
        github_client_id: str | None,
        github_client_secret: str | None,
        google_client_id: str | None,
        google_client_secret: str | None,
        generic_providers: dict[str, dict[str, str]] | None,
        redirect_base: str,
        default_role: str = "viewer",
    ) -> OIDCConfig:
        """Build from CLI flag values.

        ``generic_providers`` maps ``name`` → ``{discovery_url, client_id,
        client_secret}``. A provider is enabled only if both client_id and
        client_secret are non-empty (per the card's requirement).
        """
        providers: dict[str, OIDCProvider] = {}
        if github_client_id and github_client_secret:
            providers["github"] = GitHubProvider(
                client_id=github_client_id,
                client_secret=github_client_secret,
            )
        if google_client_id and google_client_secret:
            providers["google"] = GoogleProvider(
                client_id=google_client_id,
                client_secret=google_client_secret,
                redirect_base=redirect_base,
            )
        if generic_providers:
            for name, cfg in generic_providers.items():
                du = cfg.get("discovery_url")
                cid = cfg.get("client_id")
                csec = cfg.get("client_secret")
                if du and cid and csec:
                    providers[name] = GenericOIDCProvider(
                        name=name,
                        discovery_url=du,
                        client_id=cid,
                        client_secret=csec,
                        redirect_base=redirect_base,
                    )
        return cls(
            redirect_base=redirect_base,
            default_role=default_role,
            providers=providers,
        )


__all__ = ["OIDCConfig"]
