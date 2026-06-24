# Skills Brokering + Auto-Evolution — Phase 1 Design

**Status:** Design Complete (2026-06-24, Session 29)
**Author:** boomerang-architect
**Plan Reference:** memini-ai memory `fbfeca3b-b8c4-4718-a971-81750cb390df`
**Session Summary:** memini-ai memory `4d4fe00f-355a-494e-bdb0-2cec3b7ef350`

---

## 1. Overview & Goals

Phase 1 wires the Neuralgentics broker to serve as a **skills broker** — not just an MCP-tool router. It adds a `SkillCatalog` (mirroring the existing `ServerCatalog`), a `ListSkills(role)` JSON-RPC method, a per-agent skill-scope YAML policy file, and an orchestrator pre-dispatch hook (`skill_lookup.ts`) that automatically picks the best matching skill for a task by cosine similarity. Simultaneously, it flips the `SelfEvolutionGate` default to `autoCreate: true` and wires the gate to run **before** every compaction backup and every `//boomerang-handoff` invocation — so newly-created skills are captured in backups and visible to the next session. This makes the "skills broker" framing legitimate: the broker becomes the single source of truth for "what can this agent reach?" — tools AND skills, same role-filtered JSON-RPC surface.

---

## 2. Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│                        NEURALGENTICS PLUGIN (TS)                     │
│                                                                      │
│  ┌─────────────────────┐    ┌──────────────────────────────────┐    │
│  │ handleCompaction()  │    │  //boomerang-handoff SKILL.md    │    │
│  │ (hooks/compaction.ts)│    │  (.opencode/skills/boomerang-   │    │
│  │                     │    │   handoff/SKILL.md)              │    │
│  │  ┌───────────────┐  │    │                                  │    │
│  │  │ gate.run()    │  │    │  Step 1: run evolution gate      │    │
│  │  │ {autoCreate:  │  │    │  Step 2: run handoff             │    │
│  │  │  true}        │  │    │  Step 3: commit new SKILL.md     │    │
│  │  └──────┬────────┘  │    │  Step 4: return handle           │    │
│  │         │           │    └──────────┬───────────────────────┘    │
│  │         ▼           │               │                            │
│  │  CRITICAL_FILES     │               │                            │
│  │  backup loop        │               │                            │
│  └─────────────────────┘               │                            │
│                                        │                            │
│  ┌─────────────────────────────────────┼────────────────────────┐   │
│  │  skill_lookup.ts                    │                        │   │
│  │  (self-evolution/skill_lookup.ts)   │                        │   │
│  │                                     ▼                        │   │
│  │  pickSkill(taskContext, role) ──► ListSkills(role) ──►      │   │
│  │       │                         JSON-RPC call                │   │
│  │       ▼                                                    │   │
│  │  cosine(taskVec, skillVec) → top-1 if score ≥ 0.6          │   │
│  │  returns {name, body, score}                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  SelfEvolutionGate (self-evolution/index.ts)                  │   │
│  │  autoCreate: true (flipped from false)                       │   │
│  │  run({autoCreate?: boolean}) → {evaluated, qualified,        │   │
│  │                                  created}                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ JSON-RPC over stdio
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     NEURALGENTICS BACKEND (Go)                        │
│                                                                      │
│  processRequest() switch:                                            │
│    case "broker.listSkills": → handleBrokerListSkills(req, brk)      │
│                                                                      │
│  handleBrokerListSkills():                                           │
│    cat := brk.BuildSkills(params.Role, workspaceRoot)                 │
│    return successResponse(req.ID, cat)                               │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     BROKER (Go)                                       │
│                                                                      │
│  Broker struct:                                                      │
│    + WorkspaceRoot string  (NEW FIELD)                               │
│                                                                      │
│  NewBroker(workspaceRoot string) *Broker  (SIGNATURE CHANGE)         │
│                                                                      │
│  BuildSkills(role, workspaceRoot string) *catalog.SkillCatalog       │
│    └─► catalog.Builder.BuildSkills(role, workspaceRoot)              │
│         │                                                            │
│         ├─► LoadScope(agent-skill-scope.yaml)                       │
│         ├─► Walk .opencode/skills/*/SKILL.md                        │
│         ├─► Parse front-matter (name, description, tags)            │
│         ├─► Merge tags (YAML baseline + front-matter override)      │
│         └─► Return SkillCatalog                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ reads from disk
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     FILESYSTEM                                       │
│                                                                      │
│  agent-skill-scope.yaml  (repo root, NEW)                            │
│  .opencode/skills/*/SKILL.md  (existing + auto-created)              │
│  skills/*.md  (legacy, SKIPPED in Phase 1)                          │
└──────────────────────────────────────────────────────────────────────┘
```

**Two wiring points:**
- **(a)** `handleCompaction` calls `gate.run({autoCreate: true})` **BEFORE** the `CRITICAL_FILES` backup loop — so any newly-created `SKILL.md` is captured in the compaction backup memory snapshot.
- **(b)** The `//boomerang-handoff` skill runs `gate.run({autoCreate: true})` **BEFORE** the handoff commit — so freshly-created skills are visible to the next session.

---

## 3. SkillCatalog Data Model (Go) — for T-SB-004

### 3.1 Structs

```go
// SkillSummary is a lightweight description of a skill for catalog display.
type SkillSummary struct {
    Name        string   `json:"name"`         // from SKILL.md front-matter
    Description string   `json:"description"`  // from SKILL.md front-matter
    Source      string   `json:"source"`       // "local" | "external" (Phase 1: always "local")
    Tags        []string `json:"tags"`         // merged from YAML + front-matter
    Path        string   `json:"path"`         // relative to workspace root
    SizeBytes   int64    `json:"size_bytes"`   // file size of SKILL.md
    AgentScope  []string `json:"agent_scope"`  // roles this skill is visible to (merged)
}

// SkillCatalog is an aggregate view of all available skills, filtered by role.
type SkillCatalog struct {
    Skills      []SkillSummary `json:"skills"`
    TotalSkills int            `json:"total_skills"`
    Role        string         `json:"role"` // the role this catalog was built for
}
```

### 3.2 YAML Scope Loader

```go
// Scope represents the parsed agent-skill-scope.yaml file.
type Scope struct {
    Version int                `yaml:"version"`
    Roles   map[string][]string `yaml:"roles"` // role-name → [list, of, tags]
}

// LoadScope reads and parses agent-skill-scope.yaml from the given path.
// Returns an empty Scope (no filtering) if the file does not exist.
func LoadScope(path string) (*Scope, error)
```

**Contract:** If the YAML file is missing, `LoadScope` returns `&Scope{Version: 1, Roles: map[string][]string{}}` — an empty scope means **no filtering** (all skills visible to all roles). This is the "allow-all" default.

### 3.3 Front-Matter Parser

```go
// parseSkillFrontMatter extracts the YAML front-matter block from a SKILL.md file.
// The front-matter is delimited by "---\n...\n---" at the top of the file.
// Returns the parsed front-matter map, the body (everything after the second "---"),
// and any parse error.
func parseSkillFrontMatter(content string) (frontMatter map[string]interface{}, body string, err error)
```

**Contract:**
- If the file does not start with `---\n`, return empty front-matter and the full content as body (no error).
- If the opening `---` is present but no closing `---` is found, return an error.
- Extract `name` (string), `description` (string), `tags` ([]string or comma-separated string) from the front-matter.
- `tags` in front-matter may be a YAML list (`[tag1, tag2]`) or a comma-separated string (`"tag1, tag2"`). The parser normalizes to `[]string`.

### 3.4 Builder.BuildSkills Algorithm

```go
// BuildSkills constructs a SkillCatalog filtered by role.
// workspaceRoot is the absolute path to the project root.
func (b *Builder) BuildSkills(role string, workspaceRoot string) SkillCatalog
```

**Algorithm (pseudocode):**

```
1. scopePath := filepath.Join(workspaceRoot, "agent-skill-scope.yaml")
2. scope, err := LoadScope(scopePath)
   // If err != nil, log warning and use empty scope (allow-all)
3. skills := []SkillSummary{}
4. skillDirs := walkDirectories(filepath.Join(workspaceRoot, ".opencode", "skills"))
   // Each dir contains a SKILL.md file
5. FOR EACH skillDir IN skillDirs:
     a. skillPath := filepath.Join(skillDir, "SKILL.md")
     b. content := readFile(skillPath)
     c. fm, body, err := parseSkillFrontMatter(content)
        // If err != nil, skip this skill (log warning)
     d. name := fm["name"].(string)  // required
     e. description := fm["description"].(string)  // required
     f. fmTags := normalizeTags(fm["tags"])  // []string, may be empty
     g. fileInfo := stat(skillPath)
     h. mergedTags, agentScope := mergeTags(name, fmTags, role, scope)
     i. IF role != "" AND role NOT IN agentScope:
          CONTINUE  // skip — this skill is not visible to this role
     j. skills = append(skills, SkillSummary{
          Name:        name,
          Description: description,
          Source:      "local",
          Tags:        mergedTags,
          Path:        relativePath(skillPath, workspaceRoot),
          SizeBytes:   fileInfo.Size(),
          AgentScope:  agentScope,
        })
6. RETURN SkillCatalog{Skills: skills, TotalSkills: len(skills), Role: role}
```

**Phase 1 scope:** Only walk `/.opencode/skills/*/SKILL.md`. The legacy `skills/` directory (with `<role>.md` files like `architect.md`, `coder.md`) is **skipped** in Phase 1. See §12 Open Questions for rationale.

### 3.5 Tag Merge Rule (Exact Specification)

The tag merge rule determines which skills are visible to which roles. It is a **hybrid** of YAML baseline + SKILL.md front-matter override.

**Definitions:**
- **YAML baseline:** `agent-skill-scope.yaml` defines, per role, a list of tags that role is allowed to see. Example: `tester: [verification, quality, regression, e2e]`.
- **Front-matter tags:** Each `SKILL.md` may have a `tags:` field in its front-matter. Tags can be **additive** (`+tag`) or **subtractive** (`-tag`). Plain tags (no prefix) are treated as additive.

**Merge algorithm (per skill, per role):**

```
function mergeTags(skillName, fmTags, role, scope):
    // Step 1: Get YAML baseline tags for this role
    yamlTags := scope.Roles[role]  // may be nil if role not in YAML

    // Step 2: If YAML has no entry for this role AND scope is non-empty:
    //         This role is not explicitly listed → skill is NOT visible
    //         UNLESS the role is "orchestrator" (wildcard).
    //         If scope is empty (file missing), allow all.
    if scope.Version > 0 AND len(scope.Roles) > 0:
        if role == "orchestrator":
            agentScope = allKnownRoles()
        else if yamlTags == nil:
            agentScope = []  // role not listed → no access
        else:
            agentScope = [role]
    else:
        agentScope = allKnownRoles()  // no YAML → allow all

    // Step 3: If the skill has NO tags in front-matter:
    //         Inherit YAML-default tags for its role (if any).
    //         If YAML has no tags for this role, skill is visible to all roles
    //         (but agentScope from Step 2 still applies).
    if len(fmTags) == 0:
        if yamlTags != nil:
            mergedTags = yamlTags
        else:
            mergedTags = []  // no tags → visible to all (empty = wildcard)
        return mergedTags, agentScope

    // Step 4: Skill HAS front-matter tags. Apply additive/subtractive modifiers.
    mergedTags = copy(yamlTags)  // start from YAML baseline (may be nil)
    for tag in fmTags:
        if tag starts with "-":
            remove tag[1:] from mergedTags
        else if tag starts with "+":
            add tag[1:] to mergedTags (dedup)
        else:
            add tag to mergedTags (dedup)

    // Step 5: Role filter check.
    // A role can see this skill if:
    //   - role is "orchestrator" (wildcard), OR
    //   - any of the mergedTags overlaps with yamlTags for this role, OR
    //   - yamlTags is nil (role not in YAML → no filter)
    if role != "orchestrator" AND yamlTags != nil:
        overlap := intersection(mergedTags, yamlTags)
        if len(overlap) == 0:
            agentScope = []  // no tag overlap → not visible

    return mergedTags, agentScope
