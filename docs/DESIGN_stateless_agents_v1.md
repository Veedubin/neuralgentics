# DESIGN: Stateless Agent Architecture with Memory-Backed Context

**Version:** v1.0  
**Date:** 2026-05-22  
**Status:** Approved (Architecture Decision — see memory `ff3f2930`)  
**Author:** boomerang-architect  

---

## 1. Problem Statement

Currently, the `NeuralgenticsOrchestrator.handleTask()` method assembles a full `ContextPackage` (including L0/L1 summaries, relevant files, code snippets, and prior decisions) and passes it **inline** as part of the `OrchestrationResult`. This causes:

- **Token bloat** — Agents receive thousands of tokens of context they may not need
- **State coupling** — Agents are stateful in OpenCode's context window; the orchestrator manages state
- **Redundant transfers** — Tool descriptions and memory injection are repeated per-dispatch
- **No feedback loop** — Agents can't store their own results back for the orchestrator to consume independently

## 2. Solution: Memory-Backed Context

Instead of passing `ContextPackage` inline, the orchestrator stores it in **memini-core** (the HTTP memory server on port 8900) and hands each agent a **seed prompt** containing only:

1. A short task description (1-2 sentences)
2. A memory UUID (e.g., `mem_abc123`) pointing to the full ContextPackage
3. Protocol instructions to fetch/write context from memini-core

Agents become **stateless** — they retrieve their own context on startup, query memories during work, store their wrap-up summary on completion, and return only `{memory_id, description}` to the orchestrator.

---

## 3. Sequence Diagram

```
┌──────────────────┐       ┌──────────────┐       ┌──────────────────┐
│   Orchestrator   │       │  memini-core │       │    Agent         │
│   (handleTask)   │       │  (port 8900) │       │  (coder/arch/…)  │
└────────┬─────────┘       └──────┬───────┘       └────────┬─────────┘
         │                        │                        │
         │  ① Build ContextPackage│                        │
         │  (query L0/L1,         │                        │
         │   relevant memories)   │                        │
         │                        │                        │
         │  ② POST /memory/add    │                        │
         │  {content: JSON(CP),   │                        │
         │   sourceType:          │                        │
         │    "context_package",  │                        │
         │   metadata: {taskId,   │                        │
         │    agentRole, ...}}    │                        │
         │───────────────────────>│                        │
         │                        │                        │
         │  ③ { id: "mem_cp_001" }│                       │
         │<───────────────────────│                        │
         │                        │                        │
         │  ④ Dispatch agent with SEED PROMPT              │
         │  {task, memory_id:     │                        │
         │   "mem_cp_001",        │                        │
         │   protocol}            │                        │
         │────────────────────────────────────────────────>│
         │                        │                        │
         │                        │  ⑤ GET /memory/        │
         │                        │     mem_cp_001         │
         │                        │<───────────────────────│
         │                        │                        │
         │                        │  ⑥ ContextPackage JSON │
         │                        │───────────────────────>│
         │                        │                        │
         │                        │ ⑦ Agent does work      │
         │                        │  (reads/writes files,  │
         │                        │   queries memory, etc.)│
         │                        │<──────────────────────>│
         │                        │                        │
         │                        │  ⑧ POST /memory/add    │
         │                        │  {content: JSON(wrap), │
         │                        │   sourceType:          │
         │                        │    "agent_wrap_up",    │
         │                        │   metadata: {          │
         │                        │    contextMemoryId:    │
         │                        │    "mem_cp_001", ..}} │
         │                        │<───────────────────────│
         │                        │                        │
         │                        │  ⑨ { id: "mem_wu_002" }│
         │                        │───────────────────────>│
         │                        │                        │
         │                        │  ⑩ POST /memory/       │
         │                        │     mem_cp_001/trust   │
         │                        │  {signal:"agent_used"} │
         │                        │<───────────────────────│
         │                        │                        │
         │  ⑪ Agent returns       │                        │
         │  {memory_id:           │                        │
         │   "mem_wu_002",        │                        │
         │   description:         │                        │
         │   "Implemented 5       │                        │
         │    routes in           │                        │
         │    server.py"}        │                        │
         │<────────────────────────────────────────────────│
         │                        │                        │
         │  ⑫ GET /memory/        │                        │
         │     mem_wu_002         │                        │
         │───────────────────────>│                        │
         │                        │                        │
         │  ⑬ Full wrap-up JSON   │                        │
         │<───────────────────────│                        │
         │                        │                        │
         │  ⑭ Orchestrator presents result to user         │
         │                        │                        │
```

