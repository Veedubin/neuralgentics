# DESIGN: Fine-Grained Agent Scoping + Dependency Loop Recovery

**Version:** v1.0  
**Date:** 2026-05-22  
**Status:** DESIGN (Architecture Decision)  
**Author:** boomerang-architect  
**Supersedes:** (none — net-new capability)  
**References:** [`DESIGN_stateless_agents_v1.md`](DESIGN_stateless_agents_v1/), [`ARCHITECTURE_PLAN_V5.md`](ARCHITECTURE_PLAN_V5/)

---

## Table of Contents

1. [Task Decomposition Algorithm](#1-task-decomposition-algorithm)
2. [Task Entry Format (Schema)](#2-task-entry-format-schema)
3. [Dependency Graph](#3-dependency-graph)
4. [Blocker Recovery Flow](#4-blocker-recovery-flow)
5. [Memory Types](#5-memory-types)
6. [Orchestrator Task State Machine](#6-orchestrator-task-state-machine)
7. [Sub-Agent Recursion](#7-sub-agent-recursion)
8. [Conflict Prevention](#8-conflict-prevention)
9. [Type System Modifications](#9-type-system-modifications)
10. [Integration with Existing Systems](#10-integration-with-existing-systems)
11. [Implementation Phases](#11-implementation-phases)
12. [Failure Modes & Recovery](#12-failure-modes--recovery)

---

## 1. Task Decomposition Algorithm

### 1.1 Problem

Currently, the architect produces plans like `"implement packages/core/"` — monolithic chunks that map to multi-file coder dispatches. When a coder hits a missing dependency mid-flight, there is no structured escalation path.

### 1.2 Principle: One File Per Agent Invocation

Every agent dispatch creates **at most 1 new file** or modifies **at most 1 existing file**. A feature requiring 5 files produces a plan with 5 task entries in dependency order.

### 1.3 Algorithm Steps

```
Input:  Feature description (string) + project directory context
Output: FineGrainedTaskList (ordered list of task entries)

Step 1: ENTITY EXTRACTION
   ┌─ Parse feature description → identify noun phrases
   │  "Add user authentication with JWT tokens and login/logout endpoints"
   │  Entities: [User, JWT Token, Login Endpoint, Logout Endpoint]
   └─ Map entities to file paths via project structure conventions

Step 2: FILE PATH RESOLUTION
   For each entity:
   ├─ Query: Is this a new type/model? → packages/api/src/models/{entity}.py
   ├─ Is this config? → packages/api/src/config.py (modify_existing)
   ├─ Is this a route/endpoint? → packages/api/src/routes/{entity}.py
   ├─ Is this middleware? → packages/api/src/middleware/{entity}.py
   ├─ Is this a utility? → packages/api/src/utils/{entity}.py
   ├─ Is this a test? → tests/test_{entity}.py
   └─ Is this documentation? → docs/{entity}.md

Step 3: FILE TYPE DETERMINATION
   For each resolved path:
   ├─ File does NOT exist → new_file
   ├─ File exists → modify_file
   └─ Record: { path, type, entity, operation }

Step 4: DEPENDENCY ANALYSIS
   For each file, determine what it imports/needs:
   ├─ Import analysis: "from models.user import User" → depends on models/user.py
   ├─ Interface analysis: needs Pydantic model defined in models.py → depends on models.py
   ├─ Config analysis: uses settings from config.py → depends on config.py
   ├─ Auth analysis: needs auth middleware → depends on middleware/auth.py
   └─ Test analysis: tests/test_X.py → depends on X.py (the implementation)

Step 5: TOPOLOGICAL SORT
   ┌─ Build DAG: nodes = files, edges = dependencies
   ├─ Run Kahn's algorithm for topological ordering
   ├─ Detect cycles → ERROR (invalid plan)
   └─ Output: ordered list of task groups

Step 6: PARALLEL GROUP IDENTIFICATION
   Group tasks by topological depth:
   ├─ Depth 0: tasks with NO unsatisfied dependencies → can run in parallel
   ├─ Depth 1: tasks whose dependencies are all at depth 0 → can run after depth 0
   ├─ Depth N: ...
   └─ Output: List[Group{ depth, tasks, canParallelize }]

Step 7: AGENT ROLE ASSIGNMENT
   Map file type → agent role:
   ├─ new_file | modify_file (implementation) → coder
   ├─ test file → tester
   ├─ documentation → writer
   ├─ config (env vars, settings) → coder
   └─ types/models (Pydantic, interfaces) → coder

Step 8: TOKEN ESTIMATION
   Heuristic based on file complexity:
   ├─ Pydantic model (simple) → ~50-80 tokens per model
   ├─ Route handler (CRUD) → ~100-150 tokens per endpoint
   ├─ Middleware → ~80-120 tokens
   ├─ Config → ~60-100 tokens
   ├─ Test file → ~100-200 tokens
   └─ Sum per file → rounded to nearest 10

Step 9: OUTPUT — FineGrainedTaskList
   Return ordered list with:
   - Each task scoped to exactly ONE file
   - Dependencies explicitly stated
   - Parallel groups identified
   - Token estimates for scheduling
```

### 1.4 Algorithm Complexity

| Metric | Value |
|--------|-------|
| Time complexity | O(N + E) where N = files, E = dependencies (topological sort) |
| Expected N per feature | 3–15 files |
| Architect LLM cost | ~300–800 tokens per decomposition (entity extraction + dependency reasoning) |
| Cacheable? | Yes — same feature description + same file tree → same decomposition |

### 1.5 Decomposition Heuristics

| Heuristic | Rule |
|-----------|------|
| **Max files per task** | 1 (non-negotiable) |
| **Min task size** | Any file that would be < 10 meaningful lines → merge with nearest neighbor, flag for architect review |
| **Max dependency chain depth** | 5 (chains > 5 suggest decomposition error — architect must re-examine) |
| **Circular dependency** | ERROR — architect must break the cycle by splitting a file or introducing an interface |
| **Config-first ordering** | Config files (config.py, .env, pyproject.toml) always at depth 0 |

---

## 2. Task Entry Format (Schema)

### 2.1 FineGrainedTaskEntry

```typescript
/**
 * A single scoped task entry in the architect's decomposition plan.
 * Each entry maps to exactly ONE agent dispatch targeting ONE file.
 */
export interface FineGrainedTaskEntry {
  /** UUID for this task entry (generated by architect or orchestrator) */
  taskId: string;

  /** Absolute or workspace-relative file path this task owns */
  targetFile: string;

  /** Whether this task creates or modifies the target file */
  fileOperation: 'new_file' | 'modify_file';

  /** Agent role dispatched for this task */
  agent: AgentRole;

  /** Human-readable description of what this task does */
  description: string;

  /** Precise scope boundary: exactly what files/lines this agent may touch */
  scope: {
    /** Only this file may be created/modified */
    filesAllowed: string[];
    /** Lines or sections within the file (optional, for modify_file) */
    sectionsAllowed?: string[];
    /** Files explicitly forbidden to touch (e.g., sibling files with other owners) */
    filesForbidden: string[];
  };

  /** Task IDs that MUST complete before this task can start */
  dependsOn: string[];

  /** Estimated token cost for dispatching this task (used by slot scheduler) */
  estimatedTokens: number;

  /** Priority within its dependency group */
  priority: 'low' | 'medium' | 'high';

  /** Whether this task can run in parallel with other tasks at the same depth */
  canParallelize: boolean;

  /** The dependency graph depth (0 = no deps, N = N dep layers deep) */
  topologicalDepth: number;

  /** Current execution status */
  status: TaskExecutionStatus;

  /** Memory ID of the context package for this task (set by orchestrator at dispatch) */
  contextMemoryId?: string;

  /** Memory ID of the agent partial result (set if task is BLOCKED) */
  partialResultMemoryId?: string;

  /** Memory ID of the blocker report (set if task is BLOCKED) */
  blockerReportMemoryId?: string;

  /** Memory ID of the design delta that resolved the blocker (set on RESOLVED) */
  designDeltaMemoryId?: string;

  /** When the task was first dispatched (ISO-8601) */
  dispatchedAt?: string;

  /** When the task completed (ISO-8601) */
  completedAt?: string;

  /** Number of times this task has been dispatched (for retry tracking) */
  dispatchCount: number;

  /** Maximum allowed dispatches before marking FAILED */
  maxDispatches: number;

  /** Whether this task was created mid-execution (design_delta from blocker recovery) */
  isDeltaTask: boolean;

  /** If isDeltaTask, the parent taskId that was blocked */
  parentTaskId?: string;

  /** If isDeltaTask, the blockerReportMemoryId that triggered this delta */
  resolvedBlockerId?: string;
}

/**
 * Task execution status — mirrors the orchestrator state machine.
 */
export type TaskExecutionStatus =
  | 'PENDING'       // Not yet dispatched — waiting for dependencies
  | 'READY'         // All dependencies satisfied — can be dispatched
  | 'ACTIVE'        // Agent is currently executing
  | 'BLOCKED'       // Agent hit a blocker — partial result saved
  | 'RESOLVING'     // Architect is designing the missing dependency
  | 'RESUMED'       // Dependency resolved — original agent re-dispatched
  | 'COMPLETE'      // Agent returned valid wrap-up
  | 'FAILED'        // Max retries exceeded or unrecoverable error
  | 'CANCELLED';    // Orchestrator/user cancelled the task
```

### 2.2 Example: 5-File Feature

```typescript
const exampleTaskList: FineGrainedTaskEntry[] = [
  {
    taskId: "task_auth_001",
    targetFile: "packages/auth/src/models.py",
    fileOperation: "new_file",
    agent: "coder",
    description: "Define Pydantic models: User, Token, LoginRequest, LoginResponse",
    scope: {
      filesAllowed: ["packages/auth/src/models.py"],
      filesForbidden: ["packages/auth/src/config.py", "packages/auth/src/routes.py"]
    },
    dependsOn: [],
    estimatedTokens: 80,
    priority: "high",
    canParallelize: true,
    topologicalDepth: 0,
    status: "PENDING",
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false
  },
  {
    taskId: "task_auth_002",
    targetFile: "packages/auth/src/config.py",
    fileOperation: "new_file",
    agent: "coder",
    description: "Auth configuration: JWT_SECRET, TOKEN_EXPIRY, ALGORITHM",
    scope: {
      filesAllowed: ["packages/auth/src/config.py"],
      filesForbidden: ["packages/auth/src/models.py"]
    },
    dependsOn: [],
    estimatedTokens: 60,
    priority: "high",
    canParallelize: true,
    topologicalDepth: 0,
    status: "PENDING",
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false
  },
  {
    taskId: "task_auth_003",
    targetFile: "packages/auth/src/auth.py",
    fileOperation: "new_file",
    agent: "coder",
    description: "JWT token creation/validation, password hashing (bcrypt)",
    scope: {
      filesAllowed: ["packages/auth/src/auth.py"],
      filesForbidden: ["packages/auth/src/routes.py"]
    },
    dependsOn: ["task_auth_001", "task_auth_002"],
    estimatedTokens: 150,
    priority: "high",
    canParallelize: false,
    topologicalDepth: 1,
    status: "PENDING",
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false
  },
  {
    taskId: "task_auth_004",
    targetFile: "packages/auth/src/routes.py",
    fileOperation: "new_file",
    agent: "coder",
    description: "POST /login, POST /logout endpoints using auth.py",
    scope: {
      filesAllowed: ["packages/auth/src/routes.py"],
      filesForbidden: []
    },
    dependsOn: ["task_auth_003"],
    estimatedTokens: 120,
    priority: "medium",
    canParallelize: false,
    topologicalDepth: 2,
    status: "PENDING",
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false
  },
  {
    taskId: "task_auth_005",
    targetFile: "tests/test_auth.py",
    fileOperation: "new_file",
    agent: "tester",
    description: "Unit tests for auth: login success, invalid credentials, token expiry",
    scope: {
      filesAllowed: ["tests/test_auth.py"],
      filesForbidden: []
    },
    dependsOn: ["task_auth_003", "task_auth_004"],
    estimatedTokens: 180,
    priority: "medium",
    canParallelize: false,
    topologicalDepth: 3,
    status: "PENDING",
    dispatchCount: 0,
    maxDispatches: 3,
    isDeltaTask: false
  }
];
```

### 2.3 Field Validation Rules

| Field | Rule |
|-------|------|
| `targetFile` | Must be unique across ALL active task entries (see §8 Conflict Prevention) |
| `scope.filesAllowed` | Must contain exactly `[targetFile]` unless documented exception |
| `dependsOn` | Every referenced taskId MUST exist in the same FineGrainedTaskList |
| `topologicalDepth` | Must match the dependency graph computation; validated on load |
| `isDeltaTask` | If true, `parentTaskId` and `resolvedBlockerId` are required |
| `dispatchCount` | Must be ≤ `maxDispatches` before status transitions to FAILED |
| `estimatedTokens` | Must be > 0 and ≤ 5000 (guard against unreasonable estimates) |

---

## 3. Dependency Graph

### 3.1 DAG Representation

The task list forms a Directed Acyclic Graph (DAG):

```
Nodes: FineGrainedTaskEntry.targetFile (unique per file)
Edges: FineGrainedTaskEntry.dependsOn → taskId
```

### 3.2 ASCII Example: 5-File Auth Feature

```
Depth 0 (Parallel Group 1 — can run simultaneously):
  ┌─────────────────┐       ┌─────────────────┐
  │ task_auth_001   │       │ task_auth_002   │
  │ models.py       │       │ config.py       │
  │ [coder]          │       │ [coder]          │
  │ est: 80 tokens  │       │ est: 60 tokens  │
  └────────┬────────┘       └────────┬────────┘
           │                         │
           └──────────┬──────────────┘
                      │ (both must complete)
                      ▼
Depth 1 (Sequential — depends on both Depth 0 tasks):
           ┌─────────────────┐
           │ task_auth_003   │
           │ auth.py         │
           │ [coder]          │
           │ est: 150 tokens │
           └────────┬────────┘
                    │
                    ▼
Depth 2 (Sequential — depends on auth.py):
           ┌─────────────────┐
           │ task_auth_004   │
           │ routes.py       │
           │ [coder]          │
           │ est: 120 tokens │
           └────────┬────────┘
                    │
                    ▼
Depth 3 (Sequential — depends on auth.py + routes.py):
           ┌─────────────────┐
           │ task_auth_005   │
           │ test_auth.py    │
           │ [tester]         │
           │ est: 180 tokens │
           └─────────────────┘

Total: 5 tasks, 3 parallel at depth 0, 590 estimated tokens
Parallel savings: Depth 0 runs 2 tasks simultaneously → ~140 tokens worth of work in 1 slot-cycle
```

### 3.3 Topological Sorting (Kahn's Algorithm)

```
function topologicalSort(tasks: FineGrainedTaskEntry[]): FineGrainedTaskEntry[][] {
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>(); // taskId → dependents

  // Build adjacency + in-degree
  for (const task of tasks) {
    inDegree.set(task.taskId, task.dependsOn.length);
    for (const dep of task.dependsOn) {
      if (!graph.has(dep)) graph.set(dep, []);
      graph.get(dep)!.push(task.taskId);
    }
  }

  // Find all tasks with in-degree 0
  const groups: FineGrainedTaskEntry[][] = [];
  let currentGroup = tasks.filter(t => inDegree.get(t.taskId) === 0);

  while (currentGroup.length > 0) {
    groups.push(currentGroup);
    const nextGroup: FineGrainedTaskEntry[] = [];

    for (const task of currentGroup) {
      const dependents = graph.get(task.taskId) || [];
      for (const depId of dependents) {
        const newDegree = (inDegree.get(depId) || 1) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          nextGroup.push(tasks.find(t => t.taskId === depId)!);
        }
      }
    }
    currentGroup = nextGroup;
  }

  // Set topologicalDepth on each entry
  for (let depth = 0; depth < groups.length; depth++) {
    for (const task of groups[depth]) {
      task.topologicalDepth = depth;
      task.canParallelize = groups[depth].length > 1;
    }
  }

  return groups;
}
```

### 3.4 Graph Validation

| Check | Error Condition | Action |
|-------|----------------|--------|
| Cycle detection | `groups.length < tasks.length` (some nodes never reach in-degree 0) | Architect must break cycle by splitting a file |
| Dangling reference | `dependsOn` contains taskId not in the list | Reject plan — architect error |
| Self-reference | `dependsOn` contains own taskId | Reject plan — architect error |
| Depth > 5 | Any task at depth > 5 | Warn — architect should re-examine decomposition |
| Orphan tasks | Tasks with in-degree 0 that also have no dependents (leaf orphans) | Accept — standalone files are valid |

---

## 4. Blocker Recovery Flow

### 4.1 Problem

A coder agent, mid-execution, discovers it needs a file that doesn't exist yet and wasn't in the original plan.

### 4.2 12-Step Sequence Diagram

```
Step  Coder Agent            Orchestrator            Architect             memini-core
────  ───────────            ─────────────            ─────────             ───────────
  1   [Executing server.py]
      [needs User model   ]
      [from models.py     ]
      [  → models.py not  ]
      [    found on disk  ]
      │
  2   │──BLOCKER_REPORT─────→│
      │ { targetFile:        │
      │   "server.py",       │
      │   missingDep:        │
      │   "models.py",       │
      │   requirements:      │
      │   "Need Pydantic     │
      │    User model with   │
      │    id,email,name,    │
      │    password_hash",   │
      │   partialWork:       │
      │   "Imported FastAPI, │
      │    set up lifespan,  │
      │    registered /users │
      │    prefix" }         │
      │                      │
  3                          │──POST /memory/add───→│
                             │  sourceType:         │  { id: "mem_partial_001" }
                             │   "agent_partial"    │
                             │  content: {          │
                             │   taskId: "task_003",│
                             │   file: "server.py", │
                             │   completed: [...],  │
                             │   dependsOn:         │
                             │    ["models.py"] }   │
                             │                      │
  4                          │──POST /memory/add───→│
                             │  sourceType:         │  { id: "mem_blocker_001" }
                             │   "blocker_report"   │
                             │  content: {          │
                             │   taskId: "task_003",│
                             │   file: "server.py", │
                             │   missingDep:        │
                             │    "models.py",      │
                             │   requirements:      │
                             │    "User Pydantic    │
                             │     model..." }      │
                             │                      │
  5                          │──DISPATCH───────────→│
                             │  architect seed      │
                             │  prompt:             │
                             │  "Design models.py   │
                             │   for server.py.     │
                             │   Blocker report at  │
                             │   mem_blocker_001.   │
                             │   Partial result at  │
                             │   mem_partial_001."  │
                             │                      │
  6                                               │──GET /memory/────────→│
                                                  │  mem_blocker_001      │  Blocker report JSON
                                                  │                       │
                                                  │──GET /memory/────────→│
                                                  │  mem_partial_001      │  Partial result JSON
                                                  │                       │
  7                                               │[Architect analyzes:   ]
                                                  │[  - Blocker report   ]
                                                  │[  - Partial result   ]
                                                  │[  - Existing patterns]
                                                  │[  - User requirements]
                                                  │[                      ]
                                                  │[Optionally dispatches:]
                                                  │[  - researcher for   ]
                                                  │[    API patterns      ]
                                                  │[  - explorer for      ]
                                                  │[    existing models   ]
                                                  │                      │
  8                                               │──POST /memory/add───→│
                                                  │  sourceType:         │  { id: "mem_delta_001" }
                                                  │   "design_delta"     │
                                                  │  content: {          │
                                                  │   blockerReportId:   │
                                                  │    "mem_blocker_001",│
                                                  │   targetFile:        │
                                                  │    "models.py",      │
                                                  │   tasks: [           │
                                                  │    {taskId:"dt_001", │
                                                  │     file:"models.py",│
                                                  │     description:     │
                                                  │     "4 Pydantic      │
                                                  │      models: User,   │
                                                  │      Token, LoginReq,│
                                                  │      LoginResp" }],  │
                                                  │   depOrder:["dt_001"]│
                                                  │   }                 │
                                                  │                      │
  9                          │←──ARCHITECT RETURNS─│
                             │  { memory_id:        │
                             │    "mem_delta_001",  │
                             │    description:      │
                             │    "models.py: 4     │
                             │     Pydantic models"}│
                             │                      │
 10                          │──DISPATCH───────────→│
                             │  coder seed prompt:  │
                             │  "Implement          │
                             │   models.py.         │
                             │   Design at          │
                             │   mem_delta_001."    │
                             │                      │
                             │                      │  [Coder builds   ]
                             │                      │  [models.py with ]
                             │                      │  [4 Pydantic     ]
                             │                      │  [models          ]
                             │                      │
                             │                      │  POST /memory/add
                             │                      │  sourceType:
                             │                      │   "agent_wrap_up"
                             │                      │  → mem_wu_models
                             │                      │
 11                          │←──CODER RETURNS──────│
                             │  { memory_id:        │
                             │    "mem_wu_models",  │
                             │    success: true }    │
                             │                      │
 12                          │──RE-DISPATCH────────→│
                             │  original coder for  │
                             │  server.py           │
                             │  (resumed with       │
                             │   updated context:   │
                             │   models.py now      │
                             │   EXISTS on disk!)   │
                             │                      │  [Coder resumes  ]
                             │                      │  [server.py from ]
                             │                      │  [partial result ]
                             │                      │  [→ now succeeds ]
```

### 4.3 Blocker Report Schema

```typescript
/**
 * Structured report from a coder agent when it hits a missing dependency.
 * Stored in memini-core as sourceType="blocker_report".
 */
export interface BlockerReport {
  /** UUID of the blocked task */
  taskId: string;

  /** File the agent was working on when blocked */
  blockedFile: string;

  /** What the agent was trying to do when it hit the blocker */
  blockedOperation: string;

  /** The missing dependency — file path, type definition, config key, etc. */
  missingDependency: {
    /** What kind of thing is missing */
    type: 'file' | 'type_definition' | 'config' | 'interface' | 'external_api' | 'other';
    /** File path if it's a file */
    filePath?: string;
    /** Type/interface name if it's a type definition */
    typeName?: string;
    /** Natural language description of what's needed */
    description: string;
    /** Specific requirements the missing thing must satisfy */
    requirements: string[];
  };

  /** What the agent completed before hitting the blocker */
  partialWork: {
    /** Natural language summary */
    summary: string;
    /** Lines or sections completed */
    completedSections: string[];
    /** Memory ID of the partial result (agent_partial) */
    partialResultMemoryId: string;
    /** Files that were modified during partial work */
    filesTouched: string[];
  };

  /** The agent's best guess at what should happen next */
  suggestion: {
    /** Recommended action */
    action: 'create_file' | 'define_type' | 'add_config' | 'implement_interface' | 'research';
    /** Suggested file path for the missing dependency */
    suggestedFilePath?: string;
    /** Suggested agent to resolve the blocker */
    suggestedAgent: AgentRole;
  };

  /** Context memory ID of the original task */
  contextMemoryId: string;

  /** When the blocker was reported */
  reportedAt: string;
}
```

### 4.4 PENDING_BLOCKER Protocol Step

The existing `ProtocolStep` enum must be extended:

```typescript
export type ProtocolStep =
  | 'IDLE'
  | 'MEMORY_QUERY'
  | 'THOUGHT_CHAIN'
  | 'PLAN'
  | 'DELEGATE'
  | 'PENDING_BLOCKER'    // ← NEW: agent hit a blocker, waiting on resolution
  | 'GIT_CHECK'
  | 'QUALITY_GATES'
  | 'DOC_UPDATE'
  | 'MEMORY_SAVE'
  | 'COMPLETE';
```

`PENDING_BLOCKER` sits between `DELEGATE` and `GIT_CHECK` because:
- It is a mid-execution state (the agent has been dispatched but work is incomplete)
- `GIT_CHECK` is skipped until the blocker resolves (we don't check git for half-done work)
- Once resolved, the flow resumes at `DELEGATE` (re-dispatch agent)
- After re-dispatch succeeds, normal flow continues: `GIT_CHECK` → `QUALITY_GATES` → ...

---

## 5. Memory Types

### 5.1 New `sourceType` Values

Extending `MemorySourceType` in `neuralgentics/packages/orchestrator/src/types.ts`:

```typescript
export type MemorySourceType =
  | 'session'
  | 'file'
  | 'web'
  | 'boomerang'
  | 'project'
  | 'context_package'
  | 'agent_wrap_up'
  | 'agent_partial'      // ← NEW: partial result when agent hits blocker
  | 'blocker_report'     // ← NEW: structured blocker report from agent
  | 'design_delta';      // ← NEW: architect's response to a blocker
```

### 5.2 `agent_partial` Memory Type

**Purpose:** Store the partially completed work when an agent hits a blocker. Allows the orchestrator to resume the agent with context about what was already done.

**Content shape (JSON stringified):**
```json
{
  "taskId": "task_003",
  "targetFile": "packages/api/src/server.py",
  "completedWork": [
    "Imported FastAPI and uvicorn",
    "Set up app = FastAPI() with lifespan",
    "Registered /users route prefix",
    "Added CORS middleware",
    "Implemented health check endpoint GET /health"
  ],
  "remainingWork": [
    "Implement POST /users handler (needs User model from models.py)",
    "Wire up database session dependency",
    "Add error handlers for 404/500"
  ],
  "dependsOn": ["models.py"],
  "filesTouched": ["packages/api/src/server.py"],
  "contextMemoryId": "mem_cp_003",
  "blockedAt": "2026-05-22T15:30:00Z"
}
```

**Metadata:**
```json
{
  "taskType": "code-implementation",
  "agentRole": "coder",
  "taskId": "task_003",
  "contextMemoryId": "mem_cp_003",
  "blockedAt": "2026-05-22T15:30:00Z",
  "project": "neuralgentics",
  "version": "1.0"
}
```

**Relationships (set via memini-core after creation):**
```
(agent_partial)  ──DERIVED_FROM──→ (context_package)   [the original context]
(agent_partial)  ──SUPPORTS──────→ (blocker_report)     [explains why work stopped]
```

### 5.3 `blocker_report` Memory Type

**Purpose:** The agent's structured report of what's blocking progress. This is what the architect reads to design a resolution.

**Content shape:**
```json
{
  "taskId": "task_003",
  "blockedFile": "packages/api/src/server.py",
  "blockedOperation": "Implementing POST /users handler",
  "missingDependency": {
    "type": "file",
    "filePath": "packages/api/src/models.py",
    "description": "User Pydantic model with id, email, name, password_hash fields",
    "requirements": [
      "Must include id field (UUID, auto-generated)",
      "Must include email field with Pydantic EmailStr validation",
      "Must include password_hash field (string, not the raw password)",
      "Must include created_at and updated_at timestamps",
      "Must export as from models import User"
    ]
  },
  "partialWork": {
    "summary": "Server setup complete: FastAPI app, lifespan, CORS, health check. Blocked on POST /users because User model is not yet defined.",
    "completedSections": ["imports", "app initialization", "lifespan", "cors", "/health"],
    "partialResultMemoryId": "mem_partial_001",
    "filesTouched": ["packages/api/src/server.py"]
  },
  "suggestion": {
    "action": "create_file",
    "suggestedFilePath": "packages/api/src/models.py",
    "suggestedAgent": "coder"
  },
  "contextMemoryId": "mem_cp_003",
  "reportedAt": "2026-05-22T15:30:00Z"
}
```

**Metadata:**
```json
{
  "taskType": "code-implementation",
  "agentRole": "coder",
  "taskId": "task_003",
  "partialResultMemoryId": "mem_partial_001",
  "reportedAt": "2026-05-22T15:30:00Z",
  "project": "neuralgentics",
  "version": "1.0",
  "severity": "blocking"
}
```

**Relationships:**
```
(blocker_report)  ──DERIVED_FROM──→ (agent_partial)     [the partial result explains why]
(blocker_report)  ──BLOCKS────────→ (context_package)    [the original task is blocked]
(blocker_report)  ──RELATED_TO────→ (design_delta)       [resolved by this architect design]
```

### 5.4 `design_delta` Memory Type

**Purpose:** The architect's design for resolving a blocker. Contains the new task entry (or entries) for the missing dependency. This is structurally identical to a mini `FineGrainedTaskList` — just for the dependency.

**Content shape:**
```json
{
  "blockerReportId": "mem_blocker_001",
  "targetFile": "packages/api/src/models.py",
  "description": "Pydantic models for the API: User, Token, LoginRequest, LoginResponse",
  "tasks": [
    {
      "taskId": "task_delta_001",
      "targetFile": "packages/api/src/models.py",
      "fileOperation": "new_file",
      "agent": "coder",
      "description": "4 Pydantic models: User (id,email,name,password_hash,created_at,updated_at), Token (access_token,token_type), LoginRequest (email,password), LoginResponse (user:User,token:Token)",
      "scope": {
        "filesAllowed": ["packages/api/src/models.py"],
        "filesForbidden": []
      },
      "dependsOn": [],
      "estimatedTokens": 100,
      "priority": "high",
      "canParallelize": false,
      "topologicalDepth": 0,
      "status": "PENDING",
      "dispatchCount": 0,
      "maxDispatches": 3,
      "isDeltaTask": true,
      "parentTaskId": "task_003",
      "resolvedBlockerId": "mem_blocker_001"
    }
  ],
  "depOrder": ["task_delta_001"],
  "estimatedTokens": 100,
  "agentRole": "coder",
  "createdAt": "2026-05-22T15:32:00Z"
}
```

**Metadata:**
```json
{
  "taskType": "architecture-design",
  "agentRole": "architect",
  "blockerReportMemoryId": "mem_blocker_001",
  "createdAt": "2026-05-22T15:32:00Z",
  "project": "neuralgentics",
  "version": "1.0"
}
```

**Relationships:**
```
(design_delta)  ──RESOLVES──────→ (blocker_report)     [this design addresses the blocker]
(design_delta)  ──DERIVED_FROM──→ (agent_partial)      [informed by what was already done]
(design_delta)  ──RELATED_TO────→ (context_package)    [part of the original task's family]
```

### 5.5 New Relationship Types

Two new relationship types must be added:

```typescript
export type RelationshipType =
  | 'SUPERSEDES'
  | 'PARTIAL_UPDATE'
  | 'RELATED_TO'
  | 'CONTRADICTS'
  | 'DERIVED_FROM'
  | 'SUPPORTS'       // ← NEW: one memory provides supporting context for another
  | 'BLOCKS'         // ← NEW: one memory blocks progress on another
  | 'RESOLVES';      // ← NEW: one memory resolves a blocker described by another
```

---

## 6. Orchestrator Task State Machine

### 6.1 States and Transitions

```
                          ┌─────────────┐
                          │   PENDING   │  (dependencies not yet satisfied)
                          └──────┬──────┘
                                 │ all dependsOn tasks COMPLETE
                                 ▼
                          ┌─────────────┐
                          │   READY     │  (can be dispatched)
                          └──────┬──────┘
                                 │ orchestrator dispatches agent
                                 ▼
              ┌──────────────────────────────────────┐
              │             ACTIVE                   │  (agent executing)
              └────┬─────────────┬──────────────┬────┘
                   │             │              │
      agent returns│    agent hits blocker      │ timeout or
      valid wrap-up│             │              │ max retries
                   ▼             ▼              ▼
            ┌──────────┐  ┌──────────┐  ┌──────────┐
            │ COMPLETE │  │ BLOCKED  │  │  FAILED  │
            └──────────┘  └────┬─────┘  └──────────┘
                               │ orchestrator stores partial result
                               │ dispatches architect for resolution
                               ▼
                        ┌──────────┐
                        │RESOLVING │  (architect designing dependency)
                        └────┬─────┘
                             │ architect returns design_delta
                             │ orchestrator dispatches coder for dependency
                             ▼
                    ┌──────────────┐
                    │  DEPENDENCY  │  (coder implementing missing dependency)
                    │  BUILDING    │
                    └──────┬───────┘
                           │ coder returns wrap-up for dependency
                           │ dependency file now EXISTS on disk
                           ▼
                    ┌──────────────┐
                    │   RESUMED    │  (original agent re-dispatched)
                    └──────┬───────┘
                           │ agent completes successfully
                           ▼
                    ┌──────────────┐
                    │   COMPLETE   │
                    └──────────────┘

   Any state ──(user/orchestrator cancels)──→ CANCELLED
   BLOCKED ──(max blocker chain depth exceeded)──→ FAILED
   RESOLVING ──(architect cannot resolve)──→ FAILED
```

### 6.2 Transition Triggers

| From | To | Trigger | Handler |
|------|----|---------|---------|
| `PENDING` | `READY` | All `dependsOn` tasks are `COMPLETE` | `orchestrator.evaluateDependencies()` |
| `READY` | `ACTIVE` | `orchestrator.dispatchTask(entry)` called | `orchestrator.dispatchFineGrainedTask()` |
| `ACTIVE` | `COMPLETE` | Agent returns `{ memory_id, success: true }` | `orchestrator.handleAgentResult()` |
| `ACTIVE` | `BLOCKED` | Agent returns `BLOCKER_REPORT` with missing dependency | `orchestrator.handleBlocker()` |
| `ACTIVE` | `FAILED` | Dispatch timeout, max retries exceeded, or agent returns unrecoverable error | `orchestrator.handleFailure()` |
| `BLOCKED` | `RESOLVING` | Orchestrator stores partial+blocker → dispatches architect | `orchestrator.escalateToArchitect()` |
| `RESOLVING` | `DEPENDENCY_BUILDING` | Architect returns `design_delta` → orchestrator dispatches coder | `orchestrator.dispatchDeltaTask()` |
| `DEPENDENCY_BUILDING` | `RESUMED` | Coder completes dependency → orchestrator re-dispatches original agent | `orchestrator.resumeBlockedTask()` |
| `RESUMED` | `COMPLETE` | Re-dispatched agent returns valid wrap-up | `orchestrator.handleAgentResult()` |
| `RESOLVING` | `FAILED` | Architect cannot resolve (unknown dep, circular, out of scope) | `orchestrator.handleUnresolvableBlocker()` |
| `BLOCKED` | `FAILED` | Blocker chain depth exceeds `MAX_BLOCKER_CHAIN_DEPTH` (default: 3) | `orchestrator.handleBlockerChainExceeded()` |
| Any | `CANCELLED` | User or orchestrator cancels the task | `orchestrator.cancelTask()` |

### 6.3 State Machine Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Only one task per file can be `ACTIVE`, `BLOCKED`, `RESOLVING`, or `RESUMED` at a time | File-level lock checked before dispatch (see §8) |
| `dispatchCount` never exceeds `maxDispatches` | Checked in `orchestrator.dispatchFineGrainedTask()` |
| Blocker chain depth (nested RESOLVING→DEPENDENCY_BUILDING cycles) ≤ `MAX_BLOCKER_CHAIN_DEPTH` | Counter incremented on each `BLOCKED→RESOLVING` transition |
| `COMPLETE` task's `targetFile` must exist on disk | Post-completion validation: `fs.existsSync(targetFile)` |
| `RESUMED` agent receives updated context that includes the now-existing dependency file | Context rebuild includes the newly created file in `relevantFiles` |

### 6.4 Blocker Chain Depth Example

```
task_001 (server.py) BLOCKED → needs models.py       [depth 1]
  → task_delta_001 (models.py) BLOCKED → needs types.py [depth 2]
    → task_delta_002 (types.py) BLOCKED → needs config.py [depth 3]
      → task_delta_003 (config.py) BLOCKED → needs ???      [depth 4 → FAILED]
```

At depth 4 (exceeding `MAX_BLOCKER_CHAIN_DEPTH=3`), the orchestrator marks the entire chain as `FAILED` and surfaces to the user: "Blocker chain exceeded maximum depth. Original task blocked on models.py, which was blocked on types.py, which was blocked on config.py, which required an unknown dependency. The architect should re-examine the original feature decomposition."

### 6.5 Orchestrator Methods

```typescript
class NeuralgenticsOrchestrator {
  // === Existing ===
  handleTask(task: Task): Promise<OrchestrationResult>;

  // === New Fine-Grained Methods ===
  /** Convert architect's FineGrainedTaskList into dispatchable work units */
  ingestFineGrainedPlan(plan: FineGrainedTaskList): Promise<void>;

  /** Dispatch a single fine-grained task entry */
  dispatchFineGrainedTask(entry: FineGrainedTaskEntry): Promise<void>;

  /** Handle a blocker report from an agent */
  handleBlocker(
    taskId: string,
    blockerReport: BlockerReport,
    partialResult: AgentPartialResult
  ): Promise<void>;

  /** Escalate a blocker to the architect for resolution */
  escalateToArchitect(taskId: string, blockerReportMemoryId: string): Promise<void>;

  /** Dispatch a delta task (dependency created by architect from blocker) */
  dispatchDeltaTask(deltaMemoryId: string): Promise<void>;

  /** Resume a blocked task after its dependency has been resolved */
  resumeBlockedTask(taskId: string): Promise<void>;

  /** Evaluate which pending tasks now have all dependencies satisfied */
  evaluateDependencies(): Promise<FineGrainedTaskEntry[]>;

  /** Get the full task chain including delta tasks for a given feature */
  getTaskChain(featureId: string): Promise<FineGrainedTaskEntry[]>;

  /** Cancel a task and all its delta descendants */
  cancelTaskChain(taskId: string): Promise<void>;

  // === File-level locking ===
  /** Check if a file is currently owned by any active task */
  isFileLocked(filePath: string): boolean;

  /** Acquire file lock (checked before dispatch) */
  acquireFileLock(filePath: string, taskId: string): boolean;

  /** Release file lock (on COMPLETE, FAILED, or CANCELLED) */
  releaseFileLock(filePath: string, taskId: string): void;
}
```

---

## 7. Sub-Agent Recursion

### 7.1 Architect Can Spawn Sub-Agents to Resolve Blockers

When the architect receives a blocker report, it may need additional research to design the resolution. The architect can spawn sub-agents:

```
Architect receives blocker → "Need models.py for server.py"
│
├─ Option A: Architect knows the answer (simple case)
│  └─ Produce design_delta directly
│
├─ Option B: Architect needs research
│  ├─ Spawn researcher: "Search for Pydantic User model patterns in FastAPI projects"
│  │  └─ Researcher returns findings → stored in memini-core
│  │
│  ├─ Spawn explorer: "Find all existing model files in packages/*/src/models/"
│  │  └─ Explorer returns file list + patterns → stored in memini-core
│  │
│  └─ Architect synthesizes: blocker requirements + research findings + existing patterns
│     └─ Produce design_delta
│
└─ Option C: Architect needs to understand partial work
   └─ Fetch agent_partial from memini-core
      └─ Examine what the coder already built
         └─ Design delta that integrates with existing partial work
```

### 7.2 Sub-Agent Dispatch Protocol (Recursive)

The architect follows the existing stateless agent protocol for sub-agent dispatch:

```
Architect dispatches sub-agent:
  1. Build mini ContextPackage for sub-agent (research task)
  2. POST /memory/add → store as context_package → get subContextMemoryId
  3. Dispatch sub-agent with seed prompt containing subContextMemoryId
  4. Sub-agent: fetch context → do work → store wrap-up → return {memory_id, description}
  5. Architect: GET /memory/{wrapUpId} → read results
  6. Architect: incorporate sub-agent findings into design_delta
```

### 7.3 Sub-Agent Chaining (Max Depth)

```
Architect ──spawn──→ Researcher ──spawn──→ Explorer ──spawn──→ ... ??
```

**Rule:** Sub-agent recursion depth is limited to **2** (architect → sub-agent → sub-sub-agent). Deeper chains suggest the blocker is too complex for automated resolution and should be escalated to the user.

### 7.4 Sub-Agent Memory Relationships

```
(design_delta) ──DERIVED_FROM──→ (researcher_wrap_up)
(design_delta) ──DERIVED_FROM──→ (explorer_wrap_up)
(researcher_wrap_up) ──SUPPORTS──→ (blocker_report)
(explorer_wrap_up) ──SUPPORTS──→ (blocker_report)
```

### 7.5 Timeout for Sub-Agent Research

| Sub-agent type | Default timeout | Rationale |
|----------------|----------------|-----------|
| `researcher` | 60s | Web searches + synthesis |
| `explorer` | 30s | Local file finding only |
| `coder` (delta task) | 120s | Code generation for dependency |

If any sub-agent times out, the architect must still produce a `design_delta` — using best available context or marking the blocker as `requires_user_intervention`.

---

## 8. Conflict Prevention

### 8.1 The Problem

With fine-grained scoping, multiple tasks may target different files. But if two tasks somehow target the **same file** (architect bug, delta collision, or parallel coder dispatch), we must prevent conflicting writes.

### 8.2 File Ownership Registry

The orchestrator maintains an **in-memory file ownership map**:

```typescript
class FileOwnershipRegistry {
  /** Map: filePath → { taskId, status, acquiredAt } */
  private locks: Map<string, FileLock>;

  /** Try to acquire a file lock. Returns false if another task owns the file. */
  acquire(filePath: string, taskId: string): boolean {
    const existing = this.locks.get(filePath);
    if (existing && existing.taskId !== taskId && existing.status !== 'COMPLETE') {
      return false; // CONFLICT: file already owned
    }
    this.locks.set(filePath, { taskId, status: 'ACTIVE', acquiredAt: Date.now() });
    return true;
  }

  /** Release a file lock */
  release(filePath: string, taskId: string): void {
    const existing = this.locks.get(filePath);
    if (existing && existing.taskId === taskId) {
      this.locks.delete(filePath);
    }
  }

  /** Check all active locks (for crash recovery) */
  getActiveLocks(): Map<string, FileLock> { return this.locks; }
}
```

### 8.3 Lock Lifecycle

```
Task enters READY state
  │
  ├─ orchestrator checks: acquireFileLock(targetFile, taskId)
  │   ├─ true → proceed to dispatch (ACTIVE)
  │   └─ false → CONFLICT. Re-queue task. Log conflict. Alert architect.
  │
  ▼
Task is ACTIVE (lock held)
  │
  ├─ COMPLETE → releaseFileLock(targetFile) ✓
  ├─ FAILED   → releaseFileLock(targetFile) ✓
  ├─ CANCELLED → releaseFileLock(targetFile) ✓
  └─ BLOCKED  → lock is HELD (the blocked task still "owns" the file)
       │
       └─ When RESOLVING → DEPENDENCY_BUILDING → RESUMED → COMPLETE
          → releaseFileLock(targetFile) ✓
```

**Key:** When a task is `BLOCKED`, the file lock is **held** — no other agent should touch `server.py` while the original coder's partial work is pending resolution. The file is "owned" until either:
- The blocker resolves and the coder finishes (`COMPLETE`)
- The task fails or is cancelled (lock released, any agent can retry)

### 8.4 Lock Crash Recovery

The in-memory lock map is ephemeral. If the orchestrator crashes:

1. On restart, query memini-core for all `agent_partial` memories (tasks in BLOCKED state)
2. For each: verify the file on disk still contains the partial work described
3. Rebuild the lock map: for each BLOCKED or ACTIVE task, re-acquire the lock
4. Resume the recovery flow: trigger `evaluateDependencies()` to unblock downstream tasks

### 8.5 Conflict Resolution Protocol

```
Two tasks claim ownership of the same file:
  1. Orchestrator detects conflict at dispatch time
  2. Logs: CONFLICT: file "models.py" claimed by task_001 (ACTIVE) and task_delta_005 (READY)
  3. Checks: which task was created first? (dispatchCount, then creation timestamp)
  4. First-created task wins → second task gets status CONFLICT_RESOLVING
  5. Orchestrator dispatches architect: "Two tasks want models.py. Merge or split?"
  6. Architect either:
     a) Merges: single task covers both purposes → CONFLICT_RESOLVED → COMPLETE
     b) Splits: models.py → models/core.py + models/auth.py → two tasks, no conflict
     c) Defers: second task waits for first → dependency added

Priority order for conflict resolution:
  1. Original plan task (isDeltaTask=false) beats delta task (isDeltaTask=true)
  2. Earlier creation timestamp beats later
  3. Higher priority beats lower
  4. If all equal → architect decides
```

### 8.6 Prevention in the Architect's Decomposition

The architect's task decomposition algorithm already prevents most conflicts:

| Prevention | Mechanism |
|------------|-----------|
| **Unique target files** | Step 2 (file path resolution) assigns each entity to a unique path. Two entities mapping to the same path triggers a warning. |
| **Cross-validation** | Step 5 (topological sort) detects if two tasks claim the same file at the same depth — impossible with unique paths. |
| **Delta task uniqueness** | Design_delta tasks carry `isDeltaTask=true` and `parentTaskId`, making them traceable to the blocker that created them. |
| **File existence check before create** | Before marking `fileOperation: "new_file"`, architect checks `fs.existsSync(targetFile)`. If the file already exists, `fileOperation` must be `"modify_file"`. |

---

## 9. Type System Modifications

### 9.1 Files to Modify

| File | Changes |
|------|---------|
| `neuralgentics/packages/orchestrator/src/types.ts` | Add `FineGrainedTaskEntry`, `TaskExecutionStatus`, `BlockerReport`, `AgentPartialResult`, `DesignDelta`, `FileLock`, `FineGrainedTaskList`. Extend `ProtocolStep`, `MemorySourceType`, `RelationshipType`. |
| `neuralgentics/packages/orchestrator/src/stateless-protocol.ts` | Add `SEED_PROMPT_BLOCKER_TEMPLATE`, `SEED_PROMPT_DELTA_TEMPLATE` for architect and delta coder dispatches. |
| `neuralgentics/packages/orchestrator/src/index.ts` | Add new orchestrator methods from §6.5. |

### 9.2 New Type Exports

```typescript
// types.ts — new exports

export interface FineGrainedTaskList {
  featureId: string;
  featureDescription: string;
  tasks: FineGrainedTaskEntry[];
  createdAt: string;
  totalEstimatedTokens: number;
  maxTopologicalDepth: number;
}

export interface FineGrainedTaskEntry { /* see §2.1 */ }
export type TaskExecutionStatus = /* see §2.1 */;
export interface BlockerReport { /* see §4.3 */ }

export interface AgentPartialResult {
  taskId: string;
  targetFile: string;
  completedWork: string[];
  remainingWork: string[];
  dependsOn: string[];
  filesTouched: string[];
  contextMemoryId: string;
  blockedAt: string;
}

export interface DesignDelta {
  blockerReportId: string;
  targetFile: string;
  description: string;
  tasks: FineGrainedTaskEntry[];
  depOrder: string[];
  estimatedTokens: number;
  agentRole: AgentRole;
  createdAt: string;
}

export interface FileLock {
  taskId: string;
  status: TaskExecutionStatus;
  acquiredAt: number;
}
```

### 9.3 Protocol Step Extension

```typescript
// stateless-protocol.ts — new seed prompt templates

export const SEED_PROMPT_BLOCKER_TEMPLATE = `---
## Task
Blocker Resolution: {task}

## Memory Context
Blocker report at: \`{blockerMemoryId}\`
Partial result at: \`{partialMemoryId}\`

Fetch both from memini-core to understand what's blocking and what's been done.

Analyze the blocker. If research is needed, dispatch researcher/explorer sub-agents via the stateless protocol.
Produce a design_delta with tasks for the missing dependency. Store it in memini-core as sourceType="design_delta".
Return: { memory_id: "<design_delta_id>", description: "<summary>" }
---`;

export const SEED_PROMPT_DELTA_CODER_TEMPLATE = `---
## Task
Delta Implementation: {task}

## Memory Context
Design delta at: \`{deltaMemoryId}\`

Fetch from memini-core. This is a dependency that was missed in the original plan.
Implement it following the design specification.
---`;
```

---

## 10. Integration with Existing Systems

### 10.1 With Stateless Agent Protocol

The fine-grained scoping system is designed to work with the stateless memory-backed protocol from [`DESIGN_stateless_agents_v1.md`](DESIGN_stateless_agents_v1/):

| Aspect | Integration |
|--------|------------|
| **Dispatch** | Each `FineGrainedTaskEntry` → `storeContextPackage()` → seed prompt with `contextMemoryId` |
| **Agent work** | Agent fetches context from memini-core, does work, stores wrap-up |
| **Blocker** | Agent stores partial result + blocker report in memini-core (instead of wrap-up) |
| **Recovery** | Orchestrator reads blocker report → dispatches architect → architect returns design_delta → delta coder dispatched → original agent resumed with updated context |

### 10.2 With Concurrency Controls

The existing `TaskLimiter` and slot management integrate naturally:

| Existing | Fine-Grained Extension |
|----------|----------------------|
| `maxConcurrentSubAgents` | Applies per-depth-group. Depth-0 tasks are dispatched up to `maxConcurrentSubAgents` at once. |
| `agentTimeouts` | Per-task timeout based on `estimatedTokens`. Small tasks (≤100 tokens) get shorter timeouts. |
| `canDispatch()` | Extended with `isFileLocked()` — no dispatch if the file is owned. |
| `releaseAgent()` | On `BLOCKED`, the slot is released but the file lock is **held**. On `COMPLETE`, both are released. |

### 10.3 With Routing Matrix

Existing `ROUTING_MATRIX` / `MANDATORY_SEQUENCES` apply:

| Rule | Fine-Grained Impact |
|------|--------------------|
| Architect before Coder | `architecture-design` tasks always at depth 0. Coder tasks at depth ≥ 1. |
| Coder before Tester | Tester tasks have `dependsOn` on coder tasks for the files they test. |
| Reviewer gates merge | After coder `COMPLETE`, orchestrator auto-creates reviewer delta task if one isn't in the plan. |

### 10.4 With Quality Gates

The existing `GIT_CHECK` → `QUALITY_GATES` flow applies per-task:

```
FineGrainedTaskEntry COMPLETE →
  1. GIT_CHECK: verify working tree is clean for this file
  2. QUALITY_GATES: Lint → Typecheck → Test (scoped to the target file)
  3. If all pass → mark task as truly COMPLETE, release file lock
  4. If fail → auto-create delta task for boomerang-linter to fix
```

---

## 11. Implementation Phases

### Phase 1: Core Types & Memory Schema (Low Risk)
- Add `FineGrainedTaskEntry`, `TaskExecutionStatus`, `BlockerReport`, `AgentPartialResult`, `DesignDelta` to `types.ts`
- Extend `MemorySourceType` with `agent_partial`, `blocker_report`, `design_delta`
- Extend `RelationshipType` with `SUPPORTS`, `BLOCKS`, `RESOLVES`
- Extend `ProtocolStep` with `PENDING_BLOCKER`
- Write unit tests for type validation

### Phase 2: File Ownership Registry (Medium Risk)
- Implement `FileOwnershipRegistry` class
- Thread lock checks into `dispatchFineGrainedTask()`
- Add crash recovery: on orchestrator startup, rebuild lock map from memini-core
- Write tests for lock acquisition, release, conflict detection, crash recovery

### Phase 3: Orchestrator State Machine (High Risk)
- Implement `ingestFineGrainedPlan()`, `dispatchFineGrainedTask()`, `evaluateDependencies()`
- Implement `handleBlocker()`, `escalateToArchitect()`, `dispatchDeltaTask()`, `resumeBlockedTask()`
- Integrate with existing `TaskLimiter` for slot management
- Write integration tests for state transitions

### Phase 4: Seed Prompts & Agent Protocol (Medium Risk)
- Add `SEED_PROMPT_BLOCKER_TEMPLATE`, `SEED_PROMPT_DELTA_TEMPLATE` to `stateless-protocol.ts`
- Update architect SKILL.md with blocker resolution protocol
- Update coder SKILL.md with blocker reporting protocol
- Write end-to-end tests simulating blocker → recovery → completion

### Phase 5: Architect Task Decomposition Tool (Medium Risk)
- Implement `decomposeFeature()` algorithm (§1.3) as an architect prompt template
- Validate decomposition outputs: unique file paths, valid dependency graph, reasonable token estimates
- Write tests for entity extraction, topological sort, parallel group identification

### Phase 6: Sub-Agent Recursion (Low Risk)
- Architect can spawn researcher/explorer during blocker resolution
- Max recursion depth: 2
- Integrate with memory relationships: DERIVED_FROM, SUPPORTS
- Write tests for sub-agent chaining

---

## 12. Failure Modes & Recovery

### 12.1 Blocker Chain Exceeds Max Depth

**Symptom:** Task blocked → delta task blocked → delta-delta blocked → ...
**Cause:** Architect underestimated dependency depth in original decomposition.
**Recovery:**
1. After `MAX_BLOCKER_CHAIN_DEPTH` (default: 3), mark the entire chain as `FAILED`
2. Store the full chain trace in memini-core as `blocker_chain_report`
3. Surface to user: "Implementation blocked on a chain of 3+ missing dependencies. The original decomposition missed: [chain]. Please review the feature scope."
4. User can either: (a) approve expanding the scope, (b) redesign the feature, (c) manually create the missing foundations

### 12.2 Agent Returns Invalid Blocker Report

**Symptom:** Blocker report JSON doesn't match schema.
**Recovery:**
1. Validate blocker report against schema before processing
2. If invalid: return error to agent with schema reference → agent retries with valid report
3. If agent fails 3 times to produce valid blocker report: mark task as `FAILED` with reason `invalid_blocker_report`
4. Log the raw agent output for debugging

### 12.3 Architect Cannot Resolve Blocker

**Symptom:** Architect returns `design_delta` with `tasks: []` or `confidence: 0.0`.
**Recovery:**
1. Orchestrator detects empty delta → escalates to user
2. User provides guidance: "models.py should contain X, Y, Z"
3. Architect re-dispatched with user-provided requirements
4. Alternatively: user creates the file manually → orchestrator detects file exists → resumes blocked task

### 12.4 Partial Result Becomes Stale

**Symptom:** During blocker resolution, another process modifies the partially-completed file.
**Recovery:**
1. Before resuming blocked task, orchestrator hashes the file and compares against the hash stored in `agent_partial`
2. If hashes differ: warn → architect re-evaluates whether the partial work is still valid
3. Architect may: (a) produce updated design_delta that accounts for changes, (b) restart the task from scratch

### 12.5 Task Completes But File Is Missing

**Symptom:** Agent returns `COMPLETE` wrap-up but `fs.existsSync(targetFile)` is false.
**Recovery:**
1. Mark task as `FAILED` with reason `file_not_created`
2. Log the agent wrap-up for debugging
3. Auto-create a new delta task for the same file (fresh dispatch)
4. If this happens repeatedly for the same agent, adjust trust score on that agent's context memory

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **FineGrainedTaskEntry** | A single task unit scoped to exactly 1 file |
| **FineGrainedTaskList** | The architect's full decomposition for a feature |
| **Delta Task** | A task created mid-execution to resolve a blocker (`isDeltaTask: true`) |
| **Blocker Report** | Structured report from agent about what's blocking progress |
| **Agent Partial Result** | Partially completed work stored when an agent hits a blocker |
| **Design Delta** | Architect's design for resolving a blocker (mini task list) |
| **File Ownership Registry** | In-memory map preventing two agents from owning the same file |
| **Blocker Chain Depth** | Number of nested blocker→delta→blocker→delta cycles |
| **Topological Depth** | Position in the dependency DAG (0 = no deps, N = N layers deep) |
| **PENDING_BLOCKER** | New protocol step: agent execution is blocked pending dependency resolution |

## Appendix B: Maximum Blocker Chain Depth Rationale

The default `MAX_BLOCKER_CHAIN_DEPTH` is set to **3** because:

1. **Depth 1** (original task blocked): Common. Architect missed a dependency in decomposition.
2. **Depth 2** (delta task blocked): Uncommon. Architect's resolution was incomplete.
3. **Depth 3** (delta-delta blocked): Rare. Suggests systemic decomposition error.
4. **Depth 4+**: Extreme. Almost certainly a bug or fundamentally incomplete design. Should be escalated to user rather than auto-resolved.

At depth 4, the orchestrator has spent ~4 round-trips (BLOCKED→RESOLVING→DEPENDENCY_BUILDING→RESUMED × 4) without completing the original task. This is both token-expensive and time-expensive. Escalating to the user is the correct choice.

## Appendix C: Design Decisions Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | One file per agent dispatch | Eliminates conflict risk, enables precise dependency tracking, makes partial results tractable | 2026-05-22 |
| 2 | File lock held through BLOCKED state | Prevents another agent from overwriting partial work while the blocker resolves | 2026-05-22 |
| 3 | MAX_BLOCKER_CHAIN_DEPTH = 3 | Balances automated recovery with cost-awareness. Beyond 3 suggests architectural-level issues. | 2026-05-22 |
| 4 | Blocker report + partial result as separate memory types | Allows independent querying, trust scoring, and relationship tracking | 2026-05-22 |
| 5 | Architect owns blocker resolution (not coder self-escalation) | Architect has the research/reasoning capability to design the dependency. Coder only reports | 2026-05-22 |
| 6 | In-memory file lock map backed by memini-core | Speed for dispatch checks, durability for crash recovery | 2026-05-22 |
| 7 | Delta tasks carry `isDeltaTask: true` and `parentTaskId` | Full traceability of how tasks were created during execution | 2026-05-22 |
| 8 | PENDING_BLOCKER as a mid-execution protocol step | Fits between DELEGATE and GIT_CHECK; GIT_CHECK deferred until blocker resolves | 2026-05-22 |
| 9 | Sub-agent recursion max depth = 2 | Limits token cost spiral. Deeper research chains suggest architectural redesign needed | 2026-05-22 |
| 10 | Architect prompt-based decomposition (not code-based) | Leverages LLM reasoning for entity extraction; validated by code for correctness | 2026-05-22 |

---

*This design document supersedes any inline design comments in source files. Implementation must follow this specification. Deviations should be raised as review items before code changes.*
