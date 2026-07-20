"""memini-browser module package (stub for T-105; full impl in T-108).

Module directory on disk is ``memini_browser`` (underscore, Python-valid);
the manifest ``name`` field is ``memini-browser`` (hyphenated, URL-friendly).
The two are intentionally decoupled — the loader matches on the manifest
``name``, not the directory name.
"""

from neuralgentics.web.modules.memini_browser.stub import MeminiBrowserStub

__all__ = ["MeminiBrowserStub"]
