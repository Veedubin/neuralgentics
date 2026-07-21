# Extraction Runbook: broker-go and web -> standalone repos

This is the complete, copy-paste runbook for extracting two packages out of
the `neuralgentics` monorepo (`github.com/Veedubin/neuralgentics`) into two
new standalone GitHub repos, with full git history preserved.

> **Status:** PREP ONLY. The scripts and scaffolding in this directory are
> ready. The user creates the GitHub repos and runs the pushes. Nothing in
> this runbook modifies the original monorepo.

---

## TL;DR

```bash
# From the neuralgentics monorepo root:
./scripts/extract-broker-go.sh neuralgentics-broker
./scripts/extract-web.sh       neuralgentics-web

# Then, for each output repo:
cd /tmp/neuralgentics-extract-<name>
git log --oneline                              # review
<run the build/test commands the script printed>
git branch -M main
git push -u origin main
```

The two scripts do **not** push. They produce ready-to-push repos in
`/tmp/neuralgentics-extract-<name>` with `origin` already set.

---

## Proposed repo names (confirm before creating)

| Package | Proposed standalone repo | Reason |
|---------|--------------------------|--------|
| `packages/broker-go` | `Veedubin/neuralgentics-broker` | Matches the Go module path already in `go.mod` (`github.com/Veedubin/neuralgentics-broker`) and the package's own README. |
| `packages/web` | `Veedubin/neuralgentics-web` | Matches `pyproject.toml` `name = "neuralgentics-web"` and the existing PyPI distribution name. |

**These names are proposals — confirm before you create the repos.** Both
already match what the in-package `go.mod` / `pyproject.toml` declare, so
changing them would require also editing those files. If you want different
names, edit the scripts' defaults and the scaffolding READMEs first.

---

## What you need to do (in order)

### 1. Create two EMPTY GitHub repos

Go to <https://github.com/new> twice and create:

- `Veedubin/neuralgentics-broker`
- `Veedubin/neuralgentics-web`

**Critical:** the repos must be **empty**. Do **not** initialize them with a
README, LICENSE, or `.gitignore`. GitHub's "Initialize this repository with:"
checkboxes should all be unchecked. An initialized repo produces an
initial commit on the remote that will conflict with the rewritten history
you're about to push — you'd have to `git push --force` and that leaves a
stray merge commit.

### 2. Run the broker-go extraction

```bash
cd /home/jcharles/Projects/MCP-Servers/neuralgentics
./scripts/extract-broker-go.sh neuralgentics-broker
```

The script:

1. Checks for `git filter-repo` (prints an install hint if missing).
2. Clones the monorepo to `/tmp/neuralgentics-extract-neuralgentics-broker`.
3. Runs `git filter-repo --subdirectory-filter packages/broker-go` — this
   rewrites the clone's history so it only contains the ~24 commits that
   touched `packages/broker-go`, and the broker-go files move to the repo
   root. **The original monorepo is untouched** (we work on a temp clone).
4. Installs standalone scaffolding:
   - `README.md` — the standalone README (old in-package README backed up to
     `README.monorepo.md`)
   - `LICENSE` — MIT, copyright "Veedubin" 2026 (old one backed up to
     `LICENSE.monorepo.txt`)
   - `.gitignore` — Go build artifacts (old one backed up to
     `.gitignore.monorepo`)
   - `.github/workflows/ci.yml` — Go build + vet + `go test -race` on push/PR
     to `main` (NEW — the package had no CI of its own)
5. Sets `origin` to `git@github.com:Veedubin/neuralgentics-broker.git`.
6. Prints the exact next-step commands. **Does not push.**

### 3. Run the web extraction

```bash
cd /home/jcharles/Projects/MCP-Servers/neuralgentics
./scripts/extract-web.sh neuralgentics-web
```

Same flow as above, but for `packages/web` (~25 commits preserved). The web
package did NOT have its own `LICENSE` or `.gitignore`, so those are written
fresh (no backup needed). The in-package `README.md` is backed up to
`README.monorepo.md` and the standalone README is installed. The CI workflow
is `uv sync --extra dev --extra team-server` → `ruff check` → `mypy --strict`
(excluding `memini_browser/memini_client.py`, which has 2 pre-existing
optional-SDK type errors) → `pytest`.

### 4. Review and push each repo

```bash
# broker-go
cd /tmp/neuralgentics-extract-neuralgentics-broker
git log --oneline                       # ~24 commits, all touching broker-go
git show --stat HEAD                    # sanity-check the top commit
go build ./...                          # confirm it still builds
go vet ./...
go test -race -count=1 ./...            # 221 tests expected
git branch -M main
git push -u origin main
```

```bash
# web
cd /tmp/neuralgentics-extract-neuralgentics-web
git log --oneline                       # ~25 commits, all touching web
git show --stat HEAD                    # sanity-check the top commit
uv sync --extra dev --extra team-server # confirm deps install
uv run ruff check .                     # lint
uv run pytest                           # 266+ tests expected
git branch -M main
git push -u origin main
```

### 5. Confirm CI is green on both repos

After pushing, GitHub Actions will run the new `ci.yml` on each repo:

- `neuralgentics-broker`: setup-go (1.25 from `go.mod`) → `go build` →
  `go vet` → `go test -race -count=1`.
- `neuralgentics-web`: setup-python 3.12 → `astral-sh/setup-uv@v5` →
  `uv sync` → `ruff check` → `mypy --strict` (excluding the
  `memini_browser/memini_client.py` stubs) → `pytest`.

