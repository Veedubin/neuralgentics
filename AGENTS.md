# Neuralgentics Agents

## Provider Configuration (Ollama Cloud & Alternatives)

All projects in this workspace ship with **Ollama Cloud** as the default
LLM provider. To switch to a different provider — local Ollama, Docker
Model Runner, OpenAI, Anthropic, Google, OpenRouter, or any
OpenAI-compatible endpoint — see:

> **`~/Projects/MCP-Servers/docs/providers.md`** — the canonical
> provider-switching guide. Covers 5 recipes (local Ollama, Docker
> Model Runner, the Big Three, OpenRouter, custom endpoints), a
> quick-reference for just changing which Ollama Cloud model each
> agent uses, a 6-step migration checklist, and a troubleshooting
> table for the common `ProviderModelNotFoundError`,
> `Provider not found`, and `401 Unauthorized` errors.

If you only want to swap which model each agent uses (and the model
already exists in `provider.ollama.models`), the guide shows a `sed`
one-liner that does it in seconds.

## Memory
Memory management is decentralized. Memory is the absolute source of truth. Agents MUST fetch their context and store their wrap-ups in `memini-core` using the provided `memory_id`.

## Stateless Agent Protocol

Neuralgentics employs a "stateless" model where agents do not receive large ContextPackages inline. Instead, memory is the central source of truth.

**The Flow:**
`Orchestrator` $\rightarrow$ `memini-core` (Store Context) $\rightarrow$ `Agent` (Seed Prompt + ID) $\rightarrow$ `Agent` (Fetch Context) $\rightarrow$ `memini-core` (Store Wrap-up) $\rightarrow$ `Orchestrator`

**Token Efficiency:**
By replacing a ~2,000+ token ContextPackage with a ~200 token seed prompt, we significantly reduce prompt overhead and latency.

### Example Seed Prompt
```markdown
Task: Implement the user registration flow.
Memory ID: `mem-12345-abcde`
Action: Fetch the ContextPackage from memini-core using the Memory ID above and execute the task.
```

## Agent Onboarding Rules (Mandatory)

- **Fetch Context**: Every agent MUST query `memini-core` on startup if provided with a `memory_id`.
- **Store Wrap-up**: Every agent MUST store its final output/wrap-up in `memini-core` upon completion.
- **Return Handle**: Every agent MUST return exactly `{memory_id, description}` to the orchestrator.
- **Trust Signal**: Every wrap-up stored in memory must include the `agent_used` signal on the original context memory to increase its trust score.

## Sub-Agent Dispatch
If an agent spawns sub-agents, it must act as a mini-orchestrator and follow the stateless pattern:
1. Store sub-task context in `memini-core`.
2. Pass a seed prompt (with `memory_id`) to the sub-agent.
3. Sub-agents must adhere to all Stateless Agent Protocol rules.

## Routing

Agents must state their intent clearly in their thought process. The orchestrator routes tasks to specific specialists based on the internal Routing Matrix.

## External Tools
For web research, GitHub operations, or other external integrations, describe the required capability. The MCP Broker will provision the relevant tools for the session.

## Quality Gates
All code changes must pass the automatic quality gate before being marked as complete:
**Lint** $\rightarrow$ **Typecheck** $\rightarrow$ **Test**

### Zero-Error Rule (Mandatory)
A sub-agent **MUST NOT** mark a card `done` while any quality gate is failing — including gates they claim are "pre-existing" or "unrelated to my changes". The only acceptable outcomes when a gate fails:

1. **Fix inline** — the agent has the file context, edit and re-run the gate until it passes.
2. **Block the card** — set `Status: blocked` in the kanban entry, document which gate failed, the exact error, and a one-line remediation. The orchestrator will dispatch a follow-up card.

False success reports (e.g. wrap-up claims "all gates pass" while the dispatch log shows errors) are a session-ending violation. The orchestrator re-runs every gate on return; sub-agents that lie lose trust.

*(Added 2026-06-04 Session 20 after T-029 wrap-up falsely claimed "all 4 Go modules build clean" while the dispatch log contained go build errors. Verified clean on re-run; rule added to prevent recurrence.)*

## Protocol
All tasks must follow the 9-step Boomerang Protocol, enforced by the orchestrator:
1. Memory Query
2. Thought Chain
3. Planning
4. Delegation
5. Git Check
6. Quality Gates
7. IMPROVE (Extract patterns, bump trust, update shared knowledge)
8. Doc Update
9. Memory Save (Wrap-up storage in `memini-core`)

### Why IMPROVE

