---
name: update-gh-docs
description: Updates GitHub-flavored documentation (README, CHANGELOG, release notes) so they are consistent, well-formatted, and validated to render correctly on github.com. Invoked as part of the release-card workflow, before tagging a release. Generic prompts for any GitHub-hosted project, with neuralgentics-specific tailoring (hero copy from Session 22, fish-shell user, podman-only, no docker, repo at Veedubin/neuralgentics).
---

# Update GitHub Docs

## Description

When the orchestrator is about to tag a release, this skill updates the GitHub-visible documentation files (`README.md`, `CHANGELOG.md`, GitHub release notes, and any repo-root `.md` files visitors see first) so they are:
- **Consistent** — version numbers, dates, links all match
- **Complete** — every public-facing file has accurate content
- **Formatted correctly** — renders cleanly on github.com (no broken markdown, no mermaid — use Unicode box-drawing per neuralgentics house style)
- **Validated** — links resolve, code blocks have correct language tags, table-of-contents works

The skill is **generic by design** but with neuralgentics-specific tailoring at the bottom. It can be adapted to other projects by changing the project-specific block.

## When to Use This Skill

- The orchestrator is about to tag a release (`v*` tag push) and needs the public docs ready.
- The user asks to "update the docs" or "make the README better."
- A major new feature is shipped and the public-facing docs need an update.
- The release-card workflow says `T-DOCS-NNN` is the next ready card.

## Generic Flow (any GitHub project)

### Step 1: Identify the docs to update
Common files in order of visibility:
1. `README.md` — the landing page visitors see first
2. `CHANGELOG.md` — version history
3. `docs/index.md` or similar — extended docs landing
4. Any `ROADMAP.md`, `CONTRIBUTING.md`, `LICENSE` in repo root
5. GitHub release notes (auto-generated from the tag push, but can be customized)

### Step 2: Read each file and check
- **Version numbers** — match the upcoming release tag (e.g., `v0.1.1`).
- **Date stamps** — today's date in `YYYY-MM-DD` format.
- **Code blocks** — every `\`\`\`` has a language tag (`\`\`\`bash`, `\`\`\`go`, `\`\`\`typescript`).
- **Links** — relative links use folder-form (no `.md` extension — github.com resolves these automatically).
- **Internal links** — broken anchors are the #1 GH-docs bug. Use `grep -rn "](#" .` to find anchors and verify they match headings.
- **External links** — `curl -sIL <url>` to verify not 404.
- **Mermaid** — replace with Unicode box-drawing per house style (or use `\`\`\`mermaid` blocks if the project wants them).
- **Markdown flavor** — github.com uses GFM (GitHub Flavored Markdown). Tables, task lists, autolinks, strikethrough all work. HTML is allowed but discouraged.

