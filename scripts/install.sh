#!/usr/bin/env bash
# neuralgentics v0.5.0 — binary release installer
# "HACK THE PLANET!" — Hackers (1995)
#
# Downloads pre-built binaries from GitHub Releases.
# No source build, no Go/Bun/Python required for end users.
#
# Usage:
#   ./scripts/install.sh                              # interactive install
#   ./scripts/install.sh --no-path                    # don't modify shell rc
#   ./scripts/install.sh --prefix /opt/neuralgentics  # custom install root
#   ./scripts/install.sh --version 0.2.0               # specific version
#   ./scripts/install.sh --repo myorg/neuralgentics    # custom GitHub repo
#   curl -fsSL https://github.com/Veedubin/neuralgentics/releases/latest/download/install.sh | bash
set -euo pipefail

APP="neuralgentics"
DEFAULT_VERSION="0.6.4"

# ─── Colors ──────────────────────────────────────────────────────────────────

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
GREEN='\033[0;32m'
BRIGHT_GREEN='\033[1;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Defaults ────────────────────────────────────────────────────────────────

PREFIX="${NEURALGENTICS_PREFIX:-$PWD/.neuralgentics}"
NEURALGENTICS_DATA_DIR="${NEURALGENTICS_DATA_DIR:-$PWD/.neuralgentics}"
BIN_LINK_DIR="$PWD/.neuralgentics/bin"
VERSION="${DEFAULT_VERSION}"
REPO=""
NO_PATH=false
NO_VERIFY=false
DRY_RUN=false
VERBOSE=false
NON_INTERACTIVE=false

# ─── Logging ─────────────────────────────────────────────────────────────────

log()     { printf "${GREEN}[$APP]${NC} %s\n" "$*" >&2; }
warn()    { printf "${ORANGE}[warn]${NC} %s\n" "$*" >&2; }
err()     { printf "${RED}[error]${NC} %s\n" "$*" >&2; }
verbose() { [[ "${VERBOSE}" == "true" ]] && log "$@" || true; }

run() {
    if $DRY_RUN; then
        printf "  ${MUTED}[dry-run]${NC} %s\n" "$*" >&2
    else
        verbose "running: $*"
        "$@"
    fi
}

# ─── Usage ───────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
$APP Installer v${DEFAULT_VERSION} — Binary Release

Usage: $(basename "$0") [options]

Options:
    -h, --help              Show this help
    -v, --verbose           Verbose output
    -y, --yes               Non-interactive: accept all defaults
        --non-interactive   Same as --yes
        --no-path           Don't modify shell rc files
        --no-verify         Skip SHA256 verification
        --dry-run           Show what would be done without executing
        --prefix <dir>      Install root (default: $PWD/.neuralgentics,
                            env: NEURALGENTICS_PREFIX)
        --version <v>       Version to install (default: ${DEFAULT_VERSION})
        --repo <owner/repo> GitHub repo (default: auto-detect or
                            Veedubin/neuralgentics)

Examples:
    $0                              # interactive install
    $0 --no-path                    # don't edit shell rc
    $0 --version 0.2.0              # install specific version
    $0 --repo myorg/neuralgentics   # custom GitHub repo
    $0 --dry-run                    # preview without changes
    curl -fsSL .../install.sh | bash
EOF
}

# ─── Arg parsing ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)         usage; exit 0 ;;
        -v|--verbose)      VERBOSE=true; shift ;;
        --no-path)         NO_PATH=true; shift ;;
        --no-verify)       NO_VERIFY=true; shift ;;
        --dry-run)         DRY_RUN=true; shift ;;
        -y|--yes|--non-interactive)
                           NON_INTERACTIVE=true; shift ;;
        --prefix)
            [[ -n "${2:-}" ]] || { err "--prefix requires an argument"; exit 1; }
            PREFIX="$2"; _PREFIX_EXPLICIT=true; shift 2
            ;;
        --version)
            [[ -n "${2:-}" ]] || { err "--version requires an argument"; exit 1; }
            VERSION="${2#v}"; shift 2
            ;;
        --repo)
            [[ -n "${2:-}" ]] || { err "--repo requires an argument"; exit 1; }
            REPO="$2"; shift 2
            ;;
        *) warn "Unknown option: $1 (continuing)"; shift ;;
    esac
done

INSTALL_BIN="$PREFIX/bin"

# ─── Banner ──────────────────────────────────────────────────────────────────

print_banner() {
    printf "${BRIGHT_GREEN}" >&2
    cat <<'BANNER' >&2

██╗  ██╗ █████╗  ██████╗██╗  ██╗    ████████╗██╗  ██╗███████╗
██║  ██║██╔══██╗██╔════╝██║ ██╔╝    ╚══██╔══╝██║  ██║██╔════╝
███████║███████║██║     █████╔╝        ██║   ███████║█████╗
██╔══██║██╔══██║██║     ██╔═██╗        ██║   ██╔══██║██╔══╝
██║  ██║██║  ██║╚██████╗██║  ██╗       ██║   ██║  ██║███████╗
╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝       ╚═╝   ╚═╝  ╚═╝╚══════╝

██████╗ ██╗      █████╗ ███╗   ██╗███████╗████████╗
██╔══██╗██║     ██╔══██╗████╗  ██║██╔════╝╚══██╔══╝
██████╔╝██║     ███████║██╔██╗ ██║█████╗     ██║
██╔═══╝ ██║     ██╔══██║██║╚██╗██║██╔══╝     ██║
██║     ███████╗██║  ██║██║ ╚████║███████╗   ██║
╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝
BANNER
    printf "${NC}" >&2
    printf "\n  ${BRIGHT_GREEN}HACK THE PLANET${NC} ${MUTED}—${NC} ${CYAN}neuralgentics v${VERSION}${NC}\n\n" >&2
}

# ─── OS/arch detection ────────────────────────────────────────────────────────

detect_os_arch() {
    local raw_os arch
    raw_os="$(uname -s)"
    case "$raw_os" in
        Darwin*)  os="darwin" ;;
        Linux*)   os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)        err "Unsupported OS: $raw_os"; exit 1 ;;
    esac

    arch="$(uname -m)"
    case "$arch" in
        aarch64|arm64) arch="arm64" ;;
        x86_64|amd64)  arch="amd64" ;;
        *)             err "Unsupported arch: $arch"; exit 1 ;;
    esac

    # macOS x64 on Apple Silicon → use arm64 binary
    if [[ "$os" == "darwin" && "$arch" == "amd64" ]]; then
        local rosetta
        rosetta="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
        [[ "$rosetta" == "1" ]] && arch="arm64"
    fi

    # MUSL detection (Alpine, etc.)
    is_musl=false
    if [[ "$os" == "linux" ]]; then
        if [[ -f /etc/alpine-release ]]; then
            is_musl=true
        elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
            is_musl=true
        fi
    fi

    local target="$os-$arch"
    case "$target" in
        linux-amd64|linux-arm64|darwin-arm64|windows-amd64|windows-arm64)
            local musl_tag=""
    [[ "$is_musl" == "true" ]] && musl_tag=" (musl)"
    log "Detected: $os/$arch$musl_tag"
            ;;
        *)
            err "Unsupported target: $target"
            err "Supported: linux-amd64, linux-arm64, darwin-arm64, windows-amd64, windows-arm64"
            exit 1
            ;;
    esac

    export DETECTED_OS="$os"
    export DETECTED_ARCH="$arch"
    export DETECTED_MUSL="$is_musl"
}

# ─── WSL detection ───────────────────────────────────────────────────────────

