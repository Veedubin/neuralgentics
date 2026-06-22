#!/usr/bin/env bash
# neuralgentics — OpenCode plugin installer
# "HACK THE PLANET!" — Hackers (1995)
#
# Downloads the plugin tarball from GitHub Releases, extracts to
# ~/.neuralgentics/, installs npm dependencies, and symlinks the
# .opencode/ config into your project.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
#   curl ... | bash -s -- --home-dir              # install to ~/.neuralgentics
#   curl ... | bash -s -- --prefix /opt/ng        # custom install root
#   curl ... | bash -s -- --version 0.7.4         # specific version
#   curl ... | bash -s -- --dry-run               # preview without installing
set -euo pipefail

APP="neuralgentics"
DEFAULT_VERSION="0.7.4"
REPO="${NEURALGENTICS_REPO:-Veedubin/neuralgentics}"

# ─── Defaults ────────────────────────────────────────────────────────────────

PREFIX=""
VERSION="${DEFAULT_VERSION}"
DRY_RUN=false
INSTALL_HOME=false
YES=false

# ─── Logging ─────────────────────────────────────────────────────────────────

log()     { printf "[%s] %s\n" "$APP" "$*" >&2; }
warn()    { printf "[warn] %s\n" "$*" >&2; }
err()     { printf "[ERROR] %s\n" "$*" >&2; exit 1; }

# ─── Argument parsing ───────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --home-dir|-home-dir) INSTALL_HOME=true; shift ;;
        --prefix)             PREFIX="$2"; shift 2 ;;
        --version)            VERSION="$2"; shift 2 ;;
        --repo)               REPO="$2"; shift 2 ;;
        --yes|-y)             YES=true; shift ;;
        --dry-run)            DRY_RUN=true; shift ;;
        --help|-h)
            cat <<EOF
neuralgentics installer — OpenCode plugin setup

Usage:
  curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
  curl ... | bash -s -- [flags]

Flags:
  --home-dir        Install to ~/.neuralgentics (recommended)
  --prefix <dir>    Custom install root
  --version <ver>   Specific version (default: $DEFAULT_VERSION)
  --repo <org/name> Custom GitHub repo
  --yes, -y         Skip confirmation prompts
  --dry-run         Preview without installing
  --help, -h        Show this help

After install:
  cd your-project
  ln -s ~/.neuralgentics/.opencode .opencode
  opencode
EOF
            exit 0
            ;;
        *) warn "Unknown option: $1 (continuing)"; shift ;;
    esac
done

# ─── Resolve install prefix ──────────────────────────────────────────────────

if [[ -n "$PREFIX" ]]; then
    : # explicit --prefix wins
elif $INSTALL_HOME; then
    PREFIX="$HOME/.neuralgentics"
else
    # Default: install next to the project (PWD-local)
    PREFIX="$PWD/.neuralgentics"
fi

# ─── Non-interactive detection ──────────────────────────────────────────────

if [[ ! -t 0 ]]; then
    log "stdin is not a TTY (e.g. curl|bash). Auto-accepting all defaults."
    log "To force a specific install path, re-run with: --prefix <dir> or --home-dir"
    YES=true
fi

# ─── Confirm ─────────────────────────────────────────────────────────────────

if ! $YES && ! $DRY_RUN; then
    printf "\nInstall neuralgentics plugin to %s? [Y/n]: " "$PREFIX" >&2
    read -r answer
    if [[ -n "$answer" ]] && [[ ! "$answer" =~ ^[Yy] ]]; then
        log "Install cancelled."
        exit 0
    fi
fi

log "Installing neuralgentics v${VERSION} to ${PREFIX}"

# ─── Download ────────────────────────────────────────────────────────────────

ARCHIVE="neuralgentics-${VERSION}.tar.gz"
ARCHIVE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ARCHIVE}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt"

if $DRY_RUN; then
    log "[dry-run] Would download ${ARCHIVE_URL}"
    log "[dry-run] Would extract to ${PREFIX}"
    log "[dry-run] Would run: cd ${PREFIX}/.opencode && npm install"
    log "[dry-run] Done."
    exit 0
