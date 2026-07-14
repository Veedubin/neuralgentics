#!/usr/bin/env bash
# render.sh — Regenerate Mermaid diagrams from .mmd sources.
# Produces both SVG (vector, default in mkdocs) and PNG (raster, 2x scale).
#
# Requirements:
#   - @mermaid-js/mermaid-cli v11+ in repo root node_modules (already installed)
#   - /usr/bin/chromium (system Arch package, or set PUPPETEER_EXECUTABLE_PATH)
#   - mermaid-config.json next to this script (sets htmlLabels: false so text
#     renders as real <text> elements, not <foreignObject> which most non-browser
#     renderers ignore)
#
# Usage:
#   ./render.sh           # regenerate all SVGs and PNGs
#   ./render.sh svg       # SVG only
#   ./render.sh png       # PNG only
#   ./render.sh clean     # remove generated .svg and .png files

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="/home/jcharles/Projects/MCP-Servers"
PUPPETEER_JSON="$HERE/puppeteer.json"
MMDC="$WORKSPACE/node_modules/.bin/mmdc"
CONFIG="$HERE/mermaid-config.json"

if [[ ! -x "$MMDC" ]]; then
    echo "ERROR: $MMDC not found. Run 'npm install' in $WORKSPACE first." >&2
    exit 1
fi

MODE="${1:-all}"

if [[ "$MODE" == "clean" ]]; then
    rm -f "$HERE"/diagram-*.svg "$HERE"/diagram-*.png
    echo "Cleaned. .mmd sources preserved."
    exit 0
fi

# Regenerate puppeteer config (point at system chromium, --no-sandbox for root)
cat > "$PUPPETEER_JSON" <<'EOF'
{
  "executablePath": "/usr/bin/chromium",
  "args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
}
EOF

render_svg() {
    for DIAGRAM in diagram-1-overview diagram-2-broker-flow diagram-3-dispatch-flow; do
        echo "Rendering $DIAGRAM.svg..."
        npx --no-install mmdc \
            -i "$HERE/$DIAGRAM.mmd" \
            -o "$HERE/$DIAGRAM.svg" \
            -p "$PUPPETEER_JSON" \
            -c "$CONFIG" \
            -t neutral \
            -b transparent
    done
}

render_png() {
    for DIAGRAM in diagram-1-overview diagram-2-broker-flow diagram-3-dispatch-flow; do
        echo "Rendering $DIAGRAM.png..."
        npx --no-install mmdc \
            -i "$HERE/$DIAGRAM.mmd" \
            -o "$HERE/$DIAGRAM.png" \
            -p "$PUPPETEER_JSON" \
            -c "$CONFIG" \
            -t neutral \
            -b white \
            -w 1600 \
            -s 2
    done
}

case "$MODE" in
    svg)  render_svg ;;
    png)  render_png ;;
    all)  render_svg; render_png ;;
    *)    echo "Usage: $0 [svg|png|all|clean]" >&2; exit 1 ;;
esac

echo ""
echo "Done. Outputs in $HERE:"
ls -la "$HERE"/diagram-*.{svg,png} 2>/dev/null || true
