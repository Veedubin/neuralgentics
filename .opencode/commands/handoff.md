---
name: /handoff
description: End-of-session wrap-up — runs the self-evolution gate, updates HANDOFF.md + TASKS.md, commits new SKILL.md files
agent: orchestrator
---

Wrap up the current session. Load and follow the `handoff` skill at `.opencode/skills/handoff/SKILL.md`. The skill runs the self-evolution gate (auto-create skills from repeated patterns), updates `HANDOFF.md` and `TASKS.md` with session outcomes, and commits any newly-created skill artifacts. Do not push — leave the working tree for the user to review.