#!/usr/bin/env bash
set -e

# Neuralgentics — Auto-Updater
# Usage: ./scripts/update.sh [--check] [--dry-run] [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GITHUB_REPO="jcharles/neuralgentics"  # Adjust if repo differs
DRY_RUN=false
VERBOSE=false
CHECK_ONLY=false

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[update]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[update]${NC} %s\n" "$*"; }
err()  { printf "${RED}[update]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Auto-Updater

Usage: $(basename "$0") [OPTIONS]

Options:
  --check     Check for updates without applying
  --dry-run   Show what would be done without executing
  --verbose   Enable verbose output
  -h, --help  Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   CHECK_ONLY=true; shift ;;
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

# --- Functions ---
get_current_version() {
  local version
  version=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/package.json'))['version'])" 2>/dev/null)
  if [[ -z "$version" ]]; then
    # Strip leading v if present in git describe
    version=$(git -C "$PROJECT_ROOT" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
  fi
  echo "${version:-0.0.0}"
}

get_latest_version() {
  local latest
  latest=$(curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null \
    | sed 's/^v//')
  echo "${latest:-}"
}

version_gt() {
  # Returns 0 (true) if $1 > $2
  python3 -c "
from packaging.version import Version
import sys
sys.exit(0 if Version('$1') > Version('$2') else 1)
" 2>/dev/null
}

download_release() {
  local version="$1"
  local tag="v${version}"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  local tarball_url="https://github.com/$GITHUB_REPO/releases/download/$tag/neuralgentics-v${version}.tar.gz"

  log "Downloading release $tag..."
  verbose "URL: $tarball_url"
  verbose "Temp dir: $tmp_dir"

  if ! curl -fsSL -o "$tmp_dir/neuralgentics.tar.gz" "$tarball_url"; then
    err "Failed to download release tarball."
    rm -rf "$tmp_dir"
    exit 1
  fi

  echo "$tmp_dir"
}

apply_update() {
  local tmp_dir="$1"
  log "Extracting update..."
  run tar -xzf "$tmp_dir/neuralgentics.tar.gz" -C "$tmp_dir/dist"

  log "Running install script..."
  if [[ -f "$tmp_dir/dist/share/install.sh" ]]; then
    run bash "$tmp_dir/dist/share/install.sh"
  else
    warn "No install.sh in release tarball — manual install required."
  fi

  log "Replacing current installation..."
  # Backup current dist
  if [[ -d "$PROJECT_ROOT/build/dist" ]]; then
    run mv "$PROJECT_ROOT/build/dist" "$PROJECT_ROOT/build/dist.bak"
  fi
  run cp -r "$tmp_dir/dist" "$PROJECT_ROOT/build/dist"

  # Cleanup
  run rm -rf "$tmp_dir"

  log "Update applied."
}

restart_service() {
  # Best-effort service restart
  if pgrep -f "neuralgentics serve" &>/dev/null; then
    log "Restarting Neuralgentics service..."
    pkill -f "neuralgentics serve" 2>/dev/null || true
    sleep 1
    nohup "$PROJECT_ROOT/build/dist/bin/neuralgentics" serve &>/dev/null &
    log "Service restarted (PID: $!)"
  else
    verbose "No running service detected — skipping restart."
  fi
}

# --- Main ---
main() {
  local current
  local latest

  current=$(get_current_version)
  latest=$(get_latest_version)

  if [[ -z "$latest" ]]; then
    err "Could not fetch latest version from GitHub."
    err "Check network connectivity and repo: $GITHUB_REPO"
    exit 1
  fi

  log "Current: v${current}"
  log "Latest:  v${latest}"

  if ! version_gt "$latest" "$current"; then
    log "Already up to date (v${current})."
    exit 0
  fi

  log "Update available: v${current} → v${latest}"

  if $CHECK_ONLY; then
    log "Use --without --check to apply the update."
    exit 0
  fi

  $DRY_RUN && warn "Dry run — no changes will be made."

  local tmp_dir
  tmp_dir=$(download_release "$latest")
  apply_update "$tmp_dir"
  restart_service

  log "Updated to v${latest}."
}

main