The IMPROVE step enforces separation between execution and learning. Workers (dispatched sub-agents) never write to shared memory during execution; only the IMPROVE phase writes. After quality gates pass, the orchestrator (or a designated sub-agent) analyzes the outcomes of the completed work:

1. **Analyzes outcomes** — patterns that emerged, failures that occurred, decisions that were made.
2. **Extracts signals** — successful approaches stored as patterns, failures stored as anti-patterns, key decisions stored with architecture decision records.
3. **Writes to memory** — uses `memory.triggerExtraction`, `memory.getTier1Summary`, and `memory.getRelationshipSummary` to populate shared knowledge.
4. **Bumps trust** — calls `memory.adjustTrust` with `agent_used` for memories that proved correct, `user_corrected` for memories that needed fixing.

This ensures shared knowledge reflects verified outcomes, not speculative predictions made before quality gates pass.

## Agent Roster

| Role | Model | Purpose |
| :--- | :--- | :--- |
| Orchestrator | Primary | Task decomposition, routing, and protocol enforcement |
| Architect | Primary | System design, trade-off analysis, and research |
| Coder | Secondary | High-speed implementation and bug fixing |
| Reviewer | Primary | Code quality, security audit, and logic verification |
| Explorer | Secondary | File finding and codebase mapping |
| Tester | Secondary | Unit, integration, and E2E test generation |
| Git | Secondary | Version control, commits, branches, tags |
| Writer | Secondary | Documentation and markdown writing |

## Architecture (v0.9.4 — Plugin + npm init CLI)

Neuralgentics is an **OpenCode plugin** — not a standalone TUI. The user runs `opencode`, which loads `@veedubin/neuralgentics` from `.opencode/opencode.json`. The plugin provides:

- **MCP tools**: routing validation, memory save/query, compaction backup/restore, stateless agent dispatch, self-evolution gate
- **Lifecycle hooks**: session.created, session.idle, session.compacting
- **Config merger**: injects neuralgentics version + memory URL into opencode config

### Container Stack (memory backend)
```
docker compose -f ~/.neuralgentics/docker-compose.yml up -d
```
- **neuralgentics-postgres**: PostgreSQL 18 + pgvector + TimescaleDB (port 6200). Supports multi-model embeddings with `embedding` (384-dim), `embedding_bge_m3` (1024-dim), and `embedding_bge_large` (1024-dim) columns. RRF (Reciprocal Rank Fusion) merges results across all populated columns by default.
- **neuralgentics-sidecar**: Python gRPC embedding service (BGE-M3 by default, port 50051). BGE-Large is still available via `--embed-model bge-large` for backwards compat.
- **neuralgentics-backend**: Go JSON-RPC memory server (trust engine, knowledge graph, thought chains). Supports `memory.search_rrf` for multi-model queries.

### Sidecar lifecycle (v0.9.6+)

The `neuralgentics-sidecar` is **lazy-loaded by default** — model is only in memory when actively used. Idle unload after 5 min (configurable via `IDLE_MIN`). To keep the model hot, set `EAGER=true` in `.env` or pass `--no-lazy-load` to the init CLI.

Quantization: default is `int8` on CPU and `fp16` on GPU. Override with `NEURALGENTICS_EMBED_DTYPE={fp32|fp16|int8}` or `--quantize` flag.

The sidecar exposes a `/status` HTTP endpoint on port 50052 for monitoring. The Go memory server can `sidecar.start` and `sidecar.stop` the container via JSON-RPC (local-only — errors if sidecar is remote).

### Install Flow
The recommended install flow is now:
```bash
npx @veedubin/neuralgentics --init
cd your-project
opencode
```

The old curl-bash installer (`curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash`) is deprecated and no longer maintained.

### What's in the archive
- `@veedubin/neuralgentics` — npm package providing the OpenCode plugin (orchestrator, memory client, routing)
- `.opencode/agents/` — 8 agent personas (architect, coder, explorer, git, orchestrator, reviewer, tester, writer)
- `.opencode/skills/` — 5 skills (boomerang-orchestrator, kanban-board-manager, skill-self-audit, todo-list-updater, update-gh-docs)
- `.opencode/opencode.json` — OpenCode config with Ollama Cloud models, MCP servers, LSP, formatter
- `.opencode/AGENTS.md` — Project instructions and agent protocol
- `docker-compose.yml` + `docker/*.Dockerfile` — Container stack for memory backend

### What was REMOVED (v0.9.0+)
- **TUI binary** — the `neuralgentics` command no longer exists. Run `opencode` instead.
- **Go backend binary in archive** — backend runs as a container, not a downloaded binary
- **Sidecar auto-setup in installer** — sidecar runs as a container
- **PATH setup** — no binary to put on PATH
- **GPU detection** — handled by container runtime
- **5-platform build matrix** — single platform-independent npm package
- **PyPI `neuralgentics-cli` package** — was a mistake, never should have been published

