#!/usr/bin/env bash
set -e

# Neuralgentics — External Skills Fetcher (release-time wrapper)
# Usage: ./scripts/external-skills-fetcher.sh [--dry-run] [--verbose] [-h/--help]
#
# Clones the curated external skill repos into ~/.neuralgentics/external_skills/
# and writes a MANIFEST.json with provenance metadata. Reads
# external_skills.enabled from ~/.neuralgentics/.env — if unset or false, no-ops
# with a log message.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_HOME_DIR="$HOME/.neuralgentics"
EXTERNAL_DIR="$DEFAULT_HOME_DIR/external_skills"
DRY_RUN=false
VERBOSE=false

# --- Colors (match release.sh style) ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "${GREEN}[external-skills]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[external-skills]${NC} %s\n" "$*"; }
err()  { printf "${RED}[external-skills]${NC} %s\n" "$*" >&2; }
verbose() { $VERBOSE && log "[verbose] $*" || true; }

# --- Args ---
usage() {
    cat <<EOF
Neuralgentics External Skills Fetcher

Usage: $(basename "$0") [OPTIONS]

Options:
    --home-dir DIR   Use DIR as the home directory (default: ~/.neuralgentics)
    --dry-run        Show what would be done without executing
    --verbose        Enable verbose output
    -h, --help       Show this help message
EOF
    exit 0
}

HOME_DIR="$DEFAULT_HOME_DIR"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --home-dir) HOME_DIR="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --verbose) VERBOSE=true; shift ;;
        -h|--help) usage ;;
        *) err "Unknown option: $1"; usage ;;
    esac
done

EXTERNAL_DIR="$HOME_DIR/external_skills"
MANIFEST_TMP=""

# --- Helpers ---
run() {
    if $DRY_RUN; then
        warn "[dry-run] $*"
    else
        verbose "Running: $*"
        "$@"
    fi
}

# Read a key from .env (KEY="value" or KEY=value)
read_env() {
    local key="$1"
    local env_file="$HOME_DIR/.env"
    if [[ ! -f "$env_file" ]]; then
        echo ""
        return
    fi
    # Grep for the key, strip comments and quotes
    grep -E "^${key}=" "$env_file" 2>/dev/null | head -1 | sed -E "s/^${key}=//" | sed -E 's/^"(.*)"$/\1/' | sed -E "s/^'(.*)'$/\1/"
}

is_enabled() {
    local val
    val=$(read_env "external_skills.enabled")
    [[ "${val,,}" == "true" ]]
}

# Clone or pull a single repo
fetch_repo() {
    local name="$1"
    local url="$2"
    local license="$3"
    local attribution="$4"
    local repo_dir="$EXTERNAL_DIR/$name"
    local status="cloned"
    local commit_sha=""

    if [[ -d "$repo_dir/.git" ]]; then
        verbose "Pulling $name..."
        if run git -C "$repo_dir" pull --ff-only 2>/dev/null; then
            status="updated"
        else
            warn "git pull failed for $name (offline?); using existing HEAD"
            status="skipped-network-error"
        fi
    else
        verbose "Cloning $name..."
        if ! run git clone --depth 1 "$url" "$repo_dir" 2>/dev/null; then
            err "git clone failed for $name from $url"
            return 1
        fi
    fi

    if $DRY_RUN; then
        commit_sha="(dry-run)"
    else
        commit_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo "")
    fi
    verbose "Commit SHA: $commit_sha"

    # Stash in a temp file for the manifest step
    local entry
    entry=$(cat <<EOF
    "$name": {
      "url": "$url",
      "commit_sha": "$commit_sha",
      "license": "$license",
      "attribution": "$attribution",
      "refreshed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
      "status": "$status"
    }
EOF
)
    echo "$entry" >> "$MANIFEST_TMP"
}

write_manifest() {
    if $DRY_RUN; then
        warn "[dry-run] Would write MANIFEST.json"
        return
    fi
    mkdir -p "$EXTERNAL_DIR"
    local manifest_path="$EXTERNAL_DIR/MANIFEST.json"
    cat > "$manifest_path" <<EOF
{
  "version": 1,
  "updated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "home_dir": "$HOME_DIR",
  "repos": {
$(cat "$MANIFEST_TMP" | sed '$!s/$/,/')
  }
}
EOF
    log "Wrote $manifest_path"
}

# --- Main ---
main() {
    log "External skills fetcher starting (home=$HOME_DIR)..."

    if ! is_enabled; then
        log "external_skills.enabled is not true in $HOME_DIR/.env — skipping"
        exit 0
    fi

    if ! command -v git &>/dev/null; then
        err "git is not installed; cannot fetch external skills"
        exit 1
    fi

    mkdir -p "$EXTERNAL_DIR"

    MANIFEST_TMP=$(mktemp)
    trap 'rm -f "$MANIFEST_TMP"' EXIT

    fetch_repo "ai-research-skills" \
        "https://github.com/Orchestra-Research/AI-Research-SKILLs.git" \
        "MIT" \
        "Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License."

    fetch_repo "ui-ux-pro-max-skill" \
        "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git" \
        "MIT" \
        "Copyright 2024 Next Level Builder. Used under MIT License."

    write_manifest

    log "External skills fetch complete."
}

main