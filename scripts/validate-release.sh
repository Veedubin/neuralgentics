#!/usr/bin/env bash
# ─── Pre-Release Validation ───────────────────────────────────────────────────
# Run this BEFORE tagging a release. Catches the exact failure modes that
# killed v0.6.5, v0.6.6, and v0.6.7 in CI:
#   - Missing files in git (gitignored but needed by release workflow)
#   - Broken sed/node commands in the workflow YAML
#   - Version mismatches between install.sh and package.json
#   - Invalid JSON/YAML
#   - TypeScript/Go compilation errors
#
# Usage: ./scripts/validate-release.sh
# Exit 0 = clean, ready to tag. Exit 1 = fix before tagging.
# ────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
WARN=0

green()  { printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
red()    { printf "  \033[0;31m✗\033[0m %s\n" "$1"; }
yellow() { printf "  \033[0;33m⚠\033[0m %s\n" "$1"; }

pass() { green "$1"; PASS=$((PASS + 1)); }
fail() { red "$1"; FAIL=$((FAIL + 1)); }
warn() { yellow "$1"; WARN=$((WARN + 1)); }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pre-Release Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── 1. Shell script syntax ───────────────────────────────────────────────────
echo "── 1. Shell script checks ──"

if bash -n scripts/install.sh 2>&1; then
    pass "install.sh: bash syntax OK"
else
    fail "install.sh: bash syntax ERROR"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -x scripts/install.sh 2>&1; then
        pass "install.sh: shellcheck clean"
    else
        fail "install.sh: shellcheck found issues"
    fi
else
    warn "shellcheck not installed — skipping (apt-get install shellcheck)"
fi

# ─── 2. YAML validation ───────────────────────────────────────────────────────
echo ""
echo "── 2. YAML validation ──"

for yml in .github/workflows/release.yml .github/workflows/ci.yml; do
    if [[ -f "$yml" ]]; then
        if python3 -c "import yaml; yaml.safe_load(open('$yml'))" 2>&1; then
            pass "$yml: valid YAML"
        else
            fail "$yml: INVALID YAML"
        fi
    else
        warn "$yml: file not found"
    fi
done

# ─── 3. JSON validation ───────────────────────────────────────────────────────
echo ""
echo "── 3. JSON validation ──"

for json in \
    .opencode/opencode.json \
    .opencode/package.json \
    package.json \
    packages/tui/package.json \
    packages/tui/tsconfig.json
do
    if [[ -f "$json" ]]; then
        if python3 -c "import json; json.load(open('$json'))" 2>&1; then
            pass "$json: valid JSON"
        else
            fail "$json: INVALID JSON"
        fi
    else
        fail "$json: FILE MISSING (needed by release workflow)"
    fi
done

# ─── 4. Version consistency ───────────────────────────────────────────────────
# The NPM release artifact is overlay/packages/opencode/package.json — that is
# what .github/workflows/release.yml publish-npm publishes. It is the PRIMARY
# source of truth. The root package.json, install.sh DEFAULT_VERSION, and
# packages/tui/package.json MUST stay in sync with it, otherwise the
# validator and the install script point at a version the archive doesn't
# contain (see Session 46 v0.12.1 recovery).
echo ""
echo "── 4. Version consistency ──"

OVERLAY_VERSION=$(python3 -c "import json; print(json.load(open('overlay/packages/opencode/package.json'))['version'])")
ROOT_VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
INSTALL_VERSION=$(grep '^DEFAULT_VERSION=' scripts/install.sh | sed 's/.*"\(.*\)"/\1/')
TUI_VERSION=$(python3 -c "import json; print(json.load(open('packages/tui/package.json'))['version'])")

DRIFT=0
drift_msg=""

check_sync() {
    local label="$1" file_ver="$2"
    if [[ "$file_ver" != "$OVERLAY_VERSION" ]]; then
        drift_msg="${drift_msg}    ${label}: ${file_ver} (expected ${OVERLAY_VERSION})\n"
        DRIFT=$((DRIFT + 1))
    fi
}

check_sync "overlay/packages/opencode/package.json (primary)" "$OVERLAY_VERSION"
check_sync "package.json (root)"                              "$ROOT_VERSION"
check_sync "scripts/install.sh DEFAULT_VERSION"               "$INSTALL_VERSION"
check_sync "packages/tui/package.json"                        "$TUI_VERSION"

if [[ $DRIFT -eq 0 ]]; then
    pass "✓ All version sources agree on ${OVERLAY_VERSION}"
else
    fail "Version sources disagree (primary = overlay = ${OVERLAY_VERSION}):"
    printf "%b" "$drift_msg"
fi

# ─── 4b. Git tag match (if a tag is provided) ─────────────────────────────────
# Pass the intended tag via the TAG env var or the first CLI arg, e.g.:
#   TAG=v0.12.2 ./scripts/validate-release.sh
#   ./scripts/validate-release.sh v0.12.2
if [[ -n "${1:-${TAG:-}}" ]]; then
    INTENDED_TAG="${1:-${TAG}}"
    INTENDED_TAG="${INTENDED_TAG#v}"   # strip leading 'v'
    if [[ "$INTENDED_TAG" == "$OVERLAY_VERSION" ]]; then
        pass "Git tag v${INTENDED_TAG} matches overlay version ${OVERLAY_VERSION}"
    else
        fail "Git tag v${INTENDED_TAG} does NOT match overlay version ${OVERLAY_VERSION}"
    fi
fi

# ─── 5. Release file existence (simulate archive assembly) ────────────────────
echo ""
echo "── 5. Release archive file check ──"

# These are the files the release workflow copies into the archive.
# If any are missing from git, the cp commands in CI will fail.
RELEASE_FILES=(
    ".opencode/agents/"              # directory — check for .md files
    ".opencode/skills/"              # directory — check for subdirs
    ".opencode/opencode.json"
    ".opencode/package.json"
    ".opencode/package-lock.json"
    ".opencode/.gitignore"
    "AGENTS.md"
    "scripts/install.sh"
    "overlay/packages/opencode/package.json"
    "overlay/packages/opencode/tsconfig.json"
    "packages/memory/cmd/embedding-sidecar/main.py"
    "packages/memory/cmd/embedding-sidecar/requirements.txt"
)

missing=0
for f in "${RELEASE_FILES[@]}"; do
    if [[ "$f" == */ ]]; then
        # Directory check — must exist and contain at least one file
        if [[ -d "$f" ]] && ls "$f" 2>/dev/null | head -1 | grep -q .; then
            pass "$f (has content)"
        else
            fail "$f: EMPTY or MISSING"
            missing=$((missing + 1))
        fi
    else
        if [[ -f "$f" ]]; then
            pass "$f"
        else
            fail "$f: MISSING (release workflow cp will fail)"
            missing=$((missing + 1))
        fi
    fi
done

# Check overlay source files
if ls overlay/packages/opencode/src/*.ts 2>/dev/null | head -1 | grep -q .; then
    pass "overlay/packages/opencode/src/ (has .ts files)"
else
    fail "overlay/packages/opencode/src/: EMPTY or MISSING"
    missing=$((missing + 1))
fi

# Check sidecar proto files
if ls packages/memory/cmd/embedding-sidecar/embedding_sidecar/proto/embedding/v1/*.py 2>/dev/null | head -1 | grep -q .; then
    pass "embedding-sidecar proto files present"
else
    fail "embedding-sidecar proto files MISSING"
    missing=$((missing + 1))
fi

# ─── 6. TypeScript typecheck ──────────────────────────────────────────────────
echo ""
echo "── 6. TypeScript typecheck ──"

if [[ -f packages/tui/tsconfig.json ]]; then
    if (cd packages/tui && npx tsc --noEmit 2>&1); then
        pass "packages/tui: tsc --noEmit clean"
    else
        fail "packages/tui: tsc --noEmit found errors"
    fi
else
    warn "packages/tui/tsconfig.json not found — skipping typecheck"
fi

# ─── 7. Go vet ────────────────────────────────────────────────────────────────
echo ""
echo "── 7. Go vet ──"

GO_MODULES=(
    "packages/memory"
    "packages/orchestrator-go"
    "packages/broker-go"
    "packages/backend-go"
)

for mod in "${GO_MODULES[@]}"; do
    if [[ -f "$mod/go.mod" ]]; then
        if (cd "$mod" && go vet ./... 2>&1); then
            pass "$mod: go vet clean"
        else
            fail "$mod: go vet found issues"
        fi
    else
        warn "$mod: go.mod not found — skipping"
    fi
done

# ─── 8. Git status check ──────────────────────────────────────────────────────
echo ""
echo "── 8. Git status ──"

if git diff --quiet && git diff --cached --quiet; then
    pass "Working tree clean"
else
    warn "Working tree has uncommitted changes — commit before tagging"
    git status --short
fi

# Check that the tag doesn't already exist
CURRENT_VERSION="$OVERLAY_VERSION"
if git tag -l "v$CURRENT_VERSION" | grep -q "v$CURRENT_VERSION"; then
    fail "Tag v$CURRENT_VERSION already exists — bump version before re-tagging"
else
    pass "Tag v$CURRENT_VERSION is available"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  Results: %d passed, %d failed, %d warnings\n" "$PASS" "$FAIL" "$WARN"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo "  ❌ VALIDATION FAILED — fix the issues above before tagging."
    echo "  Common fixes:"
    echo "    - Missing file:  git add -f <path>  (check .gitignore)"
    echo "    - Version mismatch: overlay/packages/opencode/package.json is the"
    echo "      primary source (that is what release.yml publishes to NPM)."
    echo "      Bump root package.json, install.sh DEFAULT_VERSION, and"
    echo "      packages/tui/package.json to match it."
    echo "    - JSON/YAML error: fix syntax in the file"
    echo "    - TypeScript error: fix type errors in packages/tui/src/"
    echo "    - Go vet error: fix the reported issue"
    exit 1
fi

echo ""
echo "  ✅ Ready to tag. Run:"
echo "     git tag -a v$CURRENT_VERSION -m \"v$CURRENT_VERSION: <description>\""
echo "     git push origin main && git push origin v$CURRENT_VERSION"
exit 0
