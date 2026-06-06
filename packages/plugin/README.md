# @neuralgentics/plugin

OpenCode integration plugin that wires the Neuralgentics runtime into the IDE.

## What it is

The Plugin is the **OpenCode-specific** package that implements the OpenCode Plugin API contract. When OpenCode loads Neuralgentics, it activates this plugin, which registers custom MCP tools, handles lifecycle events, and manages the stateless agent protocol.

## What it is NOT

The Plugin is **not** a generic SDK. It depends on OpenCode's plugin runtime and lifecycle hooks. If you need typed access to memory, routing, or hooks from a non-OpenCode context, use `@neuralgentics/sdk` instead.

## Who uses it

- OpenCode loads the plugin via `file://./overlay/packages/opencode` (or `file://./packages/plugin`) registration in `.opencode/opencode.json`
- The plugin is activated once per session and provides MCP tools for the duration

## Boundary with packages/sdk/

| Plugin (`@neuralgentics/plugin`) | SDK (`@neuralgentics/sdk`) |
|---|---|
| OpenCode-specific integration | Framework-agnostic typed client |
| Imports from `@opencode-ai/sdk` | No OpenCode imports |
| Exports: MCP tools, lifecycle, config | Exports: adapters, client, types, utils |
| Depends on `@neuralgentics/orchestrator` directly | Depends on `@neuralgentics/orchestrator` directly |

**Rule: Plugin MAY import from SDK. SDK MUST NOT import from Plugin.**

Currently both packages depend on `@neuralgentics/orchestrator` directly rather than the SDK depending on the orchestrator. This is acceptable — the SDK re-exports orchestrator types for convenience.

## Integration points

The plugin implements the OpenCode Plugin API contract with these keys:

### Custom MCP Tools

| Tool | Purpose |
|---|---|
| `neuralgentics_validate_routing` | Validate agent routing against the Routing Matrix |
| `neuralgentics_save_tool_result` | Persist tool execution results to memory |
| `neuralgentics_get_agents_md` | Retrieve AGENTS.md content for agent context |
| `neuralgentics_compaction_backup` | Backup critical files before compaction |
| `neuralgentics_compaction_restore` | Restore files after compaction |
| `neuralgentics_evolution_gate` | Detect repeated patterns and create skills/agents |
| `neuralgentics_dispatch_task` | Dispatch a task through the stateless orchestrator |
| `neuralgentics_complete_task` | Complete a stateless task cycle and fetch wrap-up |

### Lifecycle Events

- `session.created` — Log activation; load AGENTS.md
- `session.idle` — Log tool availability
- `session.compacting` — Auto-backup critical files to memory

### Configuration

- `useStatelessAgents` — Enable stateless agent protocol (default: false)
- `memoryBaseUrl` — Memory server URL (default: `http://localhost:8900`)
- `agentsMdPath` — Path to AGENTS.md (default: `./AGENTS.md`)
- `skillsDir` — Directory for self-evolution skill templates

## Development

```bash
npm run build       # Compile TypeScript
npm run typecheck   # Type-check without emitting
```

## If you need typed access to memory/routing/hooks from a non-OpenCode context

Use `@neuralgentics/sdk` instead. The SDK provides the same typed adapters without the OpenCode plugin lifecycle.
