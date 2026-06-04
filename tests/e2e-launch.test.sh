#!/usr/bin/env bash
# Neuralgentics End-to-End Launch Test
# Verifies all components are wired correctly

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

echo "=== Neuralgentics E2E Launch Test ==="

# Test 1: memini-core health
echo "[1/5] Checking memini-core..."
if curl -s http://localhost:8900/health | grep -q "ok"; then
    echo "  ✅ memini-core running"
else
    echo "  ❌ memini-core not running (start with ./serve.sh)"
    FAIL=1
fi

# Test 2: Plugin builds
echo "[2/5] Checking plugin build..."
if [ -f "$SCRIPT_DIR/packages/plugin/dist/index.js" ]; then
    echo "  ✅ Plugin built"
else
    echo "  ❌ Plugin not built (run: cd packages/plugin && npm run build)"
    FAIL=1
fi

# Test 3: Orchestrator exports
echo "[3/5] Checking orchestrator exports..."
if grep -q "export" "$SCRIPT_DIR/packages/orchestrator/dist/index.js" 2>/dev/null; then
    echo "  ✅ Orchestrator exports found"
else
    echo "  ❌ Orchestrator not built (run: cd packages/orchestrator && npm run build)"
    FAIL=1
fi

# Test 4: SDK exports
echo "[4/5] Checking SDK exports..."
if grep -q "export" "$SCRIPT_DIR/packages/sdk/dist/index.js" 2>/dev/null; then
    echo "  ✅ SDK exports found"
else
    echo "  ❌ SDK not built (run: cd packages/sdk && npm run build)"
    FAIL=1
fi

# Test 5: OpenCode base exists
echo "[5/5] Checking OpenCode base..."
if [ -f "$SCRIPT_DIR/opencode-base/package.json" ]; then
    echo "  ✅ OpenCode base present"
else
    echo "  ❌ OpenCode base missing"
    FAIL=1
fi

# Test 6: Plugin registered in opencode.json
echo "[6/5] Checking opencode.json registration..."
if grep -q "@neuralgentics/plugin" "/home/jcharles/Projects/MCP-Servers/.opencode/opencode.json" 2>/dev/null; then
    echo "  ✅ Plugin registered in OpenCode config"
else
    echo "  ⚠️ Plugin NOT registered in opencode.json (run launcher manually)"
fi

if [ $FAIL -eq 0 ]; then
    echo ""
    echo "✅ All systems ready. Launch with: ./neuralgentics"
    exit 0
else
    echo ""
    echo "❌ Some components missing. Run ./scripts/install.sh to set up."
    exit 1
fi
