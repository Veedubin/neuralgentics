#!/usr/bin/env bash
# Extract packages/web from the neuralgentics monorepo into a standalone
# GitHub repo, preserving full git history of the web subtree.
#
# Usage:
#   ./scripts/extract-web.sh <target-repo-name>
#
# Example:
#   ./scripts/extract-web.sh neuralgentics-web
#
# What this does:
#   1. Checks for `git filter-repo` (prints install hint if missing).
#   2. Clones the neuralgentics monorepo to /tmp/neuralgentics-extract-<name>.
#   3. Runs `git filter-repo --subdirectory-filter packages/web` to rewrite
#      history down to just that subtree (web files become the repo root,
#      full commit history preserved).
#   4. Copies scaffolding files (README.md, LICENSE, .github/workflows/ci.yml,
#      .gitignore) into the filtered repo. If web already had its own
#      README.md (it does — it was a package in the monorepo), the old file
#      is backed up to README.monorepo.md so the new standalone scaffolding
#      wins. The web package did NOT have its own LICENSE or .gitignore, so
#      those are written fresh.
#   5. Sets `origin` to git@github.com:Veedubin/<name>.git.
#   6. Prints exact next-step instructions. DOES NOT push.
#
# This script does NOT modify the original monorepo. It works on a temp
# clone, so the monorepo's working tree and history are untouched.
#
# Idempotent: the temp dir is rm -rf'd before each run.

set -euo pipefail

# --- args + defaults -------------------------------------------------------

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <target-repo-name>" >&2
    echo "Example: $0 neuralgentics-web" >&2
    exit 2
fi

TARGET_NAME="$1"
MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBDIR="packages/web"
SCAFFOLD_DIR="${MONOREPO_ROOT}/scripts/scaffolding/web"
REMOTE_URL="git@github.com:Veedubin/${TARGET_NAME}.git"
TMP_DIR="/tmp/neuralgentics-extract-${TARGET_NAME}"

# --- helpers ---------------------------------------------------------------

log() { printf '\033[1;34m[extract-web]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[extract-web ERROR]\033[0m %s\n' "$*" >&2; }

# --- preflight -------------------------------------------------------------

# 1. git filter-repo must be available. We accept either the standalone
#    `git filter-repo` subcommand or the `python3 -m git_filter_repo` module.
if ! git filter-repo --version >/dev/null 2>&1 \
   && ! python3 -m git_filter_repo --version >/dev/null 2>&1; then
    err "git filter-repo is not installed."
    echo "Install one of:"
    echo "  pip install git-filter-repo      # makes the 'git filter-repo' subcommand available"
    echo "  brew install git-filter-repo"
    echo "  apt install git-filter-repo"
    echo
    echo "After installing, re-run this script."
    exit 1
fi

# Pick the invocation that works.
filter_repo_cmd=(git filter-repo)
if ! git filter-repo --version >/dev/null 2>&1; then
    filter_repo_cmd=(python3 -m git_filter_repo)
fi

# 2. Monorepo + scaffolding must exist.
if [[ ! -d "${MONOREPO_ROOT}/${SUBDIR}" ]]; then
    err "Subdirectory not found: ${MONOREPO_ROOT}/${SUBDIR}"
    exit 1
fi
if [[ ! -d "${SCAFFOLD_DIR}" ]]; then
    err "Scaffolding dir not found: ${SCAFFOLD_DIR}"
    exit 1
fi

# --- main ------------------------------------------------------------------

log "Target repo:  ${TARGET_NAME}"
log "Monorepo:     ${MONOREPO_ROOT}"
log "Subdirectory: ${SUBDIR}"
log "Remote URL:   ${REMOTE_URL}"
log "Temp dir:     ${TMP_DIR}"

# Idempotent: clean any previous temp clone.
if [[ -d "${TMP_DIR}" ]]; then
    log "Removing existing temp dir: ${TMP_DIR}"
    rm -rf "${TMP_DIR}"
fi

# 3. Clone the monorepo (full history — filter-repo needs the real objects).
log "Cloning monorepo to ${TMP_DIR} ..."
git clone --no-local "${MONOREPO_ROOT}" "${TMP_DIR}"