detect_wsl() {
    local kernel_release=""
    if [[ -f /proc/sys/kernel/osrelease ]]; then
        kernel_release="$(cat /proc/sys/kernel/osrelease 2>/dev/null || true)"
    fi

    local wsl_detected=false
    # Method 1: kernel release string contains "microsoft" or "WSL"
    if [[ "$kernel_release" =~ [Mm]icrosoft || "$kernel_release" =~ WSL ]]; then
        wsl_detected=true
    fi
    # Method 2: WSL_INTEROP env var (WSL2)
    if [[ -n "${WSL_INTEROP:-}" ]]; then
        wsl_detected=true
    fi
    # Method 3: WSL_DISTRO_NAME env var
    if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
        wsl_detected=true
    fi

    if [[ "$wsl_detected" == "true" ]]; then
        printf "\n" >&2
        printf "${ORANGE}⚠  WSL Detected — Windows Subsystem for Linux${NC}\n" >&2
        printf "${MUTED}   • Linux binaries work inside WSL${NC}\n" >&2
        printf "${MUTED}   • Add ~/.local/bin to your WSL shell rc, NOT Windows PATH${NC}\n" >&2
        printf "${MUTED}   • Windows paths from /mnt/c may have permission issues${NC}\n" >&2
        if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
            printf "${MUTED}   • Distro: %s${NC}\n" "$WSL_DISTRO_NAME" >&2
        fi
        # WSL1 vs WSL2
        if [[ -n "${WSL_INTEROP:-}" ]]; then
            printf "${MUTED}   • WSL2 detected (WSL_INTEROP set)${NC}\n" >&2
        else
            printf "${MUTED}   • WSL1 detected (no WSL_INTEROP)${NC}\n" >&2
        fi
        printf "${MUTED}   • For native Windows install, use install.ps1 in PowerShell${NC}\n" >&2
        printf "\n" >&2

        # Note: user can add ~/.local/bin to Windows PATH via:
        # wslpath -w ~/.local/bin → add to Windows PATH
        export WSL_MODE=true
    else
        export WSL_MODE=false
    fi
}

# ─── Repo detection ───────────────────────────────────────────────────────────

detect_repo() {
    if [[ -n "$REPO" ]]; then
        return 0
    fi

    # Try git remote from script directory
    local git_dir
    git_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
    if [[ -n "$git_dir" && -d "$git_dir/../.git" ]]; then
        local remote_url
        remote_url="$(git -C "$git_dir/.." remote get-url origin 2>/dev/null || true)"
        if [[ -n "$remote_url" ]]; then
            # Normalize: https://github.com/owner/repo.git → owner/repo
            #            git@github.com:owner/repo.git → owner/repo
            #            ssh://git@github.com/owner/repo.git → owner/repo
            remote_url="${remote_url#.git}"
            remote_url="${remote_url%.git}"
            # Strip protocol and host
            remote_url="${remote_url#https://github.com/}"
            remote_url="${remote_url#git@github.com:}"
            remote_url="${remote_url#ssh://git@github.com/}"
            REPO="$remote_url"
            log "Detected repo from git remote: $REPO"
            return 0
        fi
    fi

    REPO="Veedubin/neuralgentics"
    log "Using default repo: $REPO"
}

# ─── Download ────────────────────────────────────────────────────────────────

unbuffered_sed() {
    # Cross-platform unbuffered sed (bash 3.2 compatible)
    if echo | sed -u -e "" >/dev/null 2>&1; then
        sed -nu "$@"
    elif echo | sed -l -e "" >/dev/null 2>&1; then
        sed -nl "$@"
    else
        local pad
        pad="$(printf "\n%512s" "")"
        sed -ne "s/$/\\${pad}/" "$@"
    fi
}

print_progress() {
    local bytes="$1"
    local length="$2"
    [[ "$length" -gt 0 ]] || return 0

    local width=50
    local percent="$(( bytes * 100 / length ))"
    [[ "$percent" -gt 100 ]] && percent=100
    local on="$(( percent * width / 100 ))"
    local off="$(( width - on ))"

    local filled empty
    filled="$(printf "%*s" "$on" "")"
    filled="${filled// /■}"
    empty="$(printf "%*s" "$off" "")"
    empty="${empty// /･}"

    printf "\r${ORANGE}%s%s %3d%%${NC}" "$filled" "$empty" "$percent" >&4
}

download_with_progress() {
    local url="$1"
    local output="$2"

    if [[ -t 2 ]]; then
        exec 4>&2
    else
        exec 4>/dev/null
    fi

    local tmp_dir="${TMPDIR:-/tmp}"
    local basename="${tmp_dir}/${APP}_install_$$"
    local tracefile="${basename}.trace"

    rm -f "$tracefile"
    mkfifo "$tracefile"

    # Hide cursor
    printf "\033[?25l" >&4

    trap "trap - RETURN; rm -f \"$tracefile\"; printf '\033[?25h' >&4; exec 4>&-" RETURN

    (
        curl --trace-ascii "$tracefile" -s -L -o "$output" "$url" 2>/dev/null
    ) &
    local curl_pid=$!

    unbuffered_sed \
        -e 'y/ACDEGHLNORTV/acdeghlnortv/' \
        -e '/^0000: content-length:/p' \
        -e '/^<= recv data/p' \
        "$tracefile" | \
    {
        local length=0
        local bytes=0

        while IFS=" " read -r -a line; do
            [[ "${#line[@]}" -lt 2 ]] && continue
            local tag="${line[0]} ${line[1]}"

            if [[ "$tag" == "0000: content-length:" ]]; then
                length="${line[2]}"
                length="$(echo "$length" | tr -d '\r')"
                bytes=0
            elif [[ "$tag" == "<= recv" ]]; then
                local size="${line[3]}"
                bytes="$(( bytes + size ))"
                if [[ "$length" -gt 0 ]]; then
                    print_progress "$bytes" "$length"
                fi
            fi
        done
    }

    wait "$curl_pid"
    local ret=$?
    echo "" >&4
    return $ret
}

download_file() {
    local url="$1"
    local output="$2"
    local description="$3"

    log "Downloading $description..."

    if $DRY_RUN; then
        printf "  ${MUTED}[dry-run]${NC} curl -L -o %s %s\n" "$output" "$url" >&2
        return 0
    fi

    mkdir -p "$(dirname "$output")"

    # Try progress bar if TTY, fallback to plain curl
    if [[ -t 2 ]] && command -v mkfifo >/dev/null 2>&1; then
        if ! download_with_progress "$url" "$output"; then
            # Fallback to simple curl with progress bar
            curl -# -L -o "$output" "$url"
        fi
    else
        curl -# -L -o "$output" "$url"
    fi

    if [[ ! -f "$output" ]]; then
        err "Download failed: $url"
        exit 1
    fi
}

# ─── SHA256 verification ──────────────────────────────────────────────────────

verify_sha256() {
    if $NO_VERIFY; then
        log "Skipping SHA256 verification (--no-verify)"
        return 0
    fi

    local archive_name="$1"
    local checksums_url="$2"
    local archive_path="$3"
    local tmp_dir="$(dirname "$archive_path")"

    log "Verifying SHA256 checksum..."

    if $DRY_RUN; then
        printf "  ${MUTED}[dry-run]${NC} sha256sum -c checksums.txt\n" >&2
        return 0
    fi

    # Download checksums.txt
    local checksums_path="$tmp_dir/checksums.txt"
    if ! curl -sL -o "$checksums_path" "$checksums_url" 2>/dev/null; then
        warn "Could not download checksums.txt — skipping verification"
        return 0
    fi

    # Verify: sha256sum expects "hash  filename" format
    # We only check our specific archive
    local expected_hash
    expected_hash="$(grep "$archive_name" "$checksums_path" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$expected_hash" ]]; then
        warn "Archive $archive_name not found in checksums.txt — skipping verification"
        return 0
    fi

    local actual_hash
    actual_hash="$(sha256sum "$archive_path" | awk '{print $1}')"

    if [[ "$actual_hash" != "$expected_hash" ]]; then
        err "SHA256 mismatch!"
        err "  Expected: $expected_hash"
        err "  Actual:   $actual_hash"
        err "  Archive may be corrupted — aborting."
        exit 1
    fi

    log "SHA256 verified: $archive_name"
}

# ─── Extract ─────────────────────────────────────────────────────────────────

