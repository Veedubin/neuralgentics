#!/usr/bin/env bash
set -e

# Neuralgentics — Release Script
# Usage: ./scripts/release.sh [--dry-run] [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false
VERBOSE=false
SKIP_EXTERNAL_SKILLS=false

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[release]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[release]${NC} %s\n" "$*"; }
err()  { printf "${RED}[release]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Release Script

Usage: $(basename "$0") [OPTIONS]

Options:
  --dry-run                Show what would be done without executing
  --verbose                Enable verbose output
  --skip-external-skills   Skip external skills fetch and bundling (lean tarball)
  -h, --help               Show this help message
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    --skip-external-skills) SKIP_EXTERNAL_SKILLS=true; shift ;;
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

# --- External Skills Fetcher ---
run_external_fetcher() {
  if $SKIP_EXTERNAL_SKILLS; then
    warn "Skipping external skills fetch (--skip-external-skills set)"
    return 0
  fi

  local env_file="$PROJECT_ROOT/.env"
  local enabled="false"
  if [[ -f "$env_file" ]]; then
    enabled=$(grep -E '^external_skills\.enabled=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "false")
  fi

  if [[ "$enabled" != "true" ]]; then
    warn "external_skills.enabled is not 'true' — skipping external skills fetch"
    return 0
  fi

  log "Fetching external skills..."
  if ! run "$SCRIPT_DIR/external-skills-fetcher.sh"; then
    err "External skills fetch failed; use --skip-external-skills to bypass (offline release)"
    exit 1
  fi
}

# --- Steps ---
read_version() {
  local version
  version=$(python3 -c "import json; print(json.load(open('$PROJECT_ROOT/package.json'))['version'])" 2>/dev/null)
  if [[ -z "$version" ]]; then
    err "Could not read version from package.json"
    exit 1
  fi
  echo "$version"
}

check_clean_tree() {
  if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)" ]]; then
    err "Working tree is not clean. Commit or stash changes before releasing."
    git -C "$PROJECT_ROOT" status --short
    exit 1
  fi
  log "Working tree is clean."
}

run_tests() {
  log "Running tests..."
  run bun test packages/plugin
  run cd "$PROJECT_ROOT/packages/memini-core" && uv run pytest && cd "$PROJECT_ROOT"
}

build_dist() {
  log "Building dist tarball..."
  run "$PROJECT_ROOT/scripts/build.sh"

  local version
  version=$(read_version)
  local tarball_name="neuralgentics-v${version}.tar.gz"

  run cd "$PROJECT_ROOT/build"
  run tar -czf "$tarball_name" -C dist .
  verbose "Tarball: $PROJECT_ROOT/build/$tarball_name"
  run cd "$PROJECT_ROOT"
  echo "$tarball_name"
}

create_tag() {
  local version="$1"
  local tag="v${version}"
  log "Creating tag $tag..."
  run git -C "$PROJECT_ROOT" tag "$tag"
  run git -C "$PROJECT_ROOT" push origin "$tag"
}

create_github_release() {
  local version="$1"
  local tarball="$2"
  local tag="v${version}"

  if ! command -v gh &>/dev/null; then
    warn "gh CLI not found — skipping GitHub release creation."
    warn "Install gh CLI and run: gh release create $tag $tarball"
    return 0
  fi

  log "Creating GitHub release for $tag..."
  run gh release create "$tag" \
    "$PROJECT_ROOT/build/$tarball" \
    --title "Neuralgentics $tag" \
    --notes "Release $tag of Neuralgentics. See CHANGELOG.md for details."
}

# --- Main ---
main() {
  local version
  version=$(read_version)

  log "Preparing release v${version}..."
  $DRY_RUN && warn "Dry run — no changes will be made."

  check_clean_tree
  run_external_fetcher
  run_tests

  local tarball
  tarball=$(build_dist)

  create_tag "$version"
  create_github_release "$version" "$tarball"

  log "Release v${version} created."
}

main