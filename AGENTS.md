# Neuralgentics Agents

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

False success reports (e.g. wrap-up claims "all gates pass" while the dispatch log shows errors) are a session-ending violation. The orchestrator re-runs every gate on return; sub-agents that lie lose trust and get the `--max-steps` budget reduced.

*(Added 2026-06-04 Session 20 after T-029 wrap-up falsely claimed "all 4 Go modules build clean" while the dispatch log contained go build errors. Verified clean on re-run; rule added to prevent recurrence.)*

## Protocol
All tasks must follow the 8-step Boomerang Protocol, enforced by the orchestrator:
1. Memory Query
2. Thought Chain
3. Planning
4. Delegation
5. Git Check
6. Quality Gates
7. Doc Update
8. Memory Save (Wrap-up storage in `memini-core`)


## Agent Roster

| Role | Model | Purpose |
| :--- | :--- | :--- |
| Orchestrator | Primary | Task decomposition, routing, and protocol enforcement |
| Architect | Primary | System design, trade-off analysis, and research |
| Coder | Secondary | High-speed implementation and bug fixing |
| Reviewer | Primary | Code quality, security audit, and logic verification |
| Explorer | Secondary | File finding and codebase mapping |
| Tester | Secondary | Unit, integration, and E2E test generation |

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

### Rule 5: Coders Delegate Lint/Format to Sub-Agents (Mandatory)
A coder MUST NOT run `gofmt`/`goimports`/`eslint`/`prettier`/`ruff`/`black` style fixes inline. The coder's job is the **logical change** (implement, fix, refactor). Style enforcement is a separate concern that belongs to a `boomerang-linter` sub-dispatch.

**How it works:**
- The coder's wrap-up MUST include a list of "files touched that need linting" (with the lint tool per file: e.g., `gofmt -w` for `.go`, `bun run lint --fix` for `.ts`, `ruff check --fix` for `.py`).
- The orchestrator then dispatches a `boomerang-linter` card (T-LINT-XXX) that:
  1. Reads the coder's wrap-up memory
  2. Runs the appropriate linter/formatter on each touched file
  3. Re-runs tests to confirm style changes didn't break anything
  4. Commits the lint changes as a separate commit (e.g., `style(memory): gofmt + goimports after T-065`)
- This keeps the coder's context focused on the actual bug fix and gives the linter agent a clean, scoped job.

**Exception:** If the coder's change is purely stylistic (no logical change, e.g., a rename), the coder may lint inline. But any non-trivial code change should defer lint to a sub-agent.

*(Added 2026-06-05 Session 23 after observing coder context get pulled into formatting concerns at the end of long dispatches. Formalizes the "coder writes logic, linter enforces style" split.)*

## Future Direction: Git-Heavy Workflow
Once the kanban + linter sub-dispatch workflow is stable (Session 24+), the user wants to migrate toward a **git-heavy** model where:
- Each card lives on its own feature branch (e.g., `git checkout -b t-065-scan-error-propagation`).
- Commits are small, atomic, and reference the card ID in the message (`fix(memory): ...  Refs: T-065`).
- The orchestrator (or `boomerang-git` sub-agents) handles branch creation, rebases, and PR opening.
- The kanban card status is updated from git state (e.g., PR merged → card done).
- Rollback is a single `git revert` instead of an undo dance in working memory.

This is **not in scope for Session 23** — it's the long-term direction. The orchestrator should keep the existing 1-commit-per-area pattern but START including `Refs: T-XXX` in commit messages so the future git-heavy migration has clean history to work with.

*(Added 2026-06-05 Session 23 after a T-065+T-066 combined dispatch produced coherent work for the first half then degraded to "recommendations for next steps" instead of finishing the second task. Cost: 1 wasted dispatch, partial quality. Going forward: 1 task = 1 dispatch = 1 wrap-up = 1 memory save.)*
