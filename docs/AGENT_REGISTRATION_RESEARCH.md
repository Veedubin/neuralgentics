# Agent Registration: How OpenCode v1.15.x Discovers Agents

**Date:** 2026-05-22  
**Researcher:** boomerang-architect  
**Status:** Complete

## 1. The Core Mechanism: `ConfigAgent.load(dir)` 

OpenCode discovers agents through a **filesystem scan**, not through programmatic registration. The entrypoint is in:

```
opencode-base/packages/opencode/src/config/agent.ts — ConfigAgent.load(dir)
```

### How it works (lines 106-130):

```typescript
export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item) // Parse YAML frontmatter + markdown body
    if (!md) continue
    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])
    const config = { name, ...md.data, prompt: md.content.trim() }
    result[config.name] = ConfigParse.schema(Info, config, item)
  }
  return result
}
```

**What it globs:** `{agent,agents}/**/*.md` — meaning files in either `agent/` or `agents/` directory with `.md` extension.

**What it parses:** YAML frontmatter (gray-matter parser) + markdown body → the body becomes the agent's `prompt`.

## 2. WHERE This Scan Runs

The `ConfigAgent.load(dir)` is called for **each directory** returned by `ConfigPaths.directories()`.

From `opencode-base/packages/opencode/src/config/config.ts` (lines 657-659):
```typescript
result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
```

And from `ConfigPaths.directories()` (paths.ts lines 23-41), directories are collected in this order:

| Priority | Path | Source |
|----------|------|--------|
| 1 | `~/.config/opencode/` | Global config |
| 2 | `.opencode/` walking UP from workdir to worktree | Project configs (ancestor-first) |
| 3 | `~/.opencode/` | Home directory config |
| 4 | `OPENCODE_CONFIG_DIR` env var (if set) | Explicit override |

**This means:** agents defined in lower-priority directories can be **overridden** by higher-priority ones via `mergeDeep()`. A project-level `agents/boomerang.md` would override one in `~/.opencode/agents/`.

## 3. The THREE Sources of Agent Definitions

### Source A: Filesystem `.opencode/agents/*.md` 

This is how the boomerang-v3 agents at `/home/jcharles/Projects/MCP-Servers/.opencode/agents/` appear in OpenCode.

**These 15 files exist:**
```
.opencode/agents/
├── boomerang-agent-builder.md
├── boomerang-architect.md
├── boomerang-coder.md
├── boomerang-explorer.md
├── boomerang-git.md
├── boomerang-handoff.md
├── boomerang-init.md
├── boomerang-linter.md
├── boomerang-release.md
├── boomerang-scraper.md
├── boomerang-tester.md
├── boomerang-writer.md
├── boomerang.md
├── mcp-specialist.md
└── researcher.md
```

**Format (from `boomerang-architect.md`):**
```markdown
---
description: Boomerang Architect v3 - ...
mode: subagent          # or "primary" or "all" (appears in both lists)
model: ollama/deepseek-v4-pro
steps: 50
permission:
  read:
    "*": allow
  glob: allow
  tool:
    "memini-ai-dev_query_memories": allow
    ...
  task:
    "researcher": allow
    "boomerang-explorer": allow
---

## Agent prompt body (markdown)
This becomes the system prompt for the agent.
```

