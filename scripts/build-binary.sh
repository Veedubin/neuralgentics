#!/usr/bin/env bash
set -euo pipefail

# Neuralgentics — Build Standalone Binary
# Builds the standalone binary from the already-patched and overlaid opencode-base.
# Assumes scripts/update-opencode.sh has already been run successfully.
#
# Usage:
#   ./scripts/build-binary.sh [--platform <platform>] [--verbose] [-h/--help]
#
# Platforms:
#   linux-x64      Linux x86_64 (default on linux)
#   darwin-arm64    macOS ARM64 (default on macOS ARM)
#   windows-x64    Windows x86_64
#
# If --platform is omitted, the script detects the local platform.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_DIR="$PROJECT_ROOT/opencode-base"
OPENCODE_PKG="$OPENCODE_DIR/packages/opencode"
VERBOSE=false
PLATFORM=""

# --- Color helpers ---
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }

# --- Args ---
usage() {
  cat <<EOF
Neuralgentics Binary Builder

Usage: $(basename "$0") [OPTIONS]

Options:
  --platform <platform>   Target platform: linux-x64, darwin-arm64, windows-x64
                          Default: auto-detect local platform
  --verbose               Enable verbose output
  -h, --help              Show this help message

Platforms:
  linux-x64       Linux x86_64
  darwin-arm64    macOS ARM64
  windows-x64     Windows x86_64

Output:
  Binary:   opencode-base/packages/opencode/dist/neuralgentics
  Tarball:  neuralgentics-v<version>-<platform>.tar.gz
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      shift
      PLATFORM="$1"
      shift
      ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage ;;
    *) red "Unknown option: $1"; usage ;;
  esac
done

# --- Detect platform if not specified ---
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os-$arch" in
    linux-x86_64|linux-amd64) echo "linux-x64" ;;
    darwin-arm64)             echo "darwin-arm64" ;;
    darwin-x86_64)            echo "darwin-x64" ;;
    *) echo "linux-x64" ;;  # fallback
  esac
}

if [[ -z "$PLATFORM" ]]; then
  PLATFORM="$(detect_platform)"
  green "Auto-detected platform: $PLATFORM"
fi

# Validate platform
case "$PLATFORM" in
  linux-x64|darwin-arm64|windows-x64) ;;
  *) red "ERROR: Unsupported platform '$PLATFORM'. Use: linux-x64, darwin-arm64, windows-x64"; exit 1 ;;
esac

# --- Map platform to bun target ---
bun_target() {
  case "$1" in
    linux-x64)     echo "bun-linux-x64" ;;
    darwin-arm64)  echo "bun-darwin-arm64" ;;
    windows-x64)   echo "bun-windows-x64" ;;
  esac
}

BUN_TARGET="$(bun_target "$PLATFORM")"
green "Bun compile target: $BUN_TARGET"

# --- Determine binary name (windows needs .exe) ---
BINARY_NAME="neuralgentics"
if [[ "$PLATFORM" == "windows-x64" ]]; then
  BINARY_NAME="neuralgentics.exe"
fi

# --- Step 1: Verify build output exists ---
green "Verifying build output..."

# Detect platform binary directory (use local detection for finding existing build)
LOCAL_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
DIST_BIN_DIR="$OPENCODE_PKG/dist/opencode-$LOCAL_PLATFORM/bin"

# Fall back: try just finding any opencode binary in dist/
if [[ ! -d "$DIST_BIN_DIR" ]]; then
  yellow "  Expected dist directory not found: $DIST_BIN_DIR"
  yellow "  Searching for any built binary..."

  FOUND_BIN="$(find "$OPENCODE_PKG/dist" -name 'opencode' -type f 2>/dev/null | head -1)"
  if [[ -z "$FOUND_BIN" ]]; then
    red "ERROR: No built binary found in $OPENCODE_PKG/dist/"
    red "Run scripts/update-opencode.sh first to build."
    exit 1
  fi
  DIST_BIN_DIR="$(dirname "$FOUND_BIN")"
fi

green "  Found build output in: $DIST_BIN_DIR"

# --- Step 2: Get version ---
VERSION="$(jq -r .version "$PROJECT_ROOT/package.json" 2>/dev/null || echo "0.0.0")"
green "Version: $VERSION"

# --- Step 3: Compile standalone binary ---
green "Compiling standalone binary for $PLATFORM..."

cd "$OPENCODE_PKG"

OUTPUT_PATH="dist/$BINARY_NAME"

if [[ -f "bin/opencode" ]]; then
  green "  Compiling from: bin/opencode"
  if [[ "$VERBOSE" == "true" ]]; then
    bun build --compile --target="$BUN_TARGET" --outfile="$OUTPUT_PATH" bin/opencode
  else
    bun build --compile --target="$BUN_TARGET" --outfile="$OUTPUT_PATH" bin/opencode 2>&1 | tail -5
  fi
else
  # Try the entry point from package.json
  ENTRY_POINT="$(node -e "const p = require('./package.json'); console.log(p.main || 'src/index.ts')" 2>/dev/null || echo "src/index.ts")"
  if [[ -f "$ENTRY_POINT" ]]; then
    green "  Compiling from: $ENTRY_POINT"
    if [[ "$VERBOSE" == "true" ]]; then
      bun build --compile --target="$BUN_TARGET" --outfile="$OUTPUT_PATH" "$ENTRY_POINT"
    else
      bun build --compile --target="$BUN_TARGET" --outfile="$OUTPUT_PATH" "$ENTRY_POINT" 2>&1 | tail -5
    fi
  else
    red "ERROR: Cannot determine entry point for compilation."
    red "  Expected bin/opencode or package.json main entry."
    exit 1
  fi
fi

cd "$PROJECT_ROOT"

# --- Step 4: Verify output ---
FULL_OUTPUT_PATH="$OPENCODE_PKG/$OUTPUT_PATH"

if [[ -f "$FULL_OUTPUT_PATH" ]]; then
  green "Build complete!"
  green "  Binary: $FULL_OUTPUT_PATH"
  green "  Size:   $(du -h "$FULL_OUTPUT_PATH" | cut -f1)"
  green "  Platform: $PLATFORM"
else
  red "ERROR: Binary was not created at expected path: $FULL_OUTPUT_PATH"
  exit 1
fi

# --- Step 5: Create distribution tarball ---
TARBALL_NAME="neuralgentics-v${VERSION}-${PLATFORM}.tar.gz"
TARBALL_DIR="$PROJECT_ROOT/dist"
TARBALL_PATH="$TARBALL_DIR/$TARBALL_NAME"

green "Creating distribution tarball..."

mkdir -p "$TARBALL_DIR"

# Create tarball containing the binary
# We cd into the dist directory so the tarball contains just the binary at top level
(cd "$(dirname "$FULL_OUTPUT_PATH")" && tar -czf "$TARBALL_PATH" "$(basename "$FULL_OUTPUT_PATH")")

if [[ -f "$TARBALL_PATH" ]]; then
  green "Tarball created!"
  green "  File:   $TARBALL_PATH"
  green "  Size:   $(du -h "$TARBALL_PATH" | cut -f1)"
  green "  Run:    tar -xzf $TARBALL_PATH"
else
  red "ERROR: Tarball was not created at expected path: $TARBALL_PATH"
  exit 1
fi

green "=========================================="
green "Build Summary"
green "  Version:  v$VERSION"
green "  Platform: $PLATFORM"
green "  Target:   $BUN_TARGET"
green "  Binary:   $FULL_OUTPUT_PATH"
green "  Tarball:  $TARBALL_PATH"
green "=========================================="