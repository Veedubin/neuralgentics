"""memini-browser stub module (T-105 scaffold). Real implementation in T-108."""

from neuralgentics.web.modules.base import Module

__all__ = ["MeminiBrowserStub"]


class MeminiBrowserStub(Module):
    """Placeholder for the memini-browser module."""

    async def render(self, ctx) -> str:  # type: ignore[no-untyped-def]
        return "<div class='module-stub'>Memory Browser — coming in T-108</div>"
