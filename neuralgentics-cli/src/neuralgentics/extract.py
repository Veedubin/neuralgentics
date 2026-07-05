"""Tarball extraction (re-exports from :mod:`neuralgentics.download`).

The design doc (Appendix A.11.6) lists ``download.py`` and ``extract.py`` as
separate modules, but the extraction logic is small and tightly coupled to
the download path. The implementation lives in :mod:`neuralgentics.download`;
this module re-exports the public extraction surface so callers can import
from the documented location.
"""

from __future__ import annotations

from .download import extract_tarball

__all__ = ["extract_tarball"]
