"""gateway-audit stub module (T-105 scaffold). Real implementation in T-106."""

from neuralgentics.web.modules.base import Module

__all__ = ["GatewayAuditStub"]


class GatewayAuditStub(Module):
    """Placeholder for the gateway-audit module."""

    async def render(self, ctx) -> str:  # type: ignore[no-untyped-def]
        return "<div class='module-stub'>Gateway Audit — coming in T-106</div>"