## What's in v0.9.4
- **npm `npx --init` flow** replaces the old curl-bash installer. Run `npx @veedubin/neuralgentics --init` to bootstrap your project.
- **Safe container setup**: The new installer skips containers if they're already running, respects `.env` files, and never overwrites existing data.
- **PyPI `neuralgentics-cli` package removed**: This was a mistake and never should have been published.
- **Go backend continues as a containerized sibling of memini-ai**: The Go backend runs as a container, not a standalone binary, and shares the same PostgreSQL schema as memini-ai for consistency.

## Container Deletion Policy (MANDATORY)

**All agents MUST NOT delete, remove, `podman rm`, `podman rm -f`, `podman system prune`, `docker system prune`, `docker rm`, or otherwise destroy ANY container, volume, image, named volume, bind mount, or podman network/storage artifact for ANY reason — without explicit, case-by-case permission from the user.**

This includes (but is not limited to):
- `podman rm [-f|-a|-all] <container>`
- `podman volume rm <volume>`
- `podman rmi [-f] <image>`
- `podman network rm <network>`
- `podman system reset / podman system prune / podman system prune -a`
- Any `rm -rf` against `/home/jcharles/.local/share/containers/storage/volumes/*`
- Removing rows from `db.sql` (the podman container/volume/image state DB)
- Wiping `/home/jcharles/Projects/MCP-Servers/PGVector-Data/`, `/home/jcharles/Projects/MCP-Servers/qdrant_storage/`, or any other project data directory

**If an agent believes a container, volume, image, or artifact needs to be removed**, the agent must:
1. **STOP and ASK the user** with the exact `podman rm` / `podman volume rm` / etc. command shown in full.
2. Wait for explicit "yes, do it" approval.
3. Only then execute.

The same rule applies to containers the user previously had running that are currently stopped. A stopped container may still contain irreplaceable data, configuration, or state the user wants preserved.

## Currently-Running Containers (as of 2026-07-09)

| Container | Image | Port | State | Purpose |
|-----------|-------|------|-------|---------|
| `memini-postgres` | `docker.io/timescale/timescaledb-ha:pg18` | 5434 → 5432 | Running | Postgres 18 + TimescaleDB + pgvector. User's production DB for memini-ai. |
| `neuralgentics-postgres` | `localhost/neuralgentics-postgres:test` | 6200 → 5432 | Running | **Go backend's database** (sibling of memini-ai). 14 tables initialized (same schema as memini-ai, ported). Currently empty because the Go backend container is not running. |

**DO NOT `podman rm` either of these containers without explicit user permission.**

## Go Backend Default Connection (as of 2026-06-24)

The Go backend `packages/backend-go/cmd/backend/main.go` connects to:

| Field     | Value (matches `neuralgentics-postgres` container) |
|-----------|----------------------------------------------------|
| Host      | `localhost:6200`                                   |
| User      | `neuralgentics`                                    |
| Password  | `neuralgentics`                                    |
| Database  | `neuralgentics`                                    |

**Override at runtime** via the `NEURALGENTICS_DB_URL` env var. Default works
because the `neuralgentics-postgres` podman container is running with
`POSTGRES_USER=neuralgentics`, `POSTGRES_PASSWORD=neuralgentics`,
`POSTGRES_DB=neuralgentics` and exposes 6200 → 5432.

If the backend refuses to start with `failed to initialize memory system` or
`FATAL: database "neuralgentics" does not exist`:

1. Confirm the container is up: `podman ps --filter name=neuralgentics-postgres`
2. Verify credentials: `podman inspect neuralgentics-postgres --format '{{range .Config.Env}}{{println .}}{{end}}'`
3. If the DB truly isn't there, the issue is the container, not the binary —
   do NOT recreate the container without explicit user permission.
4. Override as a last resort: `NEURALGENTICS_DB_URL="postgresql://user:pass@host:5432/db" ./neuralgentics-backend`

**Do not change the default URL** in `main.go` without confirming the
container's actual credentials — the historical wrong default
(`postgresql://postgres:password@localhost:5434/neuralgentics`) pointed at
`memini-postgres` instead and caused startup failures.

## Release Engineering Notes

