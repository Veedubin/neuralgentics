#!/usr/bin/env bash
set -e

# Neuralgentics — Apply OpenCode Patches
# Usage: ./scripts/apply-patches.sh [--dry-run] [--verbose] [-h/--help]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$PROJECT_ROOT/patches"
DRY_RUN=false
VERBOSE=false

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[patch]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[patch]${NC} %s\n" "$*"; }
err()  { printf "${RED}[patch]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Patch Applier

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

# --- Functions ---
apply_patch() {
  local patch_file="$1"
  local patch_name
  patch_name=$(basename "$patch_file")

  if $DRY_RUN; then
    # Dry-run the patch to see if it applies cleanly
    if patch -p1 --dry-run < "$patch_file" &>/dev/null; then
      warn "[dry-run] Would apply: $patch_name"
    else
      err "[dry-run] Patch would FAIL: $patch_name"
      return 1
    fi
  else
    verbose "Applying: $patch_name"
    if patch -p1 < "$patch_file"; then
      log "Applied: $patch_name"
    else
      err "Failed to apply: $patch_name"
      err "Revert with: patch -R -p1 < $patch_file"
      return 1
    fi
  fi
}

# --- Main ---
main() {
  if [[ ! -d "$PATCHES_DIR" ]]; then
    warn "No patches directory found at $PATCHES_DIR"
    exit 0
  fi

  local count=0
  local patches=()
  for patch_file in "$PATCHES_DIR"/*.patch; do
    if [[ -f "$patch_file" ]]; then
      patches+=("$patch_file")
    fi
  done

  if [[ ${#patches[@]} -eq 0 ]]; then
    log "No patches found in $PATCHES_DIR"
    exit 0
  fi

  log "Found ${#patches[@]} patch(es) to apply."
  $DRY_RUN && warn "Dry run — no changes will be made."

  for patch_file in "${patches[@]}"; do
    apply_patch "$patch_file" || exit 1
    count=$((count + 1))
  done

  log "All $count patch(es) applied successfully."
}

main