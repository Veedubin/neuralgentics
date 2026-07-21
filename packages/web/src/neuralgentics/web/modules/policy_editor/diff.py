"""Unified-diff helpers for the policy_editor module (T-156).

Computes a colored unified diff between the on-disk policy content and
the proposed content (or between the current content and the .bak
backup for the history view).

The diff is rendered as a list of :class:`DiffLine` objects so the
Jinja2 template can color each line without parsing the unified-diff
format itself.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass


@dataclass
class DiffLine:
    """One line of a colored diff.

    ``kind`` is one of:

      * ``context`` — unchanged (no +/- marker)
      * ``add``     — added in the new version (``+``)
      * ``del``     — removed from the old version (``-``)
      * ``meta``    — unified-diff metadata (``---``, ``+++``, ``@@``)
    """

    kind: str
    text: str


def compute_diff(
    old: str, new: str, *, fromfile: str = "current", tofile: str = "proposed"
) -> list[DiffLine]:
    """Return a list of :class:`DiffLine` representing the unified diff.

    ``old`` is the on-disk (or .bak) content; ``new`` is the proposed
    content. Returns an empty list when the two are byte-identical.
    """
    if old == new:
        return []
    old_lines = old.splitlines(keepends=False)
    new_lines = new.splitlines(keepends=False)
    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=fromfile,
        tofile=tofile,
        lineterm="",
    )
    out: list[DiffLine] = []
    for line in diff:
        # difflib prefixes metadata with ---/+++/@@; added lines with +;
        # removed lines with -; context lines with a space.
        if line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
            out.append(DiffLine(kind="meta", text=line))
        elif line.startswith("+"):
            out.append(DiffLine(kind="add", text=line[1:]))
        elif line.startswith("-"):
            out.append(DiffLine(kind="del", text=line[1:]))
        else:
            # Context line starts with a single space.
            out.append(DiffLine(kind="context", text=line[1:] if line.startswith(" ") else line))
    return out


def diff_has_changes(lines: list[DiffLine]) -> bool:
    """True when the diff contains at least one add or del line."""
    return any(ln.kind in ("add", "del") for ln in lines)


__all__ = ["DiffLine", "compute_diff", "diff_has_changes"]
