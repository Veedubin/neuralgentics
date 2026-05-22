#!/usr/bin/env bash
# =============================================================================
# Neuralgentics — File Structure Verification
#
# Checks that all expected project files exist.
# Prints PASS/FAIL for each check.
# Exit code: 0 if all pass, 1 if any fail.
# =============================================================================
# NOTE: do not use "set -e" here — we handle failures manually

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=false
PASS_COUNT=0
FAIL_COUNT=0

pass() {
    echo "  PASS: $1"
    ((PASS_COUNT++))
}

fail() {
    echo "  FAIL: $1" >&2
    FAILED=true
    ((FAIL_COUNT++))
}

check_file() {
    local label="$1"
    local path="$2"
    if [[ -f "$PROJECT_ROOT/$path" ]]; then
        pass "$label — $path"
    else
        fail "$label — $path NOT FOUND"
    fi
}

echo ""
echo "=== Neuralgentics File Structure Verification ==="
echo ""

check_file "memini-core server"    "packages/memini-core/src/memini_core/server.py"
check_file "plugin entry point"    "packages/plugin/src/index.ts"
check_file "orchestrator entry"    "packages/orchestrator/src/index.ts"
check_file "broker server"         "packages/broker/src/broker/server.py"
check_file "architect skill"       "skills/architect.md"
check_file "AGENTS.md"             "AGENTS.md"
check_file "build script"          "scripts/build.sh"

echo ""
echo "--- Summary: $PASS_COUNT passed, $FAIL_COUNT failed ---"
echo ""

if $FAILED; then
    exit 1
fi
exit 0
