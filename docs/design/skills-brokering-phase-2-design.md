# Skills Brokering + Auto-Evolution — Phase 2 Design

**Status:** Design Complete (2026-06-24, Session 30)
**Author:** boomerang-architect
**Plan Reference:** memini-ai memory `fbfeca3b-b8c4-4718-a971-81750cb390df`
**Phase 1 Ship Summary:** memini-ai memory `51c47f78-6008-4fbd-b37d-fbd65f4e9463`
**Phase 1 Design Doc:** `docs/design/skills-brokering-phase-1-design.md`

---

## 1. Overview & Goals

Phase 2 extends the Neuralgentics skills broker from local-only skills (~5-10 per project) to a federated catalog that includes **external skill repositories** cloned at release time and refreshed on session start. The SkillCatalog grows from N local skills to N+~400 external skills (778 files from AI-Research-SKILLs + 387 files from ui-ux-pro-max-skill). External skills are provenance-stamped (repo, commit SHA, attribution), go through the same `agent-skill-scope.yaml` role filter as local skills, and are bundled into the release tarball so that end users get a self-contained archive. A new LRU body cache (TS-side, ~5MB cap) eliminates repeated disk I/O during `pickSkill` calls. The release pipeline gains an opt-out `--skip-external-skills` flag for lean builds.

---