```

**Summary of rules:**
| Condition | Behavior |
|-----------|----------|
| YAML file missing | All skills visible to all roles (no filter) |
| Role is `orchestrator` | Sees everything (wildcard, mirrors `CanAccess` orchestrator wildcard) |
| Role not listed in YAML | Role sees no skills (unless orchestrator) |
| Skill has no `tags:` in front-matter | Inherits YAML-default tags for its role; if YAML has no tags for that role, skill is visible to all |
| Skill has `tags:` in front-matter | Must have at least one tag overlap with the role's YAML tags for the role to see it |
| `+tag` in front-matter | Adds tag to merged set |
| `-tag` in front-matter | Removes tag from merged set |
| Plain tag in front-matter | Adds tag to merged set (same as `+tag`) |

---

## 4. `ListSkills(role)` JSON-RPC Method — for T-SB-005

### 4.1 Method Signature

- **Method name:** `broker.listSkills` (camelCase, consistent with `broker.buildCatalog`)
- **Params:** `{"role": "orchestrator"}` — role is optional; if empty/omitted, returns all skills (no role filter)
- **Returns:** `SkillCatalog` struct marshalled as JSON

### 4.2 Backend Changes (`packages/backend-go/cmd/backend/main.go`)

**New params struct** (add near line 163, alongside `brokerBuildCatalogParams`):

```go
type brokerListSkillsParams struct {
    Role string `json:"role"`
}
```

**New handler function** (add near line 1217, alongside `handleBrokerBuildCatalog`):

```go
func handleBrokerListSkills(req jsonrpcRequest, brk *broker.Broker, workspaceRoot string) jsonrpcResponse {
    var params brokerListSkillsParams
    if err := parseParams(req.Params, &params); err != nil {
        return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
    }

    cat := brk.BuildSkills(params.Role, workspaceRoot)
    return successResponse(req.ID, cat)
}
```

**New switch case** (add near line 890, in the `// Broker` section):