**Key:** The orchestrator never passes user context inline. Agents load it on demand from memini-core. The orchestrator retrieves results independently — it does not need to parse agent output directly.

---

## 4. Memory Schema: `context_package` Type

Stored via `POST /memory/add` on port 8900.

### Request Body

```json
{
  "content": "<JSON-stringified ContextPackage>",
  "sourceType": "context_package",
  "metadata": {
    "taskType": "code-implementation",
    "agentRole": "coder",
    "taskId": "task_abc123",
    "contextMemoryId": "mem_cp_001",
    "createdAt": "2026-05-22T23:00:00Z",
    "project": "neuralgentics",
    "parentMemoryId": null,
    "version": "1.0"
  }
}
```

### `content` Field Structure (JSON serialized as string)

```json
{
  "originalUserRequest": "Build a REST API for user management with CRUD operations",
  "taskBackground": "Task: Build a REST API for user management with CRUD operations\nType: code-implementation\nPriority: high\n\nContext from memory (3 results):\n- [project] Previously implemented auth middleware in auth.ts\n- [file] Neuralgentics plugin uses OpenCode v1.15.x plugin API",
  "relevantFiles": [
    "neuralgentics/packages/plugin/src/adapters/memory.ts",
    "neuralgentics/packages/orchestrator/src/index.ts"
  ],
  "codeSnippets": [
    "// MemoryAdapter implementation at neuralgentics/packages/plugin/src/adapters/memory.ts:111-248"
  ],
  "previousDecisions": [
    "ARCHITECTURAL DECISION: Stateless agents with memory-backed context...",
    "Neuralgentics Plugin → OpenCode Integration Design (2026-05-22)..."
  ],
  "expectedOutput": "Modified files with implementation, 100-300 word summary",
  "scopeBoundaries": {
    "inScope": ["Write/edit code", "Implement features", "Fix bugs"],
    "outOfScope": []
  },
  "errorHandling": "Type errors → fix types. Runtime errors → add guards. Never swallow exceptions.",
  "l0Summary": "Neuralgentics is an independent coding agent built on OpenCode base...",
  "l1Summary": "Key decisions: 1. Plugin API uses named-export pattern...",
  "trustScores": {
    "ff3f2930-d81a-4d0c-901d-11a48c005211": 0.9
  }
}
```

### `metadata` Field (machine-queryable)

| Key | Type | Purpose |
|-----|------|---------|
| `taskType` | string | The `TaskType` from the orchestrator (code-implementation, architecture-design, etc.) |
| `agentRole` | string | The `AgentRole` dispatched (coder, architect, tester, etc.) |
| `taskId` | string | The orchestrator's task UUID |
| `contextMemoryId` | string | Self-referencing — the memory ID of this context (set after creation) |
| `parentMemoryId` | string\|null | For sub-agent contexts, points to parent context. Null for top-level. |
| `createdAt` | ISO-8601 | When the context was created |
| `project` | string | Always "neuralgentics" |
| `version` | string | Schema version for forward compatibility |

### Response

```json
{
  "id": "mem_cp_001"
}
```

---

## 5. Memory Schema: `agent_wrap_up` Type

Stored via `POST /memory/add` on port 8900.

### Request Body

```json
{
  "content": "<JSON-stringified WrapUp>",
  "sourceType": "agent_wrap_up",
  "metadata": {
    "taskType": "code-implementation",
    "agentRole": "coder",
    "taskId": "task_abc123",
    "contextMemoryId": "mem_cp_001",
    "parentWrapUpId": null,
    "createdAt": "2026-05-22T23:05:00Z",
    "project": "neuralgentics",
    "durationMs": 45000,
    "success": true
  }
}
```

