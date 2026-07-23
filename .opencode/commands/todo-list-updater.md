---
name: /todo-list-updater
description: Refresh the project's todo list (TASKS.md) to reflect the current cycle's state
agent: orchestrator
---

Refresh the project todo list. Load and follow the `todo-list-updater` skill at `.opencode/skills/todo-list-updater/SKILL.md`. The skill marks completed items as done, removes stale items, adds newly discovered items, and keeps the current-phase section of `TASKS.md` scannable for the next cycle.