# @neuralgentics/sdk

Typed client library for Neuralgentics sub-agents and external consumers.

## What it is

The SDK is a **framework-agnostic** TypeScript package that provides typed wrappers for memory, routing, and hook abstractions. It does NOT depend on OpenCode — it can be used by any TypeScript consumer that needs to interact with the Neuralgentics runtime.

## What it is NOT

The SDK is **not** the OpenCode integration. If you need to wire Neuralgentics into the OpenCode IDE, use `packages/plugin/` instead. The SDK contains no OpenCode-specific imports, lifecycle hooks, or plugin API calls.

## Who uses it

- Sub-agents defined in `.opencode/agents/neuralgentics-*.md` can import the SDK for typed memory and routing access
- External MCP consumers that want a typed client without the OpenCode plugin overhead
- The Plugin package (`@neuralgentics/plugin`) may import from the SDK, but the SDK MUST NOT import from the Plugin

## Boundary with packages/plugin/

| SDK (`@neuralgentics/sdk`) | Plugin (`@neuralgentics/plugin`) |
|---|---|
| Framework-agnostic typed client | OpenCode-specific integration |
| No OpenCode imports | Imports from `@opencode-ai/sdk` |
| Exports: adapters, client, types, utils | Exports: MCP tools, lifecycle, config |
| Used by sub-agents and external consumers | Used by OpenCode at plugin activation |

**Rule: SDK MAY be used by Plugin. SDK MUST NOT use Plugin.**

## API surface

The SDK exports the following from `src/index.ts`:

- **Client**: `BoomerangClient`, `createClient` — entry points for typed RPC calls
- **Types**: `AgentConfig`, `AgentMode`, `PermissionMap`, `TaskPlan`, `ContextPackage`, `RetryConfig`, etc.
- **Adapters**:
  - `MemoryAdapter` — read/write/query memories via HTTP
  - `HooksAdapter` — register and dispatch tool hooks
  - `getAgentConfig`, `resolveAgent`, `validateRouting`, etc. — routing matrix lookups
- **Utilities**: `withRetry`, `sleep`, `classifyError`, `ok`, `fail`, `tryOperation`, etc.

## Quick example

```typescript
import { createClient } from '@neuralgentics/sdk';

const client = createClient({ baseUrl: 'http://localhost:8900' });

// Store a memory entry
const id = await client.memory.add('Agent completed task T-042', {
  sourceType: 'session',
  metadata: { agent: 'coder' },
});

// Query memories
const results = await client.memory.query('task completion patterns');
```

## Development

```bash
npm run build       # Compile TypeScript
npm run typecheck   # Type-check without emitting
npm test            # Run vitest
```

## Do not add OpenCode-specific imports to this package

If you need OpenCode lifecycle hooks, MCP tool definitions, or plugin configuration, that belongs in `packages/plugin/`.