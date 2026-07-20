"""gateway-audit module package (full impl T-106).

Re-exports :class:`GatewayAuditModule`, the real implementation. The T-105
:mod:`stub` is kept for backward compatibility but is no longer the entry
point — importing :class:`GatewayAuditStub` from here still works but emits
a ``DeprecationWarning``.
"""

from __future__ import annotations

import warnings

from neuralgentics.web.modules.gateway_audit.module import GatewayAuditModule
from neuralgentics.web.modules.gateway_audit.stub import GatewayAuditStub

__all__ = ["GatewayAuditModule", "GatewayAuditStub"]

# Re-export the stub under its old name for any caller that imported it
# during the T-105 window. Emit a one-shot deprecation warning on first use.
_orig_stub_init = GatewayAuditStub.__init__


def _deprecating_stub_init(self, *args: object, **kwargs: object) -> None:  # type: ignore[no-untyped-def]
    warnings.warn(
        "GatewayAuditStub is deprecated; the full GatewayAuditModule replaced it in T-106.",
        DeprecationWarning,
        stacklevel=2,
    )
    _orig_stub_init(self, *args, **kwargs)  # type: ignore[arg-type]


GatewayAuditStub.__init__ = _deprecating_stub_init  # type: ignore[method-assign]
