---
name: /external-skills-fetcher
description: Clone and refresh the curated external skill repos into ~/.neuralgentics/external_skills/
---

Fetch external skills. Load and follow the `external-skills-fetcher` skill at `.opencode/skills/external-skills-fetcher/SKILL.md`. The skill clones the curated external skill repositories (Orchestra-Research/AI-Research-SKILLs and nextlevelbuilder/ui-ux-pro-max-skill) into `~/.neuralgentics/external_skills/` and refreshes them on session start. Toggle via `external_skills.enabled` in `.env`.