- **v0.12.5** is the latest tagged release (2026-07-15). Process-correction patch per AGENTS.md "Never Retag a Public Release" rule — v0.12.4 was already on npm, so a 1-character patch bump (0.12.4 → 0.12.5) was applied to unblock the failed re-publish. No code changes; see HANDOFF.md Session 48.
- **Release workflow**: Single job compiles the overlay plugin (`npx tsc`), bundles `.opencode/` config, and publishes the `@veedubin/neuralgentics` npm package. Container job builds and pushes postgres/sidecar/backend to ghcr.io.
- **Install flow**: Users run `npx @veedubin/neuralgentics --init` to bootstrap their project. The old curl-bash installer is deprecated.
- **Pre-release validation**: `scripts/validate-release.sh` — 8 checks (shell syntax, YAML, JSON, version consistency, file existence, TypeScript typecheck, Go vet, git status). Run before every `git tag`.
- **Archive naming**: `@veedubin/neuralgentics` npm package. Container images tagged as `ghcr.io/veedubin/neuralgentics-*:v0.9.4`.

## Execution Ordering Rules (MANDATORY)

These rules are **code-level enforced** by the orchestrator.

### Rule 1: Architect Designs Before Coder Builds
**NEVER** dispatch `architect` and `coder` in parallel for the same feature.

| Workflow | Correct Order | Wrong |
|----------|--------------|-------|
| New feature requiring design | 1. Architect → Design doc → 2. Coder → Implement | ❌ Architect + Coder in parallel |
| Bug fix (design exists) | Coder only | — |
| Design review | Architect → Reviewer | — |

**Rationale:** The coder needs the architect's design document as a Context Package. Sending both at the same time wastes tokens on duplicate/incorrect work.

### Rule 2: Reviewer Gates Merge
All `code-implementation` outputs MUST pass `reviewer` before `tester` runs integration tests.

### Rule 3: Parallelism Allowed Only For Independent Tasks
Multiple coders may run in parallel ONLY when tasks have no shared files and no design dependencies.

### Rule 4: One Task Per Coder Per Dispatch (Mandatory)
A single coder dispatch must contain **exactly ONE task** (T-XXX). Never bundle multiple tasks (e.g., T-065 + T-066) into one prompt, even if they are in the same module or "logically related."

**Rationale:** Coder agents have a finite context window. After ~60% utilization they start producing sloppy, hallucinated, or incomplete output. Splitting work into single-task dispatches keeps each coder within its sweet spot and forces clean wrap-ups (commit, memory save, quality gates) at the natural boundary of each task.

**Enforcement:**
- The orchestrator MUST scope each coder dispatch to a single card.
- If two related fixes would benefit from one agent's context, dispatch them as **two sequential coder cards** (T-065 first, then T-066) — the second coder can read T-065's commit and wrap-up memory to pick up where the first left off.
- Testers and architects may still be multi-task because they are read-only; this rule applies specifically to `boomerang-coder` dispatches.

### Rule 5: Coder Launches Linter Sub-Agent (Scan → Return → Apply → Verify)
The coder owns the diff. The linter is a **read-only scan sub-agent** that identifies what to fix — the coder applies the fix and writes the commit. The coder may also re-launch the linter (or a tester) to verify the fix landed cleanly.

**The flow inside one coder dispatch:**

```
1. Coder makes the logical change (edit code, add test, etc.)
2. Coder launches boomerang-linter sub-agent (via Task tool) with:
     - The list of files the coder touched
     - The project root
     - "Run the project's linters/formatters in CHECK mode (no writes).
      Return: (a) list of files that fail lint, (b) the exact diff lint would apply,
      (c) any other findings (missing test coverage, suspicious patterns)."
3. Linter returns a structured report. Coder reads it.
4. Coder APPLIES the linter's suggested fixes (writes the diff itself, runs the formatter
   in WRITE mode if needed: `gofmt -w file.go`, `bun run lint --fix`, etc.).
5. Coder re-runs the linter sub-agent to verify clean.
6. If linter also runs the test suite (e.g., pytest with --collect-only, or vitest run),
   coder runs the actual tests too: `go test`, `bun test`, `pytest`.
7. Coder commits, saves memory, returns to orchestrator.
```

**Why this split:**
- The linter has a **narrow, mechanical** job (read file → run tool → report). Perfect for a sub-agent.
- The coder has the **logical context** of the change (why the code looks the way it does). Only the coder can decide whether a lint warning is a real bug or a false positive.
- Linter suggestions are returned as data, not applied autonomously — the coder is the gate.
- Re-running the linter in step 5 catches anything the coder missed when applying fixes.

**What the linter sub-agent does NOT do:**
- Write files. Linter is read-only.
- Commit. Only the coder commits.
- Save memory. Only the coder saves the wrap-up memory.
- Decide whether to apply a fix. The coder decides.