### `content` Field Structure (JSON serialized as string)

```json
{
  "summary": "Implemented 5 REST routes in server.py: GET /users, POST /users, GET /users/:id, PUT /users/:id, DELETE /users/:id. Added input validation middleware and error handling.",
  "filesModified": [
    "neuralgentics/packages/api/src/server.py",
    "neuralgentics/packages/api/src/middleware/validation.py",
    "neuralgentics/packages/api/src/models/user.py"
  ],
  "filesCreated": [
    "neuralgentics/packages/api/tests/test_users.py"
  ],
  "followUpTasks": [
    "Add authentication middleware to protect routes",
    "Write integration tests for user CRUD",
    "Document API in README.md",
    "Add rate limiting for POST /users"
  ],
  "trustSignals": {
    "contextMemoryId": "mem_cp_001",
    "signal": "agent_used"
  },
  "errors": [],
  "warnings": [
    "Skipped rate limiting — not in scope for this task"
  ],
  "subAgentResults": [
    {
      "memoryId": "mem_wu_sub_003",
      "description": "Linter fixed 3 ESLint errors"
    }
  ]
}
```

### `metadata` Field (machine-queryable)

| Key | Type | Purpose |
|-----|------|---------|
| `taskType` | string | The `TaskType` (copied from context) |
| `agentRole` | string | The `AgentRole` that executed |
| `taskId` | string | The orchestrator's task UUID |
| `contextMemoryId` | string | Links back to the context_package memory the agent consumed |
| `parentWrapUpId` | string\|null | For sub-agent wrap-ups, points to parent's wrap-up |
| `createdAt` | ISO-8601 | When the wrap-up was stored |
| `project` | string | Always "neuralgentics" |
| `durationMs` | number | Wall-clock time the agent spent |
| `success` | boolean | Whether the agent considers the task successful |

### Response

```json
{
  "id": "mem_wu_002"
}
```

---

## 6. Seed Prompt Template

This is the **only** content the orchestrator passes to an agent at dispatch time. It replaces the current practice of injecting the full `ContextPackage` inline.

```
---
## Task
Build a REST API for user management with CRUD operations in server.py.

## Memory Context
Your full context package is stored in memini-core at memory ID: `mem_cp_001`

## Protocol (MANDATORY — Do NOT skip)

### 1. Context Retrieval
On start, fetch your context package:
```
GET http://localhost:8900/memory/mem_cp_001
```
The response contains a JSON ContextPackage with:
- `taskBackground` — task details and memory context
- `relevantFiles` — files to examine
- `codeSnippets` — relevant code excerpts
- `previousDecisions` — prior architectural decisions
- `scopeBoundaries` — what is IN/OUT of scope
- `expectedOutput` — what the orchestrator expects
- `l0Summary` / `l1Summary` — project overview and key decisions

### 2. Memory Queries (during work)
Query memini-core as needed:
```
POST http://localhost:8900/memory/query
Body: { "query": "your search terms", "limit": 10 }
```

### 3. Wrap-Up Storage (before returning)
Build a wrap-up JSON and store it:
```
POST http://localhost:8900/memory/add
Body: {
  "content": "JSON string with { summary, filesModified, filesCreated, followUpTasks, errors, warnings }",
  "sourceType": "agent_wrap_up",
  "metadata": {
    "taskType": "code-implementation",
    "agentRole": "coder",
    "taskId": "task_abc123",
    "contextMemoryId": "mem_cp_001",
    "durationMs": 45000,
    "success": true
  }
}
```

### 4. Trust Signal
Adjust trust on the context memory:
```
POST http://localhost:8900/memory/mem_cp_001/trust
Body: { "signal": "agent_used" }
```

### 5. Return Format
Return ONLY this to the orchestrator:
```
{memory_id: "<wrap_up_memory_id>", description: "<one-line summary>"}
```
---

## 7. Agent Skill File Template

Each agent's `SKILL.md` must include a **"Stateless Context Protocol"** section. Below is the template, shown for `boomerang-coder` as an example.

```markdown
## Stateless Context Protocol (MANDATORY — Do NOT skip)