### Step 3: Update the changelog
- Add a new top section for the new version.
- Sections in this order: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Notes`.
- Be specific — name the file, the function, the commit. Don't be vague.
- Reference issue/PR numbers if they exist.
- For a patch release (v0.1.0 → v0.1.1), the "Changed" section is usually empty.
- For a minor release (v0.1.x → v0.2.0), the "Added" section is usually longest.

### Step 4: Update the README
- Verify the hero copy still matches the product reality.
- Verify the install command actually works (curl the URL, verify the script exists).
- Verify the "Quickstart" example actually runs end-to-end.
- Verify all `[link](path)` references resolve.
- Verify the badges (if any) point to live URLs.

### Step 5: Validate on github.com (or local equivalent)
- If you can push to a test branch, push and check the rendered page.
- If not, use `markdownlint` or `markdown-link-check` if installed.
- The minimum validation:
  ```bash
  # All internal .md links resolve
  for f in $(find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/site/*"); do
    grep -oE '\]\([^)]+\.md\)' "$f" | while read link; do
      target=$(echo "$link" | sed 's/^](\(.*\))/\1/')
      test -f "$target" || echo "BROKEN: $f -> $target"
    done
  done
  ```
- Manual check: open each file in a markdown preview (VS Code, Obsidian, etc.) and skim.

### Step 6: Commit the docs updates
- ONE commit per file (or one combined commit if all changes are small).
- Message format: `docs(readme): update hero + install URL for v0.1.1 — Refs: T-DOCS-NNN`
- Push to the same branch the release will tag from.

## Neuralgentics-Specific Tailoring

### House style (from Session 22)
- **No mermaid diagrams in docs.** Use Unicode box-drawing characters (`┌─┐│└┘├┤┬┴┼─╭╮╰╯`). The user explicitly rejected mermaid.
- **Hero copy is a flat feature list**, not clever marketing. Format:
  > "Multi-Agent Orchestration, Permissions-based MCP Server Broker, Context Continuity Across Sessions"
  Sub-headline: "An open-source agent runtime, built for engineers who ship."
- **Honest comparison tables.** Cells with no data marked `(needs research)` rather than fabricated.
- **No source builds for end users** — GH builds all release artifacts. The release workflow is at `.github/workflows/release.yml`.
- **5 release targets only:** linux/amd64, linux/arm64, darwin/arm64 (Apple Silicon), windows/amd64, windows/arm64.

### Project facts (verify before publishing)
- **Repo URL:** `https://github.com/Veedubin/neuralgentics` (NOT `neuralgentics/neuralgentics` — that org does not exist).
- **Latest tag:** check `git tag --sort=-version:refname | head -1` and `curl -s https://api.github.com/repos/Veedubin/neuralgentics/releases/latest | jq -r .tag_name`.
- **Install command:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
  ```
  (NOT `releases/latest/download/install.sh` — install.sh is not in release assets, it's served from `main`.)
- **Container option:** `podman-compose up` (podman only, no docker).
- **Test commands:**
  - Go: `cd packages/<module> && GOWORK=off go test -short -timeout 60s ./...`
  - TS: `cd packages/tui && bun test`
- **5 platform builds:** linux-amd64, linux-arm64, darwin-arm64, windows-amd64, windows-arm64.

### Files that MUST be updated per release (neuralgentics-specific)
- `README.md` — install command, version badge, quickstart
- `CHANGELOG.md` — new top section
- `docs/index.md` — hero copy, latest features
- `mkdocs.yml` — `site_url`, `repo_url`, version, any new pages
- `package.json` — `version` field (root + `packages/tui`, `packages/opencode`)
- `packages/backend-go/cmd/backend/main.go` — add `var version = ""` and assign to `serverInfo.Version` so ldflag works (TODO from v0.1.0)
- `.github/workflows/release.yml` — verify Go version, build matrix, container job status

### Files that MUST NOT be in the public repo
- `HANDOFF.md`, `CONTEXT.md`, `TASKS.md` (gitignored, kept on disk for orchestrator state)
- `certs/` (self-signed TLS, gitignored)
- `.venv/`, `node_modules/`, `build/`, `dist/`, `site/` (build artifacts)
- `opencode-base/` (legacy vendoring, removed in Session 21)
- `docs/design/session-*.md` and `docs/design/*-plan*.md` (internal session artifacts, local-only)

### Verifying the docs actually load
- The mkdocs site is at `https://veedubin.github.io/neuralgentics/`. After pushing changes to `main`, the docs workflow (`.github/workflows/docs.yml`) re-deploys.
- Validate: `curl -sIL https://veedubin.github.io/neuralgentics/ | head -5` (expect 200).
- Validate: `curl -s https://veedubin.github.io/neuralgentics/getting-started/installation/ | grep -c "raw.githubusercontent"` (expect ≥1 — confirms the install URL fix from Session 22 is still in place).
- Validate: open the GH release page after tagging and verify the rendered release notes look right.

## Kanban Rule: Release Card MUST Spawn a T-DOCS Card

Per AGENTS.md R6 (added Session 23): every release card (T-REL-NNN) MUST include a child `T-DOCS-NNN` card that invokes this skill before the tag is pushed. The release card is not "done" until the docs card is done.

Release card template:

```markdown
### T-REL-001 · Tag v0.1.1 release
- **Status:** ready
- **Assignee:** boomerang-release
- **Goal:** Tag v0.1.1 with all Session 23 bug fixes and push to GH.
- **Acceptance:**
  - [ ] All quality gates green (T-069 done)
  - [ ] T-DOCS-XXX docs update done (invoke update-gh-docs skill)
  - [ ] Tag v0.1.1 pushed to origin
  - [ ] GH Actions release workflow green
  - [ ] Release assets all uploaded (5 platforms + checksums.txt)
  - [ ] Live docs site serves correctly
- **Depends on:** T-069, T-DOCS-XXX
- **Scope IN:** version bump, CHANGELOG, tag push, release verification
- **Scope OUT:** code changes (those are separate cards)
```

The T-DOCS-XXX card:

```markdown
### T-DOCS-001 · Update GitHub docs for v0.1.1
- **Status:** ready
- **Assignee:** boomerang-writer
- **Skill:** update-gh-docs
- **Goal:** Update README, CHANGELOG, docs/index.md, mkdocs.yml, package.json versions for v0.1.1.
- **Acceptance:**
  - [ ] All version numbers match v0.1.1
  - [ ] All internal links resolve
  - [ ] Hero copy still accurate
  - [ ] Install command still works (curl-tested)
  - [ ] Hero copy is the flat feature list (not clever marketing)
  - [ ] No mermaid in any doc file
  - [ ] One commit per file
- **Depends on:** T-REL-001 (for version target)
```

## Anti-Patterns

- **Don't** auto-generate docs from code. They're for humans. Use code for the data, write the prose.
- **Don't** put `WIP` or `TODO` in public docs. Either finish it or don't include it.
- **Don't** link to local files with `.md` extensions — github.com doesn't render these as anchors. Use folder-form: `[link](path/to/page/)` not `[link](path/to/page.md)`.
- **Don't** include comparison cells with fabricated data. Mark `(needs research)` instead.
- **Don't** update docs in the same commit as code changes. Separate them for clean rollback.
- **Don't** push docs changes directly to main. Open a PR unless the project is single-maintainer and that's the norm.
- **Don't** add emojis to docs unless the user explicitly asks. (User preference: no emojis in docs.)

## Model

Use **Gemma** for routine doc updates (formatting, link checks, version bumps). Use **DeepSeek** for any doc that requires careful judgment (hero copy, comparison tables, hero sections).

## Owner

- `boomerang-writer` is the primary agent for this skill.
- The orchestrator invokes it as part of the release-card workflow.
- The skill can also be invoked manually when the user says "update the docs" or "/boomerang-handoff" if a release is imminent.

*(Added 2026-06-05 Session 23. Prior to this, doc updates were ad-hoc. This skill formalizes the checklist and ties it to the release-card workflow so docs are NEVER out of sync with the code at tag time.)*
