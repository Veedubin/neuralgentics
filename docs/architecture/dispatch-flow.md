# Dispatch Flow

The Orchestrator is the "brain" of the session. It translates a vague user request into a deterministic set of tasks, ensuring no step is skipped and every agent has exactly the context it needs.

## 🔄 The Dispatch Pipeline

Neuralgentics does not use simple linear prompts. It uses a **decompositional pipeline**.

```text
    USER PROMPT
         │
         ▼
 ╔══════════════════╗
 ║   THOUGHT CHAIN  ║ ◄── Logged to memini-ai
 ╚══════════════════╝
         │
         ▼
 ╔══════════════════╗
 ║ TASK DECOMPOSE   ║ ◄── Create Kanban cards
 ╚══════════════════╝
         │
         ▼
 ╔══════════════════╗
 ║ ROUTE MATRIX     ║ ◄── Select Specialist
 ╚══════════════════╝
         │
         ▼
 ╔══════════════════╗
 ║ CONTEXT PACKAGE ║ ◄── Fetch L0/L1/L2 Memory
 ╚══════════════════╝
         │
         ▼
 ╔══════════════════╗
 ║    TASK() CALL   ║ ◄── OpenCode Dispatch
 ╚══════════════════╝
         │
         ▼
   [ SPECIALIST AGENT ]
```
> **Diagram 3 — Dispatch Pipeline.** The user's intent is first processed through a sequential thought chain. The orchestrator then decomposes the goal into a set of discrete cards on the Kanban board. Each card is routed to a specialist (e.g., `boomerang-coder`) and packaged with a targeted' slice of memory before being executed.

---

## 🛠️ Process Details

### 1. Thought Chain
Before acting, the orchestrator must "think." It uses `memini-ai-dev_add_thought` to record its reasoning. This prevents "hallucinated paths" and allows developers to audit *why* a specific agent was chosen for a task.

### 2. Task Decomposition
The orchestrator transforms a prompt into a list of tasks in `TASKS.md`. 
- **Triage:** Initial sorting.
- **Ready:** Tasks deemed actionable.
- **Running:** The currently executing task.

### 3. The Routing Matrix
The routing matrix is a hard-coded rule set that prevents agent misuse. For example:
- `Research` $\rightarrow$ `boomerang-architect` (NOT explorer)
- `File Finding` $\rightarrow$ `boomerang-explorer` (ONLY glob/find)
- `Implementation` $\rightarrow$ `boomerang-coder`

### 4. The Context Package
To stay token-efficient, the orchestrator does not send a dump of all project files. It constructs a **Context Package** containing:
- The specific User Request.
- Relevant file snippets via `memini-ai-dev_search_project`.
- Previous decisions from L1 memory.
- Defined boundaries (what is IN vs OUT of scope).