extract_archive() {
    local archive_path="$1"
    local target_dir="$2"
    local strip_components="${3:-0}"

    log "Extracting to $target_dir..."

    if $DRY_RUN; then
        if [[ "$archive_path" == *.zip ]]; then
            local strip_opt=""
            [[ "$strip_components" -gt 0 ]] && strip_opt=" (strip $strip_components)"
            printf "  ${MUTED}[dry-run]${NC} unzip -q %s -d %s%s\n" "$archive_path" "$target_dir" "$strip_opt" >&2
        else
            local strip_flag=""
            [[ "$strip_components" -gt 0 ]] && strip_flag=" --strip-components=$strip_components"
            printf "  ${MUTED}[dry-run]${NC} tar -xzf %s -C %s%s\n" "$archive_path" "$target_dir" "$strip_flag" >&2
        fi
        return 0
    fi

    mkdir -p "$target_dir"

    if [[ "$archive_path" == *.zip ]]; then
        if ! command -v unzip >/dev/null 2>&1; then
            err "'unzip' is required for .zip archives but not installed"
            err "Install: apt-get install unzip (or equivalent)"
            exit 1
        fi
        # .zip archives: unzip doesn't support --strip-components natively,
        # so extract to a temp dir and move contents up if strip > 0.
        if [[ "$strip_components" -gt 0 ]]; then
            local tmp_extract
            tmp_extract="$(mktemp -d "${TMPDIR:-/tmp}/${APP}_zip_strip_XXXXXX")"
            unzip -q "$archive_path" -d "$tmp_extract"
            # Move the inner directory contents up
            local inner_dir
            inner_dir="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | head -1)"
            if [[ -n "$inner_dir" ]]; then
                mv "$inner_dir/"* "$target_dir/" 2>/dev/null || true
                mv "$inner_dir"/.* "$target_dir/" 2>/dev/null || true
            fi
            rm -rf "$tmp_extract"
        else
            unzip -q "$archive_path" -d "$target_dir"
        fi
    else
        # .tar.gz archives: use --strip-components when available, fallback otherwise.
        if [[ "$strip_components" -gt 0 ]]; then
            # Try tar with --strip-components first (GNU tar, busybox tar)
            if tar --version >/dev/null 2>&1; then
                # GNU tar — supports --strip-components
                tar -xzf "$archive_path" -C "$target_dir" --strip-components="$strip_components"
            else
                # Fallback: extract normally, then move inner dir contents up
                local tmp_extract
                tmp_extract="$(mktemp -d "${TMPDIR:-/tmp}/${APP}_tar_strip_XXXXXX")"
                tar -xzf "$archive_path" -C "$tmp_extract"
                local inner_dir
                inner_dir="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 -type d | head -1)"
                if [[ -n "$inner_dir" ]]; then
                    mv "$inner_dir/"* "$target_dir/" 2>/dev/null || true
                    mv "$inner_dir"/.* "$target_dir/" 2>/dev/null || true
                fi
                rm -rf "$tmp_extract"
            fi
        else
            tar -xzf "$archive_path" -C "$target_dir"
        fi
    fi

    log "Extracted to $target_dir"
}

# ─── Post-install: chmod + symlink ───────────────────────────────────────────

post_install() {
    log "Setting up binaries..."

    # chmod +x all binaries
    if $DRY_RUN; then
        printf "  ${MUTED}[dry-run]${NC} chmod +x %s/bin/*\n" "$PREFIX" >&2
    else
        chmod +x "$INSTALL_BIN"/neuralgentics* 2>/dev/null || true
        chmod +x "$INSTALL_BIN"/neuralgentics-backend* 2>/dev/null || true
    fi

    # macOS quarantine removal
    if [[ "$DETECTED_OS" == "darwin" ]]; then
        if ! $DRY_RUN; then
            xattr -d com.apple.quarantine "$INSTALL_BIN"/neuralgentics* 2>/dev/null || true
            xattr -d com.apple.quarantine "$INSTALL_BIN"/neuralgentics-backend* 2>/dev/null || true
        fi
        verbose "Removed macOS quarantine attribute"
    fi

    export NEURALGENTICS_INSTALL_PREFIX="$PREFIX"

    # Write install.env so the TUI resolver can find the backend binary
    if ! $DRY_RUN; then
        mkdir -p "$NEURALGENTICS_DATA_DIR"
        cat > "$NEURALGENTICS_DATA_DIR/install.env" <<ENVEOF
# Source this file to set Neuralgentics env vars
# Generated by neuralgentics installer on $(date -u '+%Y-%m-%d %H:%M UTC')
export NEURALGENTICS_INSTALL_PREFIX="${PREFIX}"
export NEURALGENTICS_DATA_DIR="${NEURALGENTICS_DATA_DIR}"
ENVEOF
        verbose "Wrote install.env to $NEURALGENTICS_DATA_DIR/install.env"
    else
        printf "  ${MUTED}[dry-run]${NC} write %s/install.env\n" "$NEURALGENTICS_DATA_DIR" >&2
    fi

    # Symlink $BIN_LINK_DIR/neuralgentics -> $INSTALL_BIN/neuralgentics.
    # Skip when BIN_LINK_DIR == INSTALL_BIN (PWD-local installs): the
    # binary is already in the right place, no symlink needed.
    local target="$INSTALL_BIN/neuralgentics"
    local link="$BIN_LINK_DIR/neuralgentics"
    local link_dir
    link_dir="$(dirname "$link")"

    if [[ "$link_dir" == "$INSTALL_BIN" ]]; then
        verbose "Skip symlink: $BIN_LINK_DIR == \$INSTALL_BIN (PWD-local install)"
    else
        run mkdir -p "$link_dir"

        if [[ -e "$link" && ! -L "$link" ]]; then
            warn "$link exists and is not a symlink — leaving in place"
        else
            if $DRY_RUN; then
                printf "  ${MUTED}[dry-run]${NC} ln -sf %s %s\n" "$target" "$link" >&2
            else
                ln -sf "$target" "$link"
                log "Symlinked: $link -> $target"
            fi
        fi
    fi
}

# ─── PATH setup ──────────────────────────────────────────────────────────────

add_to_path() {
    local config_file="$1"
    local command="$2"
    if grep -Fxq "$command" "$config_file" 2>/dev/null; then
        verbose "PATH already set in $config_file"
        return 0
    fi
    if [[ -w "$config_file" ]]; then
        printf "\n# %s\n%s\n" "$APP" "$command" >> "$config_file"
        log "Added $APP to PATH in $config_file"
    else
        warn "Cannot write to $config_file — add manually:"
        warn "  $command"
    fi
}

setup_path() {
    if $NO_PATH; then
        log "Skipping PATH modification (--no-path)"
        return 0
    fi

    # PWD-local install: BIN_LINK_DIR == INSTALL_BIN, the binary is already
    # in place at $PREFIX/bin/. No symlink, no PATH-add. Just print a tip.
    if [[ "$BIN_LINK_DIR" == "$INSTALL_BIN" ]]; then
        log "Project-local install at $PREFIX — invoke with: $PREFIX/bin/neuralgentics"
        log "Or add to your shell: export PATH=\"$PREFIX/bin:\$PATH\""
        return 0
    fi

    # Skip if already in PATH
    if [[ ":$PATH:" == *":$BIN_LINK_DIR:"* ]]; then
        log "$BIN_LINK_DIR already in PATH"
        return 0
    fi

    local current_shell config_file=""
    current_shell="$(basename "${SHELL:-bash}")"

    case "$current_shell" in
        fish)
            local fish_config="$HOME/.config/fish/config.fish"
            if [[ -f "$fish_config" ]]; then
                config_file="$fish_config"
            else
                # Create the fish config directory and file
                if ! $DRY_RUN; then
                    mkdir -p "$HOME/.config/fish"
                fi
                config_file="$fish_config"
            fi
            if ! $DRY_RUN; then
                add_to_path "$config_file" "fish_add_path $BIN_LINK_DIR"
            else
                printf "  ${MUTED}[dry-run]${NC} add_to_path %s fish_add_path %s\n" "$config_file" "$BIN_LINK_DIR" >&2
            fi
            ;;
        zsh)
            for f in "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zshenv" "$HOME/.config/zsh/.zshrc"; do
                if [[ -f "$f" ]]; then config_file="$f"; break; fi
            done
            [[ -z "$config_file" ]] && config_file="${ZDOTDIR:-$HOME}/.zshrc"
            if ! $DRY_RUN; then
                add_to_path "$config_file" "export PATH=\"$BIN_LINK_DIR:\$PATH\""
            else
                printf "  ${MUTED}[dry-run]${NC} add_to_path %s\n" "$config_file" >&2
            fi
            ;;
        bash)
            for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
                if [[ -f "$f" ]]; then config_file="$f"; break; fi
            done
            [[ -z "$config_file" ]] && config_file="$HOME/.bashrc"
            if ! $DRY_RUN; then
                add_to_path "$config_file" "export PATH=\"$BIN_LINK_DIR:\$PATH\""
            else
                printf "  ${MUTED}[dry-run]${NC} add_to_path %s\n" "$config_file" >&2
            fi
            ;;
        ash|sh)
            for f in "$HOME/.ashrc" "$HOME/.profile"; do
                if [[ -f "$f" ]]; then config_file="$f"; break; fi
            done
            [[ -z "$config_file" ]] && config_file="$HOME/.profile"
            if ! $DRY_RUN; then
                add_to_path "$config_file" "export PATH=\"$BIN_LINK_DIR:\$PATH\""
            else
                printf "  ${MUTED}[dry-run]${NC} add_to_path %s\n" "$config_file" >&2
            fi
            ;;
        *)
            warn "Unknown shell: $current_shell — add manually: export PATH=\"$BIN_LINK_DIR:\$PATH\""
            ;;
    esac

    # GitHub Actions
    if [[ -n "${GITHUB_ACTIONS:-}" && "${GITHUB_ACTIONS}" == "true" ]]; then
        if ! $DRY_RUN; then
            echo "$BIN_LINK_DIR" >> "$GITHUB_PATH"
            log "Added $BIN_LINK_DIR to \$GITHUB_PATH"
        else
            printf "  ${MUTED}[dry-run]${NC} echo %s >> \$GITHUB_PATH\n" "$BIN_LINK_DIR" >&2
        fi
    fi

    # WSL: note about adding to Windows PATH
    if [[ "${WSL_MODE:-}" == "true" ]]; then
        local win_path
        if command -v wslpath >/dev/null 2>&1; then
            win_path="$(wslpath -w "$BIN_LINK_DIR" 2>/dev/null || true)"
            if [[ -n "$win_path" ]]; then
                log "WSL tip: Add to Windows PATH: $win_path"
            fi
        fi
    fi
}

