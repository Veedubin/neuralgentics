#!/usr/bin/env bash

# Neuralgentics — Post-Install Verification
# Usage: ./scripts/verify.sh [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERBOSE=false
PASSED=0
FAILED=0

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()    { printf "%s\n" "$*"; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Verification Script

Usage: $(basename "$0") [OPTIONS]

Options:
  --verbose   Enable verbose output
  -h, --help  Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage ;;
    *) printf "${RED}Unknown option: $1${NC}\n"; usage ;;
  esac
done

# --- Checks ---
check_pass() {
  printf "  ${GREEN}✓${NC} %s\n" "$1"
  PASSED=$((PASSED + 1))
}

check_fail() {
  printf "  ${RED}✗${NC} %s\n" "$1"
  FAILED=$((FAILED + 1))
}

check_memini_core() {
  verbose "Checking memini-core (localhost:8123/health)..."
  if curl -sf http://localhost:8123/health &>/dev/null; then
    check_pass "memini-core responding on port 8123"
  else
    check_fail "memini-core NOT responding on port 8123"
  fi
}

check_broker() {
  verbose "Checking MCP broker (localhost:8901/health)..."
  if curl -sf http://localhost:8901/health &>/dev/null; then
    check_pass "MCP broker responding on port 8901"
  else
    check_fail "MCP broker NOT responding on port 8901"
  fi
}

check_typescript() {
  verbose "Checking TypeScript plugin builds..."
  if command -v bun &>/dev/null; then
    if bun run typecheck &>/dev/null; then
      check_pass "TypeScript plugin typecheck passed"
    else
      check_fail "TypeScript plugin typecheck FAILED"
    fi
  else
    check_fail "bun not found — cannot run typecheck"
  fi
}

check_postgres() {
  verbose "Checking PostgreSQL connection..."
  if command -v pg_isready &>/dev/null; then
    if pg_isready &>/dev/null; then
      check_pass "PostgreSQL is ready"
    else
      check_fail "PostgreSQL is NOT ready"
    fi
  else
    check_fail "pg_isready not found — cannot check PostgreSQL"
  fi
}

check_python_deps() {
  verbose "Checking Python dependencies..."
  if command -v uv &>/dev/null; then
    if cd "$PROJECT_ROOT/packages/memini-core" && uv run python -c "import memini_core" &>/dev/null; then
      check_pass "memini-core Python package importable"
    else
      check_fail "memini-core Python package NOT importable"
    fi
    cd "$PROJECT_ROOT"
  elif command -v python3 &>/dev/null; then
    if python3 -c "import memini_core" &>/dev/null; then
      check_pass "memini-core Python package importable"
    else
      check_fail "memini-core Python package NOT importable"
    fi
  else
    check_fail "python3 not found"
  fi
}

check_node_deps() {
  verbose "Checking Node dependencies..."
  if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
    check_pass "node_modules present"
  else
    check_fail "node_modules missing — run 'bun install'"
  fi
}

# --- Main ---
main() {
  log "Neuralgentics — Post-Install Verification"
  log "========================================="

  check_memini_core
  check_broker
  check_typescript
  check_postgres
  check_python_deps
  check_node_deps

  log ""
  log "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"

  if [[ $FAILED -gt 0 ]]; then
    log ""
    log "${YELLOW}Some checks failed. Run './scripts/install.sh' to fix missing dependencies.${NC}"
    exit 1
  fi

  log ""
  log "${GREEN}All checks passed!${NC}"
}

main