#!/usr/bin/env bash
set -e

# Neuralgentics — Master Build Script
# Usage: ./scripts/build.sh [--dry-run] [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/build/dist"
DRY_RUN=false
VERBOSE=false

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[build]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[build]${NC} %s\n" "$*"; }
err()  { printf "${RED}[build]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Build Script

Usage: $(basename "$0") [OPTIONS]

Options:
  --dry-run   Show what would be done without executing
  --verbose   Enable verbose output
  -h, --help  Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

# --- Build Steps ---
clean_dist() {
  log "Cleaning $DIST_DIR..."
  run rm -rf "$DIST_DIR"
  run mkdir -p "$DIST_DIR/bin"
  run mkdir -p "$DIST_DIR/lib"
  run mkdir -p "$DIST_DIR/share"
}

build_typescript() {
  log "Building TypeScript packages (plugin, orchestrator)..."
  run bun run build:ts

  # Copy compiled JS output
  for pkg in plugin orchestrator; do
    local src="$PROJECT_ROOT/packages/$pkg/dist"
    if [[ -d "$src" ]]; then
      run cp -r "$src" "$DIST_DIR/lib/$pkg"
      verbose "Copied $pkg → $DIST_DIR/lib/$pkg"
    else
      warn "No dist found for $pkg — skipping copy"
    fi
  done
}

build_python() {
  log "Building Python packages (memini-core, broker)..."
  run cd "$PROJECT_ROOT/packages/memini-core"
  if command -v uv &>/dev/null; then
    run uv build
  else
    run python3 -m build
  fi

  # Copy wheel/sdist to dist
  local py_dist="$PROJECT_ROOT/packages/memini-core/dist"
  if [[ -d "$py_dist" ]]; then
    run cp -r "$py_dist" "$DIST_DIR/lib/memini-core"
    verbose "Copied memini-core dist → $DIST_DIR/lib/memini-core"
  fi
  run cd "$PROJECT_ROOT"
}

create_cli_wrapper() {
  log "Creating CLI wrapper script..."
  local cli_path="$DIST_DIR/bin/neuralgentics"
  cat > "$cli_path" <<'CLI_EOF'
#!/usr/bin/env bash
set -e

NEURALGENTICS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Neuralgentics — Coding Agent Built on OpenCode

Usage: neuralgentics <command> [options]

Commands:
  serve       Start all services
  install     Run install script
  update      Check for / apply updates
  verify      Verify installation
  version     Print version
  help        Show this help message
EOF
  exit 0
}

case "${1:-help}" in
  serve)   exec "$NEURALGENTICS_ROOT/share/serve.sh" "${@:2}" ;;
  install) exec "$NEURALGENTICS_ROOT/share/install.sh" "${@:2}" ;;
  update)  exec "$NEURALGENTICS_ROOT/share/update.sh" "${@:2}" ;;
  verify)  exec "$NEURALGENTICS_ROOT/share/verify.sh" "${@:2}" ;;
  version) cat "$NEURALGENTICS_ROOT/share/VERSION" ;;
  help|*)  usage ;;
esac
CLI_EOF
  run chmod +x "$cli_path"
  verbose "CLI wrapper created at $cli_path"
}

copy_runtime_files() {
  log "Copying runtime files..."
  # Copy scripts to share/
  for script in serve.sh verify.sh install.sh update.sh; do
    if [[ -f "$PROJECT_ROOT/scripts/$script" ]]; then
      run cp "$PROJECT_ROOT/scripts/$script" "$DIST_DIR/share/"
    fi
  done

  # Copy package.json for version info
  run cp "$PROJECT_ROOT/package.json" "$DIST_DIR/share/package.json"

  # Write VERSION file
  local version
  version=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/package.json'))['version'])" 2>/dev/null \
    || echo "0.0.0")
  echo "$version" > "$DIST_DIR/share/VERSION"

  # Copy patches
  if [[ -d "$PROJECT_ROOT/patches" ]]; then
    run cp -r "$PROJECT_ROOT/patches" "$DIST_DIR/share/patches"
  fi

  # Copy external skills snapshot (if present)
  if [[ -d "$HOME/.neuralgentics/external_skills" ]]; then
    local env_file="$PROJECT_ROOT/.env"
    local bundle_enabled="true"
    if [[ -f "$env_file" ]]; then
      local opt_out
      opt_out=$(grep -E '^external_skills\.bundle_in_tarball=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")
      if [[ "$opt_out" == "false" ]]; then
        bundle_enabled="false"
      fi
    fi
    if [[ "$bundle_enabled" == "true" ]]; then
      log "Bundling external skills..."
      run mkdir -p "$DIST_DIR/share/external_skills"
      # Copy contents but exclude .git dirs (saves ~50% of snapshot size)
      if command -v rsync &>/dev/null; then
        run rsync -a --exclude='.git' "$HOME/.neuralgentics/external_skills/" "$DIST_DIR/share/external_skills/"
      else
        run cp -r "$HOME/.neuralgentics/external_skills/." "$DIST_DIR/share/external_skills/" 2>/dev/null
        # Remove .git directories if cp was used
        run find "$DIST_DIR/share/external_skills" -name '.git' -type d -exec rm -rf {} + 2>/dev/null || true
      fi
      verbose "External skills copied to $DIST_DIR/share/external_skills"
    else
      warn "external_skills.bundle_in_tarball=false — skipping external skills bundle"
    fi
  else
    log "No external skills snapshot found; skipping"
  fi

  # Copy node_modules (production only)
  if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
    log "Copying production node_modules..."
    run cp -r "$PROJECT_ROOT/node_modules" "$DIST_DIR/lib/node_modules"
  fi
}

# --- Main ---
main() {
  log "Building Neuralgentics..."
  $DRY_RUN && warn "Dry run — no changes will be made."

  clean_dist
  build_typescript
  build_python
  copy_runtime_files
  create_cli_wrapper

  log "Build complete → $DIST_DIR"
  log "Run $DIST_DIR/bin/neuralgentics serve to start."
}

main