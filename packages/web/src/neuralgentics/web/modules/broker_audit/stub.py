"""broker-audit stub module (T-105 scaffold). Real implementation in T-107."""

from neuralgentics.web.modules.base import Module

__all__ = ["BrokerAuditStub"]


class BrokerAuditStub(Module):
    """Placeholder for the broker-audit module."""

    async def render(self, ctx) -> str:  # type: ignore[no-untyped-def]
        return "<div class='module-stub'>Broker Audit — coming in T-107</div>"