Confirm both are green **before** you do the monorepo cleanup step.

---

## Warnings (read before running)

### W1: Extraction rewrites the history of a *clone*, not the monorepo

`git filter-repo --subdirectory-filter` rewrites the history of the
repository it's run in. The scripts only ever run it inside a temp clone at
`/tmp/neuralgentics-extract-<name>`. **The original monorepo at
`/home/jcharles/Projects/MCP-Servers/neuralgentics` is never modified.** You
can re-run either script as many times as you want — they `rm -rf` the temp
dir first.

### W2: Do NOT delete `packages/*` from the monorepo until the new repos are pushed AND CI is green

The monorepo still builds and ships both packages until you do the cleanup
step. Leave them in place. If anything goes wrong with the extraction, the
monorepo is the source of truth and nothing has been lost.

### W3: Empty GitHub repos only

If you initialize the GitHub repo with a README / LICENSE / `.gitignore`,
the remote will have an initial commit that your rewritten local history
does not share. You'll be forced to `git push --force`, which leaves a stray
merge or a force-overwrite. Use an **empty** repo.

### W4: The extracted history contains only commits that touched the subtree

`git filter-repo --subdirectory-filter` drops commits that did not touch
`packages/broker-go` (or `packages/web`). The commit *messages* and
*authors* of the surviving commits are preserved verbatim. The commit
SHAs are rewritten (filter-repo rewrites every commit because the file paths
move from `packages/<name>/...` to `./...`). If you have any tooling that
references specific monorepo commit SHAs for these packages, those
references will need to be updated.

### W5: `git filter-repo` removes the `origin` remote by design

filter-repo assumes you're splitting a repo out of a larger history and
strips the original remote so you don't accidentally push the filtered
history back to the monorepo. The extraction scripts re-add `origin` to
point at the new standalone repo URL, so this is handled. Just don't
expect `git pull` to work until you push.

### W6: License assumption

The scaffolding `LICENSE` files are MIT, copyright "Veedubin" 2026. This
matches:

- The monorepo root `LICENSE` (MIT, "neuralgentics contributors" — slightly
  different copyright line, but same license).
- The broker-go package's own `LICENSE` (MIT, "Veedubin" 2026 — exact match).
- The web package's `pyproject.toml` declares `license = {text = "MIT"}`.

The extraction scripts back up any pre-existing `LICENSE` to
`LICENSE.monorepo.txt` before installing the scaffolding one, so the old
text is preserved if you ever want to compare.

### W7: `mypy --strict` has 2 known pre-existing errors in `memini_browser/memini_client.py`

The web CI workflow excludes
`src/neuralgentics/web/modules/memini_browser/memini_client.py` from the
`mypy --strict` run. That file has 2 type errors that come from the optional
`memini-ai` SDK integration (which is not a declared dependency — the web
package imports cleanly without it). The exclusion keeps CI green until
those stubs are upstreamed into the `memini-ai` SDK. The rest of the web
package is `mypy --strict` clean.

---

## Post-extraction monorepo cleanup (SEPARATE FUTURE STEP — NOT SCRIPTED HERE)

Once both standalone repos are pushed and CI is green, you'll want to:

1. Replace `packages/broker-go/` in the monorepo with a single
   `packages/broker-go/README.md` pointing at
   `github.com/Veedubin/neuralgentics-broker`.
2. Replace `packages/web/` in the monorepo with a single
   `packages/web/README.md` pointing at
   `github.com/Veedubin/neuralgentics-web`.
3. Update the monorepo's CI (`.github/workflows/ci.yml`) to stop running
   `go test` / `pytest` against those subtrees.
4. Update the monorepo's docs (`README.md`, `docs/index.md`, `mkdocs.yml`)
   to link out to the standalone repos instead of describing the packages
   as in-tree.
5. Update the monorepo's `go.work` / `go.work.sum` if broker-go was a workspace
   member.
6. Update the monorepo's root `pyproject.toml` / `uv.lock` if web was a
   workspace member.
7. Cut a new monorepo release tag (e.g. `v0.13.0`) reflecting the extraction.

**This is explicitly out of scope for the prep work in this directory.** It
touches monorepo CI, docs, and the Go/Python workspace files, and requires
its own design + release cycle. Flag it as a follow-up card; do not attempt
to script it blind in the same pass as the extraction.

---

## File map (what this prep created)

```
neuralgentics/
├── scripts/
│   ├── extract-broker-go.sh                         # NEW — extraction script
│   ├── extract-web.sh                               # NEW — extraction script
│   └── scaffolding/
│       ├── broker-go/
│       │   ├── README.md                            # standalone README
│       │   ├── LICENSE                              # MIT, Veedubin 2026
│       │   ├── .gitignore                           # Go build artifacts
│       │   └── .github/workflows/ci.yml             # Go build/vet/test CI
│       └── web/
│           ├── README.md                            # standalone README
│           ├── LICENSE                              # MIT, Veedubin 2026
│           ├── .gitignore                           # Python caches
│           └── .github/workflows/ci.yml             # uv + ruff + mypy + pytest CI
└── docs/
    └── EXTRACTION.md                                # this runbook
```

**Nothing else was touched.** `packages/**`, the root `.github/**`, and all
existing files are unchanged. The new files are uncommitted — run `git
status` to review before committing.