---
name: kanban-board-manager
description: Manages the Boomerang kanban board in TASKS.md. Creates, moves, and audits cards across seven statuses (triage, todo, ready, running, blocked, done, archived). Seeded by the orchestrator from a roadmap; queried by the orchestrator to find ready cards for dispatch; updated by workers when they complete a card. The board is the durable source of truth for "what is being worked on."
---

# Kanban Board Manager

## Description

The kanban board lives in the project's `TASKS.md` file. It has seven statuses (Hermes-compatible) and supports dependency links between cards. The board manager is the **only** agent that mutates the board. Workers report status changes through it; the orchestrator queries it to find ready cards.

## When to Use This Skill

- After the architect writes a roadmap → seed the board with one card per task.
- A worker has finished a card → move it `running → done` with evidence.
- A worker is stuck → move it `running → blocked` with a reason.
- The orchestrator needs to find `ready` cards → query the board.
- The user asks "what's the status?" → render the board.
- A card needs to be broken into smaller cards.
- A card needs to be re-architect-ed.
- A card needs to be requeued to "next session" (moved to `todo` with a reason).

## Card Schema

Each card in `TASKS.md` uses this exact format. The board manager is responsible for keeping the format consistent.

```markdown
### T-001 · <task title>
- **Status:** <triage|todo|ready|running|blocked|done|archived>
- **Assignee:** <agent profile, e.g. boomerang-coder>
- **Phase:** <phase name from roadmap>
- **Roadmap:** `docs/roadmap-<proj>.md#task-1-1`
- **Goal:** one-sentence goal
- **Acceptance:** testable criteria (bullet list)
- **Scope IN:** bullet list
- **Scope OUT:** bullet list, with escalation target
- **Depends on:** T-002, T-003 (or `none`)
- **Blocks:** T-004, T-005 (or `none`)
- **Created:** YYYY-MM-DD
- **Updated:** YYYY-MM-DD
- **Wrap-up evidence:**
  - changed_files: [...]
  - verification: [...]
  - residual_risk: [...]
  - summary: one-paragraph closeout
```

Cards are grouped by status in `TASKS.md` with `## <Status>` headers (e.g. `## Triage`, `## Todo`, `## Ready`, `## Running`, `## Blocked`, `## Done`, `## Archived`). The board manager keeps the seven sections in this order.

## Operations

### seed_from_roadmap(roadmap_path)

Called by the orchestrator after the architect writes a roadmap. Reads `docs/roadmap-<proj>.md`, creates one card per task with:
- Status defaults to `todo` (unless the task has no dependencies, in which case `ready`)
- Assignee defaults to the profile listed in the roadmap
- ID assigned sequentially (`T-001`, `T-002`, ...)
- All other fields populated from the roadmap section

The board manager **does not** skip this step. The roadmap is the contract; the board is the working copy.

### list_by_status(status)

Returns all card IDs and titles with the given status. Used by the orchestrator to find `ready` cards for dispatch.

### find_ready_cards()

Returns all cards with status `ready` AND all dependencies marked `done`. These are dispatchable.

### claim(card_id, worker)

Moves a card `ready → running` and stamps the worker as the assignee. Returns the card's full content for the worker's Context Package.

### complete(card_id, evidence)

Moves a card `running → done`. The `evidence` argument is the structured wrap-up:

```json
{
  "summary": "one-paragraph closeout",
  "changed_files": ["path/to/file.py"],
  "verification": ["pytest tests/x.py", "npm run lint"],
  "residual_risk": ["what was not tested", "what still needs human review"],
  "retry_notes": "what failed before if this was a retry"
}
```

The board manager appends the evidence to the card's `Wrap-up evidence` block and stamps the `Updated` date.

### block(card_id, reason)

Moves a card `running → blocked` (or `todo → blocked`) with a `Blocked reason` field. The orchestrator surfaces blocked cards to the user.

### unblock(card_id, resolution)

Moves a card `blocked → ready` (or `todo`) with a `Resolution` field describing what changed.

### break_down(card_id, new_cards)

Splits a card into multiple smaller cards. Closes the original as `archived` with reason "broken into T-X, T-Y, T-Z" and creates the new cards with `todo` status. Dependencies are re-pointed.

### rearchitect(card_id, question)

Moves a card `todo → triage` with a `Re-architect question` field. The orchestrator will route the card back to the architect with this question as part of the Context Package.

### requeue(card_id, reason)

Moves a card to `todo` with a `Requeue reason` field. Use this for cards that are out of scope for the current session but should be revisited later.

## Audit Operations

### walk_board()

Renders a human-readable summary of all cards grouped by status. Used by the orchestrator at wrap-up and by the user for status checks.

### find_unaccounted()

Returns all cards that are not `done` or `archived` AND have not been updated in the last 7 days. The orchestrator uses this at wrap-up to decide what to break, re-architect, or requeue.

### find_blocked()

Returns all `blocked` cards. The orchestrator surfaces these to the user; they need human input.

### find_done_without_evidence()

Returns all `done` cards where `Wrap-up evidence` is missing or incomplete. The orchestrator uses this to verify worker wrap-ups.

## Implementation Notes

- The board manager operates on `TASKS.md` directly. The file is the board. There is no separate database.
- Card IDs are stable. Once assigned, an ID is never reused.
- `Updated` is stamped on every status change.
- The board manager does NOT decide what to work on. The orchestrator decides that. The board manager only records decisions.
- Workers report status changes through the board manager; they do not edit `TASKS.md` directly.

## Model

Use **Gemini** for routine board operations. The board manager is mostly mechanical (move status, append evidence) and does not need heavy reasoning.

## Anti-Patterns

- **Do not** let a worker edit `TASKS.md` directly. All changes go through the board manager.
- **Do not** store card content in chat context. Always read from `TASKS.md` and write back to `TASKS.md`.
- **Do not** create a card without a roadmap link (except in `triage`, where the card IS the rough idea).
- **Do not** move a card to `done` without evidence. The board manager should refuse and prompt the worker for the wrap-up JSON.
- **Do not** auto-promote a card to `ready` if its dependencies are not all `done`. The orchestrator (or board manager's `find_ready_cards()`) checks this explicitly.
