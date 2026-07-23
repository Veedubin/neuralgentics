---
name: /skill-self-audit
description: End-of-cycle audit that detects repeated processes and creates skills for them
agent: orchestrator
---

Audit the current cycle for repeated processes. Load and follow the `skill-self-audit` skill at `.opencode/skills/skill-self-audit/SKILL.md`. The skill reviews the cycle's work, identifies any process repeated more than once, and invokes the agent-builder to formalize it as a reusable skill before the orchestrator signs off.