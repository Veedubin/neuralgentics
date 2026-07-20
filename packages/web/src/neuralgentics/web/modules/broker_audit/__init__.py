"""broker-audit module package (full impl T-107).

Re-exports :class:`BrokerAuditModule`, the real implementation. The
T-105 :mod:`stub` is kept for backward compatibility but is no longer
the entry point — importing :class:`BrokerAuditStub` from here still
works but emits a ``DeprecationWarning``.
"""

from __future__ import annotations

import warnings

from neuralgentics.web.modules.broker_audit.module import BrokerAuditModule
from neuralgentics.web.modules.broker_audit.stub import BrokerAuditStub

__all__ = ["BrokerAuditModule", "BrokerAuditStub"]

# Re-export the stub under its old name for any caller that imported it
# during the T-105 window. Emit a one-shot deprecation warning on first use.
_orig_stub_init = BrokerAuditStub.__init__


def _deprecating_stub_init(self, *args: object, **kwargs: object) -> None:  # type: ignore[no-untyped-def]
    warnings.warn(
        "BrokerAuditStub is deprecated; the full BrokerAuditModule replaced it in T-107.",
        DeprecationWarning,
        stacklevel=2,
    )
    _orig_stub_init(self, *args, **kwargs)  # type: ignore[arg-type]


BrokerAuditStub.__init__ = _deprecating_stub_init  # type: ignore[method-assign]