```go
case "broker.listSkills":
    return handleBrokerListSkills(req, brk, workspaceRoot)
```

**Note:** The `workspaceRoot` variable must be available in `processRequest`. Currently `processRequest` signature is:

```go
func processRequest(ctx context.Context, raw []byte, memSys *memory.System, orch *orchestrator.Orchestrator, brk *broker.Broker, peerCtx *activePeerContext) jsonrpcResponse
```

Add `workspaceRoot string` as a parameter:

```go
func processRequest(ctx context.Context, raw []byte, memSys *memory.System, orch *orchestrator.Orchestrator, brk *broker.Broker, peerCtx *activePeerContext, workspaceRoot string) jsonrpcResponse
```

Update the call site in the main loop (around line 700-750) to pass `workspaceRoot`.

### 4.3 Broker Changes (`packages/broker-go/src/neuralgentics/broker/broker.go`)

**Broker struct — add `WorkspaceRoot` field:**

```go
type Broker struct {
    registry      *registry.Registry
    launcher      *launcher.Launcher
    proxy         *proxy.MCPProxy
    access        *access.AccessControl
    builder       *catalog.Builder
    toolExposer   ToolExposer
    httpClients   map[string]proxy.Client
    httpMu        sync.RWMutex
    WorkspaceRoot string  // NEW — absolute path to project root
}
```

**NewBroker — add workspaceRoot parameter:**

```go
func NewBroker(workspaceRoot string) *Broker {
    reg := registry.NewRegistry()
    ac := access.NewAccessControl(access.DefaultServerRoles)
    return &Broker{
        registry:      reg,
        launcher:      launcher.NewLauncher(reg),
        proxy:         proxy.NewMCPProxy(),
        access:        ac,
        builder:       catalog.NewBuilderWithAccess(reg, ac),
        httpClients:   make(map[string]proxy.Client),
        WorkspaceRoot: workspaceRoot,
    }
}
```

**⚠️ BREAKING CHANGE:** All callers of `NewBroker()` must be updated to pass a workspace root. The primary caller is `packages/backend-go/cmd/backend/main.go` line 644. All test files that call `NewBroker()` must also be updated (see §10 Quality Gates).

**New Broker method:**

```go
// BuildSkills creates a SkillCatalog filtered by role.
// If role is empty, all skills are included.
func (b *Broker) BuildSkills(role string, workspaceRoot string) *catalog.SkillCatalog {
    cat := b.builder.BuildSkills(role, workspaceRoot)
    return &cat
}
```

**Design rationale for `WorkspaceRoot` on Broker struct:** The broker currently has no filesystem dependency — it operates purely on the in-memory registry. Adding `WorkspaceRoot` to the struct (rather than passing it as a parameter to every method) is the cleanest approach because:
1. It mirrors how the backend already holds `workspaceRoot` as a top-level variable.
2. It avoids threading `workspaceRoot` through every broker method signature.
3. The broker is constructed once at startup; the workspace root never changes during a session.
4. Test files can pass a temp directory as workspace root.

### 4.4 Backend Initialization Change

In `main()` (around line 644), change:

```go
brk := broker.NewBroker()
```

to:

```go
brk := broker.NewBroker(workspaceRoot)
```

