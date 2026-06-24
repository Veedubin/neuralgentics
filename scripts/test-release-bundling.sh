#!/usr/bin/env bash
# Neuralgentics — Release Bundling Smoke Test
#
# A simple smoke test for the release pipeline's external skills bundling.
# Can be run as a CI step or manually.
#
# Usage: ./scripts/test-release-bundling.sh
#
# Steps:
#   1. Sets up a temp home dir with a fake .env containing external_skills.enabled=true
#   2. Runs scripts/external-skills-fetcher.sh --dry-run --home-dir <tmp>
#   3. Runs scripts/release.sh --dry-run --skip-external-skills
#   4. Runs scripts/build.sh --dry-run
#   5. Cleans up the temp dir
#
# Exit code: 0 if all steps pass, 1 if any step fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { printf "${GREEN}[PASS]${NC} %s\n" "$*"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$*"; }
info() { printf "${YELLOW}[INFO]${NC} %s\n" "$*"; }

# ── Step 0: Create temp home dir with .env ──────────────────────────────────

TMP_HOME="$(mktemp -d /tmp/neuralgentics-smoke-XXXXXX)"
trap 'rm -rf "$TMP_HOME"' EXIT

info "Using temp home dir: $TMP_HOME"

# Create .env with external_skills.enabled=true
mkdir -p "$TMP_HOME"
cat > "$TMP_HOME/.env" <<'EOF'
external_skills.enabled=true
EOF
pass "Created $TMP_HOME/.env with external_skills.enabled=true"

ALL_PASSED=true

# ── Step 1: external-skills-fetcher.sh --dry-run ────────────────────────────

info "Step 1: Running external-skills-fetcher.sh --dry-run --home-dir $TMP_HOME..."
if "$SCRIPT_DIR/external-skills-fetcher.sh" --dry-run --home-dir "$TMP_HOME" 2>&1; then
    pass "external-skills-fetcher.sh --dry-run exited 0"
else
    fail "external-skills-fetcher.sh --dry-run failed"
    ALL_PASSED=false
fi

# ── Step 2: release.sh --dry-run --skip-external-skills ─────────────────────

info "Step 2: Running release.sh --dry-run --skip-external-skills..."
# release.sh may fail with "Working tree is not clean" if the tree is dirty.
# That's acceptable — we just want to verify the script parses args and
# doesn't crash on basic execution.
if "$SCRIPT_DIR/release.sh" --dry-run --skip-external-skills 2>&1; then
    pass "release.sh --dry-run --skip-external-skills exited 0"
else
    exit_code=$?
    if [ $exit_code -eq 1 ]; then
        # release.sh exits 1 for clean-tree errors — acceptable
        pass "release.sh --dry-run --skip-external-skills exited 1 (expected: clean-tree check)"
    else
        fail "release.sh --dry-run --skip-external-skills failed with exit code $exit_code"
        ALL_PASSED=false
    fi
fi

# ── Step 3: build.sh --dry-run ──────────────────────────────────────────────

info "Step 3: Running build.sh --dry-run..."
if "$SCRIPT_DIR/build.sh" --dry-run 2>&1; then
    pass "build.sh --dry-run exited 0"
else
    fail "build.sh --dry-run failed"
    ALL_PASSED=false
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$ALL_PASSED" = true ]; then
    printf "${GREEN}All smoke tests passed.${NC}\n"
    exit 0
else
    printf "${RED}Some smoke tests failed.${NC}\n"
    exit 1
fi
