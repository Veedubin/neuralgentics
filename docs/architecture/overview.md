# System Overview

Neuralgentics is not a single application, but a coordinated runtime of three primary layers: the **Interface (OpenCode)**, the **Gatekeeper (Broker)**, and the **Brain (Memini-AI)**.

## 🏗️ High-Level Architecture

```text
       USER / DEVELOPER
              │
              ▼
      ╔══════════════════╗
      ║  OPENCODE PLUGIN ║ ◄── TUI, Kanban, Orchestrator
      ╚══════════════════╝
              │
              │ JSON-RPC (stdio)
              ▼
      ╔══════════════════╗    MCP Boundary
      ║   MCP BROKER     ║ ──────────────────► [ EXT. MCP SERVERS ]
      ╚══════════════════╝                         (GitHub, Web, etc.)
              │
              │ HTTP/REST
              ▼
      ╔══════════════════╗
      ║   MEMINI-AI      ║ ◄── Trust-Weighted Memory Engine
      ╚══════════════════╝
              │
              ▼
      ╔══════════════════╗
      ║   POSTGRESQL     ║ ◄── pgvector, KG Entities
      ╚══════════════════╝
```
> **Diagram 1 — System Architecture.** The flow travels from the User through the OpenCode plugin. The Orchestrator manages the session logic, while the MCP Broker acts as a security and token-reduction gate for all external tool calls. The Memini-AI server handles the semantic "long-term" memory, backed by a vector-enabled PostgreSQL database.

---

## 🧩 Component breakdown

### 1. The Interface (OpenCode Plugin)
The plugin integrates Neuralgentics into the IDE. Its primary responsibility is **Orchestration**. It decomposes user prompts into a graph of tasks and assigns them to specific agents using a routing matrix.

### 2. The Broker (Go Backend)
The Broker is the most critical security component. It implements **Role-Based Access Control (RBAC)**. 
- **Token Reduction:** Instead of sending a 100-tool catalog to every agent, the Broker filters the catalog based on the agent's role.
- **Intent Matching:** Uses Jaccard similarity to map agent intents to the most relevant tools.

### 3. The Brain (Memini-AI)
Memini-AI is a semantic memory server. Unlike standard RAG, it uses a **Trust Engine**:
- Every memory begins with a trust score of $0.5$.
- Successful tool usage increases trust ($+0.05$).
- User corrections decrease trust ($-0.10$).
- This allows the orchestrator to prioritize "highly trusted" patterns over noisy ones.

---

## 🛠️ Tech Stack

| Component | Language | Key Technologies |
| :--- | :--- | :--- |
| **Backend/Broker** | Go | JSON-RPC, stdio, pgvector |
| **Memory Server** | Python | FastAPI, pgvector, Sentence-Transformers |
| **UI Overlay** | TypeScript | OpenCode Plugin API, React |
| **Database** | SQL | PostgreSQL 16+ |