On dispatch, you receive a SEED prompt containing a `memory_id`. Follow this protocol.

### 1. Context Retrieval (Immediately on start)
Fetch your full context package from memini-core:

```
GET http://localhost:8900/memory/{memory_id}
```

Parse the `content` field (JSON) to extract:
- `originalUserRequest` — the user's original request verbatim
- `taskBackground` — task metadata + memory context
- `relevantFiles` — file paths to examine
- `codeSnippets` — relevant code excerpts
- `previousDecisions` — prior architectural decisions and patterns
- `expectedOutput` — what the orchestrator expects back
- `scopeBoundaries.inScope` / `scopeBoundaries.outOfScope` — stay within these
- `errorHandling` — error handling strategy
- `l0Summary` / `l1Summary` — project overview and key decisions

**DO NOT start work before fetching context.** If retrieval fails (memini-core unreachable, memory not found), return an error immediately.

### 2. Ongoing Memory Queries (as needed during work)
Search for relevant memories:
```
POST http://localhost:8900/memory/query
Content-Type: application/json

{ "query": "your search terms", "limit": 10 }
```

Use search results to find related code, prior decisions, patterns, and constraints.

### 3. Wrap-Up Storage (MANDATORY — before returning to orchestrator)

Build a wrap-up JSON:
```json
{
  "summary": "One-paragraph summary of what was done, approach taken, key decisions",
  "filesModified": ["absolute/path/to/modified/file.ts"],
  "filesCreated": ["absolute/path/to/new/file.ts"],
  "followUpTasks": ["Task 1", "Task 2"],
  "trustSignals": {
    "contextMemoryId": "{memory_id}",
    "signal": "agent_used"
  },
  "errors": [],
  "warnings": ["Any non-blocking issues encountered"],
  "subAgentResults": [
    { "memoryId": "mem_wu_sub_003", "description": "Linter fixed 3 ESLint errors" }
  ]
}
```

Store it:
```
POST http://localhost:8900/memory/add
Content-Type: application/json

{
  "content": "<JSON.stringify(wrapUp)>",
  "sourceType": "agent_wrap_up",
  "metadata": {
    "contextMemoryId": "{memory_id}",
    "taskType": "code-implementation",
    "agentRole": "coder",
    "durationMs": <actual_duration>,
    "success": true
  }
}
```

Record the returned `id` from memini-core — this is your wrap-up memory ID.

### 4. Trust Signal (after wrap-up stored)
```
POST http://localhost:8900/memory/{memory_id}/trust
Content-Type: application/json

{ "signal": "agent_used" }
```

This signals to memini-core's trust engine that the context memory was used successfully (+0.05 trust adjustment).

### 5. Return Format (to orchestrator)
Return ONLY:
```
{memory_id: "<wrap_up_memory_id>", description: "<one-line summary>"}
```

The orchestrator will fetch the full wrap-up from memini-core independently.

### 6. Sub-Agent Dispatch (Recursive — if spawning sub-agents)

If you need to spawn a sub-agent (e.g., linter, tester), follow the same pattern:

1. **Build child context** — assemble a mini ContextPackage for the sub-agent
2. **Store it**: `POST /memory/add` with `sourceType: "context_package"`, get `child_memory_id`
3. **Dispatch sub-agent** with seed prompt containing `child_memory_id`
4. **Sub-agent follows this same protocol** (fetch context → work → store wrap-up → return `{memory_id, description}`)
5. **On return**, fetch the sub-agent's wrap-up: `GET /memory/{sub_wrap_up_id}`
6. **Incorporate** sub-agent results into your own wrap-up under `subAgentResults`

**Never pass context inline to sub-agents. Always use memini-core.**

