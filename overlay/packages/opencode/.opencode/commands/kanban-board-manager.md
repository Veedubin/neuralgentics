---
name: /kanban-board-manager
description: Manage the kanban board in TASKS.md — create, move, and audit cards across seven statuses
agent: orchestrator
---

Manage the project kanban board. Load and follow the `kanban-board-manager` skill at `.opencode/skills/kanban-board-manager/SKILL.md`. The skill creates one card per roadmap task in `TASKS.md`, moves cards across the seven statuses (triage, todo, ready, running, blocked, done, archived), and audits the board for unaccounted work.