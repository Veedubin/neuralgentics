---
name: external-skills-fetcher
description: Clones the curated external skill repos (Orchestra-Research/AI-Research-SKILLs + nextlevelbuilder/ui-ux-pro-max-skill) into ~/.neuralgentics/external_skills/. Refreshes on session start. Toggle via external_skills.enabled in .env. Invoke via //external-skills-fetcher.
tags:
  - external
  - skills
  - fetcher
  - git
---

# External Skills Fetcher

## When to Invoke

- **At session start** — the plugin's session-start hook invokes this skill automatically (before the SESSION START PROTOCOL so that the new SKILL.md files are visible to AGENTS.md and the rest of the protocol).
- **Manually** — via `//external-skills-fetcher` when the user wants to refresh external skills mid-session.
- **At release time** — `scripts/release.sh` calls the fetcher before building the dist tarball.

## Preconditions (Step 0)

- [ ] `git` is installed and on PATH
- [ ] Network is available (offline is handled gracefully)
- [ ] `~/.neuralgentics/` exists (created by `install.sh`)

## Step 1: Read `.env`

Read `external_skills.enabled` from the project's `.env` file (or `~/.neuralgentics/.env` as fallback).

- If unset or `false` → log `[external-skills-fetcher] external_skills.enabled is false — skipping` and return `{ enabled: false }`.
- If `true` → proceed to Step 2.

## Step 2: Clone / Refresh Repositories

Ensure `~/.neuralgentics/external_skills/` exists. For each configured repository:

### Repo 1: AI-Research-SKILLs
- **URL:** `https://github.com/Orchestra-Research/AI-Research-SKILLs.git`
- **Target dir:** `~/.neuralgentics/external_skills/ai-research-skills/`
- **License:** MIT
- **Attribution:** `Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License.`

### Repo 2: ui-ux-pro-max-skill
- **URL:** `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git`
- **Target dir:** `~/.neuralgentics/external_skills/ui-ux-pro-max-skill/`
- **License:** MIT
- **Attribution:** `Copyright 2024 Next Level Builder. Used under MIT License.`

**Clone logic (per repo):**
1. If target dir does not exist → `git clone --depth 1 <url> <target-dir>`
2. If target dir exists → `cd <target-dir> && git pull --ff-only`
   - If `git pull` fails (network error, no upstream) → log warning and continue. Do NOT throw.
3. After clone/refresh, capture the current HEAD commit SHA: `git -C <target-dir> rev-parse HEAD`

## Step 3: Write MANIFEST.json

Write `~/.neuralgentics/external_skills/MANIFEST.json`:

```json
{
  "version": 1,
  "updated_at": "<ISO 8601 timestamp>",
  "repos": {
    "ai-research-skills": {
      "url": "https://github.com/Orchestra-Research/AI-Research-SKILLs.git",
      "commit_sha": "<40-char hex SHA>",
      "license": "MIT",
      "attribution": "Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License."
    },
    "ui-ux-pro-max-skill": {
      "url": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git",
      "commit_sha": "<40-char hex SHA>",
      "license": "MIT",
      "attribution": "Copyright 2024 Next Level Builder. Used under MIT License."
    }
  }
}
```

## Step 4: Return Handle

Return to the orchestrator:

```json
{
  "enabled": true,
  "manifest_path": "~/.neuralgentics/external_skills/MANIFEST.json",
  "repos": {
    "ai-research-skills": { "status": "cloned", "commit_sha": "<sha>" },
    "ui-ux-pro-max-skill": { "status": "refreshed", "commit_sha": "<sha>" }
  },
  "errors": []
}
```

## Notes

- **Offline-safe:** If `git pull` fails due to no network, log a warning and continue. The existing clone is still usable.
- **Idempotent:** Running the fetcher multiple times is safe. `git pull --ff-only` on an already-up-to-date repo is a no-op.
- **First install:** On a fresh `install.sh` run, the tarball may include a pre-bundled `share/external_skills/` snapshot. The fetcher will `git pull` to refresh it on first session start.
- **MANIFEST.json is the source of truth** for commit SHAs and attribution. The Go catalog reads this file to stamp provenance on external skills.