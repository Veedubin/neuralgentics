#!/usr/bin/env bash
set -euo pipefail

# Neuralgentics — Regenerate Patches
# Regenerates .patch files from the current modified opencode-base state.
# Usage: ./scripts/regen-patches.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_DIR="$PROJECT_ROOT/opencode-base"
PATCHES_DIR="$PROJECT_ROOT/patches"

# --- Color helpers ---
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

# --- Validate opencode-base exists ---
if [[ ! -d "$OPENCODE_DIR/.git" ]]; then
  red "ERROR: opencode-base/ not found or not a git repository."
  red "Run scripts/update-opencode.sh first."
  exit 1
fi

# --- Check for modifications ---
cd "$OPENCODE_DIR"

diff_output="$(git diff --name-only)"
if [[ -z "$diff_output" ]]; then
  yellow "No modifications found in opencode-base — nothing to regenerate."
  exit 0
fi

green "Modified files detected:"
for f in $diff_output; do
  green "  - $f"
done

# --- Ensure patches directory exists ---
mkdir -p "$PATCHES_DIR"

# --- Regenerate patches from known targets ---
# Map of modified files to patch names.
# Add entries here when new patch targets are introduced.
declare -A PATCH_MAP=(
  ["packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx"]="001-rebrand.patch"
)

patch_index=1
generated=0
skipped=0

for modified_file in $diff_output; do
  # Determine patch filename: use map if defined, else auto-generate
  if [[ -n "${PATCH_MAP[$modified_file]+x}" ]]; then
    patch_name="${PATCH_MAP[$modified_file]}"
  else
    # Auto-generate from file path: replace / with -, strip leading path components
    patch_name="$(printf '%03d' "$patch_index")-$(basename "$modified_file" | sed 's/\.[^.]*$//').patch"
    patch_index=$((patch_index + 1))
  fi

  patch_path="$PATCHES_DIR/$patch_name"

  # Generate the diff for this specific file
  diff_content="$(git diff --src-prefix=a/ --dst-prefix=b/ -- "$modified_file")"

  if [[ -z "$diff_content" ]]; then
    yellow "  Skipping $modified_file — diff is empty (patch already applied or no longer relevant)"
    skipped=$((skipped + 1))
    continue
  fi

  printf '%s\n' "$diff_content" > "$patch_path"
  green "  Generated: $patch_name ($(wc -l < "$patch_path") lines)"
  generated=$((generated + 1))
done

cd "$PROJECT_ROOT"

green "Done. Generated $generated patch(es), skipped $skipped."
green "Patches saved to: $PATCHES_DIR/"