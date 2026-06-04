# Welcome to Neuralgentics

Neuralgentics is a high-performance coding-agent runtime designed for professional software engineering. It replaces generic LLM chat interfaces with a structured, role-based orchestration layer that manages memory, permissions, and task execution with surgical precision.

## ⚡ The 30-Second Pitch

Most "AI Agents" fail because they have no memory of past decisions, no concept of role-based authority, and a bloated context window. **Neuralgentics solves this by:**

1.  **Role-Based Routing:** Instead of one "do-it-all" bot, Neuralgentics dispatches tasks to a swarm of specialists (Architecture, Coding, Testing, Git) using a strict routing matrix.
2.  **Trust-Weighted Memory:** A PostgreSQL + pgvector backend that doesn't just store data, but tracks the *trustworthiness* of memories based on agent success/failure.
3.  **Permission-Gated Broker:** An MCP broker that ensures agents only see the tools they are authorized to use, slashing token overhead by up to 95%.
4.  **Stateless execution:** Memory is the absolute source of truth; agents are seeded with IDs and fetch context as needed.

## 🗺️ Navigation Guide

| If you want to... | Go here $\longrightarrow$ |
| :--- | :--- |
| **Get it running on your machine** | [Installation Guide](getting-started/installation.md) |
| **Ship your first feature in 5 min** | [Quickstart Guide](getting-started/quickstart.md) |
| **Understand how the brain works** | [System Overview](architecture/overview.md) |
| **Deep dive into the Memory Engine** | [Memory System Reference](reference/memory-system.md) |
| **Review the 8-step mandatory protocol**| [Session Lifecycle](reference/session-lifecycle.md) |
| **Fix a "Kimi not valid" error** | [Troubleshooting](troubleshooting.md) |

## 🚀 Key Components

- **TUI / OpenCode Plugin:** The human interface and task orchestrator.
- **The Broker (Go):** The gatekeeper for all MCP tool interactions.
- **Memini-AI (Python):** The semantic memory core with trust scoring.
- **PostgreSQL + pgvector:** The durable storage for embeddings and KG entities.

[**Explore the Design Docs $\longrightarrow$**](design/v0.1.0-release-pipeline.md)
