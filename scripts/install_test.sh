#!/usr/bin/env bash
# scripts/install_test.sh — smoke tests for scripts/install.sh flag handling.
#
# Sources install.sh's argument parser indirectly by running it with --help and
# --dry-run, then greps the output for expected strings. No real install is
# performed; no network is used. Safe to run in CI.
#
# Usage:
#   bash scripts/install_test.sh
#   bash scripts/install_test.sh --verbose
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

PASS=0
FAIL=0

assert_contains() {
    # assert_contains <label> <needle> <haystack-file-or-string>
    local label="$1" needle="$2" haystack="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        PASS=$((PASS+1))
        $VERBOSE && echo "PASS  $label" >&2
    else
        FAIL=$((FAIL+1))
        echo "FAIL  $label" >&2
        echo "      expected to contain: $needle" >&2
    fi
}

main() {
    # Sanity: install.sh exists and is syntactically valid.
    if [[ ! -f "$INSTALL_SH" ]]; then
        echo "FATAL: $INSTALL_SH not found" >&2
        exit 2
    fi
    if ! bash -n "$INSTALL_SH"; then
        echo "FATAL: $INSTALL_SH has syntax errors" >&2
        exit 2
    fi

    local help_out
    help_out="$(bash "$INSTALL_SH" --help 2>&1)"

    # ── Help-text assertions ────────────────────────────────────────────────
    assert_contains "help mentions --with-gateway"        "--with-gateway"      "$help_out"
    assert_contains "help mentions --gateway-only"         "--gateway-only"     "$help_out"
    assert_contains "help mentions --gateway-version="    "--gateway-version=" "$help_out"
    assert_contains "help mentions --uninstall-gateway"    "--uninstall-gateway" "$help_out"
    assert_contains "help mentions go install"             "go install"         "$help_out"
    assert_contains "help mentions neuralgentics-gateway" "neuralgentics-gateway" "$help_out"

    # ── Dry-run assertions ──────────────────────────────────────────────────
    local gw_only_dry
    gw_only_dry="$(bash "$INSTALL_SH" --gateway-only --dry-run --yes 2>&1)"
    assert_contains "gateway-only dry-run mentions go install" \
        "GO111MODULE=on go install github.com/Veedubin/neuralgentics-gateway/cmd/egress@latest" \
        "$gw_only_dry"
    assert_contains "gateway-only dry-run mentions egress-gateway.yaml" \
        "egress-gateway.yaml" "$gw_only_dry"

    # --with-gateway --dry-run should also surface the gateway install
    local with_gw_dry
    with_gw_dry="$(bash "$INSTALL_SH" --with-gateway --dry-run --yes 2>&1)"
    assert_contains "with-gateway dry-run mentions go install" \
        "GO111MODULE=on go install github.com/Veedubin/neuralgentics-gateway/cmd/egress@latest" \
        "$with_gw_dry"

    # --uninstall-gateway --dry-run should mention removing the binary
    local uninstall_dry
    uninstall_dry="$(bash "$INSTALL_SH" --uninstall-gateway --dry-run --yes 2>&1)"
    assert_contains "uninstall-gateway dry-run mentions /bin/egress" \
        "/bin/egress" "$uninstall_dry"
    assert_contains "uninstall-gateway dry-run preserves config" \
        "config + data left intact" "$uninstall_dry"

    # --gateway-version pinning should propagate to the go install line
    local pinned
    pinned="$(bash "$INSTALL_SH" --gateway-only --dry-run --yes --gateway-version=v0.1.0 2>&1)"
    assert_contains "gateway-version pin shows in go install line" \
        "neuralgentics-gateway/cmd/egress@v0.1.0" "$pinned"

    # Summary
    echo "" >&2
    echo "Results: $PASS passed, $FAIL failed" >&2
    if [[ "$FAIL" -gt 0 ]]; then
        exit 1
    fi
    exit 0
}

main "$@"