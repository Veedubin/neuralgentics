---
name: todo-list-updater
description: Refreshes the project's todo list (TASKS.md or its Current Phase section) to reflect the current cycle's state. Invoked by the orchestrator at end of cycle, when a phase transitions, or when the user asks to clean up the todo list. Marks done items, removes stale items, adds newly discovered items, and keeps the file scannable for the next cycle.
---

# Todo List Updater

## Description

The todo list lives in `TASKS.md` (or in a project-specific location if the project overrides the convention). The orchestrator invokes this skill to keep the file current. The file is the canonical "what are we working on right now" — chat scrollback and memory are not.

## When to Use This Skill

- The orchestrator is about to wrap up a cycle
- A phase transition is happening (a major milestone reached)
- The user asks "what's the todo list?" or "clean up the todos"
- Several items have completed since the last update
- New items were discovered during the cycle that need to be tracked

## The File Convention

`TASKS.md` has this structure. The updater preserves the structure; it does not impose it on a project that uses a different convention.

```markdown
# <Project> Tasks

## Overview
<one paragraph: what this project is, current status, link to roadmap>

## Current Phase: <phase name>
### Active
- [ ] **T-001** · <task title> — <status badge, e.g. 🔄 running> — <one-line context>
- [ ] **T-002** · <task title> — 🔲 ready — <one-line context>
- [ ] **T-003** · <task title> — 🚫 blocked — <one-line context, see reason>

### Pending (queued, not yet started)
- [ ] **T-004** · <task title> — <reason for queueing>

### Completed This Phase
- [x] **T-005** · <task title> — <one-line summary, link to wrap-up>
- [x] **T-006** · <task title> — <one-line summary, link to wrap-up>

## Next Phase: <phase name>
<bullet list of tasks, not yet started>

## Backlog / Future Phases
<bullet list of tasks for phases beyond Next>

## Completed (all phases, historical)
- [x] **T-000** · <task title> — <phase X.Y, date, link to wrap-up>

## Reference
- Roadmap: `docs/roadmap-<proj>.md`
- Kanban board: this file (TASKS.md)
- Memory: memoryManager memory ids for session summaries
```

The "Current Phase" section is the **headline** of the file. It should be scannable in 30 seconds.

## Operations

### refresh_from_board()

The default entry point. Reads the kanban board (TASKS.md kanban section or, if missing, the card-level format) and rebuilds the Current Phase section. The result is sorted: blocked → running → ready → pending.

### mark_done(card_id, summary)

Moves a card from Active to Completed This Phase. The summary is the worker's wrap-up closeout. The full wrap-up is in the kanban card; the todo list gets a one-liner plus a link to the card.

### mark_blocked(card_id, reason)

Moves a card from Active to a "Blocked" subsection with the reason. Stays visible (does not move to Pending) so the user sees it on every refresh.

### add_discovered(item, source)

Adds a new item that was discovered during the cycle. The source is a citation (e.g. "discovered during T-007: error handling for malformed messages was missing"). New items go to Active or Pending depending on whether they have dependencies.

### drop(card_id, reason)

Removes a card from the todo list entirely. Used for items that were discovered to be out of scope, duplicates, or absorbed into another card. The original card is moved to `archived` in the kanban board; the todo list entry is removed with a note in the changelog at the bottom of the file.

### transition_to_next_phase()

When the Current Phase is fully Done (all cards in `done` or `archived`), this operation:
1. Renames the current section to "Completed (<phase name>)" with a date stamp
2. Promotes Next Phase → Current Phase
3. Promotes Backlog → Next Phase
4. Stamps the new Current Phase header with today's date

### sync_to_memory()

Optional. Saves the current todo list to memoryManager with `project` metadata. The orchestrator does this on handoff. The skill does not run this automatically; it is invoked on demand.

## Rules

- **The todo list is a summary, not the source of truth.** The kanban board (TASKS.md kanban section) has the full card content. The todo list has scannable one-liners.
- **Never duplicate content.** If a card's full details are in the kanban section, the todo list entry is a one-liner with a reference.
- **The current phase is always at the top.** Historical completed phases are below.
- **No "in progress" items that aren't being worked on.** If a card is `running` but no worker is active, the orchestrator must either re-claim it or move it to `blocked`.
- **Use status badges** for scannability: 🔄 running, 🔲 ready, 🚫 blocked, ✅ done, 📦 archived, ❓ triage.

## Anti-Patterns

- **Do not** create todo items without a roadmap link (except for items discovered mid-cycle, which cite the source).
- **Do not** keep items in the Active section that have been "stuck" for more than 7 days. They are stale; move them to Blocked with a reason.
- **Do not** let the todo list grow unbounded. After 50+ items, archive the oldest 20% to a separate "Archive" file.
- **Do not** rewrite the file from scratch each time. The updater should make targeted edits and preserve the structure.

## Model

Use **Gemini** for routine refreshes. Use a higher-reasoning model (e.g. `kimi-k2.6:cloud` for Boomerang) for `transition_to_next_phase` since that involves a structural reorganization.
