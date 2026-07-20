"""memini-browser module package (full impl T-108).

Re-exports :class:`MeminiBrowserModule`, the real implementation. The
T-105 :mod:`stub` is kept for backward compatibility but is no longer
the entry point — importing :class:`MeminiBrowserStub` from here still
works but emits a ``DeprecationWarning``.

Module directory on disk is ``memini_browser`` (underscore, Python-valid);
the manifest ``name`` field is ``memini-browser`` (hyphenated, URL-friendly).
The two are intentionally decoupled — the loader matches on the manifest
``name``, not the directory name.
"""

from __future__ import annotations

import warnings

from neuralgentics.web.modules.memini_browser.module import MeminiBrowserModule
from neuralgentics.web.modules.memini_browser.stub import MeminiBrowserStub

__all__ = ["MeminiBrowserModule", "MeminiBrowserStub"]

# Re-export the stub under its old name for any caller that imported it
# during the T-105 window. Emit a one-shot deprecation warning on first use.
_orig_stub_init = MeminiBrowserStub.__init__


def _deprecating_stub_init(self, *args: object, **kwargs: object) -> None:  # type: ignore[no-untyped-def]
    warnings.warn(
        "MeminiBrowserStub is deprecated; the full MeminiBrowserModule replaced it in T-108.",
        DeprecationWarning,
        stacklevel=2,
    )
    _orig_stub_init(self, *args, **kwargs)  # type: ignore[arg-type]


MeminiBrowserStub.__init__ = _deprecating_stub_init  # type: ignore[method-assign]
