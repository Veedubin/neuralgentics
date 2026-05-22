#!/usr/bin/env bash
set -e

# Neuralgentics — Service Launcher
# Usage: ./scripts/serve.sh [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERBOSE=false
PIDS=()

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[serve]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[serve]${NC} %s\n" "$*"; }
err()  { printf "${RED}[serve]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Service Launcher

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
    *) err "Unknown option: $1"; usage ;;
  esac
done

# --- Cleanup ---
cleanup() {
  log "Shutting down services..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      verbose "Killing PID $pid"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  # Wait for graceful shutdown
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  log "All services stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM

# --- Start Services ---
start_memini_core() {
  log "Starting memini-core on port 8900..."
  cd "$PROJECT_ROOT/packages/memini-core"
  export MEMINI_DB_URL="${MEMINI_DB_URL:-postgresql://postgres:password@localhost:5434/neuralgentics}"
  if command -v uv &>/dev/null; then
    uv run python -m memini_core.server &
  else
    python3 -m memini_core.server &
  fi
  PIDS+=($!)
  cd "$PROJECT_ROOT"
  verbose "memini-core PID: ${PIDS[-1]}"

  # Wait for it to be ready
  local retries=0
  while ! curl -sf http://localhost:8900/health &>/dev/null; do
    if [[ $retries -ge 30 ]]; then
      err "memini-core failed to start within 30 seconds."
      cleanup
      exit 1
    fi
    retries=$((retries + 1))
    sleep 1
  done
  log "memini-core ready on port 8900"
}

start_broker() {
  # Check if broker config exists
  if [[ ! -d "$PROJECT_ROOT/packages/broker/src" ]]; then
    warn "Broker package not found — skipping."
    return 0
  fi

  log "Starting MCP broker on port 8901..."
  cd "$PROJECT_ROOT/packages/broker"
  if [[ -f "package.json" ]]; then
    bun run src/index.ts &
  elif [[ -f "pyproject.toml" ]]; then
    uv run python -m broker &
  else
    warn "Broker has no recognizable entry point — skipping."
    cd "$PROJECT_ROOT"
    return 0
  fi
  PIDS+=($!)
  cd "$PROJECT_ROOT"
  verbose "broker PID: ${PIDS[-1]}"

  # Wait for broker
  local retries=0
  while ! curl -sf http://localhost:8901/health &>/dev/null; do
    if [[ $retries -ge 15 ]]; then
      warn "Broker not responding after 15s — continuing anyway."
      break
    fi
    retries=$((retries + 1))
    sleep 1
  done
  log "MCP broker ready on port 8901"
}

# --- Main ---
main() {
  log "Starting Neuralgentics services..."
  $VERBOSE && log "Verbose mode enabled."

  start_memini_core
  start_broker

  log ""
  log "Neuralgentics is running."
  log "  memini-core:  http://localhost:8900"
  log "  MCP broker:   http://localhost:8901"
  log ""
  log "Press Ctrl+C to stop."

  # Keep script alive — wait on last background process
  wait
}

main