### Health Check (verify memini-core is reachable)
```
GET http://localhost:8900/health
```
If unreachable, return error: `"memini-core unreachable at localhost:8900"`
```

---

## 8. Orchestrator Changes Summary

### 8.1 Files to Modify

| File | Changes |
|------|---------|
| `packages/orchestrator/src/types.ts` | Add `StatelessOrchestrationResult`, `SeedPrompt`, `AgentWrapUp` types |
| `packages/orchestrator/src/index.ts` | Modify `handleTask()` — store context → return seed prompt; add `fetchWrapUp()`, `completeTaskCycle()` |
| `packages/orchestrator/src/context.ts` | Add `storeContextPackage()`, `getMemory()` to MemoryAdapter interface; add `buildSeedPrompt()` function |
| `packages/plugin/src/adapters/memory.ts` | Add `getMemory(id)` method to MemoryAdapter class |

### 8.2 New Types (`types.ts` additions)

```typescript
/** Result returned by stateless orchestrator dispatch */
export interface StatelessOrchestrationResult {
  agent: AgentRole;
  /** Memory ID of the context package stored in memini-core */
  contextMemoryId: string;
  /** Minimal prompt the agent receives (task + memory_id + protocol) */
  seedPrompt: string;
  executionPlan: ExecutionPlan;
}

/** What the agent returns after completing work */
export interface AgentResult {
  memory_id: string;
  description: string;
}

/** The wrap-up stored by an agent */
export interface AgentWrapUp {
  summary: string;
  filesModified: string[];
  filesCreated: string[];
  followUpTasks: string[];
  trustSignals: { contextMemoryId: string; signal: string };
  errors: string[];
  warnings: string[];
  subAgentResults: AgentResult[];
}
```

### 8.3 Modified `handleTask()` Flow

**Current (index.ts lines 87-128):**
```
handleTask(task) → buildContextPackage(task, agent, memory) → return { agent, contextPackage, executionPlan }
```

**New:**
```
handleTask(task, { stateless: true }) →
  1. Resolve agent
  2. Build ContextPackage (same buildContextPackage call)
  3. Store in memini-core: POST /memory/add (sourceType="context_package")
  4. Get back contextMemoryId
  5. Build seed prompt: buildSeedPrompt(task, contextMemoryId)
  6. Return { agent, contextMemoryId, seedPrompt, executionPlan }
  // NOTE: contextPackage is NOT included in the result
```

### 8.4 MemoryAdapter Interface Additions

```typescript
export interface MemoryAdapter {
  // ... existing methods ...
  
  /** Retrieve a single memory by ID */
  getMemory(id: string): Promise<Memory>;
  
  /** Store a context package and return the memory ID */
  storeContextPackage(pkg: ContextPackage, metadata: Record<string, unknown>): Promise<string>;
  
  /** Fetch an agent's wrap-up result */
  fetchWrapUp(id: string): Promise<AgentWrapUp>;
}
```

### 8.5 New Orchestrator Methods

```typescript
class NeuralgenticsOrchestrator {
  // ... existing ...

  /** Handle a task in stateless mode (memory-backed context) */
  async handleTaskStateless(task: Task): Promise<StatelessOrchestrationResult>;

  /** Build a seed prompt from task + memory ID */
  buildSeedPrompt(task: Task, contextMemoryId: string): string;

  /** Fetch agent wrap-up from memini-core */
  async fetchAgentWrapUp(wrapUpMemoryId: string): Promise<AgentWrapUp>;

  /** Complete the task cycle: fetch wrap-up, adjust trust, update state */
  async completeTaskCycle(taskId: string, result: AgentResult): Promise<AgentWrapUp>;
}
```

### 8.6 Backward Compatibility

The existing `handleTask()` method (returning `OrchestrationResult` with inline `contextPackage`) is **preserved**. The stateless mode is opt-in via a config flag or a separate method `handleTaskStateless()`. This allows gradual migration without breaking existing callers.

---

## 9. Example: Full Flow for "Build a New Feature" Task

### Step-by-step with memory IDs

```
┌─────────────────────────────────────────────────────────────────────┐
│ USER REQUEST: "Add user registration endpoint to the REST API"      │
└─────────────────────────────────────────────────────────────────────┘

