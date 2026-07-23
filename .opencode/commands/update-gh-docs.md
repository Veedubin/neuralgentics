---
name: /update-gh-docs
description: Update GitHub-flavored docs (README, CHANGELOG, release notes) so they render correctly and stay in sync before a release
agent: writer
---

Update GitHub-facing documentation before tagging a release. Load and follow the `update-gh-docs` skill at `.opencode/skills/update-gh-docs/SKILL.md`. The skill walks the checklist of docs to update (README, CHANGELOG, docs/index.md, mkdocs.yml, package.json version fields, release workflow) and validates that install URLs and version badges point at the correct release assets.