# ─── Verification ────────────────────────────────────────────────────────────

verify_install() {
    if $NO_VERIFY; then
        log "Skipping verification (--no-verify)"
        return 0
    fi

    if $DRY_RUN; then
        log "Skipping verification (dry-run)"
        return 0
    fi

    local errors=0
    log ""
    log "Verifying installation..."

    local checks=(
        "$INSTALL_BIN/neuralgentics:TUI binary"
        "$INSTALL_BIN/neuralgentics-backend:Backend binary"
        "$BIN_LINK_DIR/neuralgentics:neuralgentics symlink"
    )

    local entry
    for entry in "${checks[@]}"; do
        local path="${entry%%:*}"
        local label="${entry#*:}"
        if [[ -e "$path" ]]; then
            printf "  ${GREEN}✓${NC} %-30s %s\n" "$label" "$path" >&2
        else
            printf "  ${RED}✗${NC} %-30s %s\n" "$label" "$path" >&2
            errors=$((errors + 1))
        fi
    done

    # TUI binary: executable + size check (TUI has no --version mode; running it
    # would open a full TUI render and hang the install script forever — Bug #6)
    if [[ -x "$INSTALL_BIN/neuralgentics" ]]; then
        local tui_size
        tui_size=$(stat -c '%s' "$INSTALL_BIN/neuralgentics" 2>/dev/null || stat -f '%z' "$INSTALL_BIN/neuralgentics" 2>/dev/null || echo 0)
        if [[ "$tui_size" -gt 50000000 ]]; then
            printf "  ${GREEN}✓${NC} %-30s %s (%d bytes)\n" "TUI binary" "$INSTALL_BIN/neuralgentics" "$tui_size" >&2
        else
            printf "  ${RED}✗${NC} %-30s %s (suspiciously small: %d bytes)\n" "TUI binary" "$INSTALL_BIN/neuralgentics" "$tui_size" >&2
            errors=$((errors + 1))
        fi
    fi

    if [[ -x "$INSTALL_BIN/neuralgentics-backend" ]]; then
        local bout
        bout="$("$INSTALL_BIN/neuralgentics-backend" --version 2>/dev/null || true)"
        if [[ -n "$bout" ]]; then
            printf "  ${GREEN}✓${NC} %-30s %s\n" "backend --version" "$bout" >&2
        else
            printf "  ${GREEN}✓${NC} %-30s %s\n" "backend binary" "executable" >&2
        fi
    fi

    log ""
    if [[ $errors -eq 0 ]]; then
        printf "${BRIGHT_GREEN}✅ All systems ready${NC}\n" >&2
    else
        printf "${RED}❌ %s verification check(s) failed${NC}\n" "$errors" >&2
        return 1
    fi
}

# ─── Interactive prompts ──────────────────────────────────────────────────────

detect_real_home() {
    local real_home="$HOME"
    # If running under sudo, look up the invoking user's home
    if [[ -n "${SUDO_USER:-}" ]]; then
        local sudo_home
        sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
        [[ -n "$sudo_home" ]] && real_home="$sudo_home"
    fi
    # Fallback if HOME is unset or empty
    if [[ -z "${HOME:-}" ]]; then
        local fallback_home
        fallback_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
        [[ -n "$fallback_home" ]] && real_home="$fallback_home"
    fi
    printf '%s' "$real_home"
}

