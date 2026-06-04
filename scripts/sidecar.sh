#!/usr/bin/env bash
# Neuralgentics — Python gRPC embedding sidecar launcher
# Manages the embedding sidecar process lifecycle (start/stop/restart/status).
#
# The sidecar provides gRPC embedding services over a Unix domain socket
# at /tmp/neuralgentics-embed.sock by default.
#
# Environment:
#   NEURALGENTICS_EMBED_DEVICE  — "cpu" (default) or "cuda" for GPU acceleration
#   NEURAL_EMBED_ADDR           — listen address (default: unix:///tmp/neuralgentics-embed.sock)
#
# Usage:
#   ./scripts/sidecar.sh {start|stop|restart|status}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOCKET="${NEURAL_EMBED_ADDR#unix://}"
# If NEURAL_EMBED_ADDR uses the default unix: prefix, strip it for socket path check
if [[ "$SOCKET" == "$NEURAL_EMBED_ADDR" ]]; then
  # NEURAL_EMBED_ADDR was not set or didn't start with unix:// — use default socket
  SOCKET="/tmp/neuralgentics-embed.sock"
fi

PIDFILE="/tmp/neuralgentics-embed.pid"
LOGFILE="/tmp/neuralgentics-embed.log"
SIDECAR_DIR="$PROJECT_ROOT/packages/memory/cmd/embedding-sidecar"
EMBED_DEVICE="${NEURALGENTICS_EMBED_DEVICE:-cpu}"

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[sidecar]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[sidecar]${NC} %s\n" "$*"; }
err()  { printf "${RED}[sidecar]${NC} %s\n" "$*" >&2; }

# ─── Helpers ─────────────────────────────────────────────────────────────────

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

wait_for_socket() {
  local timeout="${1:-10}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if [ -S "$SOCKET" ]; then
      return 0
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
  return 1
}

# ─── Actions ─────────────────────────────────────────────────────────────────

start() {
  if is_running; then
    log "sidecar already running (pid=$(cat "$PIDFILE"), socket=$SOCKET)"
    return 0
  fi

  # Clean stale socket/pidfile
  rm -f "$SOCKET"
  rm -f "$PIDFILE"

  if [ ! -d "$SIDECAR_DIR/.venv" ]; then
    err "sidecar venv not found at $SIDECAR_DIR/.venv"
    err "Run scripts/install.sh first to set up the sidecar environment."
    exit 1
  fi

  # Select python binary: prefer venv, fall back to system
  local python_bin="$SIDECAR_DIR/.venv/bin/python"
  if [ ! -x "$python_bin" ]; then
    python_bin="$(command -v python3 || command -v python)"
    if [ -z "$python_bin" ]; then
      err "No Python interpreter found"
      exit 1
    fi
  fi

  log "starting sidecar (device=$EMBED_DEVICE, socket=$SOCKET)"
  cd "$SIDECAR_DIR"
  setsid env \
    PYTHONPATH=. \
    NEURALGENTICS_EMBED_DEVICE="$EMBED_DEVICE" \
    "$python_bin" main.py \
    > "$LOGFILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  cd "$PROJECT_ROOT"
  disown "$pid" 2>/dev/null || true

  # Wait for socket to appear (health check)
  if wait_for_socket 20; then
    log "sidecar ready (pid=$pid, socket=$SOCKET, log=$LOGFILE)"
    return 0
  else
    err "sidecar did not become ready within 10s — see $LOGFILE"
    err "Last 20 lines of log:"
    tail -20 "$LOGFILE" 2>/dev/null || err "(no log output)"
    exit 1
  fi
}

stop() {
  if ! is_running; then
    # Clean stale files even if not running
    rm -f "$PIDFILE" "$SOCKET"
    log "sidecar not running"
    return 0
  fi

  local pid
  pid=$(cat "$PIDFILE")
  log "stopping sidecar (pid=$pid)..."
  kill -TERM "$pid" 2>/dev/null || true

  # Wait for graceful shutdown
  local retries=0
  while [ $retries -lt 20 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE" "$SOCKET"
      log "sidecar stopped"
      return 0
    fi
    sleep 0.5
    retries=$((retries + 1))
  done

  warn "sidecar did not stop gracefully, sending SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PIDFILE" "$SOCKET"
  log "sidecar killed"
}

restart() {
  stop
  start
}

status() {
  if is_running; then
    local pid
    pid=$(cat "$PIDFILE")
    log "running (pid=$pid, socket=$SOCKET)"
  else
    # Clean stale pidfile if process is dead
    rm -f "$PIDFILE" "$SOCKET"
    log "not running"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    echo ""
    echo "Environment:"
    echo "  NEURALGENTICS_EMBED_DEVICE  cpu|cuda  (default: cpu)"
    echo "  NEURAL_EMBED_ADDR           Listen address (default: unix:///tmp/neuralgentics-embed.sock)"
    exit 1
    ;;
esac