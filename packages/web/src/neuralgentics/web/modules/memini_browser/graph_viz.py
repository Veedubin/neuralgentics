"""Simple SVG renderer for the memini-browser knowledge graph (T-108).

Renders a :class:`MemoryGraph` as an inline SVG with circular layout:
the root memory at center, related memories arranged on a circle around
it, relationships drawn as labelled lines. No client-side rendering —
the SVG is server-rendered Jinja2.

Approx 600x400 px. Entities as rounded boxes with the memory id + a
short content preview; relationships as lines with the type label.
"""

from __future__ import annotations

import html
import math

from neuralgentics.web.modules.memini_browser.memini_client import (
    MemoryGraph,
    MemorySummary,
)

SVG_W = 600
SVG_H = 400
CENTER_X = SVG_W // 2
CENTER_Y = SVG_H // 2
RADIUS = 140
BOX_W = 130
BOX_H = 50


def render_memory_graph_svg(graph: MemoryGraph) -> str:
    """Render a :class:`MemoryGraph` as an inline SVG string.

    The root memory is centered; related memories are placed on a circle
    of radius :data:`RADIUS` around it. If there is only the root and no
    relationships, it is rendered alone at the center.
    """
    entities = list(graph.entities)
    # De-dup by id, keep root first.
    seen: set[str] = set()
    uniq: list[MemorySummary] = []
    root_first: list[MemorySummary] = []
    for e in entities:
        if e.id in seen:
            continue
        seen.add(e.id)
        if e.id == graph.root_id:
            root_first.append(e)
        else:
            uniq.append(e)
    ordered = root_first + uniq

    # Compute positions.
    positions: dict[str, tuple[float, float]] = {}
    if not ordered:
        return _empty_svg()
    # Root at center.
    root = ordered[0]
    positions[root.id] = (float(CENTER_X), float(CENTER_Y))
    others = ordered[1:]
    n = len(others)
    for i, e in enumerate(others):
        angle = (2 * math.pi * i / max(1, n)) - math.pi / 2
        x = CENTER_X + RADIUS * math.cos(angle)
        y = CENTER_Y + RADIUS * math.sin(angle)
        positions[e.id] = (x, y)

    label = html.escape(graph.root_id)
    parts: list[str] = [
        f'<svg width="{SVG_W}" height="{SVG_H}" xmlns="http://www.w3.org/2000/svg" '
        f'class="memini-graph" role="img" aria-label="Memory graph for {label}">'
    ]

    # Relationship lines first (so boxes draw on top).
    for rel in graph.relationships:
        if rel.source_id not in positions or rel.target_id not in positions:
            continue
        x1, y1 = positions[rel.source_id]
        x2, y2 = positions[rel.target_id]
        parts.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="#94a3b8" stroke-width="1.5" />'
        )
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2
        label = html.escape(rel.relationship_type)
        parts.append(
            f'<text x="{mx:.1f}" y="{my:.1f}" font-size="9" '
            f'text-anchor="middle" fill="#475569">{label}</text>'
        )

    # Entity boxes.
    for e in ordered:
        x, y = positions[e.id]
        is_root = e.id == graph.root_id
        fill = "#dbeafe" if is_root else "#e2e8f0"
        stroke = "#2563eb" if is_root else "#475569"
        bx = x - BOX_W / 2
        by = y - BOX_H / 2
        parts.append(
            f'<rect x="{bx:.1f}" y="{by:.1f}" width="{BOX_W}" height="{BOX_H}" '
            f'rx="6" ry="6" fill="{fill}" stroke="{stroke}" stroke-width="1.5" />'
        )
        label_id = html.escape(_short_id(e.id))
        parts.append(
            f'<text x="{x:.1f}" y="{y - 4:.1f}" text-anchor="middle" '
            f'font-size="11" font-weight="bold" fill="#0f172a">{label_id}</text>'
        )
        preview = html.escape(_short_preview(e.content_preview))
        parts.append(
            f'<text x="{x:.1f}" y="{y + 12:.1f}" text-anchor="middle" '
            f'font-size="9" fill="#334155">{preview}</text>'
        )

    parts.append("</svg>")
    return "\n".join(parts)


def _empty_svg() -> str:
    return (
        f'<svg width="{SVG_W}" height="{SVG_H}" xmlns="http://www.w3.org/2000/svg" '
        f'class="memini-graph" role="img" aria-label="Empty memory graph">'
        f'<text x="{CENTER_X}" y="{CENTER_Y}" text-anchor="middle" '
        f'font-size="12" fill="#94a3b8">No entities in graph</text>'
        f"</svg>"
    )


def _short_id(memory_id: str) -> str:
    if len(memory_id) <= 18:
        return memory_id
    return memory_id[:8] + "…" + memory_id[-6:]


def _short_preview(p: str) -> str:
    # The preview is already ≤200 chars; trim to fit the box (~22 chars).
    if len(p) <= 22:
        return p
    return p[:21].rstrip() + "…"


__all__ = ["render_memory_graph_svg"]