ORCHESTRATOR (handleTaskStateless):
  taskId = "task_reg_001"
  taskType = "code-implementation"

  ┌─ buildContextPackage(task, "coder", memory)
  │   → queries L0 summary: "Neuralgentics is an independent coding agent..."
  │   → queries L1 summary: "Key decisions: Plugin API uses named-export..."
  │   → queries memories for "user registration REST API endpoint"
  │   → finds 3 relevant memories (auth middleware, existing routes, schema)
  │   → assembles ContextPackage with 7 fields
  └─ result: full ContextPackage

  ┌─ POST http://localhost:8900/memory/add
  │   content: JSON(ContextPackage)
  │   sourceType: "context_package"
  │   metadata: { taskType: "code-implementation", agentRole: "coder",
  │              taskId: "task_reg_001", parentMemoryId: null }
  └─ response: { id: "mem_cp_reg_001" }

  ┌─ buildSeedPrompt(task, "mem_cp_reg_001")
  └─ result: seed prompt (task description + protocol + memory_id)

  → Returns: { agent: "coder", contextMemoryId: "mem_cp_reg_001",
               seedPrompt: "...", executionPlan: {...} }

AGENT (boomerang-coder):
  Receives seed prompt with memory_id = "mem_cp_reg_001"

  ┌─ GET http://localhost:8900/memory/mem_cp_reg_001
  └─ response: ContextPackage JSON with all 7 fields

  Reads: taskBackground ("Add user registration endpoint"),
         relevantFiles (server.py, models/user.py, middleware/auth.py),
         codeSnippets (existing route patterns),
         previousDecisions (auth middleware already implemented),
         scopeBoundaries (inScope: implement, outOfScope: architecture decisions)

  Works:
    • Reads existing server.py to understand route patterns
    • Creates POST /users/register endpoint
    • Adds input validation for email/password fields
    • Integrates with existing auth middleware
    • Writes unit test in test_users.py

  ┌─ POST http://localhost:8900/memory/query
  │   query: "password hashing implementation"
  └─ finds: bcrypt usage pattern in existing codebase

  ┌─ POST http://localhost:8900/memory/add
  │   content: JSON({ summary: "Added POST /users/register endpoint...",
  │                   filesModified: ["server.py", "test_users.py"],
  │                   filesCreated: [],
  │                   followUpTasks: ["Add email verification",
  │                                   "Add rate limiting"],
  │                   errors: [],
  │                   warnings: ["Skipped email verification — out of scope"],
  │                   subAgentResults: [] })
  │   sourceType: "agent_wrap_up"
  │   metadata: { contextMemoryId: "mem_cp_reg_001",
  │              taskType: "code-implementation",
  │              agentRole: "coder",
  │              durationMs: 35000,
  │              success: true }
  └─ response: { id: "mem_wu_reg_001" }

  ┌─ POST http://localhost:8900/memory/mem_cp_reg_001/trust
  │   signal: "agent_used"
  └─ response: { newScore: 0.95 }  (was 0.9, +0.05 for agent_used)

  → Returns to orchestrator:
      { memory_id: "mem_wu_reg_001",
        description: "Added POST /users/register endpoint with validation" }

ORCHESTRATOR (completeTaskCycle):
  ┌─ GET http://localhost:8900/memory/mem_wu_reg_001
  └─ response: Full wrap-up JSON

  Presents to user:
    ✅ "Added POST /users/register endpoint with validation"
    → Modified: server.py, test_users.py
    → Follow-up: Add email verification, Add rate limiting

  Updates task status: COMPLETE
```

### Recursive Sub-Agent Example

If the coder spawns a linter as a sub-agent:

```
CODER (spawning sub-agent):
  ┌─ POST http://localhost:8900/memory/add
  │   content: JSON(mini_ContextPackage for linter task)
  │   sourceType: "context_package"
  │   metadata: { parentMemoryId: "mem_cp_reg_001",
  │              taskType: "linting",
  │              agentRole: "linter" }
  └─ response: { id: "mem_cp_lint_001" }

  Dispatches linter with seed prompt containing memory_id = "mem_cp_lint_001"

