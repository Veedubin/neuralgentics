"""Embedded mode — localhost-only, no auth, reads local files.

The same FastAPI app is used in both modes; this module is a thin marker
that configures the bind host to 127.0.0.1 and disables auth-dependent
endpoints. Future cards (T-109) add the real auth layer.
"""

from __future__ import annotations

import logging
from typing import Any

from neuralgentics.web.config import WebConfig

log = logging.getLogger("neuralgentics.web.embedded")


class EmbeddedMode:
    """Configures the app for embedded mode (localhost, no auth)."""

    NAME = "embedded"

    def __init__(self, config: WebConfig) -> None:
        self.config = config

    def configure(self, app: Any) -> None:
        """Hook the mode can use to install middleware/routes on the app."""
        # For v0.1 there's nothing mode-specific to install — the shell
        # routes already work without auth. T-109 will add a no-op auth
        # middleware here so embedded mode short-circuits to "always allow".
        log.debug("embedded mode configured (no auth)")

    @property
    def health_payload(self) -> dict[str, Any]:
        return {"status": "ok", "mode": "embedded"}