prompt_install_location() {
    # If --prefix was explicitly passed or NON_INTERACTIVE, skip the prompt
    if [[ -n "${_PREFIX_EXPLICIT:-}" ]] || $NON_INTERACTIVE; then
        # Compute DATA_DIR from PREFIX for non-interactive/default path.
        # Default prefix is PWD-local ($PWD/.neuralgentics). HOME-local
        # ($HOME/.neuralgentics) is only used when --prefix=$HOME/... was
        # passed explicitly.
        if [[ "$PREFIX" == "$PWD/.neuralgentics" ]]; then
            NEURALGENTICS_DATA_DIR="$PREFIX"
            BIN_LINK_DIR="$PREFIX/bin"
        elif [[ "$PREFIX" == "$HOME/.neuralgentics" || "$PREFIX" == "$(detect_real_home)/.neuralgentics" ]]; then
            local real_home
            real_home="$(detect_real_home)"
            # BIN_LINK_DIR and NEURALGENTICS_DATA_DIR may have been set at the
            # top of the file (PWD-local defaults). Override them now that
            # we know the user wants a HOME-local install.
            BIN_LINK_DIR="$real_home/.local/bin"
            NEURALGENTICS_DATA_DIR="$real_home/.local/share/neuralgentics"
        else
            NEURALGENTICS_DATA_DIR="$PREFIX"
            BIN_LINK_DIR="$PREFIX/bin"
        fi
        export NEURALGENTICS_PREFIX="$PREFIX"
        export NEURALGENTICS_DATA_DIR
        return 0
    fi

    local real_home
    real_home="$(detect_real_home)"

    # WSL detection for warning
    local wsl_flag=false
    if [[ -f /proc/version ]]; then
        local proc_ver
        proc_ver="$(cat /proc/version 2>/dev/null || true)"
        if [[ "$proc_ver" =~ [Mm]icrosoft || "$proc_ver" =~ WSL ]]; then
            wsl_flag=true
        fi
    fi
    if [[ -n "${WSL_DISTRO_NAME:-}" || -n "${WSL_INTEROP:-}" ]]; then
        wsl_flag=true
    fi

    printf '\n' >&2
    printf "${CYAN}Where should Neuralgentics install?${NC}\n" >&2
    printf "  1) Local to this project (%s) ${GREEN}<-- default${NC}\n" "$PWD" >&2
    printf "  2) Home directory (%s)\n" "$real_home" >&2
    printf "  3) Custom path\n" >&2

    if $wsl_flag; then
        printf "\n  ${ORANGE}⚠  WSL detected — install paths must stay inside the Linux distro (no /mnt/c)${NC}\n" >&2
    fi

    while true; do
        printf "Choice [1/2/3] (default: 1): " >&2
        local choice
        read -r choice || choice=""

        # Default to 1 (PWD-local)
        [[ -z "$choice" ]] && choice="1"

        case "$choice" in
            1)
                PREFIX="$PWD/.neuralgentics"
                NEURALGENTICS_DATA_DIR="$PREFIX"
                BIN_LINK_DIR="$PREFIX/bin"
                ;;
            2)
                PREFIX="$real_home/.neuralgentics"
                NEURALGENTICS_DATA_DIR="$real_home/.local/share/neuralgentics"
                BIN_LINK_DIR="$real_home/.local/bin"
                ;;
            3)
                printf "Enter custom path: " >&2
                local custom_path
                read -r custom_path || custom_path=""
                if [[ -z "$custom_path" ]]; then
                    err "Path cannot be empty"
                    continue
                fi
                # Expand ~ to real_home
                custom_path="${custom_path/#\~/$real_home}"
                # Must be absolute
                if [[ "$custom_path" != /* ]]; then
                    err "Path must be absolute (start with /). Example: $real_home/neuralgentics"
                    continue
                fi
                # Warn on obvious footguns
                if [[ "$custom_path" == "/" || "$custom_path" == "/usr" || "$custom_path" == "/etc" || "$custom_path" == "/root" ]]; then
                    err "Installing to $custom_path is not safe. Choose a user-writable directory."
                    continue
                fi
                # WSL: warn about /mnt/ paths
                if $wsl_flag && [[ "$custom_path" == /mnt/* ]]; then
                    warn "$custom_path is on the Windows filesystem (/mnt/)."
                    warn "Linux binaries on /mnt/ may have permission issues."
                    warn "Consider a path inside the WSL filesystem (e.g. ~/.neuralgentics)."
                    printf "Continue anyway? [y/N] " >&2
                    local mnt_answer
                    read -r mnt_answer || mnt_answer=""
                    if [[ ! "$mnt_answer" =~ ^[Yy] ]]; then
                        continue
                    fi
                fi
                # Validate writable
                if ! mkdir -p "$custom_path" 2>/dev/null; then
                    err "Cannot create directory: $custom_path"
                    continue
                fi
                local tmp_test
                tmp_test="$(mktemp "$custom_path/.neuralgentics_write_test_XXXXXX" 2>/dev/null || true)"
                if [[ -z "$tmp_test" ]]; then
                    err "$custom_path is not writable. Choose a different path."
                    rmdir "$custom_path" 2>/dev/null || true
                    continue
                fi
                rm -f "$tmp_test"

                PREFIX="$custom_path"
                NEURALGENTICS_DATA_DIR="$custom_path"
                BIN_LINK_DIR="$custom_path/bin"
                ;;
            *)
                err "Invalid choice. Enter 1, 2, or 3."
                continue
                ;;
        esac
        break
    done

    export NEURALGENTICS_PREFIX="$PREFIX"
    export NEURALGENTICS_DATA_DIR
    # Recompute INSTALL_BIN now that PREFIX may have changed
    INSTALL_BIN="$PREFIX/bin"
    log "Install prefix:  $PREFIX"
    log "Data directory:  $NEURALGENTICS_DATA_DIR"
    log "Bin link dir:    $BIN_LINK_DIR"
    return 0
}

generate_env_file() {
    local env_host="$1"
    local env_port="$2"
    local env_user="$3"
    local env_password="$4"
    local env_db="$5"
    local env_path="${6:-$NEURALGENTICS_DATA_DIR/.env}"

    # Ensure the data directory exists
    mkdir -p "$NEURALGENTICS_DATA_DIR"

    cat > "$env_path" <<ENVEOF
# Generated by neuralgentics installer on $(date -u '+%Y-%m-%d %H:%M UTC')
# Database connection: use ?sslmode=require (self-signed cert, no CA verify needed)
# DO NOT COMMIT — this file is in .gitignore
POSTGRES_HOST="${env_host}"
POSTGRES_PORT="${env_port}"
POSTGRES_USER="${env_user}"
POSTGRES_PASSWORD="${env_password}"
POSTGRES_DB="${env_db}"
ENVEOF

    chmod 600 "$env_path"
    verbose "Wrote .env to $env_path"
}

# Detect an available container runtime. Prefers docker (broader install base
# and what GH Actions ships by default) and falls back to podman. Sets the
# global $CONTAINER_CMD variable on success. Returns 0 on success, 1 on
# failure (caller decides how to bail).
CONTAINER_CMD=""
_detect_container_runtime() {
    if [[ -n "$CONTAINER_CMD" ]]; then
        # Already detected earlier in this run
        command -v "$CONTAINER_CMD" >/dev/null 2>&1 && return 0
    fi
    if command -v docker >/dev/null 2>&1; then
        CONTAINER_CMD="docker"
        verbose "Using container runtime: docker"
        return 0
    fi
    if command -v podman >/dev/null 2>&1; then
        CONTAINER_CMD="podman"
        verbose "Using container runtime: podman"
        return 0
    fi
    CONTAINER_CMD=""
    return 1
}

# Try to recover database credentials from an existing running container.
# Used by prompt_database() to make `curl | bash` re-runs work when a
# neuralgentics-pg container already exists but no .env file does.
# Returns 0 on success (env written), 1 on failure (caller falls back to
# prompt or auto-start).
_recover_container_creds() {
    local container_name="$1"

    local db_password=""
    local db_user=""
    local db_name=""
    local db_port=""

    # Attempt 1: extract from container's runtime environment (works for
    # containers created by THIS installer or by any other means that set
    # POSTGRES_PASSWORD via -e at run time).
    local container_env
    container_env="$($CONTAINER_CMD exec "$container_name" printenv 2>/dev/null || true)"
    if [[ -n "$container_env" ]]; then
        db_password="$(printf '%s\n' "$container_env" | grep '^POSTGRES_PASSWORD=' | head -1 | cut -d= -f2-)"
        db_user="$(printf '%s\n' "$container_env" | grep '^POSTGRES_USER=' | head -1 | cut -d= -f2-)"
        db_name="$(printf '%s\n' "$container_env" | grep '^POSTGRES_DB=' | head -1 | cut -d= -f2-)"
        # Port from inspect — more robust than regex on HostConfig
        db_port="$($CONTAINER_CMD inspect "$container_name" --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' 2>/dev/null || true)"
    fi

    # Attempt 2: search common backup locations for an existing .env
    if [[ -z "$db_password" ]]; then
        local search_paths=(
            "$PREFIX/.env"
            "$HOME/.neuralgentics/.env"
            "$HOME/.config/neuralgentics/.env"
            "$HOME/.local/share/neuralgentics/.env"
        )
        for spath in "${search_paths[@]}"; do
            if [[ -f "$spath" ]]; then
                local candidate_pw
                candidate_pw="$(grep '^POSTGRES_PASSWORD=' "$spath" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
                if [[ -n "$candidate_pw" ]]; then
                    db_password="$candidate_pw"
                    db_user="$(grep '^POSTGRES_USER=' "$spath" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
                    db_name="$(grep '^POSTGRES_DB=' "$spath" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
                    db_port="$(grep '^POSTGRES_PORT=' "$spath" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
                    log "Recovered database credentials from $spath"
                    break
                fi
            fi
        done
    fi

    # If we still need a password, we can't recover — return failure
    if [[ -z "$db_password" ]]; then
        return 1
    fi

    # Fill in defaults for anything still missing
    [[ -z "$db_user" ]] && db_user="neuralgentics"
    [[ -z "$db_name" ]] && db_name="neuralgentics"
    [[ -z "$db_port" ]] && db_port="6000"

    generate_env_file "127.0.0.1" "$db_port" "$db_user" "$db_password" "$db_name"
    log "Database configured from existing container. Connection details in $NEURALGENTICS_DATA_DIR/.env"
    return 0
}

prompt_database() {
    # Step 1: If .env already exists with valid config, return immediately.
    # This must come BEFORE the TTY guard so curl | bash re-runs work.
    local env_file="$NEURALGENTICS_DATA_DIR/.env"
    if [[ -f "$env_file" ]]; then
        local missing=0
        for key in POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
            if ! grep -q "^${key}=" "$env_file" 2>/dev/null; then
                missing=$((missing + 1))
            fi
        done
        if [[ $missing -eq 0 ]]; then
            log "Database already configured. Details in $env_file"
            return 0
        fi
    fi

    # Step 2: Detect a container runtime. Prefer docker (broader install base);
    # fall back to podman. Both are interchangeable for our purposes.
    if ! _detect_container_runtime; then
        # No runtime available — TTY-aware error
        if [[ ! -t 0 ]] && ! $NON_INTERACTIVE; then
            err "Neither docker nor podman was found on this system."
            err "Install one first: https://docs.docker.com/get-docker/ or https://podman.io/getting-started/installation"
            err "Then re-run: bash install.sh"
            exit 1
        fi
        err "Neither docker nor podman was found. Install one first:"
        err "  https://docs.docker.com/get-docker/"
        err "  https://podman.io/getting-started/installation"
        return 1
    fi

    # Step 3: Try to recover credentials from an existing container before
    # falling back to the TTY prompt. This is reachable under non-TTY now.
    # Covers: existing container + no .env (most common re-install case).
    local container_name="neuralgentics-pg"
    if $CONTAINER_CMD inspect "$container_name" >/dev/null 2>&1; then
        # Container exists (running or stopped). Try to start it if stopped,
        # then try to recover creds from its env.
        local state
        state="$($CONTAINER_CMD inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null || echo "false")"
        if [[ "$state" != "true" ]]; then
            log "Container '$container_name' exists but is stopped. Starting it..."
            if $DRY_RUN; then
                printf "  ${MUTED}[dry-run]${NC} %s start %s\n" "$CONTAINER_CMD" "$container_name" >&2
            else
                if ! $CONTAINER_CMD start "$container_name" >/dev/null 2>&1; then
                    warn "Failed to start existing container '$container_name' — will create a fresh one"
                fi
            fi
        fi
        # If we can recover creds (or we just started it successfully), skip the prompt
        if $CONTAINER_CMD inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
            if _recover_container_creds "$container_name"; then
                # _recover_container_creds writes the .env on success
                return 0
            fi
        fi
    fi

    # Step 4: TTY guard as a last resort. If we got here under non-TTY and
    # couldn't auto-recover, we either need to auto-start fresh (--yes or
    # implicit when truly broken) or fail with a clear message.
    if [[ ! -t 0 ]] && ! $NON_INTERACTIVE; then
        err "This installer needs to ask a question, but stdin is not a terminal."
        err "This usually happens when piping: curl ... | bash"
        err ""
        err "Save the installer and re-run interactively:"
        err "  curl -fsSL https://github.com/${REPO:-Veedubin/neuralgentics}/releases/latest/download/install.sh -o install.sh"
        err "  bash install.sh"
        err ""
        err "Or use non-interactive mode to auto-create a database:"
        err "  bash install.sh --yes"
        err ""
        err "If you have an existing '$container_name' container that's stopped:"
        err "  $CONTAINER_CMD start $container_name"
        err "Then re-run the installer."
        exit 1
    fi

    # Non-interactive: default to starting a fresh container
    if $NON_INTERACTIVE; then
        _start_fresh_db
        return $?
    fi

    printf '\n' >&2
    printf "${CYAN}Neuralgentics needs a PostgreSQL database with the pgvector extension.${NC}\n" >&2

    while true; do
        printf "Start one now using %s? [Y/n] (default: Y): " "$CONTAINER_CMD" >&2
        local answer
        read -r answer || answer=""

        # Default to Y
        if [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; then
            _start_fresh_db
            return $?
        fi

        if [[ "$answer" =~ ^[Nn]$ ]]; then
            break
        fi
        # Invalid input, re-prompt
        err "Please enter Y or n."
    done

    # User said n — offer sub-options
    printf '\n' >&2
    printf "Connect to existing PostgreSQL:\n" >&2
    printf "  1) Enter connection details now\n" >&2
    printf "  2) Use an existing .env file\n" >&2

    while true; do
        printf "Choice [1/2] (default: 1): " >&2
        local sub_choice
        read -r sub_choice || sub_choice=""
        [[ -z "$sub_choice" ]] && sub_choice="1"

        case "$sub_choice" in
            1)
                _prompt_connection_details
                return $?
                ;;
            2)
                _prompt_env_file
                return $?
                ;;
            *)
                err "Invalid choice. Enter 1 or 2."
                continue
                ;;
        esac
    done
}

_start_fresh_db() {
    # Make sure we have a runtime; the caller (prompt_database) should have
    # already called _detect_container_runtime, but be defensive.
    if [[ -z "$CONTAINER_CMD" ]] && ! _detect_container_runtime; then
        err "Neither docker nor podman was found. Install one first:"
        err "  https://docs.docker.com/get-docker/"
        err "  https://podman.io/getting-started/installation"
        return 1
    fi

    # Check for existing container
    local container_name="neuralgentics-pg"
    local is_running
    is_running="$($CONTAINER_CMD inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null || echo "false")"

    if [[ "$is_running" == "true" ]]; then
        log "Container '$container_name' is already running"
    else
        local container_exists
        container_exists="$($CONTAINER_CMD inspect "$container_name" >/dev/null 2>&1 && echo "true" || echo "false")"

        if [[ "$container_exists" == "true" ]]; then
            log "Starting existing container '$container_name'..."
            if $DRY_RUN; then
                printf "  ${MUTED}[dry-run]${NC} %s start %s\n" "$CONTAINER_CMD" "$container_name" >&2
            else
                $CONTAINER_CMD start "$container_name" || { err "Failed to start container '$container_name'"; return 1; }
            fi
        else
            # Generate a password for the fresh database
            local db_password
            db_password="$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -plain | head -c 32)"
            local db_user="neuralgentics"
            local db_name="neuralgentics"
            local db_port=6000

            log "Creating PostgreSQL container '$container_name' on port $db_port (using $CONTAINER_CMD)..."

            # Generate a self-signed SSL cert so the Go backend can use
            # sslmode=require without warnings (Bug #7).
            # Ensure the data dir exists before mktemp (Bug #9 from install-test v0.6.1).
            mkdir -p "$NEURALGENTICS_DATA_DIR"
            local ssl_cert_dir
            ssl_cert_dir="$(mktemp -d "${NEURALGENTICS_DATA_DIR:-/tmp}/pgssl.XXXXXX")"
            local ssl_cert="$ssl_cert_dir/server.crt"
            local ssl_key="$ssl_cert_dir/server.key"

            if $DRY_RUN; then
                printf "  ${MUTED}[dry-run]${NC} openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 365 -nodes -subj '/CN=neuralgentics'\n" \
                    "$ssl_key" "$ssl_cert" >&2
                printf "  ${MUTED}[dry-run]${NC} chmod 600 %s && chmod 644 %s\n" "$ssl_key" "$ssl_cert" >&2
            else
                if ! openssl req -x509 -newkey rsa:2048 \
                    -keyout "$ssl_key" \
                    -out "$ssl_cert" \
                    -days 365 \
                    -nodes \
                    -subj "/CN=neuralgentics" 2>/dev/null; then
                    err "Failed to generate self-signed SSL certificate"
                    rm -rf "$ssl_cert_dir"
                    return 1
                fi
                chmod 600 "$ssl_key" && chmod 644 "$ssl_cert"
            fi

            if $DRY_RUN; then
                printf "  ${MUTED}[dry-run]${NC} %s run -d --name %s -e POSTGRES_USER=%s -e POSTGRES_PASSWORD=*** -e POSTGRES_DB=%s -p %s:5432 -v %s:/var/lib/postgresql/server.crt:z -v %s:/var/lib/postgresql/server.key:z docker.io/pgvector/pgvector:pg18 bash -c 'chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'\n" \
                    "$CONTAINER_CMD" "$container_name" "$db_user" "$db_name" "$db_port" "$ssl_cert" "$ssl_key" >&2
                log "Container '$container_name' created on port $db_port (SSL enabled)"
                generate_env_file "127.0.0.1" "$db_port" "$db_user" "$db_password" "$db_name"
                log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
                return 0
            fi

            # Use :z mount option (shared SELinux relabel) WITHOUT :ro, so the
            # chown in the bash wrapper can succeed. Then chown the certs to
            # postgres:postgres before exec'ing the entrypoint (which drops to
            # the postgres user via gosu).
            #
            # Previous attempts failed in rootless podman:
            #   - chown 999:999 on host (Bug #8): fails for non-root users
            #   - :U,ro mount: chowns to image's User (root), not postgres
            #   - plain :ro: files appear as root:root, postgres can't read
            # The :z + chown-in-wrapper pattern is the canonical rootless
            # solution. (Bug #10 from install-test v0.6.1.)
            # NOTE: :z is a podman-ism. Docker accepts it but treats it the
            # same as a normal bind mount with no SELinux relabeling. Both
            # runtimes work with this invocation.

            $CONTAINER_CMD run -d \
                --name "$container_name" \
                -e POSTGRES_USER="$db_user" \
                -e POSTGRES_PASSWORD="$db_password" \
                -e POSTGRES_DB="$db_name" \
                -p "$db_port:5432" \
                -v "$ssl_cert:/var/lib/postgresql/server.crt:z" \
                -v "$ssl_key:/var/lib/postgresql/server.key:z" \
                docker.io/pgvector/pgvector:pg18 \
                bash -c "chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key" \
            || { err "Failed to create container '$container_name'"; rm -rf "$ssl_cert_dir"; return 1; }

            log "Container '$container_name' created on port $db_port (SSL enabled)"

            # Wait for PostgreSQL to accept connections
            local max_attempts=30
            local attempt=0
            log "Waiting for PostgreSQL to accept connections..."
            while [[ $attempt -lt $max_attempts ]]; do
                if $CONTAINER_CMD exec "$container_name" pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
                    log "PostgreSQL is ready"
                    break
                fi
                attempt=$((attempt + 1))
                sleep 1
            done
            if [[ $attempt -ge $max_attempts ]]; then
                err "PostgreSQL did not become ready within ${max_attempts}s"
                return 1
            fi

            # Write the .env file
            generate_env_file "127.0.0.1" "$db_port" "$db_user" "$db_password" "$db_name"
            log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
            return 0
        fi
    fi

    # Container was already running or restarted — extract connection info
    # If we have an .env from a previous install, trust it
    if [[ -f "$NEURALGENTICS_DATA_DIR/.env" ]]; then
        log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
        return 0
    fi

    # No .env yet — try to recover credentials from the running container
    # (Bug #3: auto-extract from container env when .env is missing).
    warn "Container '$container_name' is running but no .env file found."

    if _recover_container_creds "$container_name"; then
        return 0
    fi

    # Fall back to interactive prompt (TTY-only)
    if [[ ! -t 0 ]]; then
        err "Cannot recover the PostgreSQL password from the container or any backup location."
        err "Re-run the installer interactively to enter the password:"
        err "  bash install.sh"
        err "Or re-create the database with --yes to auto-generate a new password:"
        err "  bash install.sh --yes"
        return 1
    fi
    printf "Enter the PostgreSQL password used when creating '%s': " "$container_name" >&2
    local db_password
    read -r db_password || db_password=""
    if [[ -z "$db_password" ]]; then
        err "Password cannot be empty"
        return 1
    fi

    # Re-recover with the user-provided password
    local db_user="neuralgentics"
    local db_name="neuralgentics"
    local db_port="6000"
    # Best-effort defaults from container env
    local container_env
    container_env="$($CONTAINER_CMD exec "$container_name" printenv 2>/dev/null || true)"
    if [[ -n "$container_env" ]]; then
        local u
        u="$(printf '%s\n' "$container_env" | grep '^POSTGRES_USER=' | head -1 | cut -d= -f2-)"; [[ -n "$u" ]] && db_user="$u"
        local n
        n="$(printf '%s\n' "$container_env" | grep '^POSTGRES_DB=' | head -1 | cut -d= -f2-)"; [[ -n "$n" ]] && db_name="$n"
        local p
        p="$($CONTAINER_CMD inspect "$container_name" --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' 2>/dev/null || true)"
        [[ -n "$p" ]] && db_port="$p"
    fi

    generate_env_file "127.0.0.1" "$db_port" "$db_user" "$db_password" "$db_name"
    log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
    return 0
}

_prompt_connection_details() {
    local db_host db_port db_user db_password db_name

    printf "  Host [127.0.0.1]: " >&2
    read -r db_host || db_host=""
    [[ -z "$db_host" ]] && db_host="127.0.0.1"

    printf "  Port [5432]: " >&2
    read -r db_port || db_port=""
    [[ -z "$db_port" ]] && db_port="5432"

    printf "  User [postgres]: " >&2
    read -r db_user || db_user=""
    [[ -z "$db_user" ]] && db_user="postgres"

    printf "  Password (hidden): " >&2
    read -rs db_password || db_password=""
    printf '\n' >&2
    if [[ -z "$db_password" ]]; then
        err "Password cannot be empty"
        return 1
    fi

    printf "  Database [neuralgentics]: " >&2
    read -r db_name || db_name=""
    [[ -z "$db_name" ]] && db_name="neuralgentics"

    # Validate connection with psql if available
    if command -v psql >/dev/null 2>&1; then
        local db_url="postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}?sslmode=prefer"
        if ! psql "$db_url" -c "SELECT 1" --no-psqlrc -q -t >/dev/null 2>&1; then
            err "Could not connect to database at $db_host:$db_port/$db_name"
            err "  Check host, port, and that PostgreSQL is running."
            err "  Try sslmode=disable or sslmode=require in the connection string."
            return 1
        fi
        printf "  ${GREEN}✓${NC} Database connection verified.\n" >&2
    else
        warn "psql not found — skipping connection verification"
        warn "  Verify manually: psql postgresql://${db_user}:***@${db_host}:${db_port}/${db_name}"
    fi

    generate_env_file "$db_host" "$db_port" "$db_user" "$db_password" "$db_name"
    log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
    return 0
}

_prompt_env_file() {
    while true; do
        printf "  Path to .env file: " >&2
        local env_file_path
        read -r env_file_path || env_file_path=""

        if [[ -z "$env_file_path" ]]; then
            err "Path cannot be empty"
            continue
        fi

        # Expand ~
        local real_home
        real_home="$(detect_real_home)"
        env_file_path="${env_file_path/#\~/$real_home}"

        if [[ ! -f "$env_file_path" ]]; then
            err "$env_file_path does not exist"
            continue
        fi

        if [[ ! -r "$env_file_path" ]]; then
            err "$env_file_path is not readable"
            continue
        fi

        # Validate: must contain all 5 required keys
        local required_keys=(POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB)
        local missing_keys=()
        for key in "${required_keys[@]}"; do
            if ! grep -q "^${key}=" "$env_file_path" 2>/dev/null; then
                missing_keys+=("$key")
            fi
        done

        if [[ ${#missing_keys[@]} -gt 0 ]]; then
            err "$env_file_path is missing required keys:"
            for key in "${missing_keys[@]}"; do
                err "  - $key"
            done
            err "Required: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB"
            continue
        fi

        # All good — copy to the data directory
        mkdir -p "$NEURALGENTICS_DATA_DIR"
        cp "$env_file_path" "$NEURALGENTICS_DATA_DIR/.env"
        chmod 600 "$NEURALGENTICS_DATA_DIR/.env"

        # Extract values for connection validation
        local db_host db_port db_user db_password db_name
        db_host="$(grep '^POSTGRES_HOST=' "$env_file_path" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
        db_port="$(grep '^POSTGRES_PORT=' "$env_file_path" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
        db_user="$(grep '^POSTGRES_USER=' "$env_file_path" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
        db_password="$(grep '^POSTGRES_PASSWORD=' "$env_file_path" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
        db_name="$(grep '^POSTGRES_DB=' "$env_file_path" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"

        if command -v psql >/dev/null 2>&1; then
            local db_url="postgresql://${db_user}:${db_password}@${db_host}:${db_port}/${db_name}?sslmode=prefer"
            if psql "$db_url" -c "SELECT 1" --no-psqlrc -q -t >/dev/null 2>&1; then
                printf "  ${GREEN}✓${NC} Database connection verified.\n" >&2
            else
                warn "Could not verify connection to ${db_host}:${db_port}/${db_name}"
                warn "  Verify manually that the credentials are correct."
            fi
        else
            warn "psql not found — skipping connection verification"
        fi

        break
    done

    log "Database configured. Connection details in $NEURALGENTICS_DATA_DIR/.env"
    return 0
}

# ─── Project Registration ─────────────────────────────────────────────────────

# Returns the basename of a path, sanitized for use as a project name.
_get_project_name_from_path() {
    local path="$1"
    local name
    name="$(basename "$path")"
    # Sanitize: replace non-alphanumeric chars with hyphens, collapse multiples, strip leading/trailing hyphens
    name="$(printf '%s' "$name" | tr -c '[:alnum:]' '-' | tr -s '-' | sed 's/^-\|-$//g')"
    printf '%s' "$name"
}

# Returns the path to the projects registry file.
_projects_registry_path() {
    printf '%s/projects.toml' "$PREFIX"
}

# Register the current working directory as a project.
# Writes to $PREFIX/projects.toml (TOML format, human-editable).
# Idempotent: re-runs from the same directory update the existing entry.
register_project() {
    local registry_path
    registry_path="$(_projects_registry_path)"
    local project_dir="$PWD"
    local project_name
    project_name="$(_get_project_name_from_path "$project_dir")"
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    # In non-interactive mode, auto-register
    if $NON_INTERACTIVE; then
        : # skip the prompt, register directly
    else
        # Guard: don't prompt if stdin is not a TTY (Bug #2)
        if [[ ! -t 0 ]]; then
            verbose "Skipping project registration (non-TTY stdin)"
            return 0
        fi
        printf "\n${CYAN}Register this directory as a project?${NC} [%s] [Y/n]: " "$project_name" >&2
        local answer
        read -r answer || answer=""
        # Default to Y
        if [[ -n "$answer" ]] && [[ ! "$answer" =~ ^[Yy] ]]; then
            log "Skipping project registration"
            return 0
        fi
    fi

    # Ensure the directory exists
    mkdir -p "$PREFIX"

    # Check if this path is already registered
    local existing_name=""
    local is_default=false
    if [[ -f "$registry_path" ]]; then
        # If the path already exists, capture whether IT was the default.
        # We have to read this BEFORE the block-removal step wipes the old entry.
        if grep -q "path = \"${project_dir}\"" "$registry_path" 2>/dev/null; then
            existing_name="$(grep -B1 "path = \"${project_dir}\"" "$registry_path" | head -1 | sed 's/^name = "//;s/"$//')"
            verbose "Updating existing project registration: $existing_name ($project_dir)"
            # Was this path the default? Check the lines after the path line, up
            # to the next blank/header line.
            if awk -v p="path = \"${project_dir}\"" '
                $0 == p { found=1; next }
                found && /^default = true/ { print "yes"; exit }
                found && /^default = false/ { exit }
                found && /^\[\[project\]\]/ { exit }
            ' "$registry_path" | grep -q yes; then
                is_default=true   # Preserve default status on re-registration
            fi
        fi
    fi

    # If this is a brand-new registration (no existing path), determine default
    # based on whether ANY project is currently default in the registry.
    if [[ -z "$existing_name" ]]; then
        if [[ -f "$registry_path" ]] && grep -q 'default = true' "$registry_path" 2>/dev/null; then
            is_default=false  # Another project already holds default
        else
            is_default=true   # First ever registration
        fi
    fi

    # If the registry is empty (no entries), this must be the first project.
    if [[ -f "$registry_path" ]]; then
        local entry_count
        entry_count="$(grep -c '^\[\[project\]\]' "$registry_path" 2>/dev/null || echo 0)"
        if [[ "$entry_count" -eq 0 ]]; then
            is_default=true
        fi
    else
        is_default=true
    fi

    if $DRY_RUN; then
        printf "  ${MUTED}[dry-run]${NC} register_project: name=%s path=%s default=%s\n" "$project_name" "$project_dir" "$is_default" >&2
        return 0
    fi

    # Remove existing entry for this path (if any) before appending the update.
    # Each [[project]] block is 5 lines: header + name + path + registered_at + default.
    # We use awk to skip the block that contains the matching `path = "..."` line.
    if [[ -f "$registry_path" ]] && grep -q "path = \"${project_dir}\"" "$registry_path"; then
        local tmp_registry
        tmp_registry="$(mktemp "${TMPDIR:-/tmp}/${APP}_registry_XXXXXX")"
        # awk: walk line-by-line, when we see `[[project]]` start collecting
        # a 5-line block; if the collected block contains our path, drop it;
        # otherwise emit it. Anything outside a block passes through unchanged.
        awk -v target="path = \"${project_dir}\"" '
            /^\[\[project\]\]/ {
                # Read the next 4 lines (name, path, registered_at, default)
                l1 = ""; l2 = ""; l3 = ""; l4 = ""
                if ((getline l1) <= 0) l1 = ""
                if ((getline l2) <= 0) l2 = ""
                if ((getline l3) <= 0) l3 = ""
                if ((getline l4) <= 0) l4 = ""
                block = $0 "\n" l1 "\n" l2 "\n" l3 "\n" l4 "\n"
                if (block !~ target) {
                    printf "%s", block
                }
                # else: skip this block entirely
                next
            }
            { print }
        ' "$registry_path" > "$tmp_registry"
        mv "$tmp_registry" "$registry_path"
    fi

    # If this project should be default, un-mark the previous default
    if $is_default && [[ -f "$registry_path" ]]; then
        sed -i 's/^default = true/default = false/' "$registry_path" 2>/dev/null || true
    fi

    # Append the new entry
    {
        printf '\n[[project]]\n'
        printf 'name = "%s"\n' "$project_name"
        printf 'path = "%s"\n' "$project_dir"
        printf 'registered_at = "%s"\n' "$timestamp"
        printf 'default = %s\n' "$is_default"
    } >> "$registry_path"

    log "Project registered: $project_name ($project_dir)"
    if $is_default; then
        log "Marked as default project"
    fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    print_banner
    log "Installing $APP v${VERSION}"
    $DRY_RUN && log "DRY RUN — no changes will be made"
    $NO_PATH && log "Skipping PATH edit (--no-path)"
    $NO_VERIFY && log "Skipping SHA256 verify (--no-verify)"
    $NON_INTERACTIVE && log "Non-interactive mode (--yes)"

    # 0. Interactive prompt: install location (after banner, before filesystem writes)
    prompt_install_location

    # Log final paths after prompt_install_location may have changed them
    log "Prefix:    $PREFIX"
    log "Bin link:  $BIN_LINK_DIR/$APP"

    # 1. Detect platform
    detect_os_arch
    detect_wsl

    # 2. Detect repo
    detect_repo

    # 3. Build download URL
    local archive_name="neuralgentics-${VERSION}-${DETECTED_OS}-${DETECTED_ARCH}"
    if [[ "$DETECTED_OS" == "windows" ]]; then
        archive_name="${archive_name}.zip"
    else
        archive_name="${archive_name}.tar.gz"
    fi

    local base_url="https://github.com/${REPO}/releases/download/v${VERSION}"
    local archive_url="${base_url}/${archive_name}"
    local checksums_url="${base_url}/checksums.txt"

    verbose "Archive URL: $archive_url"
    verbose "Checksums URL: $checksums_url"

    # 4. Download
    local tmp_dir="${TMPDIR:-/tmp}/${APP}_install_$$"
    if ! $DRY_RUN; then
        mkdir -p "$tmp_dir"
    fi
    local archive_path="$tmp_dir/$archive_name"

    download_file "$archive_url" "$archive_path" "$archive_name"

    # 5. Verify SHA256
    verify_sha256 "$archive_name" "$checksums_url" "$archive_path"

    # 6. Extract — strip the top-level archive directory (e.g., neuralgentics/)
    #    so binaries land at $PREFIX/bin/ directly instead of $PREFIX/neuralgentics/bin/
    extract_archive "$archive_path" "$PREFIX" 1

    # 7. Post-install
    post_install

    # 8. PATH setup
    setup_path

    # 9. Interactive prompt: database (after install, before verification)
    prompt_database

    # 10. Register project directory
    register_project

    # 11. Verify
    verify_install

    # 12. Cleanup
    if ! $DRY_RUN && [[ -d "$tmp_dir" ]]; then
        rm -rf "$tmp_dir"
    fi

    # Success!
    cat <<EOF >&2

${BRIGHT_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}
${BRIGHT_GREEN}  HACK THE PLANET!${NC} — neuralgentics v${VERSION} installed

${CYAN}  Quick start:${NC}
    neuralgentics                ${MUTED}# Launch the TUI${NC}
    neuralgentics --help         ${MUTED}# Show commands${NC}
    neuralgentics status         ${MUTED}# Check component status${NC}

 ${MUTED}  Install root:  ${PREFIX}${NC}
 ${MUTED}  Data dir:      ${NEURALGENTICS_DATA_DIR}${NC}
 ${MUTED}  Binary link:   ${BIN_LINK_DIR}/neuralgentics${NC}
 ${MUTED}  Env:           source ${NEURALGENTICS_DATA_DIR}/install.env${NC}
EOF

    # Show .env path if database was configured
    if [[ -f "$NEURALGENTICS_DATA_DIR/.env" ]]; then
        printf "${MUTED}  DB config:      %s/.env${NC}\n" "$NEURALGENTICS_DATA_DIR" >&2
    fi

    # Show registered projects count
    local project_count=0
    local registry_file
    registry_file="$(_projects_registry_path)"
    if [[ -f "$registry_file" ]]; then
        project_count="$(grep -c '^\[\[project\]\]' "$registry_file" 2>/dev/null || echo 0)"
        if [[ "$project_count" -gt 0 ]]; then
            printf "${MUTED}  Projects:      %d registered (%s)${NC}\n" "$project_count" "$registry_file" >&2
        fi
    fi

    if [[ "${WSL_MODE:-}" == "true" ]]; then
        printf "${MUTED}  WSL note:     Add ~/.local/bin to your WSL shell rc${NC}\n" >&2
    fi

    cat <<EOF >&2
${MUTED}  Docs:          https://github.com/${REPO}${NC}
${MUTED}  Sidecar:       https://github.com/${REPO}/blob/main/docs/sidecar-setup.md${NC}
${BRIGHT_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

${ORANGE}  Sidecar (advanced):${NC} To enable real BGE-Large embeddings, run:
${MUTED}    git clone https://github.com/${REPO}.git && cd neuralgentics${NC}
${MUTED}    ./scripts/sidecar.sh start${NC}
${MUTED}  Or skip — memory operations work fine with noop embeddings.${NC}
EOF
}

main "$@"