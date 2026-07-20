"""gateway-audit stub module (T-105 scaffold). Replaced by T-106's real impl.

This file is kept for backward compatibility. Import :class:`GatewayAuditModule`
from :mod:`neuralgentics.web.modules.gateway_audit` (the package
``__init__``) instead.
"""

from __future__ import annotations

from neuralgentics.web.modules.base import Module

__all__ = ["GatewayAuditStub"]


class GatewayAuditStub(Module):
    """Placeholder for the gateway-audit module. Superseded by T-106."""

    async def render(self, ctx: object) -> str:
        return (
            "<div class='module-stub'>"
            "<strong>Gateway Audit</strong> — full implementation arrived in T-106. "
            "See <code>/modules/gateway-audit</code>."
            "</div>"
        )
