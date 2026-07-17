---
name: skill-self-audit
description: End-of-cycle audit that detects repeated processes and creates skills for them. Invoked by the orchestrator before wrap-up. If a process was repeated more than once during the cycle, the orchestrator invokes boomerang-agent-builder to formalize it as a skill before signing off.
---

# Skill Self-Audit

## Description

The orchestrator runs this audit at the end of every cycle. The audit scans the cycle for processes that were repeated more than once — and if any are found, the orchestrator creates a skill for them. This is how the Boomerang v3 skill library grows organically: as patterns repeat, they get formalized.

## The Rule

> **If we did a process more than once this cycle, it should be a skill.**

This is not optional. The orchestrator's wrap-up protocol includes this step explicitly. The user said:

> "We need to at the end of every boomerang look at if we did a process if it would make sense to make it a skill. We need this also built in."

So this skill is built in.

## When to Use This Skill

- The orchestrator is about to wrap up a cycle (every cycle)
- The user says "/boomerang-handoff" or the cycle is naturally ending
- A session is being terminated
- The user explicitly invokes "skill audit" or "self-audit"

## Audit Process

### 1. Review the cycle's actions

Walk through the orchestrator's actions in the current cycle:
- Memory queries
- Architect dispatches
- Worker dispatches (Task tool calls)
- File reads / searches
- Skill invocations
- Context Package builds
- Status changes

Look for **processes that recurred** — meaning the same multi-step pattern was executed more than once, even if the targets were different.

Examples of "recurring process":
- Built 3 different Context Packages for 3 different cards (→ the "build Context Package" process should be a skill)
- Dispatched 4 coder tasks each with the same permission-check step (→ the "broker permission gate" should be a skill)
- Read AGENTS.md, TASKS.md, HANDOFF.md at the start of two different cycles (→ already a skill: the Session Start Protocol)
- Had to look up the same docs/roadmap path 5 times during dispatch (→ the orchestrator should pin the roadmap as a session variable)
- Translated the same kind of card evidence into the same kanban-board-manager call 6 times (→ the wrap-up evidence structure is already formalized; no new skill needed)

Examples of "not recurring" (do NOT make a skill):
- Read 1 file once to get context
- Asked the architect to design 1 thing
- Performed 1 dispatch

### 2. For each recurring process, decide

Ask three questions:

1. **Is the process already a skill?** If yes, no action. Example: "build Context Package" is a documented pattern in the orchestrator skill, not a new skill.
2. **Is the process too narrow to be a skill?** A skill should be reusable across projects and sessions. If the process is project-specific or one-off, document it in HANDOFF.md instead of creating a skill.
3. **Would formalizing it reduce token cost or increase reliability?** If yes, create the skill. If it's just a "nice to have," defer.

If all three answer "no," don't create a skill.

### 3. If a new skill is warranted

Invoke the `boomerang-agent-builder` skill with:

- **Process name** — what to call the new skill
- **Process description** — what it does, when to use it
- **Process steps** — the exact sequence of operations
- **Inputs** — what the skill takes
- **Outputs** — what the skill returns
- **Example invocation** — a worked example

`boomerang-agent-builder` handles the rest: frontmatter, naming convention, syncing across the 3 skill locations, validating with `npm run fix-perms` and yaml_check.

### 4. If a skill should be UPDATED (not created)

If an existing skill is being applied in a way that wasn't anticipated, the orchestrator should:
- Note the deviation in HANDOFF.md
- Add a TODO to the kanban board for "improve <skill-name> to handle <scenario>"
- Continue with the current cycle; do not block on the skill update

### 5. Record the audit result

Whether or not a skill was created, the audit result is recorded:

- **Skills created this cycle:** T-XXX → new skill name
- **Skills marked for improvement:** T-YYY → skill name → reason
- **No new skills needed:** a one-liner explaining why the cycle's processes were all unique or already covered

This is saved to memoryManager with `project` metadata so the next session can see what was learned.

## Output Format

The audit returns a single Markdown block:

```markdown
## Skill Self-Audit Result

### Skills Created
- **<skill-name>** — <one-line description>
  - Triggered by: <which actions in the cycle>
  - Replaces: <ad-hoc process description>

### Skills Marked for Improvement
- **<skill-name>** — <gap description>
  - Tracked as: T-XXX on the kanban board

### No Action Needed
- <one-liner per non-issue, e.g. "The Context Package template is already in boomerang-orchestrator SKILL.md">

### Cycle Summary
- Total actions reviewed: N
- Recurring processes found: N
- Skills created: N
- Skills marked for improvement: N
```

## Anti-Patterns

- **Do not** create a skill for a process that was performed only once. "Once" is data, not a pattern.
- **Do not** create a skill that overlaps with an existing skill. Update the existing one instead.
- **Do not** create skills for project-specific processes. Those belong in HANDOFF.md or the project's own docs.
- **Do not** skip the audit. The user asked for it to be "built in," and it is.

## Model

Use **Gemini** for the audit reasoning. Skill creation itself (via `boomerang-agent-builder`) uses the agent-builder's recommended model (deepseek-v4-pro:cloud or higher).
