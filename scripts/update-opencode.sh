#!/usr/bin/env bash
set -euo pipefail

# Neuralgentics — Update OpenCode from Upstream
# Fetches latest OpenCode, applies patches, copies overlay, and builds.
# Usage: ./scripts/update-opencode.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_DIR="$PROJECT_ROOT/opencode-base"
PATCHES_DIR="$PROJECT_ROOT/patches"

# Ensure bun is on PATH
export PATH="$HOME/.bun/bin:$PATH"

# --- Color helpers ---
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

# --- Step 1: Fetch or clone upstream ---
green "Updating OpenCode from upstream..."

if [[ -d "$OPENCODE_DIR/.git" ]]; then
  green "  Repository found — fetching latest..."
  cd "$OPENCODE_DIR"
  git fetch origin
  git checkout origin/dev
  cd "$PROJECT_ROOT"
else
  green "  No repository found — cloning..."
  git clone https://github.com/anomalyco/opencode.git opencode-base
fi

# --- Step 2: Install dependencies ---
green "Installing dependencies..."
cd "$OPENCODE_DIR/packages/opencode"
bun install
cd "$PROJECT_ROOT"

# --- Step 3: Verify patches exist ---
if [[ ! -d "$PATCHES_DIR" ]]; then
  red "ERROR: Patches directory not found at $PATCHES_DIR"
  exit 1
fi

shopt -s nullglob
patch_files=("$PATCHES_DIR"/*.patch)
shopt -u nullglob

if [[ ${#patch_files[@]} -eq 0 ]]; then
  yellow "No patch files found in $PATCHES_DIR — skipping patch step."
else
  # --- Step 4: Check patches for conflicts ---
  green "Checking ${#patch_files[@]} patch(es) for conflicts..."
  CONFLICTING=()

  while IFS= read -r patch; do
    [[ -z "$patch" ]] && continue
    patch_name="$(basename "$patch")"
    printf "  Checking %s... " "$patch_name"

    cd "$OPENCODE_DIR"
    if git apply --check "$patch" 2>&1; then
      green "  ✓ Clean"
    else
      red "  ✗ Conflict"
      CONFLICTING+=("$patch_name")
    fi
    cd "$PROJECT_ROOT"
  done < <(printf '%s\n' "${patch_files[@]}" | sort)

  if [[ ${#CONFLICTING[@]} -gt 0 ]]; then
    red "ERROR: Conflicts found in the following patches:"
    for conflict in "${CONFLICTING[@]}"; do
      red "  - $conflict"
    done
    yellow "Run scripts/regen-patches.sh after resolving conflicts."
    exit 1
  fi

  # --- Step 5: Apply all patches ---
  green "Applying ${#patch_files[@]} patch(es)..."
  cd "$OPENCODE_DIR"
  while IFS= read -r patch; do
    [[ -z "$patch" ]] && continue
    patch_name="$(basename "$patch")"
    green "  Applying: $patch_name"
    git apply "$patch"
  done < <(printf '%s\n' "${patch_files[@]}" | sort)
  cd "$PROJECT_ROOT"
fi

# --- Step 6: Copy overlay files ---
if [[ -d "$PROJECT_ROOT/overlay" ]]; then
  green "Copying overlay files..."
  cp -r "$PROJECT_ROOT/overlay/." "$OPENCODE_DIR/"
fi

# --- Step 7: Build ---
green "Building..."
cd "$OPENCODE_DIR/packages/opencode"
bun run build
cd "$PROJECT_ROOT"

green "Build complete. Binary at: $OPENCODE_DIR/packages/opencode/dist/"