Where `workspaceRoot` is already available in `main()` (it's read from env/config at startup — verify the exact variable name; it may be `cfg.WorkspaceRoot` or a local variable).

---

## 5. `agent-skill-scope.yaml` Schema — for T-SB-006

### 5.1 Full Example File

```yaml
# agent-skill-scope.yaml — Neuralgentics Skills Brokering Phase 1
# Per-agent allow-list of skill tags. Hybrid model:
#   YAML baseline + SKILL.md front-matter tags override/extend.
# If this file is missing, all skills are visible to all roles (no filter).
version: 1

roles:
  # Orchestrator sees everything (wildcard — enforced in code, not YAML)
  orchestrator: []

  # Coder: implementation, refactoring, debugging, code generation
  coder:
    - implementation
    - refactor
    - debugging
    - quality
    - testing

  # Architect: design, architecture, research, planning
  architect:
    - design
    - architecture
    - research
    - planning
    - documentation

  # Tester: verification, quality, regression, e2e, coverage
  tester:
    - verification
    - quality
    - regression
    - e2e
    - testing

  # Writer: documentation, writing, markdown, prose
  writer:
    - documentation
    - writing
    - release

  # Linter: quality, style, formatting, static-analysis
  linter:
    - quality
    - style
    - formatting

  # Git: version control, branching, committing, releasing
  git:
    - commit
    - branching
    - release
    - versioning

  # Explorer: search, file-finding, codebase-navigation
  explorer:
    - search
    - navigation

  # Reviewer: quality, security, audit, review
  reviewer:
    - quality
    - security
    - audit
    - review

  # Researcher: research, web-search, data-synthesis
  researcher:
    - research
    - search

  # Boomerang-prefixed roles (mirror base roles with boomerang- prefix)
  boomerang-coder:
    - implementation
    - refactor
    - debugging
    - quality
    - testing

  boomerang-architect:
    - design
    - architecture
    - research
    - planning
    - documentation

  boomerang-tester:
    - verification
    - quality
    - regression
    - e2e
    - testing

  boomerang-linter:
    - quality
    - style
    - formatting

  boomerang-git:
    - commit
    - branching
    - release
    - versioning

  boomerang-writer:
    - documentation
    - writing
    - release

  boomerang-explorer:
    - search
    - navigation

  boomerang-scraper:
    - research
    - search
    - scraping

  boomerang-release:
    - release
    - versioning
    - documentation

  boomerang-init:
    - initialization
    - setup
    - configuration

  boomerang-handoff:
    - documentation
    - handoff
    - session

  boomerang-agent-builder:
    - design
    - architecture
    - implementation

  mcp-specialist:
    - design
    - debugging
    - implementation
    - quality
```

### 5.2 Tag Vocabulary

The following tags are the canonical set used throughout the system:

| Tag | Meaning |
|-----|---------|
| `implementation` | Writing or modifying code |
| `refactor` | Restructuring existing code without changing behavior |
| `debugging` | Finding and fixing bugs |
| `design` | System/feature design, architecture decisions |
| `architecture` | High-level system architecture |
| `research` | Web research, data gathering, analysis |
| `planning` | Task decomposition, roadmap creation |
| `documentation` | Writing docs, READMEs, markdown |
| `writing` | Prose, technical writing |
| `verification` | Checking correctness |
| `quality` | Code quality, linting, static analysis |
| `testing` | Test writing and execution |
| `regression` | Regression testing |
| `e2e` | End-to-end testing |
| `style` | Code style, formatting |
| `formatting` | Code formatting |
| `commit` | Git commits |
| `branching` | Git branching |
| `release` | Version bumps, changelogs, publishing |
| `versioning` | Version management |
| `search` | File finding, codebase search |
| `navigation` | Codebase navigation |
| `security` | Security audit, vulnerability scanning |
| `audit` | Code audit, review |
| `review` | Code review |
| `scraping` | Web scraping |
| `initialization` | Project initialization |
| `setup` | Environment setup |
| `configuration` | Config file management |
| `handoff` | Session handoff/wrap-up |
| `session` | Session management |
| `dispatch` | Task dispatch, orchestration |
| `orchestration` | Workflow orchestration |

### 5.3 Testability

Tests must be able to:
1. Create a temp directory with a valid `agent-skill-scope.yaml`.
2. Call `LoadScope(tempDir + "/agent-skill-scope.yaml")` and verify the parsed struct.
3. Test with a missing file → verify empty scope (allow-all).
4. Test with a malformed YAML → verify error return.

---

## 6. Plugin: `autoCreate` Default + Gate Wiring — for T-SB-001 + T-SB-002

### 6.1 T-SB-001: Default `autoCreate: true`

**File:** `packages/plugin/src/self-evolution/index.ts`, line 36

**Change:**

```typescript
// BEFORE:
const DEFAULT_OPTIONS: Required<SelfEvolutionGateOptions> = {
  minTriggerCount: 3,
  autoCreate: false,   // ← flip this
  noSkills: false,
  noAgents: false,
};

// AFTER:
const DEFAULT_OPTIONS: Required<SelfEvolutionGateOptions> = {
  minTriggerCount: 3,
  autoCreate: true,    // ← flipped
  noSkills: false,
  noAgents: false,
};
```

**`run()` method overload:**

```typescript
// BEFORE:
async run(): Promise<EvolutionResult> {

// AFTER:
async run(options?: { autoCreate?: boolean }): Promise<EvolutionResult> {
  const effectiveAutoCreate = options?.autoCreate ?? this.options.autoCreate;
  // ... rest of method uses effectiveAutoCreate instead of this.options.autoCreate
```

The `run()` method currently checks `this.options.autoCreate` at line 181. Change this to use the effective value:

```typescript
// Line 181 — BEFORE:
if (this.options.autoCreate) {

// Line 181 — AFTER:
if (effectiveAutoCreate) {
```

This allows callers to override the default at call time (e.g., `gate.run({autoCreate: false})` for dry-run scenarios), while the constructor default remains `true`.

### 6.2 T-SB-002: Wire Gate BEFORE Compaction Backup

**File:** `packages/plugin/src/hooks/compaction.ts`

**Change:** In `handleCompaction()`, insert the evolution gate call **before** the `CRITICAL_FILES` loop.

```typescript
// Add import at top:
import { SelfEvolutionGate } from '../self-evolution/index.js';

// In handleCompaction(), BEFORE the for-loop (line 46):
export async function handleCompaction(
  memory: MemoryAdapter,
  workspaceRoot: string,
): Promise<CompactionBackupResult> {
  // ── NEW: Run evolution gate BEFORE backup ──
  try {
    const gate = new SelfEvolutionGate({ autoCreate: true }, memory);
    const result = await gate.run({ autoCreate: true });
    console.log(
      `[neuralgentics] Evolution gate (compaction): ${result.evaluated} evaluated, ` +
      `${result.qualified} qualified, ${result.created.length} created`
    );
    if (result.created.length > 0) {
      console.log(
        `[neuralgentics] New skills created: ${result.created.map(c => c.name).join(', ')}`
      );
    }
  } catch (err) {
    // Non-fatal: log and continue. Do NOT block compaction.
    console.error(
      '[neuralgentics] Evolution gate failed during compaction:',
      err instanceof Error ? err.message : err
    );
  }

  // ── Existing backup loop (unchanged) ──
  const backedUp: string[] = [];
  // ... rest of function unchanged
```

**Why BEFORE backup:** The compaction backup captures `AGENTS.md` and `TASKS.md` to memory. If the evolution gate creates a new `SKILL.md` file, running the gate *before* the backup ensures that the backup memory snapshot reflects the post-evolution state. The `SKILL.md` itself is on disk and will be picked up by `BuildSkills` on the next catalog read, but the *knowledge that it was created* is captured in the backup.

**Edge cases:**
- If `gate.run()` throws → log the error and continue. Do NOT block compaction. The backup must still run.
- If `SelfEvolutionGate` constructor fails (e.g., memory adapter unavailable) → catch and continue.
- The gate already saves its own results to memory internally (line 194 of index.ts), so even if the backup fails, the evolution result is persisted.

---

## 7. `//boomerang-handoff` Skill — for T-SB-003

### 7.1 File to Create

**Path:** `/home/jcharles/Projects/MCP-Servers/neuralgentics/.opencode/skills/boomerang-handoff/SKILL.md`

**Note:** This file does NOT currently exist. T-SB-003 must create both the directory and the file.

### 7.2 Full SKILL.md Content

```markdown
---
name: boomerang-handoff
description: Wrap-up function for ending a session cleanly. Runs the self-evolution gate to auto-create skills from repeated patterns, updates all documentation files, commits new artifacts, and saves context for the next session.
tags:
  - handoff
  - session
  - documentation
  - evolution
---

# Boomerang Handoff

## When to Invoke

At the **end of every session**, or when the user explicitly requests `//boomerang-handoff`. This skill wraps up the session, runs the self-evolution gate, updates documentation, and commits any new artifacts.

## Preconditions (Step 0)

Before running the handoff, verify:
- [ ] All dispatched cards are in `done` or `blocked` status
- [ ] All quality gates have passed (lint, typecheck, test)
- [ ] Working tree is clean or has only documentation changes pending
- [ ] `AGENTS.md`, `TASKS.md`, and `HANDOFF.md` exist and are readable

## Step 1: Run Self-Evolution Gate

Invoke the evolution gate to detect repeated patterns and auto-create skills:

```
Call MCP tool: neuralgentics_evolution_gate
Params: { auto_create: true }
```

The gate will:
1. Query memory for pattern candidates (trigger count ≥ 3)
2. Evaluate each candidate against 4 criteria (repetition, interface clarity, independence, time savings)
3. Auto-create `SKILL.md` files for qualified candidates in `.opencode/skills/<name>/`
4. Save evolution results to memory

**Expected output:** `{ evaluated: N, qualified: M, created: [...] }`

If the gate creates new skills, note their names for the commit message in Step 3.

## Step 2: Run Handoff

Execute the standard handoff flow:

1. **Update `HANDOFF.md`** — Add a new top section with:
   - Session date and summary
   - What was completed
   - Key decisions made
   - Files changed
   - Bootstrap prompt for next session

2. **Update `TASKS.md`** — Mark completed cards as `done`, move blocked cards with reasons, archive old cards.

3. **Update `CONTEXT.md`** (if exists) — Add architecture delta section.

4. **Save session context to memory** — Use `memini-ai-dev_add_memory` with:
   - `sourceType: "boomerang"`
   - `metadata: { project: "neuralgentics", type: "session-handoff", session: N }`

## Step 3: Commit New Artifacts

If the evolution gate created new `SKILL.md` files, or if documentation was updated:

```bash
git add .opencode/skills/ HANDOFF.md TASKS.md CONTEXT.md
git commit -m "handoff: session wrap-up + evolution gate

Created skills: <list of new skill names>
Updated: HANDOFF.md, TASKS.md"
```

Do NOT push — the user may want to review before pushing.

## Step 4: Return Handle

Return a summary to the orchestrator:

```
{
  session: N,
  handoff_complete: true,
  evolution_result: { evaluated, qualified, created },
  docs_updated: ["HANDOFF.md", "TASKS.md"],
  new_skills: ["skill-name-1", "skill-name-2"],
  commit_sha: "<sha>"
}
```

## Notes

- The evolution gate runs **before** the handoff documentation update so that newly-created skills are reflected in the handoff summary.
- If the evolution gate fails, log the error and continue with the handoff — do not block the session wrap-up.
- The `auto_create: true` parameter ensures skills are created automatically without manual confirmation.
```

### 7.3 Design Notes

- The "existing handoff flow" referenced in Step 2 is the MANDATORY pattern from `AGENTS.md` §Protocol (9-step Boomerang Protocol, steps 7-9: IMPROVE → Doc Update → Memory Save).
- Step 1 (evolution gate) inserts **before** Step 2 (handoff docs) so that any newly-created skills are captured in the handoff summary and visible to the next session.
- The skill uses `tags: [handoff, session, documentation, evolution]` in its front-matter. Per the tag merge rule (§3.5), this means the skill is visible to roles whose YAML tags overlap with these tags — primarily `boomerang-handoff`, `writer`, and `orchestrator`.

---

## 8. `skill_lookup.ts` — for T-SB-007

### 8.1 File

**Path:** `packages/plugin/src/self-evolution/skill_lookup.ts` (NEW)

### 8.2 Purpose

Pre-dispatch hook for the orchestrator. Given a task context string and a role, it queries `ListSkills(role)` via the broker, computes cosine similarity between the task context and each skill's metadata, and returns the top-1 matching skill (if score ≥ 0.6). The orchestrator injects the skill body into the seed prompt.

### 8.3 Public API

```typescript
/**
 * SkillLookup — pre-dispatch skill matching for the orchestrator.
 *
 * Queries the broker's ListSkills(role) JSON-RPC method, computes
 * cosine similarity between the task context and each skill's
 * name+description+tags, and returns the top-1 match if the score
 * meets the threshold (0.6).
 */
export class SkillLookup {
  private readonly brokerClient: BrokerClient;
  private readonly threshold: number;

  /**
   * @param brokerClient — HTTP JSON-RPC client for the Go backend
   * @param threshold — minimum cosine similarity to return a match (default 0.6)
   */
  constructor(brokerClient: BrokerClient, threshold: number = 0.6);

  /**
   * Pick the best-matching skill for a task context.
   *
   * 1. Calls ListSkills(role) via the broker client
   * 2. Builds a bag-of-words vector for the task context
   * 3. For each skill, builds a bag-of-words vector for
   *    name + " " + description + " " + tags.join(" ")
   * 4. Computes cosine similarity
   * 5. Returns the top-1 match if score >= threshold, else null
   *
   * @returns {name, body, score} or null if no match meets threshold
   */
  async pickSkill(
    taskContext: string,
    role: string = "orchestrator"
  ): Promise<{ name: string; body: string; score: number } | null>;

  /**
   * Load the full SKILL.md body from disk.
   * Uses the skill's path from the catalog to read the file.
   */
  private async loadSkillBody(skillPath: string): Promise<string>;

  /**
   * Compute cosine similarity between two sparse vectors.
   * Vectors are Maps of token → frequency.
   */
  private cosine(a: Map<string, number>, b: Map<string, number>): number;
}
```

### 8.4 `pickSkill` Algorithm (Pseudocode)

```
async pickSkill(taskContext, role):
    1. catalog = await brokerClient.call("broker.listSkills", { role })
    2. if catalog.total_skills == 0: return null

    3. taskVec = bagOfWords(taskContext)
       // split on whitespace, lowercase, drop stopwords, count frequencies

    4. bestScore = 0, bestSkill = null
    5. for each skill in catalog.skills:
         skillText = skill.name + " " + skill.description + " " + skill.tags.join(" ")
         skillVec = bagOfWords(skillText)
         score = cosine(taskVec, skillVec)
         if score > bestScore:
             bestScore = score
             bestSkill = skill

    6. if bestScore < this.threshold: return null

    7. body = await loadSkillBody(skill.path)
    8. return { name: bestSkill.name, body, score: bestScore }
```

### 8.5 BrokerClient Interface

Since the plugin lives in TypeScript and the broker is Go via JSON-RPC over stdio (exposed as MCP tools), the `BrokerClient` is a thin HTTP JSON-RPC client that POSTs to the backend.

```typescript
/**
 * BrokerClient — thin HTTP JSON-RPC client for the Go backend.
 *
 * The Go backend exposes neuralgentics_* MCP tools. This client
 * sends JSON-RPC 2.0 requests over HTTP to the backend's JSON-RPC
 * endpoint (same host:port as the MCP stdio transport connects to).
 */
export interface BrokerClient {
  /**
   * Call a broker method via JSON-RPC.
   *
   * @param method — e.g. "broker.listSkills"
   * @param params — method parameters
   * @returns the result field from the JSON-RPC response
   */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}
```

**Implementation note for coder #4:** Create `packages/plugin/src/self-evolution/broker_client.ts` with a real HTTP JSON-RPC implementation. The backend listens on a configurable port (default from env `NEURALGENTICS_BACKEND_PORT` or 8900). The client POSTs to `http://localhost:{port}/jsonrpc` with body `{"jsonrpc": "2.0", "method": "...", "params": {...}, "id": 1}`. Mirror the HTTP pattern from `packages/plugin/src/adapters/memory.ts` (fetchJson helper, timeout, error handling).

### 8.6 Bag-of-Words + Cosine Algorithm (Exact Specification)

This is the embedding strategy for Phase 1. See §9 for the full rationale.

```
STOPWORDS = {"the", "a", "an", "is", "are", "was", "were", "be", "been",
             "being", "have", "has", "had", "do", "does", "did", "will",
             "would", "could", "should", "may", "might", "can", "shall",
             "to", "of", "in", "for", "on", "with", "at", "by", "from",
             "as", "into", "through", "during", "before", "after",
             "above", "below", "between", "and", "but", "or", "nor",
             "not", "so", "yet", "both", "either", "neither", "each",
             "every", "all", "any", "few", "more", "most", "other",
             "some", "such", "no", "only", "own", "same", "than",
             "too", "very", "just", "about", "also", "if", "then",
             "else", "when", "where", "why", "how", "this", "that",
             "these", "those", "it", "its", "he", "she", "they", "them",
             "we", "you", "i", "me", "my", "your", "his", "her", "our"}

function bagOfWords(text: string): Map<string, number>:
    vec = new Map()
    tokens = text.toLowerCase().split(/[\s,;:.!?()\[\]{}"']+/)
    for token in tokens:
        if token.length == 0: continue
        if token in STOPWORDS: continue
        vec[token] = (vec[token] || 0) + 1
    return vec

function cosine(a: Map<string, number>, b: Map<string, number>): number:
    // Compute dot product over union of keys
    dotProduct = 0
    for key in union(a.keys(), b.keys()):
        dotProduct += (a[key] || 0) * (b[key] || 0)

    // Compute magnitudes
    magA = sqrt(sum(v * v for v in a.values()))
    magB = sqrt(sum(v * v for v in b.values()))

    if magA == 0 || magB == 0: return 0
    return dotProduct / (magA * magB)
```

**Performance characteristics:**
- O(V) where V is the union of unique tokens in both texts.
- Typical skill metadata: ~20-50 unique tokens after stopword removal.
- Typical task context: ~50-150 unique tokens.
- Total cost per `pickSkill` call: ~5-10ms for 10 skills (negligible).

---

## 9. Embedding Strategy Decision

### 9.1 Decision: Word-Overlap Cosine (No Real Embeddings)

**Phase 1 uses simple word-overlap cosine similarity** — bag-of-words vectors with stopword removal. No real embedding model, no external API call, no GPU dependency.

### 9.2 Rationale

| Factor | Word-Overlap Cosine | Real Embeddings (e.g., BGE-Large) |
|--------|---------------------|-----------------------------------|
| Dependency | Zero — pure TypeScript | Requires embedding sidecar (Python gRPC) |
| Latency | <10ms per call | ~50-200ms per call (network + inference) |
| Testability | Trivial — deterministic, no mocking | Requires mock embed server or integration test |
| Accuracy | Good for keyword-matching tasks | Better for semantic matching |
| Phase 1 fit | Excellent — skills are keyword-rich | Overkill for Phase 1 |

**Trade-off acknowledged:** Word-overlap cosine will miss semantically-similar-but-lexically-different matches (e.g., "fix bug" vs "resolve defect"). However, Phase 1 skills are created from repeated patterns with consistent terminology, so keyword overlap is a strong signal. Real embeddings come in Phase 2 when the embedding sidecar is wired.

### 9.3 Why Not Use MemoryAdapter.queryMemories for Embedding

The `MemoryAdapter` talks to the Python memini-core server at `localhost:8900`, which has a `/api/v1/memories` endpoint for semantic search. However:
1. There is no standalone `/api/v1/embed` endpoint — the embedding is internal to the search pipeline.
2. Calling `queryMemories` with the task context would return *memories*, not an embedding vector.
3. Extracting the embedding from the search response is fragile and couples `skill_lookup` to memini-core internals.

**Decision:** Use pure bag-of-words cosine. Phase 2 will add a proper embed endpoint or use the existing sidecar.

---

## 10. Quality Gates Per Card

### T-SB-001: Default `autoCreate: true`

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**Expected:** All existing tests pass. No new test failures. TypeScript compiles clean.

### T-SB-002: Wire Gate in Compaction

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**Additional manual smoke test:** Load the plugin, trigger a fake compaction event, verify the console log shows evolution gate output before backup output.

### T-SB-003: `//boomerang-handoff` SKILL.md

No automated tests (markdown only). **Manual verification:**
- Front-matter parses correctly (valid YAML between `---` delimiters).
- File is at the correct path: `.opencode/skills/boomerang-handoff/SKILL.md`.
- All four steps are present and logically ordered.

### T-SB-004: SkillCatalog + skills.go

```bash
cd packages/broker-go && go vet ./... && go test ./... && go build ./...
```

**⚠️ BREAKING CHANGE:** `NewBroker()` signature changes from `NewBroker()` to `NewBroker(workspaceRoot string)`. All test files that call `NewBroker()` must be updated. Affected files:
- `broker_test.go` (5 calls)
- `broker_api_test.go` (18 calls)
- `broker_integration_test.go` (4 calls)
- `reload_test.go` (7 calls)

**Total: ~34 call sites to update.** Each should pass `t.TempDir()` or a test fixture path.

**New tests required:**
- `TestBuildSkills_EmptyRole` — returns all skills
- `TestBuildSkills_FilteredByRole` — returns only skills visible to the given role
- `TestBuildSkills_NoYAML` — missing `agent-skill-scope.yaml` → allow-all
- `TestParseSkillFrontMatter_Valid` — parses name, description, tags
- `TestParseSkillFrontMatter_NoFrontMatter` — file without `---` → empty front-matter
- `TestParseSkillFrontMatter_Malformed` — opening `---` but no closing → error
- `TestLoadScope_Valid` — parses valid YAML
- `TestLoadScope_Missing` — file doesn't exist → empty scope
- `TestMergeTags_BaselineOnly` — skill has no tags, inherits YAML
- `TestMergeTags_AdditiveTag` — `+tag` extends YAML baseline
- `TestMergeTags_SubtractiveTag` — `-tag` removes from YAML baseline
- `TestMergeTags_OrchestratorWildcard` — orchestrator sees everything

### T-SB-005: ListSkills JSON-RPC

```bash
cd packages/broker-go && go vet ./... && go test ./... && go build ./...
cd packages/backend-go && go vet ./... && go build ./...
```

**Note:** The backend may not have a dedicated test suite. If `go test ./packages/backend-go/...` fails due to missing tests, that's pre-existing — just ensure `go build ./...` passes.

**New tests required (in broker-go):**
- `TestListSkills_JSONRPC` — integration test that calls `broker.listSkills` via the JSON-RPC handler and verifies the response shape.

### T-SB-006: agent-skill-scope.yaml

**Verification:**
```bash
# Parse the YAML file (using Python or Go one-liner)
python3 -c "import yaml; yaml.safe_load(open('agent-skill-scope.yaml'))" && echo "YAML valid"
```

**Example Go test (in skills.go test file):**
```go
func TestLoadScope_RealFile(t *testing.T) {
    // Copy the real agent-skill-scope.yaml to a temp dir
    // Load it and verify version=1, roles has expected keys
}
```

### T-SB-007: skill_lookup.ts

```bash
cd packages/plugin && bun test && npx tsc --noEmit
```

**New tests required:**
- `TestBagOfWords_Basic` — tokenizes and counts correctly
- `TestBagOfWords_Stopwords` — removes stopwords
- `TestCosine_Identical` — returns 1.0 for identical vectors
- `TestCosine_Orthogonal` — returns 0.0 for disjoint vectors
- `TestPickSkill_NoMatch` — returns null when no skill meets threshold
- `TestPickSkill_Match` — returns top-1 when score ≥ 0.6
- `TestPickSkill_EmptyCatalog` — returns null for empty catalog
- Integration test with a stub `BrokerClient` that returns a fake catalog

---

## 11. Wave 2 Dispatch Plan (Read-Only)

This is the dispatch order for the orchestrator to execute after this design is approved. **Do not implement now.**

### Wave 2a: Coder #1 → T-SB-001 + T-SB-002 + T-SB-003
**One dispatch, file-coupled on plugin.** These three cards all touch the plugin package and the `.opencode/skills/` directory. A single coder can handle all three because:
- T-SB-001 and T-SB-002 are in the same file area (`self-evolution/index.ts` + `hooks/compaction.ts`)
- T-SB-003 creates a new markdown file (no code dependencies on T-SB-001/002, but logically coupled — the handoff skill references the gate that T-SB-001/002 configure)

**Files touched:** `packages/plugin/src/self-evolution/index.ts`, `packages/plugin/src/hooks/compaction.ts`, `.opencode/skills/boomerang-handoff/SKILL.md` (NEW)

**Quality gates:** `cd packages/plugin && bun test && npx tsc --noEmit`

### Wave 2b: Coder #2 → T-SB-004 + T-SB-005
**One dispatch, file-coupled on Go broker + backend.** These two cards are tightly coupled:
- T-SB-004 creates the `SkillCatalog` in the broker
- T-SB-005 wires the JSON-RPC method in the backend that calls it

**Files touched:** `packages/broker-go/src/neuralgentics/broker/catalog/skills.go` (NEW), `packages/broker-go/src/neuralgentics/broker/broker.go` (add `WorkspaceRoot`, `BuildSkills`), `packages/backend-go/cmd/backend/main.go` (add `case "broker.listSkills"`, handler, params struct, `workspaceRoot` param)

**⚠️ CRITICAL:** Coder #2 must update ALL ~34 `NewBroker()` call sites in test files. See §10 T-SB-004 quality gates.

**Quality gates:** `cd packages/broker-go && go vet ./... && go test ./... && go build ./...` AND `cd packages/backend-go && go vet ./... && go build ./...`

### Wave 2c: Coder #3 → T-SB-006
**Standalone, YAML file only.** No code dependencies on other cards.

**File touched:** `agent-skill-scope.yaml` (NEW at repo root)

**Quality gates:** YAML parses via `python3 -c "import yaml; ..."` or Go test.

### Wave 2d: Coder #4 → T-SB-007
**Standalone, plugin package.** Depends on T-SB-004 + T-SB-005 being complete (needs `broker.listSkills` to work), so dispatch AFTER Wave 2b.

**Files touched:** `packages/plugin/src/self-evolution/skill_lookup.ts` (NEW), `packages/plugin/src/self-evolution/broker_client.ts` (NEW)

**Quality gates:** `cd packages/plugin && bun test && npx tsc --noEmit`

### Wave 3: Tester
After all four coder waves complete:
- Run full test suites: `cd packages/plugin && bun test`, `cd packages/broker-go && go test ./...`, `cd packages/backend-go && go test ./...` (if tests exist)
- Verify `SkillCatalog` unit tests pass
- Integration stub: create a temp workspace with a fake `agent-skill-scope.yaml` and a fake `.opencode/skills/test-skill/SKILL.md`, call `BuildSkills("tester", tmpDir)`, verify the result

### Linter Sub-Agents
Per AGENTS.md Rule 5, each coder MUST:
1. Launch `boomerang-linter` sub-agent for the files it touches
2. Apply the linter's suggested fixes
3. Re-run the linter to verify clean
4. Include the linter report summary in its wrap-up

---

## 12. Open Questions / Risks

### 12.1 Legacy `skills/` Directory

The directory `/home/jcharles/Projects/MCP-Servers/neuralgentics/skills/` contains 6 files:
- `architect.md`, `coder.md`, `git.md`, `reviewer.md`, `tester.md`, `writer.md`

These files use a **different format** from `.opencode/skills/*/SKILL.md`:
- They are named `<role>.md`, not `SKILL.md`
- They have front-matter with `name`, `model`, `description` — but no `tags`
- They are agent persona prompts, not reusable skill instructions

**Phase 1 decision: SKIP these files.** The `BuildSkills` walker only reads `/.opencode/skills/*/SKILL.md`. The legacy `skills/` directory is out of scope.

**Phase 2 TODO:** Either migrate these to the `SKILL.md` format under `.opencode/skills/`, or add a separate code path in the catalog to handle legacy agent prompts. This is a Phase 2 design question.

### 12.2 `//boomerang-handoff` Skill Does Not Exist Yet

T-SB-003 creates this file from scratch. The design in §7 provides the full content. The coder must create both the directory `.opencode/skills/boomerang-handoff/` and the file `SKILL.md` within it.

### 12.3 Embedding Strategy Limitation

Word-overlap cosine (bag-of-words) is a simplified embedding strategy. It will miss semantically-similar-but-lexically-different matches. This is a **known limitation** documented in §9. Real embeddings (via the Python gRPC sidecar) are planned for Phase 2.

### 12.4 `NewBroker()` Signature Break

Changing `NewBroker()` to `NewBroker(workspaceRoot string)` is a **breaking API change** that affects ~34 test call sites. This is intentional — the broker needs filesystem access for skill catalog reads. The coder must update all call sites. See §10 T-SB-004 for the full list.

### 12.5 `workspaceRoot` Availability in Backend `main.go`

The `workspaceRoot` variable must be threaded through `processRequest()`. Verify that `main()` already has a `workspaceRoot` variable (it likely reads it from env `NEURALGENTICS_WORKSPACE_ROOT` or a config struct). If not, the coder must add it.

### 12.6 No `broker.listSkills` MCP Tool Exposure Yet

The new `broker.listSkills` JSON-RPC method is added to the backend's `processRequest` switch, but it is NOT automatically exposed as an MCP tool. The MCP tool exposure is handled separately (via the `neuralgentics_memory_manager` tool or the broker's tool registration). The orchestrator will call `broker.listSkills` via the `BrokerClient` HTTP JSON-RPC client, not via MCP. This is fine for Phase 1 — the `skill_lookup.ts` uses the HTTP client directly.

