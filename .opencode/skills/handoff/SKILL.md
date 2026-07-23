---
name: handoff
description: End-of-session wrap-up. Runs the self-evolution gate (auto-create), then updates HANDOFF.md + TASKS.md, then commits any new SKILL.md files. Invoke via `/handoff`.
tags:
  - handoff
  - session
  - documentation
  - evolution
---

# Boomerang Handoff

## When to Invoke

At the **end of every session**, or when the user explicitly requests `/handoff`. This skill wraps up the session, runs the self-evolution gate to auto-create skills from repeated patterns, updates documentation, and commits any new artifacts.

## Preconditions

Before running the handoff, verify:

- [ ] All dispatched cards are in `done` or `blocked` status
- [ ] All quality gates have passed (lint, typecheck, test)
- [ ] Working tree is clean or has only documentation changes pending
- [ ] `AGENTS.md`, `TASKS.md`, and `HANDOFF.md` exist and are readable
- [ ] You are in a git repository

## Step 1: Run Self-Evolution Gate

Invoke the evolution gate to detect repeated patterns and auto-create skills:

```
Call MCP tool: neuralgentics_evolution_gate
Params: { auto_create: true }
```

The gate will:

1. Query memory for pattern candidates (trigger count >= 3)
2. Evaluate each candidate against 4 criteria (repetition, interface clarity, independence, time savings)
3. Auto-create `SKILL.md` files for qualified candidates in `.opencode/skills/<name>/`
4. Save evolution results to memory

**Expected output:** `{ evaluated: N, qualified: M, created: [...] }`

If the gate creates new skills, note their names for the commit message in Step 3.

## Step 2: Update HANDOFF.md and TASKS.md

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

## Step 3: Commit New SKILL.md Files

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
- Gate failure does NOT block the handoff. The compaction hook also calls the gate independently with the same `autoCreate: true` default.