**Key YAML frontmatter fields** (from `agent.ts` schema, lines 21-49):

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"subagent"` \| `"primary"` \| `"all"` | Where agent appears. `subagent` = task tool only. `primary` = Agent chooser only. `all` = both. |
| `description` | string | Shown in agent list. MANDATORY for agents to appear. |
| `model` | string | Model specifier (e.g., `ollama/deepseek-v4-pro`) |
| `permission` | object | Tool access rules |
| `prompt` | (body text) | System prompt (everything after frontmatter `---`) |
| `hidden` | boolean | Hide from autocomplete (default: false) |
| `color` | hex/name | UI color |
| `steps` | integer | Max agentic iterations |
| `disable` | boolean | Disable this agent |

### Source B: Inline `opencode.json` → `config.agent` field

Agents can also be defined directly in `opencode.json` under the `agent` key. These are merged by `agent.ts` lines 283-310:

```typescript
for (const [key, value] of Object.entries(cfg.agent ?? {})) {
  if (value.disable) {
    delete agents[key]
    continue
  }
  // ... merges with filesystem-discovered agents
}
```

This means you can put agent config in `opencode.json`:
```json
{
  "agent": {
    "neuralgentics-orchestrator": {
      "mode": "all",
      "description": "Neuralgentics Orchestrator - ...",
      "model": "ollama/kimi-k2.6",
      "permission": { ... }
    }
  }
}
```

However, this only provides **configuration** (model, permissions, mode, etc.) — the **system prompt** (markdown body) must come from a `.md` file via Source A.

### Source C: Built-in (native) Agents

OpenCode has hardcoded native agents (defined in `agent/agent.ts` lines 129-281):

| Name | Mode | Hidden |
|------|------|--------|
| `build` | primary | no |
| `plan` | primary | no |
| `general` | subagent | no |
| `explore` | subagent | no |
| `scout` | subagent | no (experimental) |
| `compaction` | primary | yes |
| `title` | primary | yes |
| `summary` | primary | yes |

These are **always present** and cannot be deleted (though they can be disabled).

## 4. How the `task` Tool Finds Valid `subagent_type` Values

From `tool/task.ts` (line 139-142):
```typescript
const next = yield* agent.get(params.subagent_type)
if (!next) {
  return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
}
```

It calls `Agent.Service.get(name)` which returns the merged agent record. The `task` tool accepts any agent with `mode: "subagent"` or `mode: "all"`. Agents with `mode: "primary"` only appear in the agent chooser dropdown.

When the model invokes the `task` tool, it sees the list of available subagent types from the system prompt, which is built from `Agent.list()` (sorted alphabetically, with `build` and `plan` first if they're the default).

## 5. What `instructions: ["AGENTS.md"]` Does — NOT Agent Registration

The `instructions` field in `opencode.json` provides **system prompt instructions**, NOT agent definitions. From `session/instruction.ts` (lines 14-18, 134-148):

```typescript
const files = ["AGENTS.md", ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]), "CONTEXT.md"]