# 4. Rewrite history down to the web subtree.
log "Running git filter-repo --subdirectory-filter ${SUBDIR} ..."
(
    cd "${TMP_DIR}"
    "${filter_repo_cmd[@]}" --subdirectory-filter "${SUBDIR}"
)

# filter-repo removes the `origin` remote by design. The temp clone's
# history now only contains commits that touched packages/web, and the web
# files are now at the repo root.

# 5. Copy scaffolding into the filtered repo.
#    For files that survived the filter, back them up to <file>.monorepo.<ext>
#    so the new standalone scaffolding wins. Files that did NOT exist in the
#    subtree (LICENSE, .gitignore, .github/workflows/ci.yml) are written fresh.

log "Copying scaffolding into filtered repo ..."

backup_if_exists() {
    # backup_if_exists <scaffold-relative-dest> <backup-name>
    local dest="$1"
    local backup="$2"
    if [[ -f "${dest}" ]]; then
        log "  Backing up existing ${dest} -> ${backup}"
        mv "${dest}" "${backup}"
    fi
}

# README.md — web already has a README. Back it up, install the new
# standalone one.
backup_if_exists "${TMP_DIR}/README.md" "README.monorepo.md"
install -m 0644 "${SCAFFOLD_DIR}/README.md" "${TMP_DIR}/README.md"

# LICENSE — web does NOT have its own LICENSE (uses the monorepo root one).
# Install the standalone MIT scaffolding fresh.
install -m 0644 "${SCAFFOLD_DIR}/LICENSE" "${TMP_DIR}/LICENSE"

# .gitignore — web does NOT have its own .gitignore. Install fresh.
install -m 0644 "${SCAFFOLD_DIR}/.gitignore" "${TMP_DIR}/.gitignore"

# .github/workflows/ci.yml — does not exist in the subtree, so just install.
mkdir -p "${TMP_DIR}/.github/workflows"
install -m 0644 "${SCAFFOLD_DIR}/.github/workflows/ci.yml" \
        "${TMP_DIR}/.github/workflows/ci.yml"

# 6. Set the remote.
log "Setting origin -> ${REMOTE_URL}"
git -C "${TMP_DIR}" remote add origin "${REMOTE_URL}"

# 7. Report.
cat <<EOF

\033[1;32m=== Extraction complete (web -> ${TARGET_NAME}) ===\033[0m

The filtered standalone repo is ready at:

    ${TMP_DIR}

What was done:
  * Cloned the monorepo to a temp dir.
  * Ran git filter-repo --subdirectory-filter packages/web
    (full history of the web subtree preserved; ~25 commits).
  * Installed standalone scaffolding:
      - README.md            (old one backed up to README.monorepo.md)
      - LICENSE              (NEW — web had no LICENSE of its own)
      - .gitignore           (NEW — web had no .gitignore of its own)
      - .github/workflows/ci.yml   (NEW — uv sync + ruff + mypy + pytest on push+PR)
  * Set origin -> ${REMOTE_URL}

\033[1;33mNEXT STEPS (review, then push — DO NOT push until you have created
the empty GitHub repo Veedubin/${TARGET_NAME}):\033[0m

  cd ${TMP_DIR}
  git log --oneline                       # review the rewritten history
  git show --stat HEAD                    # sanity-check the top commit
  uv sync --extra dev --extra team-server # confirm deps install
  uv run ruff check .                     # lint
  uv run pytest                           # tests (266+ expected)

  # Create an EMPTY repo on GitHub first (no README/license/init):
  #   https://github.com/new  ->  Owner: Veedubin  Name: ${TARGET_NAME}

  # Then push:
  git branch -M main
  git push -u origin main

\033[1;33mDO NOT:\033[0m
  * Push before creating the empty GitHub repo (it will fail).
  * Create the GitHub repo with a README/license/.gitignore — that produces
    an initial commit on the remote that will conflict with your rewritten
    history. Use an EMPTY repo.
  * Delete packages/web from the neuralgentics monorepo yet — leave that
    for the post-extraction cleanup step (see docs/EXTRACTION.md).
EOF
log "Done. Not pushing — that's your call."