LINTER (sub-agent):
  Gets seed prompt → fetches context → lints files → stores wrap-up
  ┌─ POST http://localhost:8900/memory/add (wrap-up)
  └─ response: { id: "mem_wu_lint_001" }

  Returns: { memory_id: "mem_wu_lint_001",
             description: "Fixed 3 ESLint errors in server.py" }

CODER (receives sub-agent result):
  ┌─ GET http://localhost:8900/memory/mem_wu_lint_001
  └─ Reads: linter fixed 3 errors, no follow-ups

  Incorporates into own wrap-up:
    subAgentResults: [
      { memoryId: "mem_wu_lint_001",
        description: "Fixed 3 ESLint errors in server.py" }
    ]
```

---

## 10. Failure Modes

### 10.1 Agent Cannot Fetch Context

**Symptom:** `GET /memory/{id}` returns 404 or times out.

**Agent behavior:**
1. Try `GET /health` first to verify memini-core is reachable
2. If memini-core is down: return error immediately —
   `{ error: "memini-core unreachable at localhost:8900", memory_id: null }`
3. If memory ID not found: return error —
   `{ error: "context not found: mem_cp_001", memory_id: null }`

**Orchestrator recovery:**
1. Receives error from agent
2. Adjusts trust on context memory with signal `agent_ignored` (−0.05)
3. Marks task as `failed: context_unavailable`
4. On retry: creates a **new** context memory (never reuse stale IDs)
5. Logs the failure for diagnostics

### 10.2 Agent Crashes Before Wrap-Up

**Symptom:** Agent process dies, OpenCode context window is lost.

**Orchestrator recovery:**
1. Timeout on dispatch — no response from agent after N seconds
2. Queries: find all `agent_wrap_up` memories where `metadata.contextMemoryId = "mem_cp_001"`
3. If no wrap-up found: task is incomplete
4. Adjusts trust on context memory with signal `agent_ignored` (−0.05)
5. Marks task as `failed: agent_crashed`
6. Creates a **new** context memory for retry (with updated context from any partial work discovered)
7. Dispatches retry with new context memory ID

### 10.3 Stale Memory IDs

**Symptom:** Orchestrator crashes between dispatch and receiving result. On restart, it has memory IDs with no known result.

**Recovery:**
1. On orchestrator startup, query: "find all `context_package` memories where `metadata.taskId` is known but no corresponding `agent_wrap_up` exists"
2. For each orphaned context:
   - Check if the task completed by examining file timestamps
   - If unsure: retry the task with a new context memory
   - Link old context to new via `DERIVED_FROM` relationship
3. Timeout-based cleanup: context_package memories older than TTL (e.g., 24 hours) without a corresponding wrap-up are marked as stale

### 10.4 Agent Stores Incorrect Wrap-Up

**Symptom:** Wrap-up JSON is malformed or missing required fields.

**Orchestrator validation:**
1. Fetch wrap-up: `GET /memory/{wrap_up_id}`
2. Parse `content` field as JSON
3. Validate required fields: `summary` (string), `filesModified` (array), `success` (boolean)
4. If invalid:
   - Adjust trust on wrap-up memory with signal `agent_ignored`
   - Adjust trust on context memory with signal `agent_ignored`
   - Return error to user: "Agent returned invalid wrap-up"
   - Optionally: retry with explicit instructions about wrap-up format

### 10.5 Race Conditions with Parallel Agents

**Scenario:** Two agents dispatched in parallel, both modifying the same file.

**Safety net:**
1. Each agent has its own context memory ID — no shared mutable state
2. Agents read current file state at start (by reading files)
3. If both modify the same file, the second write either merges (if non-overlapping) or creates a git conflict
4. Git conflict is surfaced to the orchestrator/user for resolution
5. No memory-level locking is needed — filesystem + git provide eventual consistency

### 10.6 Trust Score Degradation

**Scenario:** An agent repeatedly fails, causing trust scores on context memories to degrade below archive threshold.

**Mitigation:**
1. The trust engine's `agent_ignored` signal is small (−0.05) — it takes many failures to archive a memory
2. Context memories that are stale (no wrap-up after TTL) are archived but NOT deleted
3. If a task is retried successfully, the orchestrator can create a `SUPERSEDES` relationship from the old (failed) context to the new (successful) context
4. User confirmation (`user_confirmed` signal, +0.10) can override automated trust degradation

### 10.7 memini-core Database Failure

**Scenario:** PostgreSQL is down, memini-core cannot write.

**Fallback:**
1. Agent detects `POST /memory/add` returns 500
2. Agent falls back to local file storage: writes context to `/tmp/neuralgentics/agent_{taskId}_wrapup.json`
3. Agent returns `{ memory_id: "local_fallback", description: "<summary>", localPath: "/tmp/..." }`
4. Orchestrator reads the local file for the result
5. On memini-core recovery, orchestrator replays the local file into memini-core

---

## 11. Implementation Phases

### Phase 1: Core Types and Memory Adapter (Low risk)
- Add new types to `types.ts` (StatelessOrchestrationResult, AgentWrapUp, AgentResult)
- Add `getMemory(id)` to `MemoryAdapter`
- Add `storeContextPackage()` to `MemoryAdapter`
- Write tests for memory adapter methods

### Phase 2: Orchestrator Stateless Mode (Medium risk)
- Add `handleTaskStateless()` method to orchestrator
- Add `buildSeedPrompt()` function
- Add `fetchAgentWrapUp()` method
- Add `completeTaskCycle()` method
- Preserve existing `handleTask()` for backward compatibility

### Phase 3: Agent Skill File Updates (Low risk, high impact)
- Update all SKILL.md files with "Stateless Context Protocol" section
- Template: coder, architect, tester, linter, explorer, writer
- Validate agents can fetch context from memini-core correctly

### Phase 4: Full Integration Test (Medium risk)
- End-to-end test: orchestrator stores context → agent fetches → agent works → agent stores wrap-up → orchestrator retrieves
- Test recursive sub-agent dispatch
- Test all failure modes (memini-core down, agent crash, stale IDs)

### Phase 5: Migration and Cleanup (Low risk)
- Switch default from `handleTask()` to `handleTaskStateless()`
- Remove inline ContextPackage passing from `OrchestrationResult`
- Deprecate `contextPackage` field

---

## 12. Token Savings Estimate

| Metric | Current (Inline) | New (Stateless) | Savings |
|--------|------------------|-----------------|---------|
| ContextPackage size (avg) | ~2,500 tokens | 0 tokens (not sent) | 100% |
| Seed prompt size | ~2,500 tokens | ~200 tokens | 92% |
| Agent context retrieval | 0 (already loaded) | ~200 tokens (HTTP + parsing) | −200 |
| **Net savings per dispatch** | — | — | **~2,100 tokens** |

For a typical multi-agent workflow (orchestrator → architect → coder → tester → linter):
- 5 dispatches × 2,100 tokens saved = **10,500 tokens saved per workflow**
- Plus: wrap-ups are stored independently, so the orchestrator doesn't need to maintain agent state

---

## 13. References

- **Prior Architectural Decision**: memory `ff3f2930` — "ARCHITECTURAL DECISION: Stateless agents with memory-backed context"
- **memini-core Server**: `neuralgentics/packages/memini-core/src/memini_core/server.py` (routes on port 8900)
- **Current Orchestrator**: `neuralgentics/packages/orchestrator/src/index.ts` (handleTask method)
- **Current Context Builder**: `neuralgentics/packages/orchestrator/src/context.ts` (buildContextPackage)
- **Memory Adapter**: `neuralgentics/packages/plugin/src/adapters/memory.ts` (HTTP JSON client)
- **Type Definitions**: `neuralgentics/packages/orchestrator/src/types.ts` (ContextPackage, OrchestrationResult)