## 2. Component Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        SESSION START / MANUAL INVOCATION                      │
│                                                                              │
│  //external-skills-fetcher  (or session-start hook)                          │
│       │                                                                      │
│       ▼                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ExternalSkillsFetcher (TS helper in plugin)                          │    │
│  │                                                                       │    │
│  │  1. Read external_skills.enabled from .env                            │    │
│  │  2. If false/unset → no-op, log                                       │    │
│  │  3. If true:                                                          │    │
│  │     a. Ensure ~/.neuralgentics/external_skills/ exists                │    │
│  │     b. For each repo: clone (if missing) or git pull --ff-only        │    │
│  │     c. Record commit SHA → MANIFEST.json                              │    │
│  │  4. Return MANIFEST.json                                              │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
│                                 ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ~/.neuralgentics/external_skills/                                    │    │
│  │                                                                       │    │
│  │  MANIFEST.json                                                        │    │
│  │  ai-research-skills/  (git clone of Orchestra-Research/AI-Research-   │    │
│  │                         SKILLs)                                       │    │
│  │  ui-ux-pro-max-skill/ (git clone of nextlevelbuilder/ui-ux-pro-max-   │    │
│  │                         skill)                                        │    │
│  └──────────────────────────────┬───────────────────────────────────────┘    │
│                                 │                                            │
└─────────────────────────────────┼────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     NEURALGENTICS BACKEND (Go)                                │
│                                                                              │
│  Broker struct:                                                              │
│    + ExternalDir string  (NEW FIELD — path to ~/.neuralgentics/external_     │
│                           skills/)                                           │
│                                                                              │
│  NewBrokerWithExternal(workspaceRoot, externalDir string) *Broker  (NEW)     │
│                                                                              │
│  BuildSkills(role) *catalog.SkillCatalog                                     │
│    └─► catalog.Builder.BuildSkills(role, workspaceRoot)                      │
│         │                                                                    │
│         ├─► LoadScope(agent-skill-scope.yaml)                               │
│         ├─► Walk .opencode/skills/*/SKILL.md  (local)                       │
│         ├─► Walk external_skills/**/SKILL.md  (external, NEW)               │
│         │    ├─► walkAIResearchSkills(dir)                                  │
│         │    └─► walkUIUXProMaxSkill(dir)                                   │
│         ├─► loadExternalManifest(externalDir) → provenance map              │
│         ├─► Dedup: local wins over external                                 │
│         ├─► Parse front-matter (same parser for both)                       │
│         ├─► Merge tags (same mergeTags for both)                            │
│         └─► Return SkillCatalog (with ExternalProvenance on external        │
│              skills)                                                         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ JSON-RPC over stdio
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     NEURALGENTICS PLUGIN (TS)                                 │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  skill_lookup.ts  (self-evolution/skill_lookup.ts)                    │    │
│  │                                                                       │    │
│  │  pickSkill(taskContext, role) ──► ListSkills(role) ──►               │    │
│  │       │                         JSON-RPC call                          │    │
│  │       ▼                                                               │    │
│  │  cosine(taskVec, skillVec) → top-1 if score ≥ 0.6                     │    │
│  │       │                                                               │    │
│  │       ▼                                                               │    │
│  │  ┌─────────────────────────────────────────────────────────────┐     │    │
│  │  │  SkillBodyCache (TS-side LRU, NEW)                            │     │    │
│  │  │                                                               │     │    │
│  │  │  Get(path) → body (cached) or read from disk + cache         │     │    │
│  │  │  Invalidate on mtimeMs change                                 │     │    │
│  │  │  ~100 entries × 50KB cap = 5MB                                │     │    │
│  │  └─────────────────────────────────────────────────────────────┘     │    │
│  │                                                                       │    │
│  │  returns {name, body, score}                                          │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  ExternalSkillsFetcher (self-evolution/external_fetcher.ts, NEW)      │    │
│  │  (see session-start path above)                                       │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                        RELEASE-TIME BUNDLING PATH                             │
│                                                                              │
│  release.sh                                                                  │
│    │                                                                          │
│    ├─► run_external_fetcher()  (NEW step, before build_dist)                 │
│    │     └─► scripts/external-skills-fetcher.sh  (thin shell wrapper)        │
│    │           └─► calls TS helper or runs git clone directly                │
│    │                 └─► populates ~/.neuralgentics/external_skills/         │
│    │                       └─► writes MANIFEST.json                          │
│    │                                                                          │
│    ├─► build_dist()                                                           │
│    │     └─► scripts/build.sh                                                │
│    │           └─► copy_runtime_files()                                       │
│    │                 └─► copy ~/.neuralgentics/external_skills/               │
│    │                       → $DIST_DIR/share/external_skills/                │
│    │                       (exclude .git/ dirs)                              │
│    │                                                                          │
│    └─► tar -czf neuralgentics-vX.Y.Z.tar.gz -C dist .                        │
│                                                                              │
│  install.sh                                                                   │
│    │                                                                          │
│    └─► After extract:                                                        │
│          if share/external_skills/ exists AND                                 │
│             ~/.neuralgentics/external_skills/ does NOT exist:                │
│            cp -r share/external_skills/ → ~/.neuralgentics/external_skills/  │
│          (idempotent: don't overwrite existing)                               │
│                                                                              │
│  update-gh-docs SKILL.md                                                      │
│    │                                                                          │
│    └─► Step 1.5 (NEW): "Ensure external_skills/ snapshot is fresh            │
│          before build"                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. external-skills-fetcher Skill (T-SB-008)

### 3.1 Design Decision: TypeScript Helper (Not Shell Script)

**Recommendation: TypeScript helper in the plugin.** Rationale:

| Factor | TS Helper | Shell Script |
|--------|-----------|--------------|
| Testability | `bun test` with temp dirs, mock git | Manual smoke only |
| Integration | Same process as self-evolution flow | Separate process, harder to debug |
| Error handling | Structured try/catch, typed returns | Exit codes, string parsing |
| Env reading | Same pattern as rest of plugin | Separate env parsing |
| Offline safety | Structured error logging | `set -e` would abort on git failure |

The shell script approach is simpler for the release-time bundling path (T-SB-010), but the session-start invocation benefits from the TS approach. **Decision: TS helper for session-start, thin shell wrapper for release-time.** The shell wrapper calls the same TS function via `bun run` or a standalone Node.js script.

### 3.2 Full SKILL.md Content

**File:** `/.opencode/skills/external-skills-fetcher/SKILL.md` (CREATE)

```markdown
---
name: external-skills-fetcher
description: Clones and refreshes external skill repositories from GitHub into ~/.neuralgentics/external_skills/. Reads external_skills.enabled from .env. Offline-safe — skips git pull on network errors.
tags:
  - external
  - skills
  - fetcher
  - git
  - session
---

# External Skills Fetcher

## When to Invoke

- **At session start** — the plugin's session-start hook invokes this skill automatically.
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
```

### 3.3 TypeScript Helper Signature

**File:** `packages/plugin/src/self-evolution/external_fetcher.ts` (CREATE)

```typescript
/**
 * ExternalSkillsFetcher — clones/refreshes external skill repos.
 *
 * Reads external_skills.enabled from .env, runs git clone/pull for
 * each configured repo, and writes MANIFEST.json with commit SHAs
 * and attribution metadata.
 */

/** Configuration for a single external skill repository. */
export interface RepoConfig {
  /** Short name used as directory name and manifest key. */
  name: string;
  /** Git clone URL. */
  url: string;
  /** SPDX license identifier. */
  license: string;
  /** Attribution string for provenance stamping. */
  attribution: string;
}

/** A single repo entry in MANIFEST.json. */
export interface ManifestRepoEntry {
  url: string;
  commit_sha: string;
  license: string;
  attribution: string;
}

/** The full MANIFEST.json structure. */
export interface Manifest {
  version: number;
  updated_at: string;       // ISO 8601
  repos: Record<string, ManifestRepoEntry>;
}

/** Result returned by fetch(). */
export interface FetchResult {
  enabled: boolean;
  manifest_path: string;
  repos: Record<string, { status: string; commit_sha: string }>;
  errors: string[];
}

/** Minimal env reader — reads KEY=value lines from a .env file. */
export interface EnvReader {
  get(key: string): string | undefined;
}

/**
 * Reads a .env file line-by-line and parses KEY="value" pairs.
 * Does NOT use dotenv — pure file I/O to avoid dependency.
 */
export function readEnvFile(path: string): EnvReader;

/** Hardcoded list of external skill repos for Phase 2. */
export const DEFAULT_REPOS: RepoConfig[];

export class ExternalSkillsFetcher {
  /**
   * @param homeDir — Path to ~/.neuralgentics/ (user data dir).
   * @param env — EnvReader for reading .env configuration.
   */
  constructor(homeDir: string, env: EnvReader);

  /**
   * Clone or refresh all configured external skill repositories.
   *
   * 1. Reads external_skills.enabled from env. If false/unset → no-op.
   * 2. Ensures ~/.neuralgentics/external_skills/ exists.
   * 3. For each repo: clone (if missing) or git pull --ff-only.
   * 4. Captures commit SHA for each repo.
   * 5. Writes MANIFEST.json.
   *
   * @param repos — List of repo configs (default: DEFAULT_REPOS).
   * @returns FetchResult with status per repo and any errors.
   */
  async fetch(repos?: RepoConfig[]): Promise<FetchResult>;

  /**
   * Run a git command in a specific directory.
   * Wraps child_process.exec for testability.
   */
  private async git(args: string[], cwd: string): Promise<string>;
}
```

### 3.4 Env Reader Pattern

The plugin already reads `.env` in several places. The pattern is:

```typescript
// Read .env file line by line, parse KEY="value" pairs.
// No dotenv dependency — pure file I/O.
export function readEnvFile(path: string): EnvReader {
  const map = new Map<string, string>();
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes.
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      map.set(key, value);
    }
  } catch {
    // File doesn't exist → empty env.
  }
  return {
    get(key: string): string | undefined {
      return map.get(key);
    },
  };
}
```

### 3.5 Offline Safety

```typescript
// In fetch():
try {
  await this.git(["pull", "--ff-only"], repoDir);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("Could not resolve host") ||
      msg.includes("Network is unreachable") ||
      msg.includes("Connection refused") ||
      msg.includes("Could not read from remote")) {
    this.errors.push(`[${repo.name}] git pull failed (offline?): ${msg}`);
    // Use existing clone's HEAD SHA.
    const sha = await this.git(["rev-parse", "HEAD"], repoDir);
    entry.commit_sha = sha.trim();
    continue;
  }
  throw err; // Non-network error → propagate.
}
```

### 3.6 MANIFEST.json Schema (Realistic Example)

```json
{
  "version": 1,
  "updated_at": "2026-06-24T14:30:00Z",
  "repos": {
    "ai-research-skills": {
      "url": "https://github.com/Orchestra-Research/AI-Research-SKILLs.git",
      "commit_sha": "773a529b8c4d1e2f3a5b6c7d8e9f0a1b2c3d4e5f6",
      "license": "MIT",
      "attribution": "Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License."
    },
    "ui-ux-pro-max-skill": {
      "url": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git",
      "commit_sha": "bdf1179a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2",
      "license": "MIT",
      "attribution": "Copyright 2024 Next Level Builder. Used under MIT License."
    }
  }
}
```

### 3.7 Invocation Point

The fetcher is invoked from **two** places:

1. **Session-start hook** — The plugin's `session.created` lifecycle hook (in `packages/plugin/src/hooks/lifecycle.ts` or equivalent) calls `ExternalSkillsFetcher.fetch()` before the orchestrator's first dispatch. This ensures external skills are available for the entire session.

2. **Manual invocation** — The `//external-skills-fetcher` skill body calls the same TS function via the plugin's MCP tool surface (e.g., `neuralgentics_external_fetcher` tool).

3. **Release-time** — `scripts/release.sh` calls a thin shell wrapper (`scripts/external-skills-fetcher.sh`) that invokes the same TS function via `bun run` or a standalone Node.js script. See §5 for details.

---

## 4. External Skill Parser (T-SB-009)

### 4.1 Updated `Builder` Struct

**File:** `packages/broker-go/src/neuralgentics/broker/catalog/catalog.go`

```go
// Builder constructs ServerCatalogs and SkillCatalogs from the registry
// and filesystem, with optional role-based access filtering.
type Builder struct {
    registry    *registry.Registry
    ac          *access.AccessControl
    externalDir string                          // NEW — path to ~/.neuralgentics/external_skills/
    manifest    map[string]ExternalProvenance   // NEW — loaded from MANIFEST.json
}
```

### 4.2 New Constructors

```go
// NewBuilder creates a new catalog Builder backed by the given registry.
// It uses DefaultAccessControl for role-based filtering.
// External skills are NOT loaded (externalDir is empty).
func NewBuilder(reg *registry.Registry) *Builder {
    return &Builder{
        registry:    reg,
        ac:          access.DefaultAccessControl(),
        externalDir: "",
        manifest:    nil,
    }
}

// NewBuilderWithAccess creates a catalog Builder with a custom AccessControl.
// External skills are NOT loaded (externalDir is empty).
func NewBuilderWithAccess(reg *registry.Registry, ac *access.AccessControl) *Builder {
    return &Builder{
        registry:    reg,
        ac:          ac,
        externalDir: "",
        manifest:    nil,
    }
}

// NewBuilderWithExternal creates a catalog Builder that also loads external
// skills from the given directory. The externalDir should be the path to
// ~/.neuralgentics/external_skills/. The manifest is loaded from
// <externalDir>/MANIFEST.json.
//
// This constructor does NOT break NewBuilder or NewBuilderWithAccess —
// it is additive.
func NewBuilderWithExternal(reg *registry.Registry, ac *access.AccessControl, externalDir string) *Builder {
    b := &Builder{
        registry:    reg,
        ac:          ac,
        externalDir: externalDir,
        manifest:    nil,
    }
    // Best-effort manifest load. If it fails, manifest stays nil
    // and external skills are skipped gracefully.
    m, err := loadExternalManifest(externalDir)
    if err != nil {
        fmt.Fprintf(os.Stderr, "[broker] warning: failed to load external manifest: %v\n", err)
    } else {
        b.manifest = m
    }
    return b
}
```

### 4.3 Updated `BuildSkills` Method

**File:** `packages/broker-go/src/neuralgentics/broker/catalog/skills.go`

The existing `BuildSkills(role, workspaceRoot)` method is extended to ALSO walk external skill directories. The local walk (`.opencode/skills/*/SKILL.md`) runs first, then external walks run. Dedup happens during external walk: if a skill name already exists in the local set, the external one is skipped.

```go
func (b *Builder) BuildSkills(role string, workspaceRoot string) SkillCatalog {
    // Step 1: Load scope (unchanged).
    scope, err := LoadScope(workspaceRoot)
    if err != nil {
        fmt.Fprintf(os.Stderr, "[broker] warning: failed to load skill scope: %v\n", err)
        scope = &ScopeFile{Version: 1, Roles: map[string][]string{}}
    }

    var skills []SkillSummary
    seenNames := make(map[string]bool) // for dedup

    // Step 2: Walk local .opencode/skills/*/SKILL.md (unchanged).
    localSkills := b.walkLocalSkills(workspaceRoot, role, scope)
    for _, s := range localSkills {
        skills = append(skills, s)
        seenNames[s.Name] = true
    }

    // Step 3: Walk external skills (NEW).
    if b.externalDir != "" && b.manifest != nil {
        externalSkills := b.walkExternalSkills(role, scope, seenNames)
        skills = append(skills, externalSkills...)
    }

    return SkillCatalog{
        Skills:      skills,
        TotalSkills: len(skills),
        Role:        role,
        Source:      "workspace",
    }
}
```

### 4.4 `ExternalProvenance` Struct

```go
// ExternalProvenance records the origin of an external skill.
// It is nil for local skills.
type ExternalProvenance struct {
    Repo       string `json:"repo"`        // repo key from MANIFEST.json (e.g., "ai-research-skills")
    CommitSHA  string `json:"commit_sha"`  // git commit SHA at time of clone/refresh
    Attribution string `json:"attribution"` // copyright/license attribution string
    License    string `json:"license"`     // SPDX license identifier
}
```

### 4.5 Updated `SkillSummary`

```go
type SkillSummary struct {
    Name        string              `json:"name"`
    Description string              `json:"description"`
    Source      string              `json:"source"`       // "local" | "external"
    Tags        []string            `json:"tags"`
    Path        string              `json:"path"`          // relative to workspace root (local) or absolute (external)
    SizeBytes   int64               `json:"size_bytes"`
    AgentScope  []string            `json:"agent_scope"`
    Provenance  *ExternalProvenance `json:"provenance,omitempty"` // NEW — nil for local skills
}
```

### 4.6 Per-Repo Walker Strategies

#### `walkAIResearchSkills(dir string) ([]SkillSummary, error)`

The AI-Research-SKILLs repo has numbered category dirs at the top level (`01-model-architecture/`, `02-tokenization/`, ..., `22-*`). Each category dir contains tool-name leaf dirs, each with exactly one `SKILL.md`.

**Walker algorithm:**

```
1. entries := os.ReadDir(dir)
2. FOR EACH entry IN entries:
     a. IF NOT entry.IsDir(): CONTINUE
     b. IF entry.Name() does NOT match ^[0-9]+-.*/: CONTINUE
        // Skip non-skill top-level dirs: docs/, packages/, scripts/,
        // anthropic_official_docs/, demos/, dev_data/, video-promo/,
        // .claude-plugin/, .github/
     c. categoryDir := filepath.Join(dir, entry.Name())
     d. toolDirs := os.ReadDir(categoryDir)
     e. FOR EACH toolDir IN toolDirs:
          i.   IF NOT toolDir.IsDir(): CONTINUE
          ii.  skillPath := filepath.Join(categoryDir, toolDir.Name(), "SKILL.md")
          iii. IF SKILL.md does NOT exist: CONTINUE
          iv.  Parse front-matter, build SkillSummary with Provenance
          v.   Append to results
3. RETURN results
```

**Allow-list regex:** `^[0-9]+-.*/` — this matches `01-model-architecture/`, `22-emerging-topics/`, etc. It excludes `docs/`, `packages/`, `scripts/`, `anthropic_official_docs/`, `demos/`, `dev_data/`, `video-promo/`, `.claude-plugin/`, `.github/`, `0-autoresearch-skill/` (if it exists — the `0-` prefix would match the regex, so it would be included; this is acceptable since it may contain skills).

#### `walkUIUXProMaxSkill(dir string) ([]SkillSummary, error)`

The ui-ux-pro-max-skill repo has skills under `.claude/skills/<skill-name>/SKILL.md`. It also has a top-level `skill.json` manifest.

**Walker algorithm:**

```
1. // Walk .claude/skills/*/SKILL.md
2. claudeSkillsDir := filepath.Join(dir, ".claude", "skills")
3. IF claudeSkillsDir does NOT exist: skip this walk
4. skillDirs := os.ReadDir(claudeSkillsDir)
5. FOR EACH skillDir IN skillDirs:
     a. IF NOT skillDir.IsDir(): CONTINUE
     b. skillPath := filepath.Join(claudeSkillsDir, skillDir.Name(), "SKILL.md")
     c. IF SKILL.md does NOT exist: CONTINUE
     d. Parse front-matter, build SkillSummary with Provenance
     e. Append to results

6. // Also read skill.json for top-level manifest
7. skillJSONPath := filepath.Join(dir, "skill.json")
8. IF skillJSONPath exists:
     a. Parse JSON
     b. IF "name" field exists AND not already in results:
          // Create a synthetic SkillSummary pointing at the main SKILL.md
          // (typically .claude/skills/<name>/SKILL.md)
          mainSkillPath := filepath.Join(claudeSkillsDir, name, "SKILL.md")
          IF mainSkillPath exists:
               Parse front-matter, build SkillSummary with Provenance
               Append to results

9. RETURN results
```

### 4.7 `loadExternalManifest` Helper

```go
// loadExternalManifest reads MANIFEST.json from the external skills directory
// and returns a map of repo name → ExternalProvenance.
//
// If the manifest file does not exist, returns an empty map and a warning
// (the skill fetcher will create it on next session start).
// If the manifest exists but is malformed, returns an error.
func loadExternalManifest(externalDir string) (map[string]ExternalProvenance, error) {
    manifestPath := filepath.Join(externalDir, "MANIFEST.json")
    data, err := os.ReadFile(manifestPath)
    if err != nil {
        if os.IsNotExist(err) {
            fmt.Fprintf(os.Stderr, "[broker] warning: external skills manifest not found at %s — external skills will be skipped until the fetcher runs\n", manifestPath)
            return map[string]ExternalProvenance{}, nil
        }
        return nil, fmt.Errorf("read manifest %s: %w", manifestPath, err)
    }

    var raw struct {
        Version int                          `json:"version"`
        Repos   map[string]struct {
            URL         string `json:"url"`
            CommitSHA   string `json:"commit_sha"`
            License     string `json:"license"`
            Attribution string `json:"attribution"`
        } `json:"repos"`
    }
    if err := json.Unmarshal(data, &raw); err != nil {
        return nil, fmt.Errorf("parse manifest %s: %w", manifestPath, err)
    }

    result := make(map[string]ExternalProvenance, len(raw.Repos))
    for repoName, repoData := range raw.Repos {
        result[repoName] = ExternalProvenance{
            Repo:        repoName,
            CommitSHA:   repoData.CommitSHA,
            Attribution: repoData.Attribution,
            License:     repoData.License,
        }
    }
    return result, nil
}
```

### 4.8 Dedup Rule

When walking external skills, for each skill found:

```go
// In walkExternalSkills:
if seenNames[skillName] {
    fmt.Fprintf(os.Stderr, "[broker] debug: external skill %q from repo %q skipped — local skill with same name exists\n",
        skillName, provenance.Repo)
    continue
}
seenNames[skillName] = true
```

**Rule:** Local skills always win over external skills with the same name. The external skill is logged at debug level and excluded from the catalog.

### 4.9 Per-Agent Filtering

External skills go through the **exact same** `mergeTags(fmTags, role, scope)` function as local skills. The `agent-skill-scope.yaml` file's role tags determine visibility. External skills' front-matter `tags:` field is parsed by the same `parseSkillTags` function.

**No changes needed to `agent-skill-scope.yaml`** for Phase 2. The existing tag vocabulary covers the external skills' tag spaces adequately. If an external skill has tags that don't overlap with any role's YAML tags, it simply won't be visible to that role — same as a local skill with non-matching tags.

### 4.10 Broker Changes

**File:** `packages/broker-go/src/neuralgentics/broker/broker.go`

```go
// Broker struct — add ExternalDir field:
type Broker struct {
    // ... existing fields ...
    ExternalDir string  // NEW — path to ~/.neuralgentics/external_skills/
}

// NewBrokerWithExternal creates a Broker with external skill support.
func NewBrokerWithExternal(workspaceRoot, externalDir string) *Broker {
    reg := registry.NewRegistry()
    ac := access.NewAccessControl(access.DefaultServerRoles)
    return &Broker{
        registry:      reg,
        launcher:      launcher.NewLauncher(reg),
        proxy:         proxy.NewMCPProxy(),
        access:        ac,
        builder:       catalog.NewBuilderWithExternal(reg, ac, externalDir),
        httpClients:   make(map[string]proxy.Client),
        WorkspaceRoot: workspaceRoot,
        ExternalDir:   externalDir,
    }
}
```

**Note:** `NewBroker()` and `NewBrokerWithWorkspace()` remain unchanged — they create builders without external skills. Only `NewBrokerWithExternal()` wires the external dir. This preserves backward compatibility.

### 4.11 Test Plan

All new tests go in `packages/broker-go/src/neuralgentics/broker/catalog/skills_test.go` and `skills_integration_test.go`, following the existing test style (temp dirs, `NewBuilderWithAccess(nil, nil)`, `t.TempDir()`).

| Test Name | What It Verifies |
|-----------|-----------------|
| `TestBuildSkills_ExternalDir_OrchestratorSeesAll` | Orchestrator sees both local and external skills |
| `TestBuildSkills_ExternalDir_RoleFiltering` | External skills are filtered by role same as local |
| `TestBuildSkills_ExternalDir_ProvenanceStamped` | External skills have non-nil Provenance with correct fields |
| `TestBuildSkills_ExternalDir_DedupPrefersLocal` | Local skill with same name as external → local wins, external skipped |
| `TestBuildSkills_ExternalDir_MissingManifestSkipsExternal` | No MANIFEST.json → external skills skipped gracefully, catalog still has local skills |
| `TestBuildSkills_ExternalDir_AIResearchSkillsLayout` | Walker correctly finds skills in `01-model-architecture/litgpt/SKILL.md` pattern, skips non-skill dirs |
| `TestBuildSkills_ExternalDir_UIUXProMaxSkillLayout` | Walker correctly finds skills in `.claude/skills/*/SKILL.md` pattern |
| `TestLoadExternalManifest_Valid` | Parses valid MANIFEST.json → correct provenance map |
| `TestLoadExternalManifest_Missing` | No MANIFEST.json → empty map + no error |
| `TestLoadExternalManifest_Malformed` | Bad JSON → error |

---

## 5. Release-Time Bundling (T-SB-010)

### 5.1 `scripts/release.sh` Changes

Add a `run_external_fetcher` step BEFORE `build_dist`. Add `--skip-external-skills` flag.

```diff
--- a/scripts/release.sh
+++ b/scripts/release.sh
@@ -9,6 +9,7 @@ PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
 DRY_RUN=false
 VERBOSE=false
+SKIP_EXTERNAL_SKILLS=false

 # --- Colors ---
@@ -38,6 +39,7 @@ while [[ $# -gt 0 ]]; do
     --dry-run) DRY_RUN=true; shift ;;
     --verbose) VERBOSE=true; shift ;;
+    --skip-external-skills) SKIP_EXTERNAL_SKILLS=true; shift ;;
     -h|--help) usage ;;
     *) err "Unknown option: $1"; usage ;;
@@ -56,6 +58,30 @@ run() {
   fi
 }

+# --- External Skills Fetcher ---
+run_external_fetcher() {
+  if $SKIP_EXTERNAL_SKILLS; then
+    warn "Skipping external skills fetch (--skip-external-skills set)"
+    return 0
+  fi
+
+  local env_file="$PROJECT_ROOT/.env"
+  local enabled="false"
+  if [[ -f "$env_file" ]]; then
+    enabled=$(grep -E '^external_skills\.enabled=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "false")
+  fi
+
+  if [[ "$enabled" != "true" ]]; then
+    warn "external_skills.enabled is not 'true' — skipping external skills fetch"
+    return 0
+  fi
+
+  log "Fetching external skills..."
+  if ! run "$SCRIPT_DIR/external-skills-fetcher.sh"; then
+    err "External skills fetch failed. Use --skip-external-skills to bypass."
+    exit 1
+  fi
+}
+
 # --- Main ---
 main() {
@@ -66,6 +92,7 @@ main() {

   check_clean_tree
+  run_external_fetcher
   run_tests

   local tarball
```

**Usage help update:**

```diff
 Options:
   --dry-run   Show what would be done without executing
   --verbose   Enable verbose output
+  --skip-external-skills  Skip external skills fetch and bundling (lean tarball)
   -h, --help  Show this help message
```

### 5.2 `scripts/external-skills-fetcher.sh` (NEW)

Thin shell wrapper that calls the TS helper or runs git directly:

```bash
#!/usr/bin/env bash
set -e
# External Skills Fetcher — shell wrapper for release-time use.
# Clones/refreshes external skill repos into ~/.neuralgentics/external_skills/
# and writes MANIFEST.json.

EXTERNAL_DIR="$HOME/.neuralgentics/external_skills"
mkdir -p "$EXTERNAL_DIR"

# Repo 1: AI-Research-SKILLs
REPO1_DIR="$EXTERNAL_DIR/ai-research-skills"
REPO1_URL="https://github.com/Orchestra-Research/AI-Research-SKILLs.git"
if [[ ! -d "$REPO1_DIR" ]]; then
    echo "[external-skills] Cloning ai-research-skills..."
    git clone --depth 1 "$REPO1_URL" "$REPO1_DIR"
else
    echo "[external-skills] Refreshing ai-research-skills..."
    git -C "$REPO1_DIR" pull --ff-only || {
        echo "[external-skills] WARNING: git pull failed for ai-research-skills (network issue?)"
        echo "[external-skills] Using existing clone at $(git -C "$REPO1_DIR" rev-parse HEAD)"
    }
fi
SHA1=$(git -C "$REPO1_DIR" rev-parse HEAD)

# Repo 2: ui-ux-pro-max-skill
REPO2_DIR="$EXTERNAL_DIR/ui-ux-pro-max-skill"
REPO2_URL="https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git"
if [[ ! -d "$REPO2_DIR" ]]; then
    echo "[external-skills] Cloning ui-ux-pro-max-skill..."
    git clone --depth 1 "$REPO2_URL" "$REPO2_DIR"
else
    echo "[external-skills] Refreshing ui-ux-pro-max-skill..."
    git -C "$REPO2_DIR" pull --ff-only || {
        echo "[external-skills] WARNING: git pull failed for ui-ux-pro-max-skill (network issue?)"
        echo "[external-skills] Using existing clone at $(git -C "$REPO2_DIR" rev-parse HEAD)"
    }
fi
SHA2=$(git -C "$REPO2_DIR" rev-parse HEAD)

# Write MANIFEST.json
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$EXTERNAL_DIR/MANIFEST.json" <<MANIFESTEOF
{
  "version": 1,
  "updated_at": "$NOW",
  "repos": {
    "ai-research-skills": {
      "url": "$REPO1_URL",
      "commit_sha": "$SHA1",
      "license": "MIT",
      "attribution": "Copyright 2025 Claude AI Research Skills Contributors. Used under MIT License."
    },
    "ui-ux-pro-max-skill": {
      "url": "$REPO2_URL",
      "commit_sha": "$SHA2",
      "license": "MIT",
      "attribution": "Copyright 2024 Next Level Builder. Used under MIT License."
    }
  }
}
MANIFESTEOF

echo "[external-skills] MANIFEST.json written with commit SHAs: ai-research=$SHA1 ui-ux=$SHA2"
```

### 5.3 `scripts/build.sh` Changes

Extend `copy_runtime_files()` to also copy external skills:

```diff
--- a/scripts/build.sh
+++ b/scripts/build.sh
@@ -139,6 +139,22 @@ copy_runtime_files() {
   fi

+  # Copy external skills (if they exist and bundling is enabled)
+  local external_src="$HOME/.neuralgentics/external_skills"
+  if [[ -d "$external_src" ]]; then
+    local env_file="$PROJECT_ROOT/.env"
+    local bundle_enabled="true"
+    if [[ -f "$env_file" ]]; then
+      local opt_out
+      opt_out=$(grep -E '^external_skills\.bundle_in_tarball=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")
+      if [[ "$opt_out" == "false" ]]; then
+        bundle_enabled="false"
+      fi
+    fi
+    if [[ "$bundle_enabled" == "true" ]]; then
+      log "Bundling external skills..."
+      run rsync -a --exclude='.git/' "$external_src/" "$DIST_DIR/share/external_skills/"
+    else
+      warn "external_skills.bundle_in_tarball=false — skipping external skills bundle"
+    fi
+  fi
+
   # Copy node_modules (production only)
   if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
```

**Key details:**
- Uses `rsync -a --exclude='.git/'` to copy skill files but NOT the `.git/` directories (which would be huge and unnecessary).
- Checks `external_skills.bundle_in_tarball` from `.env`. Defaults to `true` if unset.
- If `~/.neuralgentics/external_skills/` doesn't exist (e.g., fetcher was skipped), the copy step is a no-op.

### 5.4 `scripts/install.sh` Changes

Add a step after extraction to unpack bundled external skills:

```diff
--- a/scripts/install.sh
+++ b/scripts/install.sh
@@ -286,6 +286,18 @@ if [[ -f "$PREFIX/.opencode/package.json" ]]; then
 fi

+# ── External skills (bundled in tarball) ─────────────────────────────────────
+
+if [[ -d "$PREFIX/share/external_skills" ]]; then
+  local external_target="$HOME/.neuralgentics/external_skills"
+  if [[ ! -d "$external_target" ]]; then
+    log "Installing bundled external skills to $external_target..."
+    cp -r "$PREFIX/share/external_skills" "$external_target"
+  else
+    log "External skills already exist at $external_target — skipping (fetcher will refresh on session start)"
+  fi
+fi
+
 # ── Env file ────────────────────────────────────────────────────────────────
```

**Key details:**
- **Idempotent:** Only copies if `~/.neuralgentics/external_skills/` does NOT already exist. If the user already has external skills (from a previous install or manual clone), the bundled snapshot is NOT overwritten.
- The fetcher skill will `git pull --ff-only` on first session start to refresh to the latest commit.

### 5.5 `update-gh-docs` SKILL.md Changes

Add Step 1.5 to the release flow:

```diff
--- a/.opencode/skills/update-gh-docs/SKILL.md
+++ b/.opencode/skills/update-gh-docs/SKILL.md
@@ -35,6 +35,14 @@ Common files in order of visibility:
 5. GitHub release notes (auto-generated from the tag push, but can be customized)

+### Step 1.5: Ensure external skills snapshot is fresh
+
+Before building the release tarball, verify that the external skills snapshot
+is up-to-date:
+
+- [ ] `~/.neuralgentics/external_skills/MANIFEST.json` exists and has valid commit SHAs
+- [ ] If `external_skills.enabled=true` in `.env`, run `scripts/external-skills-fetcher.sh` to refresh
+- [ ] If `external_skills.enabled=false` or unset, this step is a no-op
+
 ### Step 2: Read each file and check
```

### 5.6 Edge Cases

| Scenario | Behavior |
|----------|----------|
| No `.env` file | `external_skills.enabled` defaults to `false` → fetcher no-ops → no external skills in tarball (lean install) |
| `.env` has `external_skills.enabled=false` | Fetcher no-ops, build skips bundling |
| `.env` has `external_skills.enabled=true` but no network at release time | `git clone` fails → `release.sh` exits with error unless `--skip-external-skills` is set |
| `.env` has `external_skills.bundle_in_tarball=false` | Fetcher still runs (refreshes cache), but build skips copying to tarball |
| `--skip-external-skills` flag on release.sh | Entire external skills pipeline skipped → lean tarball |
| Install on machine that already has `~/.neuralgentics/external_skills/` | `install.sh` skips the copy (idempotent) |
| Install on fresh machine with bundled external skills | `install.sh` copies `share/external_skills/` → `~/.neuralgentics/external_skills/` |

### 5.7 Size Budget

| Repo | Files | Expected Size (after stripping .git/) |
|------|-------|--------------------------------------|
| AI-Research-SKILLs | ~778 files (mostly markdown) | ~5-8 MB |
| ui-ux-pro-max-skill | ~387 files (markdown + templates) | ~2-3 MB |
| **Total** | **~1,165 files** | **~7-11 MB** |

The current tarball is ~15-20 MB (plugin JS + node_modules + config). Adding ~10 MB is a ~50% increase but still well within acceptable limits for a developer tool. The `--skip-external-skills` flag provides an escape hatch for users who want the lean install.

---

## 6. LRU Body Cache (T-SB-011)

### 6.1 Design Decision: TS-Side Cache (Option B)

**Recommendation: TypeScript-side LRU cache in `skill_lookup.ts`.** The Go `SkillBodyCache` type is designed and unit-tested but NOT wired into a JSON-RPC method in Phase 2. Rationale:

| Factor | TS-Side (Option B) | Go-Side (Option A) | Hybrid (Option C) |
|--------|-------------------|-------------------|-------------------|
| Simplicity | In-process, no broker change | Requires new JSON-RPC method | Two caches to coordinate |
| Latency | Zero network overhead | JSON-RPC round-trip per body read | Mixed |
| Testability | `bun test` with temp files | `go test` with temp files | Both |
| Phase 2 fit | Excellent — `loadSkillBody` already does disk I/O in TS | Overengineered for Phase 2 | Unnecessary complexity |
| Phase 3 upgrade path | Can migrate to Go-side if needed | Already there | — |

**Decision:** The TS-side cache wraps the existing `loadSkillBody` function. The Go `SkillBodyCache` is designed, implemented, and unit-tested as a standalone type in `skill_cache.go` — it is ready for Phase 3 wiring if the team decides to move body loading to the broker.

### 6.2 Go `SkillBodyCache` Type

**File:** `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache.go` (CREATE)

```go
package catalog

import (
    "os"
    "sync"
    "time"
)

// SkillBodyCache is an in-memory LRU cache for SKILL.md body content.
//
// It stores full file bodies keyed by absolute path, with LRU eviction
// when the cache exceeds maxSkills entries or maxBytes total size.
// Cache entries are invalidated when the file's modTime changes.
//
// Phase 2: Designed and unit-tested but NOT wired into a JSON-RPC method.
// The TS-side cache in skill_lookup.ts is the active cache for Phase 2.
// This type is ready for Phase 3 wiring if body loading moves to the broker.
type SkillBodyCache struct {
    mu       sync.Mutex
    capacity int                  // max number of skill entries
    maxBytes int64                // max total bytes stored
    entries  map[string]*cacheEntry // key = absolute file path
    order    []string             // LRU order, oldest first (index 0 = eviction candidate)
    bytes    int64                // current total bytes stored
    hits     uint64               // cumulative cache hits
    misses   uint64               // cumulative cache misses
}

type cacheEntry struct {
    body    string
    modTime time.Time
    size    int64
}

// NewSkillBodyCache creates a new LRU cache for skill bodies.
//
// maxSkills is the maximum number of skills to cache (default: 100).
// maxBytes is the maximum total bytes to store (default: 5 * 1024 * 1024 = 5MB).
func NewSkillBodyCache(maxSkills int, maxBytes int64) *SkillBodyCache {
    if maxSkills <= 0 {
        maxSkills = 100
    }
    if maxBytes <= 0 {
        maxBytes = 5 * 1024 * 1024 // 5MB
    }
    return &SkillBodyCache{
        capacity: maxSkills,
        maxBytes: maxBytes,
        entries:  make(map[string]*cacheEntry),
        order:    make([]string, 0, maxSkills),
    }
}

// Get returns the cached body for the given file path.
//
// If the path is not in the cache, it reads the file from disk, caches it,
// and returns the body. If the file's modTime has changed since it was cached,
// the entry is invalidated and re-read from disk.
//
// Returns (body, true) on success, ("", false) if the file cannot be read.
func (c *SkillBodyCache) Get(path string) (string, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Check if cached and modTime still matches.
    if entry, ok := c.entries[path]; ok {
        info, err := os.Stat(path)
        if err == nil && info.ModTime().Equal(entry.modTime) {
            // Cache hit — promote to MRU.
            c.promoteToMRU(path)
            c.hits++
            return entry.body, true
        }
        // modTime changed — invalidate and fall through to re-read.
        c.removeEntry(path)
    }

    // Cache miss — read from disk.
    data, err := os.ReadFile(path)
    if err != nil {
        c.misses++
        return "", false
    }

    info, _ := os.Stat(path)
    modTime := time.Now()
    if info != nil {
        modTime = info.ModTime()
    }

    body := string(data)
    entrySize := int64(len(body))

    // Evict if necessary before inserting.
    c.evictFor(entrySize)

    entry := &cacheEntry{
        body:    body,
        modTime: modTime,
        size:    entrySize,
    }
    c.entries[path] = entry
    c.order = append(c.order, path)
    c.bytes += entrySize
    c.misses++

    return body, true
}

// Put inserts or refreshes a body in the cache.
//
// If the path already exists, the entry is updated and promoted to MRU.
// If the path is new, it is inserted after evicting if necessary.
func (c *SkillBodyCache) Put(path, body string) {
    c.mu.Lock()
    defer c.mu.Unlock()

    info, _ := os.Stat(path)
    modTime := time.Now()
    if info != nil {
        modTime = info.ModTime()
    }

    newSize := int64(len(body))

    // If already cached, update in place.
    if oldEntry, ok := c.entries[path]; ok {
        c.bytes -= oldEntry.size
        oldEntry.body = body
        oldEntry.modTime = modTime
        oldEntry.size = newSize
        c.bytes += newSize
        c.promoteToMRU(path)
        return
    }

    // New entry — evict if needed.
    c.evictFor(newSize)

    entry := &cacheEntry{
        body:    body,
        modTime: modTime,
        size:    newSize,
    }
    c.entries[path] = entry
    c.order = append(c.order, path)
    c.bytes += newSize
}

// Invalidate removes a single entry from the cache.
func (c *SkillBodyCache) Invalidate(path string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.removeEntry(path)
}

// InvalidateAll clears the entire cache.
func (c *SkillBodyCache) InvalidateAll() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.entries = make(map[string]*cacheEntry)
    c.order = make([]string, 0, c.capacity)
    c.bytes = 0
    // hits and misses are NOT reset — they are cumulative stats.
}

// Stats returns current cache statistics.
func (c *SkillBodyCache) Stats() (entries int, bytes int64, hits uint64, misses uint64) {
    c.mu.Lock()
    defer c.mu.Unlock()
    return len(c.entries), c.bytes, c.hits, c.misses
}

// ─── Internal helpers (caller must hold c.mu) ────────────────────────────────

// promoteToMRU moves the given path to the end of the order slice (most recently used).
func (c *SkillBodyCache) promoteToMRU(path string) {
    for i, p := range c.order {
        if p == path {
            // Remove from current position.
            c.order = append(c.order[:i], c.order[i+1:]...)
            // Append to end (MRU).
            c.order = append(c.order, path)
            return
        }
    }
}

// removeEntry deletes an entry from the cache without promoting or stats update.
func (c *SkillBodyCache) removeEntry(path string) {
    if entry, ok := c.entries[path]; ok {
        c.bytes -= entry.size
        delete(c.entries, path)
    }
    for i, p := range c.order {
        if p == path {
            c.order = append(c.order[:i], c.order[i+1:]...)
            return
        }
    }
}

// evictFor evicts the oldest entries until there is room for newBytes.
// Evicts until both len(entries) < capacity AND bytes + newBytes <= maxBytes.
func (c *SkillBodyCache) evictFor(newBytes int64) {
    for len(c.order) > 0 &&
        (len(c.entries) >= c.capacity || c.bytes+newBytes > c.maxBytes) {
        oldest := c.order[0]
        c.removeEntry(oldest)
    }
}
```

### 6.3 Go Unit Tests

**File:** `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache_test.go` (CREATE)

```go
package catalog

import (
    "os"
    "path/filepath"
    "sync"
    "testing"
    "time"
)

func TestSkillBodyCache_InsertAndGet(t *testing.T) {
    dir := t.TempDir()
    path := filepath.Join(dir, "test.md")
    content := "# Test Skill\n\nBody content."
    if err := os.WriteFile(path, []byte(content), 0644); err != nil {
        t.Fatal(err)
    }

    cache := NewSkillBodyCache(10, 1024*1024)
    body, ok := cache.Get(path)
    if !ok {
        t.Fatal("expected cache hit after read")
    }
    if body != content {
        t.Errorf("expected body %q, got %q", content, body)
    }

    // Second Get should be a cache hit (no disk read).
    body2, ok2 := cache.Get(path)
    if !ok2 {
        t.Fatal("expected cache hit on second read")
    }
    if body2 != content {
        t.Errorf("expected same body on second read")
    }

    entries, _, hits, misses := cache.Stats()
    if entries != 1 {
        t.Errorf("expected 1 entry, got %d", entries)
    }
    if hits != 1 {
        t.Errorf("expected 1 hit, got %d", hits)
    }
    if misses != 1 {
        t.Errorf("expected 1 miss, got %d", misses)
    }
}

func TestSkillBodyCache_EvictionAtCapacity(t *testing.T) {
    dir := t.TempDir()
    cache := NewSkillBodyCache(3, 1024*1024) // max 3 entries

    // Insert 5 files.
    for i := 0; i < 5; i++ {
        path := filepath.Join(dir, fmt.Sprintf("skill%d.md", i))
        content := fmt.Sprintf("Skill %d body", i)
        if err := os.WriteFile(path, []byte(content), 0644); err != nil {
            t.Fatal(err)
        }
        cache.Put(path, content)
    }

    entries, _, _, _ := cache.Stats()
    if entries != 3 {
        t.Errorf("expected 3 entries after eviction, got %d", entries)
    }

    // The first 2 should have been evicted (oldest).
    path0 := filepath.Join(dir, "skill0.md")
    if _, ok := cache.Get(path0); ok {
        t.Error("skill0 should have been evicted (oldest)")
    }
    path1 := filepath.Join(dir, "skill1.md")
    if _, ok := cache.Get(path1); ok {
        t.Error("skill1 should have been evicted (oldest)")
    }
    // skill2, skill3, skill4 should still be present.
    path4 := filepath.Join(dir, "skill4.md")
    if _, ok := cache.Get(path4); !ok {
        t.Error("skill4 should still be cached (newest)")
    }
}

func TestSkillBodyCache_EvictionAtByteLimit(t *testing.T) {
    dir := t.TempDir()
    cache := NewSkillBodyCache(100, 50) // max 50 bytes

    // Insert a 100-byte file — should evict itself? No, evictFor checks
    // len(entries) >= capacity OR bytes+newBytes > maxBytes.
    // With capacity=100, only the byte limit triggers.
    path := filepath.Join(dir, "big.md")
    content := strings.Repeat("x", 100)
    if err := os.WriteFile(path, []byte(content), 0644); err != nil {
        t.Fatal(err)
    }
    cache.Put(path, content)

    // The 100-byte entry should have been evicted because it exceeds maxBytes.
    entries, bytes, _, _ := cache.Stats()
    if entries != 0 {
        t.Errorf("expected 0 entries (100 bytes > 50 byte limit), got %d", entries)
    }
    if bytes != 0 {
        t.Errorf("expected 0 bytes, got %d", bytes)
    }
}

func TestSkillBodyCache_LRUOrder(t *testing.T) {
    dir := t.TempDir()
    cache := NewSkillBodyCache(3, 1024*1024)

    // Insert A, B, C.
    files := []string{"a.md", "b.md", "c.md"}
    for _, f := range files {
        path := filepath.Join(dir, f)
        os.WriteFile(path, []byte(f), 0644)
        cache.Put(path, f)
    }

    // Access A (promotes to MRU).
    cache.Get(filepath.Join(dir, "a.md"))

    // Insert D — should evict B (now oldest, since A was promoted).
    pathD := filepath.Join(dir, "d.md")
    os.WriteFile(pathD, []byte("d"), 0644)
    cache.Put(pathD, "d")

    // A should still be present (was promoted).
    if _, ok := cache.Get(filepath.Join(dir, "a.md")); !ok {
        t.Error("A should still be cached (promoted to MRU before D insert)")
    }
    // B should be evicted.
    if _, ok := cache.Get(filepath.Join(dir, "b.md")); ok {
        t.Error("B should have been evicted (oldest after A promotion)")
    }
    // C and D should be present.
    if _, ok := cache.Get(filepath.Join(dir, "c.md")); !ok {
        t.Error("C should still be cached")
    }
    if _, ok := cache.Get(filepath.Join(dir, "d.md")); !ok {
        t.Error("D should be cached")
    }
}

func TestSkillBodyCache_ModTimeInvalidation(t *testing.T) {
    dir := t.TempDir()
    path := filepath.Join(dir, "skill.md")
    content1 := "Version 1"
    if err := os.WriteFile(path, []byte(content1), 0644); err != nil {
        t.Fatal(err)
    }

    cache := NewSkillBodyCache(10, 1024*1024)
    body1, ok := cache.Get(path)
    if !ok || body1 != content1 {
        t.Fatalf("expected %q, got %q", content1, body1)
    }

    // Modify the file on disk.
    time.Sleep(10 * time.Millisecond) // ensure modTime changes
    content2 := "Version 2"
    if err := os.WriteFile(path, []byte(content2), 0644); err != nil {
        t.Fatal(err)
    }

    // Get should detect modTime change and re-read.
    body2, ok := cache.Get(path)
    if !ok || body2 != content2 {
        t.Fatalf("expected %q after modTime change, got %q", content2, body2)
    }

    // Stats: 2 misses (first read + re-read after modTime change), 0 hits.
    _, _, hits, misses := cache.Stats()
    if misses != 2 {
        t.Errorf("expected 2 misses, got %d", misses)
    }
    if hits != 0 {
        t.Errorf("expected 0 hits, got %d", hits)
    }
}

func TestSkillBodyCache_ConcurrentAccess(t *testing.T) {
    dir := t.TempDir()
    path := filepath.Join(dir, "shared.md")
    content := "Shared content"
    if err := os.WriteFile(path, []byte(content), 0644); err != nil {
        t.Fatal(err)
    }

    cache := NewSkillBodyCache(10, 1024*1024)
    var wg sync.WaitGroup

    // 10 goroutines concurrently reading the same file.
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            body, ok := cache.Get(path)
            if !ok || body != content {
                t.Errorf("concurrent Get failed: ok=%v body=%q", ok, body)
            }
        }()
    }
    wg.Wait()

    // Should have exactly 1 entry, 1 miss, 9 hits.
    entries, _, hits, misses := cache.Stats()
    if entries != 1 {
        t.Errorf("expected 1 entry, got %d", entries)
    }
    if misses != 1 {
        t.Errorf("expected 1 miss, got %d", misses)
    }
    if hits != 9 {
        t.Errorf("expected 9 hits, got %d", hits)
    }
}

func TestSkillBodyCache_Invalidate(t *testing.T) {
    dir := t.TempDir()
    path := filepath.Join(dir, "skill.md")
    os.WriteFile(path, []byte("content"), 0644)

    cache := NewSkillBodyCache(10, 1024*1024)
    cache.Put(path, "content")

    entries, _, _, _ := cache.Stats()
    if entries != 1 {
        t.Fatalf("expected 1 entry before invalidate, got %d", entries)
    }

    cache.Invalidate(path)
    entries, _, _, _ = cache.Stats()
    if entries != 0 {
        t.Errorf("expected 0 entries after invalidate, got %d", entries)
    }
}

func TestSkillBodyCache_InvalidateAll(t *testing.T) {
    dir := t.TempDir()
    cache := NewSkillBodyCache(10, 1024*1024)

    for i := 0; i < 5; i++ {
        path := filepath.Join(dir, fmt.Sprintf("skill%d.md", i))
        os.WriteFile(path, []byte(fmt.Sprintf("content%d", i)), 0644)
        cache.Put(path, fmt.Sprintf("content%d", i))
    }

    entries, _, _, _ := cache.Stats()
    if entries != 5 {
        t.Fatalf("expected 5 entries before InvalidateAll, got %d", entries)
    }

    cache.InvalidateAll()
    entries, bytes, _, _ := cache.Stats()
    if entries != 0 {
        t.Errorf("expected 0 entries after InvalidateAll, got %d", entries)
    }
    if bytes != 0 {
        t.Errorf("expected 0 bytes after InvalidateAll, got %d", bytes)
    }
}

func TestSkillBodyCache_MissingFile(t *testing.T) {
    cache := NewSkillBodyCache(10, 1024*1024)
    _, ok := cache.Get("/nonexistent/path/skill.md")
    if ok {
        t.Error("expected false for missing file")
    }
    _, _, _, misses := cache.Stats()
    if misses != 1 {
        t.Errorf("expected 1 miss, got %d", misses)
    }
}
```

---

## 7. TypeScript LRU Body Cache Extension

### 7.1 Modify `skill_lookup.ts`

**File:** `packages/plugin/src/self-evolution/skill_lookup.ts`

Add a TS-side LRU cache that wraps `loadSkillBody`. The cache is a simple Map-based LRU with no external dependencies.

```typescript
// ============================================================================
// LRU Body Cache (TS-side, Phase 2)
// ============================================================================

/**
 * SkillBodyCache — in-memory LRU cache for SKILL.md body content.
 *
 * Stores full file bodies keyed by absolute path, with LRU eviction
 * when the cache exceeds maxEntries or maxBytes. Cache entries are
 * invalidated when the file's mtimeMs changes.
 *
 * Phase 2: This is the active body cache. The Go SkillBodyCache type
 * is designed and unit-tested but not wired into JSON-RPC yet.
 */
export class SkillBodyCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CachedBody>();
  private readonly order: string[] = [];  // LRU order, oldest first
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(maxEntries: number = 100, maxBytes: number = 5 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /**
   * Get the body for a skill path, using cache if available.
   *
   * If the path is cached and the file's mtimeMs hasn't changed,
   * returns the cached body. Otherwise reads from disk, caches,
   * and returns.
   *
   * @returns The body string, or empty string if the file can't be read.
   */
  async get(path: string): Promise<string> {
    // Check cache.
    const cached = this.entries.get(path);
    if (cached) {
      try {
        const stat = await stat(path);
        if (stat.mtimeMs === cached.mtimeMs) {
          // Cache hit — promote to MRU.
          this.promoteToMRU(path);
          this.hitCount++;
          return cached.body;
        }
        // mtimeMs changed — invalidate and fall through.
        this.removeEntry(path);
      } catch {
        // File gone — invalidate and fall through.
        this.removeEntry(path);
      }
    }

    // Cache miss — read from disk.
    this.missCount++;
    try {
      const body = await readFile(path, "utf-8");
      let mtimeMs = 0;
      try {
        const stat = await stat(path);
        mtimeMs = stat.mtimeMs;
      } catch { /* ignore */ }

      this.evictFor(body.length);
      this.entries.set(path, { body, mtimeMs, size: body.length });
      this.order.push(path);
      this.totalBytes += body.length;
      return body;
    } catch {
      return "";
    }
  }

  /** Invalidate a single entry. */
  invalidate(path: string): void {
    this.removeEntry(path);
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.entries.clear();
    this.order.length = 0;
    this.totalBytes = 0;
  }

  /** Get cache statistics for debugging. */
  cacheStats(): { entries: number; bytes: number; hits: number; misses: number } {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private promoteToMRU(path: string): void {
    const idx = this.order.indexOf(path);
    if (idx !== -1) {
      this.order.splice(idx, 1);
      this.order.push(path);
    }
  }

  private removeEntry(path: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      this.totalBytes -= entry.size;
      this.entries.delete(path);
    }
    const idx = this.order.indexOf(path);
    if (idx !== -1) {
      this.order.splice(idx, 1);
    }
  }

  private evictFor(newBytes: number): void {
    while (
      this.order.length > 0 &&
      (this.entries.size >= this.maxEntries || this.totalBytes + newBytes > this.maxBytes)
    ) {
      const oldest = this.order[0];
      this.removeEntry(oldest);
    }
  }
}

interface CachedBody {
  body: string;
  mtimeMs: number;
  size: number;
}
```

### 7.2 Wire Cache into `SkillLookup`

```typescript
export class SkillLookup {
  private readonly broker: BrokerClient;
  private readonly threshold: number;
  private readonly bodyCache: SkillBodyCache;  // NEW

  constructor(broker: BrokerClient, threshold: number = MIN_SCORE) {
    this.broker = broker;
    this.threshold = threshold;
    this.bodyCache = new SkillBodyCache();  // NEW — default 100 entries, 5MB
  }

  async pickSkill(
    taskContext: string,
    role: string = "orchestrator",
  ): Promise<SkillMatchResult | null> {
    // ... existing catalog query and cosine matching unchanged ...

    // Load body via cache instead of direct disk read.
    const body = await this.bodyCache.get(best.path);  // CHANGED from loadSkillBody(best.path)

    return { name: best.name, body, score: best.score };
  }

  /** Expose cache stats for debugging. */
  cacheStats() {
    return this.bodyCache.cacheStats();
  }
}
```

**Note:** The existing `loadSkillBody` function is kept for backward compatibility but is no longer called by `pickSkill`. It can be deprecated in a future phase.

### 7.3 Import Addition

```typescript
import { readFile, stat } from "node:fs/promises";
```

The existing import of `readFile` from `node:fs/promises` is already present. Add `stat` to the import.

---

## 8. Quality Gates Per Card

### T-SB-008: external-skills-fetcher

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**Additional checks:**
- `git` must be installed on the build machine (`which git`).
- Manual smoke: run the fetcher, verify `~/.neuralgentics/external_skills/MANIFEST.json` is written with valid JSON and real commit SHAs.
- Test offline behavior: disconnect network, run fetcher, verify it logs warnings and continues.

### T-SB-009: Extend SkillCatalog

```bash
cd packages/broker-go && go vet ./... && go test ./src/neuralgentics/broker/catalog/ -v -count=1 && go build ./...
```

**New tests must pass:**
- All 9 tests listed in §4.11.
- Existing tests must continue to pass (no regressions).

### T-SB-010: Release-Time Bundling

```bash
# Syntax check on all modified shell scripts
bash -n scripts/release.sh
bash -n scripts/build.sh
bash -n scripts/install.sh
bash -n scripts/external-skills-fetcher.sh

# Manual dry-run
./scripts/release.sh --dry-run --verbose
./scripts/release.sh --dry-run --skip-external-skills
```

**Additional checks:**
- Verify `--skip-external-skills` flag works.
- Verify tarball does NOT contain `.git/` directories in `share/external_skills/`.
- Verify `install.sh` idempotency: run twice, second run should skip external skills copy.

### T-SB-011: LRU Body Cache

```bash
# Go cache tests
cd packages/broker-go && go test -race ./src/neuralgentics/broker/catalog/ -run TestSkillBodyCache -v -count=1

# TS cache tests
cd packages/plugin && bun test -- --testPathPattern="skill_lookup" && npx tsc --noEmit
```

**Race detector is mandatory** for the Go cache tests (`-race` flag) because the cache uses `sync.Mutex` for concurrent access.

---

## 9. Wave 2 Dispatch Plan (Read-Only)

| Wave | Coder  | Cards           | Files                                        | Depends On                |
| ---- | ------ | --------------- | -------------------------------------------- | ------------------------- |
| 2a   | #1     | T-SB-008        | `/.opencode/skills/external-skills-fetcher/SKILL.md` (CREATE), `packages/plugin/src/self-evolution/external_fetcher.ts` (CREATE) | None                      |
| 2b   | #2     | T-SB-009        | `packages/broker-go/src/neuralgentics/broker/catalog/skills.go` (MODIFY), `catalog.go` (MODIFY), `broker.go` (MODIFY), `skills_test.go` (MODIFY), `skills_integration_test.go` (MODIFY) | None (parallel)           |
| 2c   | #3     | T-SB-011        | `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache.go` (CREATE), `skill_cache_test.go` (CREATE), `packages/plugin/src/self-evolution/skill_lookup.ts` (MODIFY) | None (parallel)           |
| 2d   | #4     | T-SB-010        | `scripts/release.sh` (MODIFY), `scripts/external-skills-fetcher.sh` (CREATE), `scripts/build.sh` (MODIFY), `scripts/install.sh` (MODIFY), `.opencode/skills/update-gh-docs/SKILL.md` (MODIFY) | None (parallel)           |
| 3    | tester | Integration     | All                                          | All coder waves complete  |

**Parallelism rationale:** All 4 coder dispatches can run in PARALLEL — no shared files:

- T-SB-008 touches `.opencode/skills/external-skills-fetcher/` + `packages/plugin/src/self-evolution/external_fetcher.ts` (both NEW).
- T-SB-009 touches `packages/broker-go/` files only.
- T-SB-011 touches `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache.go` (NEW, different file from skills.go) + `packages/plugin/src/self-evolution/skill_lookup.ts` (different file from external_fetcher.ts).
- T-SB-010 touches `scripts/` + `.opencode/skills/update-gh-docs/` only.

**No file overlap between any two coders.** The TS LRU change in T-SB-011 is in `skill_lookup.ts`, which is a different file from `external_fetcher.ts` in T-SB-008. The Go cache in T-SB-011 is in `skill_cache.go`, which is a different file from `skills.go` in T-SB-009. The release script changes in T-SB-010 don't overlap with anything else.

---

## 10. Open Questions / Risks

### 10.1 Tarball Size Increase

**Impact:** ~10 MB increase (from ~15-20 MB to ~25-30 MB). This is a ~50% size increase.

**Mitigation:**
- `--skip-external-skills` flag on `release.sh` for emergency lean builds.
- `external_skills.bundle_in_tarball=false` in `.env` for permanent opt-out.
- The `install.sh` script only copies external skills if they don't already exist (idempotent).

**Acceptance:** 25-30 MB is well within acceptable limits for a developer tool in 2026. VS Code is ~100 MB, Docker Desktop is ~500 MB. The value of having ~400 pre-vetted skills available offline outweighs the size cost.

### 10.2 Network Availability at Release Time

**Risk:** `git clone` of external repos fails during release build.

**Mitigation:**
- `release.sh` fails with a clear error message: "External skills fetch failed. Use --skip-external-skills to bypass."
- The `--skip-external-skills` flag provides an immediate escape hatch.
- The release can proceed without external skills; the tarball will be lean.

**Recommendation:** Fail the release by default. A release with stale/missing external skills is a quality issue. The operator should consciously choose `--skip-external-skills` if they want to ship without them.

### 10.3 Network Availability at Session Start

**Risk:** `git pull --ff-only` fails because the user is offline.

**Mitigation:** The fetcher catches network errors and logs a warning. It uses the existing clone's HEAD SHA for the manifest. The session proceeds with the last-known-good external skills.

**Graceful degradation:** If the user has never run the fetcher (no clone exists) AND is offline, the catalog simply has no external skills. Local skills still work. This is the same behavior as `external_skills.enabled=false`.

### 10.4 Skill Name Collisions

**Risk:** A local skill and an external skill have the same `name` in their front-matter.

**Mitigation:** Local wins. The external skill is logged at debug level and excluded from the catalog. This is documented in §4.8.

**User-facing impact:** If a user creates a local skill with the same name as a popular external skill, the external one is silently hidden. This is intentional — local customization should take precedence.

### 10.5 MANIFEST.json Commit SHA Tracking

**Risk:** An external repo force-pushes or rewrites history, changing the commit SHA. The cached MANIFEST.json has a stale SHA.

**Mitigation:** The skill cache's `modTime`-based invalidation handles this automatically. When the fetcher runs `git pull --ff-only` and the repo updates, the files on disk change → their `modTime` changes → the cache invalidates and re-reads. The MANIFEST.json itself is rewritten by the fetcher on every run, so its commit SHA is always current.

**Edge case:** If a repo force-pushes to the same commit SHA (extremely unlikely), the `modTime` of the files wouldn't change. This is acceptable — the content is the same.

### 10.6 Memory Cost of In-Memory LRU

**Impact:** 5 MB of heap memory for the TS-side body cache. Negligible for a Node.js process that typically uses 50-200 MB.

**Go-side cache:** The Go `SkillBodyCache` is designed but NOT populated in Phase 2 (it's unit-tested only). If wired in Phase 3, it would add another 5 MB to the Go backend process (~30-50 MB typical). Still negligible.

### 10.7 Cache Location Decision (TS-Side vs Go-Side)

**Decision:** TS-side for Phase 2. Documented in §6.1.

**Phase 3 upgrade path:** If the team decides to move body loading to the broker (e.g., to serve bodies via JSON-RPC for non-TS clients), the Go `SkillBodyCache` is already designed, implemented, and unit-tested. Wiring it into a `broker.getSkillBody` JSON-RPC method is a straightforward Phase 3 task.

### 10.8 External Skill Trust Scoring

**Phase 2 does NOT implement trust scoring for external skills.** External skills start with the default trust for their role's scope match (same as local skills). The trust engine in memini-ai will naturally adjust trust based on usage signals (`agent_used`, `agent_ignored`, `user_corrected`).

**Phase 3 work:** Implement a trust bootstrap for external skills based on:
- Repo stars, commit frequency, contributor count (community signal)
- Cross-repo citation count (how many other skills reference this one)
- Usage frequency across sessions (internal signal)

This is out of scope for Phase 2.

### 10.9 `0-autoresearch-skill/` in AI-Research-SKILLs

The AI-Research-SKILLs repo has a top-level dir `0-autoresearch-skill/`. The walker regex `^[0-9]+-.*/` would match this (since `0-` matches `[0-9]+-`). If this directory contains a `SKILL.md`, it will be included as an external skill. This is acceptable — it's a legitimate skill in the repo. If it does NOT contain a `SKILL.md`, the walker will skip it (the inner loop checks for `SKILL.md` existence).

---

## Appendix A: File Manifest

| Card | File | Action |
|------|------|--------|
| T-SB-008 | `.opencode/skills/external-skills-fetcher/SKILL.md` | **Create** (dir + file) |
| T-SB-008 | `packages/plugin/src/self-evolution/external_fetcher.ts` | **Create** |
| T-SB-009 | `packages/broker-go/src/neuralgentics/broker/catalog/skills.go` | **Modify** (add external walk, dedup, provenance) |
| T-SB-009 | `packages/broker-go/src/neuralgentics/broker/catalog/catalog.go` | **Modify** (add `externalDir`, `manifest` to Builder, new constructors) |
| T-SB-009 | `packages/broker-go/src/neuralgentics/broker/broker.go` | **Modify** (add `ExternalDir`, `NewBrokerWithExternal`) |
| T-SB-009 | `packages/broker-go/src/neuralgentics/broker/catalog/skills_test.go` | **Modify** (add external skill tests) |
| T-SB-009 | `packages/broker-go/src/neuralgentics/broker/catalog/skills_integration_test.go` | **Modify** (add external skill integration tests) |
| T-SB-010 | `scripts/release.sh` | **Modify** (add `run_external_fetcher`, `--skip-external-skills`) |
| T-SB-010 | `scripts/external-skills-fetcher.sh` | **Create** |
| T-SB-010 | `scripts/build.sh` | **Modify** (extend `copy_runtime_files`) |
| T-SB-010 | `scripts/install.sh` | **Modify** (add external skills unpack step) |
| T-SB-010 | `.opencode/skills/update-gh-docs/SKILL.md` | **Modify** (add Step 1.5) |
| T-SB-011 | `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache.go` | **Create** |
| T-SB-011 | `packages/broker-go/src/neuralgentics/broker/catalog/skill_cache_test.go` | **Create** |
| T-SB-011 | `packages/plugin/src/self-evolution/skill_lookup.ts` | **Modify** (add `SkillBodyCache` class, wire into `pickSkill`) |

---

## Appendix B: Locked Decisions Reference

These decisions were locked in Session 29 and must NOT be re-litigated during implementation:

| Decision | Value |
|----------|-------|
| Clone at release AND refresh on session start | Both repos |
| Toggle via `external_skills.enabled` in `.env` | Default: `false` (opt-in) |
| Cache location | `~/.neuralgentics/external_skills/` |
| Provenance stamping | `{source: "external", repo, commit_sha, attribution}` on every external skill |
| Skip-if-exists + `git pull --ff-only` on refresh | Idempotent |
| Skill body cache | LRU ~100 skills × 50KB = 5MB cap |
| One task per coder per dispatch | Enforced (AGENTS.md Rule 4) |
| Wave 2 parallelism | All 4 coders can run in parallel (no shared files) |
| TS-side cache for Phase 2 | Go cache designed + unit-tested, not wired to JSON-RPC |
| Local wins on name collision | External skill skipped, logged at debug level |
| `--skip-external-skills` flag | Emergency lean builds |