**Tool mapping (linter sub-agent picks based on file extension):**
| Extension | Linter | Formatter |
|-----------|--------|-----------|
| `.go` | `go vet`, `golangci-lint` if installed | `gofmt -w`, `goimports -w` |
| `.ts`, `.tsx` | `eslint`, `tsc --noEmit` | `eslint --fix`, `prettier --write` |
| `.py` | `ruff check`, `mypy` | `ruff format`, `black` |
| `.sh` | `shellcheck` | `shfmt -w` |
| `.md` | `markdownlint` (if installed) | `prettier --write` |

**Example prompt the coder uses to launch the linter sub-agent:**

> "You are boomerang-linter. Project root: `/home/jcharles/...`. Files to scan: `packages/memory/src/neuralgentics/memory/store/memories.go`, `packages/memory/src/neuralgentics/memory/store/queries.go`. Run in CHECK MODE only (no writes). For each tool in the table, run it on these files and return a structured report: `{file, line, tool, severity, message, suggested_fix}`. Do not commit, do not edit, do not save memory. Return the report as your final message."

**Coder's wrap-up MUST include** the linter report's summary (count of issues found, count fixed) so the orchestrator can verify the loop was followed.

*(Added 2026-06-05 Session 23. First version had the linter doing the commit. Corrected: linter is a scan/advisor, coder is the writer. The handoff is "linter says what" → "coder writes the fix" → "linter verifies" → "coder commits".)*

### Rule 6: Release Cards MUST Spawn a Docs Card (Mandatory)
Every release card (`T-REL-NNN`) MUST include a child `T-DOCS-NNN` card that invokes the `update-gh-docs` skill before the tag is pushed. The release card is not "done" until the docs card is "done."

**Why:** Prior to Session 23, the v0.1.0 release shipped with an install URL that pointed to a non-existent release asset. The user fixed it post-tag in commit `afdc89d`. The fix should not have been needed — the `update-gh-docs` skill would have caught it during the release card workflow.

**Enforcement:**
- The kanban-board-manager MUST refuse to create a release card without a corresponding docs card in `blocked` or `todo` status.
- The orchestrator MUST dispatch `T-DOCS-NNN` before `T-REL-NNN`.
- The release card's "Acceptance" section MUST include "T-DOCS-XXX done" as a checkbox.
- The release card's "Depends on" section MUST list `T-DOCS-XXX`.

**Where the docs updates go (neuralgentics-specific):**
- `README.md` (install command, version badge, quickstart)
- `CHANGELOG.md` (new top section for the new version)
- `docs/index.md` (hero copy, latest features)
- `mkdocs.yml` (`site_url`, `repo_url`, version, new pages)
- `package.json` (root + `packages/tui`, `packages/opencode` version fields)
- `.github/workflows/release.yml` (Go version, build matrix, container job status)

**Where the docs updates do NOT go (local-only, never public):**
- `HANDOFF.md`, `CONTEXT.md`, `TASKS.md` (gitignored session artifacts)
- `certs/`, `.venv/`, `node_modules/`, `build/`, `dist/`, `site/`
- `opencode-base/`
- `docs/design/session-*.md`, `docs/design/*-plan*.md` (internal design docs)

**See also:** `skills/update-gh-docs/SKILL.md` for the full checklist and generic flow.

*(Added 2026-06-05 Session 23 after v0.1.0 shipped with an install URL pointing to a non-existent release asset. The post-tag fix should not have been needed; the docs card catches it during the release workflow.)*

## Future Direction: Git-Heavy Workflow
Once the kanban + linter sub-dispatch workflow is stable (Session 24+), the user wants to migrate toward a **git-heavy** model where:
- Each card lives on its own feature branch (e.g., `git checkout -b t-065-scan-error-propagation`).
- Commits are small, atomic, and reference the card ID in the message (`fix(memory): ...  Refs: T-065`).
- The orchestrator (or `boomerang-git` sub-agents) handles branch creation, rebases, and PR opening.
- The kanban card status is updated from git state (e.g., PR merged → card done).
- Rollback is a single `git revert` instead of an undo dance in working memory.

This is **not in scope for Session 23** — it's the long-term direction. The orchestrator should keep the existing 1-commit-per-area pattern but START including `Refs: T-XXX` in commit messages so the future git-heavy migration has clean history to work with.

*(Added 2026-06-05 Session 23 after a T-065+T-066 combined dispatch produced coherent work for the first half then degraded to "recommendations for next steps" instead of finishing the second task. Cost: 1 wasted dispatch, partial quality. Going forward: 1 task = 1 dispatch = 1 wrap-up = 1 memory save.)*
