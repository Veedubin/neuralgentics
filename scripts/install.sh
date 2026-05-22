#!/usr/bin/env bash
set -e

# Neuralgentics — Master Install Script
# Usage: ./scripts/install.sh [--dev] [--dry-run] [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false
VERBOSE=false
DEV_MODE=false

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[install]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[install]${NC} %s\n" "$*"; }
err()  { printf "${RED}[install]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Install Script

Usage: $(basename "$0") [OPTIONS]

Options:
  --dev       Install in development mode (watch, debug)
  --dry-run   Show what would be done without executing
  --verbose   Enable verbose output
  -h, --help  Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)     DEV_MODE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage ;;
    *) err "Unknown option: $1"; usage ;;
  esac
done

run() {
  if $DRY_RUN; then
    warn "[dry-run] $*"
  else
    verbose "Running: $*"
    "$@"
  fi
}

# --- Dependency Checks ---
check_dep() {
  if command -v "$1" &>/dev/null; then
    verbose "$1 found: $(command -v "$1")"
    return 0
  else
    err "Missing dependency: $1"
    return 1
  fi
}

check_deps() {
  local missing=0
  log "Checking dependencies..."
  for dep in bun python3; do
    check_dep "$dep" || missing=$((missing + 1))
  done

  # pip or uv (at least one)
  if ! check_dep uv && ! check_dep pip; then
    err "Missing dependency: uv or pip"
    missing=$((missing + 1))
  fi

  # Optional deps
  for dep in docker psql; do
    if ! check_dep "$dep"; then
      warn "Optional: $1 not found — some features may be unavailable"
    fi
  done

  if [[ $missing -gt 0 ]]; then
    err "Install missing dependencies and re-run this script."
    exit 1
  fi
  log "All required dependencies satisfied."
}

# --- Install Steps ---
install_node_deps() {
  log "Installing Node/TypeScript dependencies..."
  run bun install
  if $DEV_MODE; then
    log "Installing dev dependencies..."
    run bun install --dev
  fi
}

install_python_deps() {
  log "Installing Python dependencies (memini-core)..."
  run cd "$PROJECT_ROOT/packages/memini-core"
  if command -v uv &>/dev/null; then
    run uv sync
    $DEV_MODE && run uv sync --extra dev
  else
    run pip install -e "."
    $DEV_MODE && run pip install -e ".[dev]"
  fi
  run cd "$PROJECT_ROOT"
}

init_database() {
  log "Initializing PostgreSQL schema..."
  if ! command -v psql &>/dev/null; then
    warn "psql not found — skipping database init. Run manually: python -m memini_core.database init"
    return 0
  fi

  if ! pg_isready &>/dev/null; then
    warn "PostgreSQL not ready — skipping schema init. Start PostgreSQL and re-run."
    return 0
  fi

  run cd "$PROJECT_ROOT/packages/memini-core"
  if command -v uv &>/dev/null; then
    run uv run python -m memini_core.database init
  else
    run python3 -m memini_core.database init
  fi
  run cd "$PROJECT_ROOT"
}

build_typescript() {
  log "Building TypeScript packages..."
  run bun run build:ts
}

# --- Main ---
main() {
  log "Installing Neuralgentics..."
  $DEV_MODE && log "Development mode enabled."
  $DRY_RUN && warn "Dry run — no changes will be made."

  check_deps
  install_node_deps
  install_python_deps
  init_database
  build_typescript

  log "Neuralgentics installed. Run 'neuralgentics serve' to start."
}

main