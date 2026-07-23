---
name: /orchestrator
description: Main coordinator — extrapolates the user prompt, dispatches the architect, seeds the kanban, dispatches cards, runs wrap-up audit
agent: orchestrator
---

Run the Boomerang Cycle v3 kanban-native orchestration flow. Load and follow the `orchestrator` skill at `.opencode/skills/orchestrator/SKILL.md`. The skill walks the five-phase cycle: intake & extrapolation, roadmap (architect), kanban seed, broker-gated dispatch, and wrap-up audit with skill self-audit and todo-list update.