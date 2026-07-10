#!/usr/bin/env bash
# scripts/compose.sh — Wrapper for docker compose / podman-compose
# Detects which runtime is available and provides a unified CLI.
#
# Usage:
#   ./scripts/compose.sh up       — Start all services
#   ./scripts/compose.sh down     — Stop and remove all services
#   ./scripts/compose.sh status   — Show running services
#   ./scripts/compose.sh logs     — Tail service logs
#   ./scripts/compose.sh build    — Build images from local source
#   ./scripts/compose.sh pull     — Pull pre-built images from GHCR
#
# Environment:
#   COMPOSE_BUILD=1              — Build from local source instead of pulling
#   NEURALGENTICS_VERSION         — Image tag (default: v0.1.0)
#   NEURALGENTICS_DB_PASSWORD     — PostgreSQL password (default: neuralgentics)
#   NEURALGENTICS_EMBED_DEVICE    — Embedding device: cpu or cuda (default: cpu)

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────

NEURALGENTICS_VERSION="${NEURALGENTICS_VERSION:-v0.1.0}"
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.yml"

# ─── Colors ─────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { printf "${GREEN}[compose]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[compose]${NC} %s\n" "$*"; }
err()  { printf "${RED}[compose]${NC} %s\n" "$*" >&2; }
info() { printf "${CYAN}[compose]${NC} %s\n" "$*"; }

# ─── Detect compose runtime ────────────────────────────────────────────────

detect_compose_cmd() {
    if command -v podman-compose >/dev/null 2>&1; then
        echo "podman-compose"
    elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        echo "docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        echo "docker-compose"
    else
        err "No compose runtime found. Install one of:"
        err "  podman-compose (recommended)"
        err "  docker compose (Docker CLI plugin)"
        err "  docker-compose (standalone)"
        exit 1
    fi
}

COMPOSE_CMD="$(detect_compose_cmd)"

# ─── Detect container runtime ───────────────────────────────────────────────

detect_runtime() {
    if command -v podman >/dev/null 2>&1; then
        echo "podman"
    elif command -v docker >/dev/null 2>&1; then
        echo "docker"
    else
        echo "unknown"
    fi
}

RUNTIME="$(detect_runtime)"

log "Using: ${BOLD}${COMPOSE_CMD}${NC} (runtime: ${RUNTIME})"

# ─── Export env vars for compose ────────────────────────────────────────────

export NEURALGENTICS_VERSION
export NEURALGENTICS_DB_PASSWORD="${NEURALGENTICS_DB_PASSWORD:-neuralgentics}"
export NEURALGENTICS_DB_USER="${NEURALGENTICS_DB_USER:-postgres}"
export NEURALGENTICS_DB_NAME="${NEURALGENTICS_DB_NAME:-neuralgentics}"
export NEURALGENTICS_DB_PORT="${NEURALGENTICS_DB_PORT:-6200}"
export NEURALGENTICS_EMBED_DEVICE="${NEURALGENTICS_EMBED_DEVICE:-cpu}"
export EMBEDDING_MODE="${EMBEDDING_MODE:-auto}"

# ─── Subcommands ────────────────────────────────────────────────────────────

cmd_up() {
    info "Starting Neuralgentics stack (${NEURALGENTICS_VERSION})..."

    if [ "${COMPOSE_BUILD:-0}" = "1" ]; then
        log "COMPOSE_BUILD=1 — Building images from local source..."
        ${COMPOSE_CMD} -f "$COMPOSE_FILE" build
    fi

    ${COMPOSE_CMD} -f "$COMPOSE_FILE" up -d

    echo ""
    echo "  ┌──────────────────────────────────────────────────────┐"
    echo "  │  HACK THE PLANET! — Neuralgentics is running.        │"
    echo "  │                                                        │"
    echo -n "  │  PostgreSQL:  localhost:${NEURALGENTICS_DB_PORT:-6200}"
    printf "%-28s│\n" ""
    echo "  │  Embeddings:  sidecar:50051 (internal)              │"
    echo -n "  │  Backend:     stdio (attach tui to interact)"
    printf "%-12s│\n" ""
    echo "  │                                                        │"
    echo "  │  Attach to TUI:  ${RUNTIME} attach neuralgentics-tui  │"
    echo "  │  View logs:      $0 logs                              │"
    echo "  │  Stop:           $0 down                              │"
    echo "  └──────────────────────────────────────────────────────┘"
}

cmd_down() {
    info "Stopping Neuralgentics stack..."
    ${COMPOSE_CMD} -f "$COMPOSE_FILE" down
    log "Stack stopped."
}

cmd_status() {
    ${COMPOSE_CMD} -f "$COMPOSE_FILE" ps
}

cmd_logs() {
    local service="${1:-}"
    if [ -n "$service" ]; then
        ${COMPOSE_CMD} -f "$COMPOSE_FILE" logs -f "$service"
    else
        ${COMPOSE_CMD} -f "$COMPOSE_FILE" logs -f
    fi
}

cmd_build() {
    log "Building images from local source..."
    ${COMPOSE_CMD} -f "$COMPOSE_FILE" build
    log "Build complete."
}

cmd_pull() {
    log "Pulling pre-built images from GHCR..."
    ${COMPOSE_CMD} -f "$COMPOSE_FILE" pull
    log "Pull complete."
}

cmd_help() {
    echo "Usage: $0 {up|down|status|logs|build|pull|help} [args]"
    echo ""
    echo "Commands:"
    echo "  up       Start all services (use COMPOSE_BUILD=1 to build from source)"
    echo "  down     Stop and remove all services"
    echo "  status   Show running service status"
    echo "  logs     Tail logs (optional: specify service name)"
    echo "  build    Build images from local source"
    echo "  pull     Pull pre-built images from GHCR"
    echo "  help     Show this help message"
    echo ""
    echo "Environment:"
    echo "  COMPOSE_BUILD=1          Build from source instead of pulling images"
    echo "  NEURALGENTICS_VERSION    Image tag (default: v0.1.0)"
    echo "  NEURALGENTICS_DB_PASSWORD PostgreSQL password (default: neuralgentics)"
    echo "  NEURALGENTICS_EMBED_DEVICE   cpu or cuda (default: cpu)"
}

# ─── Main ───────────────────────────────────────────────────────────────────

case "${1:-help}" in
    up)
        cmd_up
        ;;
    down)
        cmd_down
        ;;
    status|ps)
        cmd_status
        ;;
    logs)
        cmd_logs "${2:-}"
        ;;
    build)
        cmd_build
        ;;
    pull)
        cmd_pull
        ;;
    help|--help|-h)
        cmd_help
        ;;
    *)
        err "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac