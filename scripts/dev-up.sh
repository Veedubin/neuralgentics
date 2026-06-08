#!/usr/bin/env bash
# neuralgentics — Development Environment Setup Script (T-022)
#
# Brings up the test database (PostgreSQL on port 6000 with SSL),
# applies all migrations, starts the gRPC embedding sidecar, and
# verifies the Go backend binary exists.
#
# Idempotent: safe to run multiple times. Second run will report
# "Already running" where applicable and take no destructive action.
#
# Environment:
#   NEURAL_EMBED_ADDR  — Sidecar listen address (default: unix:///tmp/neuralgentics-embed.sock)
#   NEURALGENTICS_EMBED_DEVICE — "cpu" (default) or "cuda"
#
# Requirements:
#   - podman (https://podman.io)
#   - Python 3.11+ with venv at packages/memory/cmd/embedding-sidecar/.venv
#   - Go 1.22+ (for backend binary build, if not pre-built)
set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────

CONTAINER_NAME="neuralgentics-test-pg"
CONTAINER_IMAGE="docker.io/pgvector/pgvector:pg18"
DB_PORT=6000
DB_USER="postgres"
DB_PASS="testpassword"
DB_NAME="neuralgentics_test"
DB_SSLMODE="require"
SOCKET_PATH="/tmp/neuralgentics-embed.sock"
SIDECAR_PIDFILE="/tmp/neuralgentics-embed.pid"
SIDECAR_LOGFILE="/tmp/neuralgentics-embed.log"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MIGRATIONS_DIR="$PROJECT_ROOT/packages/memory/src/neuralgentics/memory/store/migrations/postgres"
SIDECAR_DIR="$PROJECT_ROOT/packages/memory/cmd/embedding-sidecar"
BACKEND_BIN="$PROJECT_ROOT/packages/backend-go/neuralgentics-backend"

CERTS_DIR="$PROJECT_ROOT/certs"
INITDB_DIR="$PROJECT_ROOT/certs/initdb.d"

# ─── Colors ──────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { printf "${GREEN}[dev-up]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[dev-up]${NC} %s\n" "$*"; }
err()  { printf "${RED}[dev-up]${NC} %s\n" "$*" >&2; }
info() { printf "${CYAN}[dev-up]${NC} %s\n" "$*"; }

# ─── Pre-flight checks ──────────────────────────────────────────────────────

if ! command -v podman >/dev/null 2>&1; then
    err "podman not found. Install with: brew install podman (mac) or apt install podman (linux)"
    exit 1
fi

# ─── Step 1: PostgreSQL container ───────────────────────────────────────────

container_exists() {
    podman inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_is_running() {
    podman inspect "$CONTAINER_NAME" --format '{{.State.Running}}' 2>/dev/null | grep -q "true"
}

setup_database() {
    if container_is_running; then
        log "PostgreSQL container '$CONTAINER_NAME' is already running on port $DB_PORT"
        return 0
    fi

    if container_exists; then
        log "Starting existing container '$CONTAINER_NAME'..."
        podman start "$CONTAINER_NAME"
        # Wait for PostgreSQL to accept connections
        wait_for_db
        return 0
    fi

    # Verify certs directory exists
    if [ ! -d "$CERTS_DIR" ]; then
        err "SSL certs directory not found: $CERTS_DIR"
        err "Run the SSL setup first (certs/server.crt and certs/server.key required)"
        exit 1
    fi

    if [ ! -f "$CERTS_DIR/server.crt" ] || [ ! -f "$CERTS_DIR/server.key" ]; then
        err "SSL certificate files not found in $CERTS_DIR"
        err "Expected: server.crt and server.key"
        exit 1
    fi

    log "Creating PostgreSQL container '$CONTAINER_NAME' on port $DB_PORT with SSL..."
    podman run -d \
        --name "$CONTAINER_NAME" \
        -e POSTGRES_USER="$DB_USER" \
        -e POSTGRES_PASSWORD="$DB_PASS" \
        -e POSTGRES_DB="$DB_NAME" \
        -v "$CERTS_DIR":/certs-source:ro \
        -v "$INITDB_DIR":/docker-entrypoint-initdb.d:ro \
        -p "$DB_PORT:5432" \
        "$CONTAINER_IMAGE"

    wait_for_db
    log "PostgreSQL container created and started on port $DB_PORT"
}

wait_for_db() {
    local max_attempts=30
    local attempt=0
    log "Waiting for PostgreSQL to accept connections..."
    while [ $attempt -lt $max_attempts ]; do
        if podman exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
            log "PostgreSQL is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    err "PostgreSQL did not become ready within ${max_attempts}s"
    exit 1
}

# ─── Step 2: Apply migrations ─────────────────────────────────────────────────

DB_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}?sslmode=${DB_SSLMODE}"

apply_migrations() {
    log "Checking database migrations..."

    # Get list of migration files, sorted
    local migration_files
    migration_files="$(find "$MIGRATIONS_DIR" -name '*.up.sql' | sort)"

    if [ -z "$migration_files" ]; then
        err "No migration files found in $MIGRATIONS_DIR"
        exit 1
    fi

    # Check if migrations are already applied by testing for the memories table
    local table_count
    table_count="$(podman exec -i "$CONTAINER_NAME" psql "$DB_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")"
    table_count="$(echo "$table_count" | tr -d '[:space:]')"

    if [ "$table_count" -ge 13 ]; then
        log "Migrations already applied ($table_count tables found — expected 13+)"
        return 0
    fi

    log "Applying migrations..."
    while IFS= read -r migration_file; do
        local filename
        filename="$(basename "$migration_file")"
        log "  Applying: $filename"
        if ! podman exec -i "$CONTAINER_NAME" psql "$DB_URL" < "$migration_file"; then
            err "Failed to apply migration: $filename"
            exit 1
        fi
    done <<< "$migration_files"

    # Verify
    table_count="$(podman exec -i "$CONTAINER_NAME" psql "$DB_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")"
    table_count="$(echo "$table_count" | tr -d '[:space:]')"
    log "Migrations applied successfully ($table_count tables)"
}

# ─── Step 3: gRPC embedding sidecar ─────────────────────────────────────────

setup_sidecar() {
    local socket_path="${NEURAL_EMBED_ADDR#unix://}"
    if [ "$socket_path" = "$NEURAL_EMBED_ADDR" ]; then
        # NEURAL_EMBED_ADDR not set or doesn't start with unix://
        socket_path="$SOCKET_PATH"
    fi

    # Check if socket already exists (sidecar may be pre-started)
    if [ -S "$socket_path" ]; then
        log "gRPC sidecar socket already exists at $socket_path"
        # Check if the process behind it is alive
        local existing_pid
        existing_pid="$(lsof -t "$socket_path" 2>/dev/null || true)"
        if [ -n "$existing_pid" ]; then
            log "gRPC sidecar is running (pid=$existing_pid)"
            return 0
        fi
        # Stale socket — remove it
        warn "Stale socket detected at $socket_path (no process bound to it). Removing."
        rm -f "$socket_path"
    fi

    # Check if sidecar is running via PID file
    if [ -f "$SIDECAR_PIDFILE" ]; then
        local pid
        pid="$(cat "$SIDECAR_PIDFILE")"
        if kill -0 "$pid" 2>/dev/null; then
            log "gRPC sidecar already running (pid=$pid, socket=$socket_path)"
            return 0
        fi
        # Stale PID file
        rm -f "$SIDECAR_PIDFILE"
    fi

    # Locate Python interpreter
    local python_bin="$SIDECAR_DIR/.venv/bin/python"
    if [ ! -x "$python_bin" ]; then
        python_bin="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
        if [ -z "$python_bin" ]; then
            err "No Python interpreter found. Install Python 3.11+ or run scripts/install.sh"
            exit 1
        fi
        warn "Using system Python: $python_bin (prefer venv at $SIDECAR_DIR/.venv)"
    fi

    # Spawn sidecar
    log "Starting gRPC embedding sidecar..."
    local embed_device="${NEURALGENTICS_EMBED_DEVICE:-cpu}"
    cd "$SIDECAR_DIR"
    setsid env \
        PYTHONPATH=. \
        NEURALGENTICS_EMBED_DEVICE="$embed_device" \
        NEURAL_EMBED_ADDR="${NEURAL_EMBED_ADDR:-unix://$SOCKET_PATH}" \
        "$python_bin" -m embedding_sidecar.main \
        > "$SIDECAR_LOGFILE" 2>&1 < /dev/null &
    local pid=$!
    echo "$pid" > "$SIDECAR_PIDFILE"
    cd "$PROJECT_ROOT"
    disown "$pid" 2>/dev/null || true

    # Wait for socket to appear (30 retries × 100ms = 3s)
    local retries=30
    local waited=0
    while [ $waited -lt $retries ]; do
        if [ -S "$socket_path" ]; then
            log "gRPC sidecar ready (pid=$pid, socket=$socket_path)"
            return 0
        fi
        sleep 0.1
        waited=$((waited + 1))
    done

    # Check if process is still alive
    if ! kill -0 "$pid" 2>/dev/null; then
        err "gRPC sidecar process died during startup. See $SIDECAR_LOGFILE:"
        tail -20 "$SIDECAR_LOGFILE" 2>/dev/null || err "(no log output)"
        exit 1
    fi

    # Process alive but socket not yet bound — give it more time
    warn "Sidecar process alive but socket not yet bound after 3s. Waiting longer..."
    local extended=0
    while [ $extended -lt 50 ]; do
        if [ -S "$socket_path" ]; then
            log "gRPC sidecar ready (pid=$pid, socket=$socket_path)"
            return 0
        fi
        sleep 0.1
        extended=$((extended + 1))
    done

    err "gRPC sidecar did not bind socket within 8s. See $SIDECAR_LOGFILE:"
    tail -20 "$SIDECAR_LOGFILE" 2>/dev/null || err "(no log output)"
    exit 1
}

# ─── Step 4: Verify Go backend binary ────────────────────────────────────────

verify_backend() {
    if [ -x "$BACKEND_BIN" ]; then
        log "Go backend binary exists: $BACKEND_BIN"
        return 0
    fi

    # Check if we can build it
    if [ -f "$PROJECT_ROOT/packages/backend-go/cmd/backend/main.go" ]; then
        warn "Go backend binary not found. Building..."
        (cd "$PROJECT_ROOT/packages/backend-go" && go build -o neuralgentics-backend ./cmd/backend/)
        if [ -x "$BACKEND_BIN" ]; then
            log "Go backend binary built successfully"
            return 0
        fi
        err "Go backend build failed"
        return 1
    fi

    # Binary not found and can't build — warn but don't fail
    warn "Go backend binary not found at $BACKEND_BIN"
    warn "Run 'cd packages/backend-go && go build -o neuralgentics-backend ./cmd/backend/' to build it"
    return 0
}

# ─── Summary ──────────────────────────────────────────────────────────────────

print_summary() {
    echo ""
    echo "=========================================="
    echo "  Neuralgentics Dev Environment Ready"
    echo "=========================================="
    echo ""
    echo "  PostgreSQL:  localhost:$DB_PORT ($DB_NAME, SSL=$DB_SSLMODE)"
    echo "  Container:   $CONTAINER_NAME"
    echo "  Sidecar:    $SOCKET_PATH"
    echo "  Backend:     $([ -x "$BACKEND_BIN" ] && echo "$BACKEND_BIN" || echo "NOT BUILT")"
    echo ""
    echo "  Quick commands:"
    echo "    ./scripts/sidecar.sh status   — Check sidecar status"
    echo "    ./scripts/sidecar.sh stop      — Stop sidecar"
    echo "    podman stop $CONTAINER_NAME    — Stop database"
    echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

info "Setting up Neuralgentics development environment..."
echo ""

setup_database
apply_migrations
setup_sidecar
verify_backend

print_summary

log "Development environment is ready!"