---

## Appendix A: File Manifest

| Card | File | Action |
|------|------|--------|
| T-SB-001 | `packages/plugin/src/self-evolution/index.ts` | Edit: flip `autoCreate` default, add `run()` overload |
| T-SB-002 | `packages/plugin/src/hooks/compaction.ts` | Edit: add gate.run() before CRITICAL_FILES loop |
| T-SB-003 | `.opencode/skills/boomerang-handoff/SKILL.md` | **Create** (dir + file) |
| T-SB-004 | `packages/broker-go/src/neuralgentics/broker/catalog/skills.go` | **Create** |
| T-SB-004 | `packages/broker-go/src/neuralgentics/broker/broker.go` | Edit: add `WorkspaceRoot`, `BuildSkills`, change `NewBroker` |
| T-SB-004 | `packages/broker-go/src/neuralgentics/broker/*_test.go` | Edit: update ~34 `NewBroker()` calls |
| T-SB-005 | `packages/backend-go/cmd/backend/main.go` | Edit: add params struct, handler, switch case, `workspaceRoot` param |
| T-SB-006 | `agent-skill-scope.yaml` | **Create** (repo root) |
| T-SB-007 | `packages/plugin/src/self-evolution/skill_lookup.ts` | **Create** |
| T-SB-007 | `packages/plugin/src/self-evolution/broker_client.ts` | **Create** |

---

## Appendix B: Locked Decisions Reference

These decisions were locked in Session 29 and must NOT be re-litigated during implementation:

| Decision | Value |
|----------|-------|
| Cadence | Every compaction + every `//boomerang-handoff`, no cooldown |
| External skills source | Clone at release + refresh on session start (Phase 2) |
| Orchestrator skill selection | Automatic by embedding similarity, top-1 if cosine ≥ 0.6 |
| Per-agent scoping | Hybrid YAML baseline + SKILL.md front-matter override |
| `autoCreate` default | `true` |
| One task per coder per dispatch | Enforced (AGENTS.md Rule 4) |
| Wave 2 grouping | coder#1 = T-SB-001+002+003, coder#2 = T-SB-004+005, coder#3 = T-SB-006, coder#4 = T-SB-007 |