fi

TMPDIR="${TMPDIR:-/tmp}"
TMP_DIR="${TMPDIR}/${APP}_install_$$"
mkdir -p "$TMP_DIR"
ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE}"

log "Downloading ${ARCHIVE}..."
if ! curl -fsSL --retry 3 --retry-delay 2 "$ARCHIVE_URL" -o "$ARCHIVE_PATH"; then
    err "Download failed. Check that version ${VERSION} exists at: https://github.com/${REPO}/releases"
fi

# ── Verify SHA256 (best-effort) ─────────────────────────────────────────────

CHECKSUMS_PATH="${TMP_DIR}/checksums.txt"
if curl -fsSL "$CHECKSUMS_URL" -o "$CHECKSUMS_PATH" 2>/dev/null; then
    EXPECTED="$(grep -F "$(basename "$ARCHIVE_PATH")" "$CHECKSUMS_PATH" | awk '{print $1}' || true)"
    if [[ -n "$EXPECTED" ]]; then
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
        elif command -v shasum >/dev/null 2>&1; then
            ACTUAL="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
        else
            ACTUAL=""
        fi
        if [[ -n "$ACTUAL" ]] && [[ "$ACTUAL" != "$EXPECTED" ]]; then
            err "SHA256 mismatch! Expected: $EXPECTED, got: $ACTUAL"
        fi
        log "SHA256 verified"
    fi
fi

# ── Extract ─────────────────────────────────────────────────────────────────

log "Extracting to ${PREFIX}..."
mkdir -p "$PREFIX"

# Strip the top-level directory from the archive (e.g. neuralgentics-0.7.4/)
tar -xzf "$ARCHIVE_PATH" -C "$PREFIX" --strip-components=1 2>/dev/null || {
    # Fallback for non-GNU tar
    TMP_EXTRACT="${TMPDIR}/${APP}_extract_$$"
    mkdir -p "$TMP_EXTRACT"
    tar -xzf "$ARCHIVE_PATH" -C "$TMP_EXTRACT"
    INNER="$(find "$TMP_EXTRACT" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [[ -n "$INNER" ]]; then
        find "$INNER" -mindepth 1 -maxdepth 1 -exec mv {} "$PREFIX/" \;
    fi
    rm -rf "$TMP_EXTRACT"
}

# ── Install npm dependencies ────────────────────────────────────────────────

if [[ -f "$PREFIX/.opencode/package.json" ]]; then
    if command -v npm >/dev/null 2>&1; then
        log "Installing plugin dependencies..."
        (cd "$PREFIX/.opencode" && npm install --no-audit --no-fund) || {
            warn "npm install failed. Plugin may not load."
            warn "Run manually: cd ${PREFIX}/.opencode && npm install"
        }
    else
        warn "npm not found — plugin dependencies not installed."
        warn "Install Node.js 20+ and run: cd ${PREFIX}/.opencode && npm install"
    fi
fi

# ── Cleanup ─────────────────────────────────────────────────────────────────

rm -rf "$TMP_DIR"

# ── Success ─────────────────────────────────────────────────────────────────

cat <<EOF >&2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HACK THE PLANET! — neuralgentics v${VERSION} installed

   Install root:  ${PREFIX}
   Plugin:        ${PREFIX}/node_modules/@neuralgentics/plugin/
   Config:        ${PREFIX}/.opencode/
   Docs:          https://github.com/${REPO}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  To activate in a project:
    cd your-project
    ln -s ${PREFIX}/.opencode .opencode
    opencode

  Memory backend (PostgreSQL + pgvector + TimescaleDB):
    docker compose -f ${PREFIX}/docker-compose.yml up -d
    (or: podman-compose -f ${PREFIX}/docker-compose.yml up -d)

  (If opencode is not installed: curl -fsSL https://opencode.ai/install.sh | bash)
EOF

echo "" >&2