// In systemPaths():
if (config.instructions) {
  for (const raw of config.instructions) {
    // Resolves "AGENTS.md" by walking up from working directory
    // Content is injected into system prompt as: "Instructions from: <path>\n<content>"
  }
}
```

**The content is injected as system instructions**, prefixed with `Instructions from: /path/to/AGENTS.md`.

**AGENTS.md does NOT create agents.** It provides guidelines and context to the LLM.

## 6. Plugin System — No Agent Registration Hooks

From `opencode-base/packages/opencode/src/config/plugin.ts`:

```typescript
export async function load(dir: string) {
  const plugins: Spec[] = []
  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", { cwd: dir, ... })) {
    plugins.push(pathToFileURL(item).href)
  }
  return plugins
}
```

Plugins are loaded by:
1. Scanning `{plugin,plugins}/*.{ts,js}` in each config directory
2. Resolving npm package specifiers from `opencode.json` → `plugin` array

**OpenCode's plugin API DOES NOT expose an `agents` or `registerAgent` method.** A search for `registerAgent` / `register.*agent` across the entire `opencode/src` directory returned zero results.

The plugin output shape is:
```typescript
export interface PluginOutput {
  tool: Record<string, ToolDefinition>;     // MCP tools
  event: (payload: { event: unknown }) => Promise<void>;  // lifecycle events
  config: (cfg: Record<string, unknown>) => Promise<void>; // config merge
  cleanup: () => Promise<void>;
}
```

**No agent registration possible via plugins.**

## 7. Why the Neuralgentics Orchestrator Does NOT Appear

**Root cause:** Neuralgentics has `.opencode/` directory at `neuralgentics/.opencode/`, but it does NOT contain an `agents/` subdirectory.

```
neuralgentics/.opencode/
├── node_modules/
├── opencode.json
├── package-lock.json
└── package.json
```

No `agents/` directory. No `.md` files with agent frontmatter.

When OpenCode launches from the `opencode-base/packages/opencode` directory (via `./neuralgentics start` → `bun run dev`), the working directory is `.../opencode-base/packages/opencode`, NOT the `neuralgentics/` root. The `directories()` walk-up picks up:
1. `~/.config/opencode/` — no agents there
2. `.opencode/` from workdir up — may or may not find `neuralgentics/.opencode/` depending on worktree
3. `~/.opencode/` — this is `/home/jcharles/.opencode/`

The boomerang agents appear because `/home/jcharles/Projects/MCP-Servers/.opencode/agents/` has them AND this directory is picked up by the path-walking (or via `~/.opencode/` symlink resolution). When working inside `MCP-Servers/`, the walk-up finds `.opencode/` at `/home/jcharles/Projects/MCP-Servers/.opencode/`.

**The Neuralgentics project has its OWN `.opencode/` at `neuralgentics/.opencode/` — but with no agents directory.**

Additionally, `@neuralgentics/plugin` cannot register agents because plugins cannot register agents in OpenCode's API.

## 8. EXACT FIX REQUIRED

### Step 1: Create `neuralgentics/.opencode/agents/` directory

### Step 2: Create agent `.md` files for each Neuralgentics agent

Minimum required: the **orchestrator** agent. Format exactly like the boomerang agents.

Example `neuralgentics/.opencode/agents/neuralgentics-orchestrator.md`:
```markdown
---
description: Neuralgentics Orchestrator - Task decomposition, routing, and protocol enforcement using memini-core for memory.
mode: all
model: ollama/kimi-k2.6
steps: 50
permission:
  read:
    "*": allow
  glob: allow
  grep: allow
  list: allow
  todowrite: allow
  external_directory: allow
  lsp: allow
  skill: allow
  question: allow
  doom_loop: allow
  tool:
    "memini-ai-dev_query_memories": allow
    "memini-ai-dev_add_memory": allow
    "memini-ai-dev_get_status": allow
    "memini-ai-dev_adjust_trust": allow
    "memini-ai-dev_get_trust_score": allow
    "memini-ai-dev_add_thought": allow
    "memini-ai-dev_start_thought_chain": allow
    "memini-ai-dev_get_thought_chain": allow
    "memini-ai-dev_search_project": allow
    "memini-ai-dev_index_project": allow
    "memini-ai-dev_get_file_contents": allow
  edit: allow
  bash:
    "*": ask
    "git *": allow
    "npm *": allow
    "bun *": allow
    "ls *": allow
    "head *": allow
    "tail *": allow
    "mkdir *": allow
    "cat *": allow
    "grep *": allow
    "find *": allow
    "cd *": allow
    "echo *": allow
    "which *": allow
  task:
    "*": deny
    "neuralgentics-architect": allow
    "neuralgentics-coder": allow
    "neuralgentics-explorer": allow
    "neuralgentics-tester": allow
    "neuralgentics-writer": allow
    "neuralgentics-reviewer": allow
    "neuralgentics-git": allow
---

You are the **Neuralgentics Orchestrator** — the central coordinator using memini-core for memory.

## YOUR JOB

1. Analyze user requests and decompose into tasks
2. Route tasks to specialist agents per the Routing Matrix
3. Enforce the 8-step Neuralgentics Protocol
4. Track task progress and maintain TASKS.md

## MANDATORY MEMORY PROTOCOL

1. **Query memini-core FIRST** — `memini-ai-dev_query_memories` for previous decisions
2. **Use thought chains** — `memini-ai-dev_add_thought` for complex analysis
3. **Save when complete** — `memini-ai-dev_add_memory` with key decisions

## Agent Roster

| Role | Purpose |
|------|---------|
| neuralgentics-architect | System design, trade-off analysis, research |
| neuralgentics-coder | Implementation and bug fixing |
| neuralgentics-reviewer | Code quality and security audit |
| neuralgentics-explorer | File finding |
| neuralgentics-tester | Test generation |
| neuralgentics-writer | Documentation |
| neuralgentics-git | Version control |

## PARALLEL EXECUTION IS MANDATORY

Always dispatch multiple sub-agents simultaneously when tasks have no dependencies.
```

### Step 3: Create remaining agent files

For each agent in the roster:
- `neuralgentics-architect.md` (mode: subagent)
- `neuralgentics-coder.md` (mode: subagent)
- `neuralgentics-explorer.md` (mode: subagent)
- `neuralgentics-tester.md` (mode: subagent)
- `neuralgentics-writer.md` (mode: subagent)
- `neuralgentics-reviewer.md` (mode: subagent)
- `neuralgentics-git.md` (mode: subagent)

Each needs: `mode: subagent`, proper `permission` block, and a system prompt body.

### Step 4: Verify directory is picked up

The Neuralgentics launcher (`./neuralgentics start`) runs OpenCode from `opencode-base/packages/opencode`. The config system walks up from that directory looking for `.opencode/`. Since `neuralgentics/.opencode/` is at `/home/jcharles/Projects/MCP-Servers/neuralgentics/.opencode/`, it will be found IF `/home/jcharles/Projects/MCP-Servers/neuralgentics/` is within the worktree search path.

To guarantee discovery, ensure the `neuralgentics/opencode-base/` directory is INSIDE the `neuralgentics/` project tree (it already is). The walk-up from `opencode-base/packages/opencode/` goes:
1. `opencode-base/packages/opencode/.opencode/` → not found
2. `opencode-base/packages/.opencode/` → not found
3. `opencode-base/.opencode/` → not found
4. `neuralgentics/.opencode/` → **FOUND!** (because `opencode-base/` is inside `neuralgentics/`)

The key is that `ConfigPaths.directories()` calls `fs.up()` with `targets: [".opencode"]`, `start: directory`, `stop: worktree`.

## 9. Summary of Blocker

| Issue | Status |
|-------|--------|
| No `agents/` directory in `neuralgentics/.opencode/` | **ROOT CAUSE** |
| Plugin cannot register agents | **OpenCode API limitation** |
| `@neuralgentics/plugin` provides MCP tools, not agents | **By design** |
| `AGENTS.md` provides instructions, not agent registration | **Documentation, not registration** |

## 10. File Modification Checklist

| File | Action |
|------|--------|
| `neuralgentics/.opencode/agents/neuralgentics-orchestrator.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-architect.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-coder.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-explorer.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-tester.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-writer.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-reviewer.md` | **CREATE** (new) |
| `neuralgentics/.opencode/agents/neuralgentics-git.md` | **CREATE** (new) |
| `neuralgentics/.opencode/opencode.json` | **MODIFY** — add `agent` field for orchestrator config (optional but recommended) |
| `neuralgentics/AGENTS.md` | **MODIFY** — update agent roster to match actual agents (cosmetic) |

## 11. Technical Edge Cases & Gotchas

1. **Naming:** Agent names become the `task` tool's `subagent_type` parameter. The orchestrator's `task` permission must explicitly allow each subagent by name. The current boomerang orchestrator allows `boomerang-coder`, `boomerang-architect`, etc. — the new orchestrator must allow `neuralgentics-coder`, `neuralgentics-architect`, etc.

2. **Model path:** Agent files use the full model specifier from `opencode.json` providers. For Neuralgentics, this is `ollama/kimi-k2.6`, etc.

3. **Merge behavior:** Filesystem agents (Source A) and JSON agents (Source B) are merged via `mergeDeep()`. JSON config wins for shared keys. The `prompt` (body text) can ONLY come from the `.md` file.

4. **Reloading:** OpenCode caches agent state in `InstanceState`. A restart is required to pick up new agent files.

5. **Home directory config:** Agent files can also go in `~/.opencode/agents/` for global availability, or `~/.config/opencode/agents/` for system-wide config.
