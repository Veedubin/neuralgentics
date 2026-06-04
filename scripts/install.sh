#!/usr/bin/env bash
# neuralgentics v0.1.0 — binary release installer
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
DEFAULT_VERSION="0.1.0"

# ─── Colors ──────────────────────────────────────────────────────────────────

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
GREEN='\033[0;32m'
BRIGHT_GREEN='\033[1;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Defaults ────────────────────────────────────────────────────────────────

PREFIX="${NEURALGENTICS_PREFIX:-$HOME/.neuralgentics}"
BIN_LINK_DIR="$HOME/.local/bin"
VERSION="${DEFAULT_VERSION}"
REPO=""
NO_PATH=false
NO_VERIFY=false
DRY_RUN=false
VERBOSE=false

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
        --no-path           Don't modify shell rc files
        --no-verify         Skip SHA256 verification
        --dry-run           Show what would be done without executing
        --prefix <dir>      Install root (default: ~/.neuralgentics,
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
        --prefix)
            [[ -n "${2:-}" ]] || { err "--prefix requires an argument"; exit 1; }
            PREFIX="$2"; shift 2
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

    log "Extracting to $target_dir..."

    if $DRY_RUN; then
        if [[ "$archive_path" == *.zip ]]; then
            printf "  ${MUTED}[dry-run]${NC} unzip -q %s -d %s\n" "$archive_path" "$target_dir" >&2
        else
            printf "  ${MUTED}[dry-run]${NC} tar -xzf %s -C %s\n" "$archive_path" "$target_dir" >&2
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
        unzip -q "$archive_path" -d "$target_dir"
    else
        tar -xzf "$archive_path" -C "$target_dir"
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

    # Symlink ~/.local/bin/neuralgentics -> ~/.neuralgentics/bin/neuralgentics
    local target="$INSTALL_BIN/neuralgentics"
    local link="$BIN_LINK_DIR/neuralgentics"

    run mkdir -p "$BIN_LINK_DIR"

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

    # Version smoke test
    if [[ -x "$INSTALL_BIN/neuralgentics" ]]; then
        local vout
        vout="$("$INSTALL_BIN/neuralgentics" --version 2>/dev/null || true)"
        if [[ -n "$vout" ]]; then
            printf "  ${GREEN}✓${NC} %-30s %s\n" "neuralgentics --version" "$vout" >&2
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

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    print_banner
    log "Installing $APP v${VERSION}"
    log "Prefix:    $PREFIX"
    log "Bin link:  $BIN_LINK_DIR/$APP"
    $DRY_RUN && log "DRY RUN — no changes will be made"
    $NO_PATH && log "Skipping PATH edit (--no-path)"
    $NO_VERIFY && log "Skipping SHA256 verify (--no-verify)"

    # 1. Detect platform
    detect_os_arch
    detect_wsl

    # 2. Detect repo
    detect_repo

    # 3. Build download URL
    local archive_name="neuralgentics-v${VERSION}-${DETECTED_OS}-${DETECTED_ARCH}"
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

    # 6. Extract
    extract_archive "$archive_path" "$PREFIX"

    # If the archive extracts into a subdirectory (e.g., neuralgentics/), move contents up
    if ! $DRY_RUN; then
        if [[ -d "$PREFIX/neuralgentics" && ! -d "$PREFIX/bin" ]]; then
            mv "$PREFIX/neuralgentics/"* "$PREFIX/" 2>/dev/null || true
            rmdir "$PREFIX/neuralgentics" 2>/dev/null || true
        fi
    fi

    # 7. Post-install
    post_install

    # 8. PATH setup
    setup_path

    # 9. Verify
    verify_install

    # 10. Cleanup
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
${MUTED}  Binary link:   ${BIN_LINK_DIR}/neuralgentics${NC}
EOF

    if [[ "${WSL_MODE:-}" == "true" ]]; then
        printf "${MUTED}  WSL note:     Add ~/.local/bin to your WSL shell rc${NC}\n" >&2
    fi

    cat <<EOF >&2
${MUTED}  Dev database:  ./scripts/dev-up.sh${NC}
${MUTED}  Docs:          https://github.com/${REPO}${NC}
${BRIGHT_GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}
EOF
}

main "$@"