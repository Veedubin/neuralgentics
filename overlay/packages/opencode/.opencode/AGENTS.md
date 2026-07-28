# AGENTS.md

This project is bootstrapped with **neuralgentics** — an OpenCode plugin
that adds a 12-agent roster, memory (via memini-ai), routing enforcement,
and slash commands. This file is the bootstrap guide OpenCode loads via
`instructions: ["AGENTS.md"]` in `.opencode/opencode.json`.

## What neuralgentics installed

- `.opencode/opencode.json` — OpenCode config: provider (Ollama Cloud by
  default), MCP servers (memini-ai-dev, etc.), LSP, formatter, plugin entry.
- `.opencode/agents/` — 12 agent personas (see roster below).
- `.opencode/skills/` — 7 skills (orchestrator, handoff, kanban-board-manager,
  skill-self-audit, todo-list-updater, update-gh-docs, external-skills-fetcher).
- `.opencode/commands/` — 7 slash commands (`/handoff`, `/orchestrator`,
  `/kanban-board-manager`, `/skill-self-audit`, `/todo-list-updater`,
  `/update-gh-docs`, `/external-skills-fetcher`).
- `AGENTS.md` — this file (project root).
- `docker-compose.yml` + `docker/*.Dockerfile` — optional container stack
  for the memory backend (PostgreSQL + pgvector + embedding sidecar).

## Mandatory memini-ai memory protocol

All agents **MUST** use memini-ai at every step. Memory is the source of
truth; without it, agents lose context across sessions and duplicate work.

1. **Query FIRST** — Before starting any task, call `memini-ai-dev_query_memories`
   with a descriptive query (e.g. `"user auth implementation patterns"`).
2. **Save AFTER** — When a task completes, call `memini-ai-dev_add_memory`
   with a concise summary. For high-value work (verified bug fixes,
   architectural decisions, session outcomes), include a `project` tag in
   the metadata.
3. **Trust signals** — If a memory was helpful, call
   `memini-ai-dev_adjust_trust` with `signal: "agent_used"` (+0.05). If it
   was wrong, use `signal: "user_corrected"` (-0.10).

## Agent roster

Neuralgentics ships 12 specialized agents. The orchestrator routes tasks
to the right specialist based on the mandatory routing matrix.

| Agent | Role |
|-------|------|
| orchestrator | Main coordinator, delegates to sub-agents |
| architect | System design, trade-off analysis, research |
| coder | Fast code generation, bug fixes |
| explorer | Codebase exploration, file finding |
| tester | Test writing, test execution |
| reviewer | Code review: logic, security, consistency |
| linter | Mechanical linting: ESLint, Ruff, mypy, tsc |
| git | Version control: commits, branches, tags |
| writer | Documentation, markdown |
| researcher | Web research, data gathering, scraping |
| release | Version bumps, changelogs, tagging |
| agent-builder | Pattern detection, skill/agent creation |

## Slash commands

- `/handoff` — Wrap up a session cleanly; save context for next session.
- `/orchestrator` — Run the full orchestrator cycle (plan → dispatch → audit).
- `/kanban-board-manager` — Manage the kanban board in TASKS.md.
- `/skill-self-audit` — End-of-cycle audit; create skills for repeated processes.
- `/todo-list-updater` — Refresh the project todo list.
- `/update-gh-docs` — Update GitHub docs (README, CHANGELOG, mkdocs).
- `/external-skills-fetcher` — Fetch external skills from a registry.

## House rules

- **No secrets** — never paste real API keys, tokens, or passwords into
  source, docs, tests, or examples. Use placeholders like
  `YOUR_API_KEY` or `{env:OLLAMA_API_KEY}`.
- **Never overwrite user files** — `--init` and `--update` never clobber
  an existing root `AGENTS.md`. Your customizations are preserved.
- **Use overrides for personalization** — drop a `.md` file named after an
  agent into `.opencode/overrides/` (e.g. `overrides/coder.md`) and its body
  is appended to the default agent on the next `--init`/`--update`. The
  `overrides/` directory is never modified by neuralgentics.
- **Re-pick models without reinstalling** — edit
  `.opencode/neuralgentics.config.json` and run
  `npx @veedubin/neuralgentics --remodel` to patch the `model:` line in each
  agent's frontmatter. Your overrides (body content) are never touched.

## Your first session (5-step quickstart)

1. **Confirm the install** — `opencode` should launch with the neuralgentics
   plugin loaded. You should see the agent roster in `.opencode/agents/`.
2. **Set your provider** — if you're not on Ollama Cloud, edit
   `.opencode/opencode.json` `provider` block. See the workspace
   `docs/providers.md` for switching recipes (local Ollama, Docker Model
   Runner, OpenAI, Anthropic, Google, OpenRouter).
3. **Start the memory backend** (optional for pgembed / built-in mode; required
   for team mode) — `docker compose up -d` or `neuralgentics --db-start`.
4. **Ask the orchestrator** — type your request; the orchestrator will
   query memini-ai, plan, and dispatch the right specialist agent(s).
5. **Wrap up** — run `/handoff` at the end of your session to save context
   for next time. The handoff updates TASKS.md, AGENTS.md (project-specific
   notes), and stores a summary memory in memini-ai.

For full docs: https://github.com/Veedubin/neuralgentics#readme