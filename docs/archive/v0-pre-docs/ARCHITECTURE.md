!!! WARNING

    **THIS DOCUMENT IS ARCHIVED AS OF 2026-06-04.**
    It describes an older version of Neuralgentics and may reference
    APIs, install paths, or env vars that no longer exist.

    For current documentation, see:
    <https://neuralgentics.github.io/neuralgentics/>
    or the source under `docs/` in the `main` branch.

---

# Architecture: Neuralgentics

## System Overview
Neuralgentics implements a hybrid architecture combining TypeScript for orchestration and Python for data-heavy memory operations. Unlike standard MCP implementations, native memory is handled via a direct HTTP bridge to avoid the overhead of the MCP protocol for frequent, small-chunk memory operations.

## High-Level Diagram

```text
+-------------------------------------------------------+
|                  User Interface (TUI)                |
+---------------------------+---------------------------+
                             |
                             v
+-------------------------------------------------------+
|               Neuralgentics Plugin (TS)               |
|  +------------------+       +-----------------------+ |
|  |  Orchestrator    | <---> |   Protocol Advisor    | |
|  +------------------+       +-----------------------+ |
|          |                                             |
|          +---------------------+-------------------+  |
|          |                     |                     | |
|          v                     v                     v |
|  +---------------+     +---------------+     +---------------+ |
|  | Native Bridge  |     |  MCP Broker   |     | Plugin Logic  | |
|  +-------+-------+     +-------+-------+     +---------------+ |
+----------|---------------------|-----------------------------+
            |                     |
            | (HTTP/JSON)         | (MCP Protocol)
            v                     v
+-----------------------+   +-----------------------------+
|    memini-core        |   |     External Tools         |
|    (Python Server)    |   | (GitHub, SearXNG, Playwright)|
+----------+------------+   +-----------------------------+
            |
            v
+-----------------------+
|  PostgreSQL / pgvector|
| (Semantic Storage)    |
+-----------------------+
```

## Plugin Architecture
The Neuralgentics plugin allows the system to integrate deeply with OpenCode's execution loop while remaining logically decoupled from the core application.

### Integration and Registration
The plugin resides at `packages/plugin/` and is officially registered in the `.opencode/opencode.json` configuration file under the `"plugin"` array. This registration informs OpenCode how to load and initialize the Neuralgentics logic.

### Event Hooks
The plugin hooks into the OpenCode event system to perform specific operations at critical stages of the agent lifecycle:
- **Compaction Backup**: Automatically triggers a snapshot of memory before consolidation sequences.
- **Tool Execution Logging**: Intercepts tool output to log execution context and results back to `memini-core`.

### MemoryAdapter
To bridge the TypeScript plugin and the Python backend, Neuralgentics uses a `MemoryAdapter`. This adapter handles the translation between the plugin's internal types and the **HTTP JSON** API provided by `memini-core` (running on port 8900). This avoids the complexity of the MCP protocol for internal memory operations.

## Data Flow
1. **Request**: User input is received by the TUI.
2. **Contextualization**: The Orchestrator calls `memini-core` via the Native Bridge to retrieve relevant semantic memories.
3. **Reasoning**: The Protocol Advisor ensures the 8-step sequence is followed.
4. **Execution**:
   - If the task requires core logic, the Plugin executes TS code.
   - If the task requires external tools, the MCP Broker routes the request.
5. **Persistence**: Results and new insights are asynchronously pushed back to `memini-core` and stored in PostgreSQL.

## Key Design Decisions
- **Hybrid Stack**: TypeScript provides the best ecosystem for the UI and plugin architecture; Python provides the best ecosystem for vector databases and LLM data processing.
- **Bypassing MCP for Memory**: Memory operations are too frequent for the MCP request/response cycle. A direct HTTP bridge reduces latency.
- **Trust-Weighted Memory**: Not all memories are equal. The system tracks trust scores to filter "hallucinated" or outdated information during context injection.
