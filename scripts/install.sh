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
DEFAULT_VERSION="0.6.7"

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
INSTALL_HOME=false
USE_EXISTING_DB=false
EXISTING_ENV_FILE=""

# ─── Env var fallback for non-interactive opt-in (Homebrew convention) ───────
if [[ "${NONINTERACTIVE:-0}" == "1" ]]; then
    NON_INTERACTIVE=true
fi

# NEURALGENTICS_ENV_FILE points --existing at a file. The flag itself
# always wins over the env var.
if [[ -z "$EXISTING_ENV_FILE" && -n "${NEURALGENTICS_ENV_FILE:-}" ]]; then
    EXISTING_ENV_FILE="$NEURALGENTICS_ENV_FILE"
fi

# ─── Logging ─────────────────────────────────────────────────────────────────

log()     { printf "[$APP] %s\n" "$*" >&2; }
warn()    { printf "[warn] %s\n" "$*" >&2; }
err()     { printf "[error] %s\n" "$*" >&2; }
verbose() { [[ "${VERBOSE}" == "true" ]] && log "$@" || true; }

run() {
    if $DRY_RUN; then
        printf "  [dry-run] %s\n" "$*" >&2
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
    --no-path               Don't modify shell rc files
    --no-verify             Skip SHA256 verification
    --dry-run               Show what would be done without executing
    --prefix <dir>          Install root (default: $PWD/.neuralgentics,
                            env: NEURALGENTICS_PREFIX)
    --home-dir              Install to \$HOME/.neuralgentics and symlink to
                            \$HOME/.local/bin/neuralgentics. Overrides --prefix.
    --existing [<file>]     Use an existing database. With no argument,
                            searches: \$PWD/.neuralgentics/.env, \$PWD/.env,
                            \$PREFIX/.env, \$PWD/../.env,
                            \$HOME/.neuralgentics/.env,
                            \$HOME/.config/neuralgentics/.env,
                            \$HOME/.local/share/neuralgentics/.env. With a
                            path, reads that file instead. The first file
                            with all 5 keys (POSTGRES_HOST, POSTGRES_PORT,
                            POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB)
                            wins. Skips container auto-start.
                            (env: NEURALGENTICS_ENV_FILE)
                            Sample template: scripts/.env.example in the repo.
    --version <v>           Version to install (default: ${DEFAULT_VERSION})
    --repo <owner/repo>     GitHub repo (default: auto-detect or
                            Veedubin/neuralgentics)

Environment variables (also honored):
    NONINTERACTIVE=1        Same as --yes
    NEURALGENTICS_PREFIX    Same as --prefix
    NEURALGENTICS_ENV_FILE  Path to an existing .env for --existing
                            (the flag argument, if any, wins)

Examples:
    $0                                          # interactive install (TTY)
    $0 --no-path                                # don't edit shell rc
    $0 --version 0.2.0                          # install specific version
    $0 --repo myorg/neuralgentics               # custom GitHub repo
    $0 --dry-run                                # preview without changes

  # Pipe form — note the 'bash -s --' before any flags. This tells bash
  # to read the script from stdin and pass everything after '--' to the
  # script as arguments. Without '-s --', bash interprets flags like
  # --existing as its own options, not the script's.
  #
  # CORRECT:  curl -fsSL .../install.sh | bash -s -- --home-dir
  # WRONG:    curl -fsSL .../install.sh | bash --home-dir  ← bash errors out
  #
    curl -fsSL .../install.sh | bash            # all defaults, no prompts
    curl -fsSL .../install.sh | bash -s -- --home-dir
    curl -fsSL .../install.sh | bash -s -- --existing
    curl -fsSL .../install.sh | bash -s -- --existing /path/to/your/.env
    curl -fsSL .../install.sh | bash -s -- --prefix /opt/neuralgentics
    curl -fsSL .../install.sh | bash -s -- --home-dir --existing

Note: \`curl ... | bash\` (no args) installs silently with all defaults to
\$PWD/.neuralgentics. To run unattended from a CI script with explicit
opt-in, pass --yes or set NONINTERACTIVE=1.
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
        --home-dir)
                           INSTALL_HOME=true; shift ;;
        --existing)
                           USE_EXISTING_DB=true
                           # Optional path: --existing <file> or --existing=<file>
                           if [[ -n "${2:-}" && "${2:-}" != -* ]]; then
                               EXISTING_ENV_FILE="$2"; shift 2
                           else
                               shift
                           fi
                           ;;
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

# ─── --home-dir handling ──────────────────────────────────────────────────────
# --home-dir sets PREFIX to $HOME/.neuralgentics and BIN_LINK_DIR to
# $HOME/.local/bin. This is the global install path (works for any
# user on the system). Overrides --prefix if both were passed.
#
# Inline real-HOME detection (detect_real_home is defined further down —
# bash resolves functions at call time, so we can't call it before its
# definition).
if $INSTALL_HOME; then
    _early_real_home="${HOME:-}"
    if [[ -z "$_early_real_home" ]]; then
        _early_real_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
    fi
    PREFIX="$_early_real_home/.neuralgentics"
    NEURALGENTICS_DATA_DIR="$_early_real_home/.local/share/neuralgentics"
    BIN_LINK_DIR="$_early_real_home/.local/bin"
    _PREFIX_EXPLICIT=true
fi

# ─── Non-interactive fallback ─────────────────────────────────────────────────
# If stdin is not a TTY (e.g. `curl ... | bash` or running under CI), the
# user can't actually answer prompts even if they want to. In that case we
# auto-accept all defaults and proceed — this is the Homebrew / Nix /
# rustup convention. The user ran a one-liner; they expect an install.
#
# This is safe because the default install location is now PWD-local
# ($PWD/.neuralgentics), so even a reflexive curl|bash doesn't pollute
# the user's $HOME.
#
# Two ways to opt into non-interactive mode explicitly:
#   --yes / --non-interactive flag (handled in arg parsing)
#   NONINTERACTIVE=1 env var (handled above, before this block)
if [[ ! -t 0 ]] && ! $NON_INTERACTIVE; then
    # No flag, no env var, but stdin is a pipe → assume one-liner install
    NON_INTERACTIVE=true
    log "stdin is not a TTY (e.g. curl|bash). Auto-accepting all defaults."
    log "To force a specific install path, re-run with: --prefix <dir> or --home-dir"
    log "To run interactively, save the script first: curl -fsSL .../install.sh -o install.sh && bash install.sh"
fi

# Resolve DATA_DIR and BIN_LINK_DIR from PREFIX early. If --home-dir or
# --prefix was passed, the PREFIX is already what the user wants. If neither
# was passed but we're non-interactive, use the default (PWD-local). If
# we're interactive, the values get refined later by prompt_install_location.
# In all cases, having correct values early means the banner, the .env
# checks, and the project registry all see the right paths from the start.
#
# Note: this is duplicated from _resolve_paths_from_prefix because that
# helper is defined further down the file. Bash resolves function calls
# at call time, not at parse time, so we can't call it before its
# definition. The duplication is small and stable.
if $NON_INTERACTIVE || [[ -n "${_PREFIX_EXPLICIT:-}" ]]; then
    # detect_real_home is defined further down too — same reason.
    # Inline a quick version: real HOME, handling sudo / unset HOME.
    _early_real_home="${HOME:-}"
    if [[ -z "$_early_real_home" ]]; then
        _early_real_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
    fi
    if [[ "$PREFIX" == "$_early_real_home/.neuralgentics" ]]; then
        NEURALGENTICS_DATA_DIR="$_early_real_home/.local/share/neuralgentics"
        BIN_LINK_DIR="$_early_real_home/.local/bin"
    else
        NEURALGENTICS_DATA_DIR="$PREFIX"
        BIN_LINK_DIR="$PREFIX/bin"
    fi
    export NEURALGENTICS_PREFIX="$PREFIX"
    export NEURALGENTICS_DATA_DIR
    INSTALL_BIN="$PREFIX/bin"
fi

# ─── Banner ──────────────────────────────────────────────────────────────────

print_banner() {
    printf "" >&2
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
    printf "" >&2
    printf "\n  HACK THE PLANET — neuralgentics v${VERSION}\n\n" >&2
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
        printf "⚠  WSL Detected — Windows Subsystem for Linux\n" >&2
        printf "   • Linux binaries work inside WSL\n" >&2
        printf "   • Add ~/.local/bin to your WSL shell rc, NOT Windows PATH\n" >&2
        printf "   • Windows paths from /mnt/c may have permission issues\n" >&2
        if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
            printf "   • Distro: %s\n" "$WSL_DISTRO_NAME" >&2
        fi
        # WSL1 vs WSL2
        if [[ -n "${WSL_INTEROP:-}" ]]; then
            printf "   • WSL2 detected (WSL_INTEROP set)\n" >&2
        else
            printf "   • WSL1 detected (no WSL_INTEROP)\n" >&2
        fi
        printf "   • For native Windows install, use install.ps1 in PowerShell\n" >&2
        printf "\n" >&2

        # Note: user can add ~/.local/bin to Windows PATH via:
        # wslpath -w ~/.local/bin → add to Windows PATH
        export WSL_MODE=true
    else
        export WSL_MODE=false
    fi
}

# ─── GPU detection ────────────────────────────────────────────────────────────

HAS_GPU=false

_detect_gpu() {
    # Check for NVIDIA GPU via nvidia-smi. This is the standard way to
    # detect CUDA-capable hardware on Linux. Also works in WSL2 with
    # NVIDIA's WSL driver. Falls back to checking for AMD ROCm via
    # rocminfo, and Intel via clinfo.
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
        HAS_GPU=true
        log "NVIDIA GPU detected — sidecar will use CUDA"
        return 0
    fi
    if command -v rocminfo >/dev/null 2>&1 && rocminfo >/dev/null 2>&1; then
        HAS_GPU=true
        log "AMD GPU detected (ROCm) — sidecar will use CPU (ROCm support pending)"
        return 0
    fi
    # Intel GPU detection via clinfo (OpenCL) — less common for ML but present
    if command -v clinfo >/dev/null 2>&1 && clinfo >/dev/null 2>&1 | grep -qi 'intel.*gpu'; then
        HAS_GPU=true
        log "Intel GPU detected — sidecar will use CPU (Intel support pending)"
        return 0
    fi
    HAS_GPU=false
    return 0  # never fail — HAS_GPU is the signal, not the exit code
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

    printf "\r%s%s %3d%%" "$filled" "$empty" "$percent" >&4
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
    :

    trap "trap - RETURN; rm -f \"$tracefile\"; exec 4>&-" RETURN

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
        printf "  [dry-run] curl -L -o %s %s\n" "$output" "$url" >&2
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
        printf "  [dry-run] sha256sum -c checksums.txt\n" >&2
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
            printf "  [dry-run] unzip -q %s -d %s%s\n" "$archive_path" "$target_dir" "$strip_opt" >&2
        else
            local strip_flag=""
            [[ "$strip_components" -gt 0 ]] && strip_flag=" --strip-components=$strip_components"
            printf "  [dry-run] tar -xzf %s -C %s%s\n" "$archive_path" "$target_dir" "$strip_flag" >&2
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
        printf "  [dry-run] chmod +x %s/bin/*\n" "$PREFIX" >&2
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
export NEURALGENTICS_ROOT="${PREFIX}"
ENVEOF
        verbose "Wrote install.env to $NEURALGENTICS_DATA_DIR/install.env"
    else
        printf "  [dry-run] write %s/install.env\n" "$NEURALGENTICS_DATA_DIR" >&2
    fi

    # Install OpenCode plugin dependencies. The archive bundles a
    # compiled overlay at node_modules/@neuralgentics/plugin/ and a
    # .opencode/package.json that references it via file: dependency.
    # npm install resolves both the npm-hosted @opencode-ai/plugin and
    # the local overlay symlink.
    if [[ -d "$PREFIX/.opencode" ]]; then
        if command -v npm >/dev/null 2>&1; then
            log "Installing OpenCode plugin dependencies..."
            if $DRY_RUN; then
                printf "  [dry-run] cd %s/.opencode && npm install\n" "$PREFIX" >&2
            else
                (cd "$PREFIX/.opencode" && npm install --no-audit --no-fund --quiet 2>&1) || \
                    warn "npm install failed — plugin may not load. Run 'cd $PREFIX/.opencode && npm install' manually."
            fi
        else
            warn "npm not found — OpenCode plugin dependencies not installed"
            warn "Install Node.js 20+ and run: cd $PREFIX/.opencode && npm install"
        fi
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
                printf "  [dry-run] ln -sf %s %s\n" "$target" "$link" >&2
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
    # EXCEPTION: if PREFIX is under $HOME (e.g. ~/.neuralgentics), always
    # add to PATH — the user ran the install from their home directory and
    # expects the binary to be globally available, not project-scoped.
    if [[ "$BIN_LINK_DIR" == "$INSTALL_BIN" ]] && [[ "$PREFIX" != "$HOME"/* ]]; then
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
                printf "  [dry-run] add_to_path %s fish_add_path %s\n" "$config_file" "$BIN_LINK_DIR" >&2
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
                printf "  [dry-run] add_to_path %s\n" "$config_file" >&2
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
                printf "  [dry-run] add_to_path %s\n" "$config_file" >&2
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
                printf "  [dry-run] add_to_path %s\n" "$config_file" >&2
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
            printf "  [dry-run] echo %s >> \$GITHUB_PATH\n" "$BIN_LINK_DIR" >&2
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
            printf "  ✓ %-30s %s\n" "$label" "$path" >&2
        else
            printf "  ✗ %-30s %s\n" "$label" "$path" >&2
            errors=$((errors + 1))
        fi
    done

    # TUI binary: executable + size check (TUI has no --version mode; running it
    # would open a full TUI render and hang the install script forever — Bug #6)
    if [[ -x "$INSTALL_BIN/neuralgentics" ]]; then
        local tui_size
        tui_size=$(stat -c '%s' "$INSTALL_BIN/neuralgentics" 2>/dev/null || stat -f '%z' "$INSTALL_BIN/neuralgentics" 2>/dev/null || echo 0)
        if [[ "$tui_size" -gt 50000000 ]]; then
            printf "  ✓ %-30s %s (%d bytes)\n" "TUI binary" "$INSTALL_BIN/neuralgentics" "$tui_size" >&2
        else
            printf "  ✗ %-30s %s (suspiciously small: %d bytes)\n" "TUI binary" "$INSTALL_BIN/neuralgentics" "$tui_size" >&2
            errors=$((errors + 1))
        fi
    fi

    if [[ -x "$INSTALL_BIN/neuralgentics-backend" ]]; then
        local bout
        bout="$("$INSTALL_BIN/neuralgentics-backend" --version 2>/dev/null || true)"
        if [[ -n "$bout" ]]; then
            printf "  ✓ %-30s %s\n" "backend --version" "$bout" >&2
        else
            printf "  ✓ %-30s %s\n" "backend binary" "executable" >&2
        fi
    fi

    log ""
    if [[ $errors -eq 0 ]]; then
        printf "✅ All systems ready\n" >&2
    else
        printf "❌ %s verification check(s) failed\n" "$errors" >&2
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
    local real_home
    real_home="$(detect_real_home)"

    # If the user passed a flag (--prefix, --home-dir) or is running
    # non-interactively (--yes, NONINTERACTIVE=1, curl|bash), don't prompt.
    # Just derive DATA_DIR and BIN_LINK_DIR from the PREFIX we already have.
    if $NON_INTERACTIVE || [[ -n "${_PREFIX_EXPLICIT:-}" ]]; then
        _resolve_paths_from_prefix "$real_home"
        return 0
    fi

    # Interactive: prompt the user.
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
    printf "Where should Neuralgentics install?\n" >&2
    printf "  1) Local to this project (%s) <-- default\n" "$PWD" >&2
    printf "  2) Home directory (%s)\n" "$real_home" >&2
    printf "  3) Custom path\n" >&2

    if $wsl_flag; then
        printf "\n  ⚠  WSL detected — install paths must stay inside the Linux distro (no /mnt/c)\n" >&2
    fi

    while true; do
        printf "Choice [1/2/3] (default: 1): " >&2
        local choice
        # Interactive: a closed stdin (Ctrl+D) means the user walked away —
        # abort. Enter accepts the default. Anything else loops for a valid answer.
        if ! read -r choice; then
            printf "\n" >&2
            err "No input received (stdin closed?). Aborting."
            exit 1
        fi
        [[ -z "$choice" ]] && choice="1"

        case "$choice" in
            1)
                PREFIX="$PWD/.neuralgentics"
                _PREFIX_EXPLICIT=true
                _resolve_paths_from_prefix "$real_home"
                ;;
            2)
                PREFIX="$real_home/.neuralgentics"
                _PREFIX_EXPLICIT=true
                _resolve_paths_from_prefix "$real_home"
                ;;
            3)
                printf "Enter custom path: " >&2
                local custom_path
                if ! read -r custom_path; then
                    err "No input received. Aborting."
                    exit 1
                fi
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
                    if ! read -r mnt_answer; then
                        err "No input received. Aborting."
                        exit 1
                    fi
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
                _PREFIX_EXPLICIT=true
                _resolve_paths_from_prefix "$real_home"
                ;;
            *)
                err "Invalid choice. Enter 1, 2, or 3."
                continue
                ;;
        esac
        break
    done

    log "Install prefix:  $PREFIX"
    log "Data directory:  $NEURALGENTICS_DATA_DIR"
    log "Bin link dir:    $BIN_LINK_DIR"
    return 0
}

# Derive NEURALGENTICS_DATA_DIR and BIN_LINK_DIR from PREFIX. Used by
# prompt_install_location and the arg-parsing branches. Logic:
#   PREFIX == $PWD/.neuralgentics  → data + bin in PREFIX (project-local)
#   PREFIX == $HOME/.neuralgentics → data in ~/.local/share, bin in ~/.local/bin
#   anything else                  → data + bin in PREFIX (custom)
# The second arg is the user's real HOME (handles sudo / unset HOME).
_resolve_paths_from_prefix() {
    local real_home="$1"
    if [[ "$PREFIX" == "$PWD/.neuralgentics" ]]; then
        NEURALGENTICS_DATA_DIR="$PREFIX"
        BIN_LINK_DIR="$PREFIX/bin"
    elif [[ "$PREFIX" == "$real_home/.neuralgentics" ]]; then
        NEURALGENTICS_DATA_DIR="$real_home/.local/share/neuralgentics"
        BIN_LINK_DIR="$real_home/.local/bin"
    else
        # Custom path — keep data + bin in PREFIX
        NEURALGENTICS_DATA_DIR="$PREFIX"
        BIN_LINK_DIR="$PREFIX/bin"
    fi
    export NEURALGENTICS_PREFIX="$PREFIX"
    export NEURALGENTICS_DATA_DIR
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
    local env_file="$NEURALGENTICS_DATA_DIR/.env"

    # --existing flag: find a valid .env somewhere we recognize. If
    # EXISTING_ENV_FILE was set (--existing /path or NEURALGENTICS_ENV_FILE),
    # use that path first. Then check the canonical install location.
    # Then search the same fallback list that _recover_container_creds uses
    # (home-dir XDG locations). The first file that passes the 5-key
    # validator wins; we copy it into the canonical location so the TUI
    # resolver and the running backend both know where to look.
    if $USE_EXISTING_DB; then
        local found_env=""
        local search_paths=()

        # 1. Explicit path from flag or env var
        if [[ -n "$EXISTING_ENV_FILE" ]]; then
            search_paths+=("$EXISTING_ENV_FILE")
        fi

        # 2. Canonical install location
        search_paths+=("$env_file")

        # 3. Same fallbacks as _recover_container_creds, plus the
        # project root (where users naturally drop a .env next to the
        # project they ran the install from). Dedupe against anything
        # already in search_paths so the error message doesn't show
        # the same path twice.
        local fallback
        for fallback in \
            "$PWD/.env" \
            "$PREFIX/.env" \
            "$PWD/../.env" \
            "$HOME/.neuralgentics/.env" \
            "$HOME/.config/neuralgentics/.env" \
            "$HOME/.local/share/neuralgentics/.env"
        do
            local dup=false
            local existing
            for existing in "${search_paths[@]}"; do
                if [[ "$existing" == "$fallback" ]]; then
                    dup=true
                    break
                fi
            done
            $dup || search_paths+=("$fallback")
        done

        local spath
        for spath in "${search_paths[@]}"; do
            [[ -z "$spath" ]] && continue
            if _env_file_valid "$spath"; then
                found_env="$spath"
                break
            fi
        done

        if [[ -n "$found_env" ]]; then
            if [[ "$found_env" != "$env_file" ]]; then
                # Copy the user-provided .env to the canonical location so
                # the TUI resolver, the running backend, and the project
                # registry all see the same file. chmod 600 — it contains
                # a password.
                if $DRY_RUN; then
                    printf "  [dry-run] cp %s %s && chmod 600 %s\n" \
                        "$found_env" "$env_file" "$env_file" >&2
                else
                    mkdir -p "$NEURALGENTICS_DATA_DIR"
                    cp "$found_env" "$env_file"
                    chmod 600 "$env_file"
                fi
                log "Adopted existing database config from $found_env"
                log "  (copied to $env_file)"
            else
                log "Using existing database from $env_file (--existing)"
            fi
            return 0
        fi

        # Nothing found — list what we looked at so the user can fix it
        err "--existing was passed but no valid .env file was found."
        err "It must contain all 5 keys: POSTGRES_HOST, POSTGRES_PORT,"
        err "POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB"
        err ""
        err "Searched these locations:"
        local spath
        for spath in "${search_paths[@]}"; do
            [[ -z "$spath" ]] && continue
            if [[ -e "$spath" ]]; then
                err "  ✗ $spath  (exists but failed validation)"
            else
                err "  · $spath  (not found)"
            fi
        done
        err ""
        err "Fix one of these:"
        err "  1) Point --existing at your file: --existing /path/to/.env"
        err "  2) Set NEURALGENTICS_ENV_FILE=/path/to/.env in the env"
        err "  3) Copy the sample template and edit it:"
        err "     cp scripts/.env.example $env_file"
        err "     \$EDITOR $env_file"
        return 1
    fi

    # Step 1: If .env already exists with valid config, return immediately.
    # This must come BEFORE the TTY guard so curl | bash re-runs work.
    if _env_file_valid "$env_file"; then
        log "Database already configured. Details in $env_file"
        return 0
    fi

    # Step 2: Detect a container runtime. Prefer docker (broader install base);
    # fall back to podman. Both are interchangeable for our purposes.
    if ! _detect_container_runtime; then
        err "Neither docker nor podman was found on this system."
        err "Install one first:"
        err "  https://docs.docker.com/get-docker/"
        err "  https://podman.io/getting-started/installation"
        err ""
        err "Or re-run with --existing if you have your own database:"
        err "  bash install.sh --existing"
        return 1
    fi

    # Step 3: Try to recover credentials from an existing container before
    # falling back to the TTY prompt. This handles the "existing container +
    # no .env" re-install case.
    local container_name="neuralgentics-pg"
    if $CONTAINER_CMD inspect "$container_name" >/dev/null 2>&1; then
        local state
        state="$($CONTAINER_CMD inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null || echo "false")"
        if [[ "$state" != "true" ]]; then
            log "Container '$container_name' exists but is stopped. Starting it..."
            if ! $DRY_RUN; then
                if ! $CONTAINER_CMD start "$container_name" >/dev/null 2>&1; then
                    warn "Failed to start existing container '$container_name' — will create a fresh one"
                fi
            fi
        fi
        if $CONTAINER_CMD inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
            if _recover_container_creds "$container_name"; then
                return 0
            fi
        fi
    fi

    # Non-interactive: default to starting a fresh container with an
    # auto-generated password. This makes `curl ... | bash` just work.
    if $NON_INTERACTIVE; then
        _start_fresh_db
        return $?
    fi

    # Interactive: ask the user.
    printf '\n' >&2
    printf "Neuralgentics needs a PostgreSQL database with the pgvector extension.\n" >&2

    while true; do
        printf "Start one now using %s? [Y/n] (default: Y): " "$CONTAINER_CMD" >&2
        local answer
        if ! read -r answer; then
            err "No input received. Aborting."
            exit 1
        fi

        if [[ -z "$answer" || "$answer" =~ ^[Yy] ]]; then
            _start_fresh_db
            return $?
        fi

        if [[ "$answer" =~ ^[Nn]$ ]]; then
            break
        fi
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
        if ! read -r sub_choice; then
            err "No input received. Aborting."
            exit 1
        fi
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

# Check if a .env file exists and contains all 5 required DB keys.
# Returns 0 (true) if valid, 1 (false) otherwise. Does not print anything.
_env_file_valid() {
    local env_file="$1"
    [[ -f "$env_file" ]] || return 1
    local key
    for key in POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
        grep -q "^${key}=" "$env_file" 2>/dev/null || return 1
    done
    return 0
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
                printf "  [dry-run] %s start %s\n" "$CONTAINER_CMD" "$container_name" >&2
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
                printf "  [dry-run] openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 365 -nodes -subj '/CN=neuralgentics'\n" \
                    "$ssl_key" "$ssl_cert" >&2
                printf "  [dry-run] chmod 600 %s && chmod 644 %s\n" "$ssl_key" "$ssl_cert" >&2
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
                printf "  [dry-run] %s run -d --name %s -e POSTGRES_USER=%s -e POSTGRES_PASSWORD=*** -e POSTGRES_DB=%s -p %s:5432 -v %s:/var/lib/postgresql/server.crt:z -v %s:/var/lib/postgresql/server.key:z docker.io/pgvector/pgvector:pg18 bash -c 'chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'\n" \
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
    local db_password=""
    if ! read -r db_password; then
        err "No input received. Aborting."
        exit 1
    fi
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

    # These 4 fields have sensible defaults. If the user just hits Enter we
    # accept the default. But if EOF/no-TTY, we ABORT — never silently
    # silently pick a default for an install op.
    printf "  Host [127.0.0.1]: " >&2
    if ! read -r db_host; then
        err "No input received. Aborting."
        exit 1
    fi
    [[ -z "$db_host" ]] && db_host="127.0.0.1"

    printf "  Port [5432]: " >&2
    if ! read -r db_port; then
        err "No input received. Aborting."
        exit 1
    fi
    [[ -z "$db_port" ]] && db_port="5432"

    printf "  User [postgres]: " >&2
    if ! read -r db_user; then
        err "No input received. Aborting."
        exit 1
    fi
    [[ -z "$db_user" ]] && db_user="postgres"

    # Password MUST be entered — no default, no EOF fallback.
    printf "  Password (hidden): " >&2
    if ! read -rs db_password; then
        printf '\n' >&2
        err "No input received. Aborting."
        exit 1
    fi
    printf '\n' >&2
    if [[ -z "$db_password" ]]; then
        err "Password cannot be empty"
        return 1
    fi

    printf "  Database [neuralgentics]: " >&2
    if ! read -r db_name; then
        err "No input received. Aborting."
        exit 1
    fi
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
        printf "  ✓ Database connection verified.\n" >&2
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
        local env_file_path=""
        if ! read -r env_file_path; then
            err "No input received. Aborting."
            exit 1
        fi

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
                printf "  ✓ Database connection verified.\n" >&2
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
        printf "\nRegister this directory as a project? [%s] [Y/n]: " "$project_name" >&2
        local answer=""
        if ! read -r answer; then
            err "No input received. Aborting."
            exit 1
        fi
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
        printf "  [dry-run] register_project: name=%s path=%s default=%s\n" "$project_name" "$project_dir" "$is_default" >&2
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

    # Symlink .opencode/ from the install prefix into the project root.
    # OpenCode reads .opencode/opencode.json from the directory where it's
    # launched (the project root). The self-contained install puts all
    # agent config in $PREFIX/.opencode/. This symlink makes it available
    # in every registered project without copying files.
    #
    # If a real directory already exists at the target (e.g. from a prior
    # manual setup), back it up as .opencode.bak-<timestamp> and force the
    # symlink. The user needs the canonical config, not a stale copy.
    local project_opencode="$project_dir/.opencode"
    local prefix_opencode="$PREFIX/.opencode"
    if [[ -d "$prefix_opencode" ]]; then
        if [[ -e "$project_opencode" && ! -L "$project_opencode" ]]; then
            local backup="$project_dir/.opencode.bak-$(date +%Y%m%d-%H%M%S)"
            if $DRY_RUN; then
                printf "  [dry-run] mv %s %s\n" "$project_opencode" "$backup" >&2
            else
                mv "$project_opencode" "$backup"
                log "Backed up existing .opencode/ to $backup"
            fi
        fi
        if $DRY_RUN; then
            printf "  [dry-run] ln -sf %s %s\n" "$prefix_opencode" "$project_opencode" >&2
        else
            ln -sf "$prefix_opencode" "$project_opencode"
            log "Symlinked $project_opencode -> $prefix_opencode"
        fi
    fi
}

# ─── OpenCode runtime ──────────────────────────────────────────────────────────
# neuralgentics spawns opencode internally via the SDK. The user never runs
# 'opencode' directly — they run 'neuralgentics'. But the opencode binary
# must be on PATH for the TUI to spawn it. Download it from GitHub releases
# into $PREFIX/bin/ alongside neuralgentics.

_install_opencode() {
    # Already installed? Check both the install prefix and system PATH.
    if command -v opencode >/dev/null 2>&1; then
        log "OpenCode runtime already on PATH ($(opencode --version 2>/dev/null || echo 'unknown'))"
        return 0
    fi
    if [[ -x "$PREFIX/bin/opencode" ]]; then
        log "OpenCode runtime already in $PREFIX/bin/"
        return 0
    fi

    log "Installing OpenCode runtime (required by neuralgentics TUI)..."

    # Map our OS/arch to opencode's release naming
    local oc_os oc_arch
    case "$DETECTED_OS" in
        linux)   oc_os="linux" ;;
        darwin)  oc_os="mac" ;;
        *)       warn "Unsupported OS for opencode: $DETECTED_OS — install manually"; return 0 ;;
    esac
    case "$DETECTED_ARCH" in
        amd64|x86_64) oc_arch="x86_64" ;;
        arm64|aarch64) oc_arch="arm64" ;;
        *)            warn "Unsupported arch for opencode: $DETECTED_ARCH — install manually"; return 0 ;;
    esac

    local oc_version="0.0.55"  # latest stable as of 2026-06-18
    local oc_archive="opencode-${oc_os}-${oc_arch}.tar.gz"
    local oc_url="https://github.com/opencode-ai/opencode/releases/download/v${oc_version}/${oc_archive}"

    if $DRY_RUN; then
        printf "  [dry-run] download %s → %s/bin/opencode\n" "$oc_url" "$PREFIX" >&2
        return 0
    fi

    local tmp_dir="${TMPDIR:-/tmp}/opencode_install_$$"
    mkdir -p "$tmp_dir"
    local oc_path="$tmp_dir/$oc_archive"

    log "Downloading $oc_archive..."
    if ! curl -fsSL "$oc_url" -o "$oc_path" 2>/dev/null; then
        warn "Failed to download opencode from $oc_url"
        warn "Install manually: curl -fsSL https://opencode.ai/install.sh | bash"
        rm -rf "$tmp_dir"
        return 0
    fi

    # Extract — the archive contains a single 'opencode' binary at the root
    tar -xzf "$oc_path" -C "$tmp_dir" opencode 2>/dev/null
    if [[ -f "$tmp_dir/opencode" ]]; then
        chmod +x "$tmp_dir/opencode"
        mv "$tmp_dir/opencode" "$PREFIX/bin/opencode"
        log "OpenCode runtime installed to $PREFIX/bin/opencode"
    else
        warn "opencode binary not found in archive — install manually"
    fi

    rm -rf "$tmp_dir"
}

# ─── Sidecar auto-setup ────────────────────────────────────────────────────────
# When a GPU is detected, download the embedding sidecar source files,
# create a Python venv, install dependencies, and pre-download the
# BGE-Large model. The sidecar is NOT started — it's just made ready
# so the user can launch it with a single command.

SIDECAR_READY=false

_setup_sidecar() {
    if ! $HAS_GPU; then
        log "No GPU detected — skipping sidecar setup (memory ops use noop embeddings)"
        return 0
    fi

    local sidecar_dir="$NEURALGENTICS_DATA_DIR/sidecar"
    local raw_base="https://raw.githubusercontent.com/${REPO}/main/packages/memory/cmd/embedding-sidecar"

    log "Setting up embedding sidecar (BGE-Large, CUDA)..."

    if $DRY_RUN; then
        printf "  [dry-run] mkdir -p %s\n" "$sidecar_dir" >&2
        printf "  [dry-run] download sidecar source files from %s\n" "$raw_base" >&2
        printf "  [dry-run] python3 -m venv %s/.venv\n" "$sidecar_dir" >&2
        printf "  [dry-run] pip install sentence-transformers torch grpcio\n" >&2
        printf "  [dry-run] pre-download BAAI/bge-large-en-v1.5 model\n" >&2
        SIDECAR_READY=true
        return 0
    fi

    # Check for Python 3
    local python_bin
    python_bin="$(command -v python3 || command -v python || true)"
    if [[ -z "$python_bin" ]]; then
        warn "Python 3 not found — skipping sidecar setup"
        warn "Install Python 3.10+ and re-run the installer to enable embeddings"
        return 0
    fi

    mkdir -p "$sidecar_dir/embedding_sidecar/proto/embedding/v1"

    # Download sidecar source files from the repo's raw GitHub URL.
    # These are small text files — no binary blobs.
    local files=(
        "main.py"
        "requirements.txt"
        "embedding_sidecar/__init__.py"
        "embedding_sidecar/embed.py"
        "embedding_sidecar/health.py"
        "embedding_sidecar/server.py"
        "embedding_sidecar/proto/__init__.py"
        "embedding_sidecar/proto/embedding/__init__.py"
        "embedding_sidecar/proto/embedding/v1/__init__.py"
        "embedding_sidecar/proto/embedding/v1/embedding_pb2.py"
        "embedding_sidecar/proto/embedding/v1/embedding_pb2_grpc.py"
    )

    local dl_errors=0
    local f
    for f in "${files[@]}"; do
        if ! curl -fsSL "$raw_base/$f" -o "$sidecar_dir/$f" 2>/dev/null; then
            warn "Failed to download sidecar file: $f"
            dl_errors=$((dl_errors + 1))
        fi
    done

    if [[ $dl_errors -gt 0 ]]; then
        warn "$dl_errors sidecar file(s) failed to download — sidecar may not work"
        warn "You can re-run the installer later to retry, or clone the repo manually"
    fi

    # Create Python virtual environment
    if ! "$python_bin" -m venv "$sidecar_dir/.venv" 2>/dev/null; then
        warn "Failed to create sidecar venv — ensure python3-venv is installed"
        warn "  Debian/Ubuntu: apt-get install python3-venv"
        warn "  Fedora/RHEL:   dnf install python3-venv"
        return 0
    fi

    local pip_bin="$sidecar_dir/.venv/bin/pip"
    local python_venv="$sidecar_dir/.venv/bin/python"

    # Install Python dependencies
    log "Installing sidecar Python dependencies (sentence-transformers, torch, grpcio)..."
    if ! "$pip_bin" install -r "$sidecar_dir/requirements.txt" --quiet 2>&1; then
        warn "pip install failed — sidecar dependencies may be incomplete"
        warn "Check $sidecar_dir/requirements.txt and re-run the installer"
        return 0
    fi

    # Pre-download the BGE-Large model (~1.3 GB). This is the slowest step —
    # the model is downloaded from HuggingFace and cached in ~/.cache/torch/.
    # We do this now so the first sidecar start is instant.
    log "Pre-downloading BGE-Large model (BAAI/bge-large-en-v1.5, ~1.3 GB)..."
    log "  This may take a few minutes on first run. Subsequent runs use the cache."
    if "$python_venv" -c "
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('BAAI/bge-large-en-v1.5', device='cuda')
# Run a tiny inference to warm up the model and verify it works
_ = model.encode('neuralgentics ready', convert_to_numpy=True)
print('BGE-Large model loaded and verified on CUDA')
" 2>&1; then
        log "BGE-Large model downloaded and verified"
    else
        warn "BGE-Large model download failed — sidecar will start but may fail on first request"
        warn "Check disk space (~2 GB free needed) and network connectivity"
        return 0
    fi

    # Write sidecar config to install.env so the backend knows where to find it
    cat >> "$NEURALGENTICS_DATA_DIR/install.env" <<ENVEOF

# Embedding sidecar — auto-configured by installer
# Start with: $sidecar_dir/.venv/bin/python $sidecar_dir/main.py &
export MEMINI_EMBEDDING_ADDR="unix:///tmp/neuralgentics-embed.sock"
export EMBEDDING_MODE="auto"
export NEURALGENTICS_EMBED_DEVICE="cuda"
ENVEOF

    SIDECAR_READY=true
    log "Sidecar ready (BGE-Large, CUDA) — start with: neuralgentics-sidecar start"
    log "  Config written to $NEURALGENTICS_DATA_DIR/install.env"
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
    _detect_gpu

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

    # 7.5. OpenCode runtime — neuralgentics spawns opencode internally via
    #      the SDK. Download it from GitHub releases into $PREFIX/bin/ so
    #      it's always available alongside neuralgentics.
    _install_opencode

    # 8. PATH setup
    setup_path

    # 9. Interactive prompt: database (after install, before verification).
    #    If this returns non-zero (e.g. --existing was passed but .env is
    #    missing, or no container runtime was found), abort the install.
    if ! prompt_database; then
        err "Database setup failed. Install aborted."
        exit 1
    fi

    # 10. Register project directory
    register_project

    # 10.5. Sidecar auto-setup (GPU only — downloads BGE-Large model)
    _setup_sidecar

    # 11. Verify
    verify_install

    # 12. Cleanup
    if ! $DRY_RUN && [[ -d "$tmp_dir" ]]; then
        rm -rf "$tmp_dir"
    fi

    # Success!
    cat <<EOF >&2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HACK THE PLANET! — neuralgentics v${VERSION} installed

  Quick start:
    neuralgentics                # Launch the TUI
    neuralgentics --help         # Show commands
    neuralgentics status         # Check component status

   Install root:  ${PREFIX}
   Data dir:      ${NEURALGENTICS_DATA_DIR}
   Binary link:   ${BIN_LINK_DIR}/neuralgentics
   Env:           source ${NEURALGENTICS_DATA_DIR}/install.env
EOF

    # Show .env path if database was configured
    if [[ -f "$NEURALGENTICS_DATA_DIR/.env" ]]; then
        printf "  DB config:      %s/.env\n" "$NEURALGENTICS_DATA_DIR" >&2
    fi

    # Show registered projects count
    local project_count=0
    local registry_file
    registry_file="$(_projects_registry_path)"
    if [[ -f "$registry_file" ]]; then
        project_count="$(grep -c '^\[\[project\]\]' "$registry_file" 2>/dev/null || echo 0)"
        if [[ "$project_count" -gt 0 ]]; then
            printf "  Projects:      %d registered (%s)\n" "$project_count" "$registry_file" >&2
        fi
    fi

    if [[ "${WSL_MODE:-}" == "true" ]]; then
        printf "  WSL note:     Add ~/.local/bin to your WSL shell rc\n" >&2
    fi

    # Sidecar status
    if $SIDECAR_READY; then
        printf "  Sidecar:      ready (BGE-Large, CUDA) — start with: neuralgentics-sidecar start\n" >&2
    else
        printf "  Sidecar:      not configured (no GPU detected)\n" >&2
        printf "                Memory operations use noop embeddings.\n" >&2
        printf "                To enable later: clone the repo and run scripts/sidecar.sh start\n" >&2
    fi

    cat <<EOF >&2
  Docs:          https://github.com/${REPO}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF

    # ── Activation ─────────────────────────────────────────────────────
    # The .opencode/ config (agent personas, skills, MCP servers) lives in
    # the install prefix. The TUI auto-detects it on startup — no manual
    # symlink needed. For explicit setup, run 'neuralgentics init'.
    echo "" >&2
    printf "  To activate in a project:\n" >&2
    printf "    cd your-project && neuralgentics init && neuralgentics\n" >&2
    printf "  (The TUI auto-links .opencode/ on startup — 'init' is optional)\n" >&2
    echo "" >&2
}

main "$@"