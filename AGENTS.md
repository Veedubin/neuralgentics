# Neuralgentics Agents

## Memory
Memory management is automatic. The orchestrator queries `memini-core` and injects the necessary context into agent prompts. Agents should never call memory tools directly; rely on the provided context.

## Routing
Agents must state their intent clearly in their thought process. The orchestrator routes tasks to specific specialists based on the internal Routing Matrix.

## External Tools
For web research, GitHub operations, or other external integrations, describe the required capability. The MCP Broker will provision the relevant tools for the session.

## Quality Gates
All code changes must pass the automatic quality gate before being marked as complete:
**Lint** $\rightarrow$ **Typecheck** $\rightarrow$ **Test**

## Protocol
All tasks must follow the 8-step Boomerang Protocol, enforced by the orchestrator:
1. Memory Query
2. Thought Chain
3. Planning
4. Delegation
5. Git Check
6. Quality Gates
7. Doc Update
8. Memory Save

## Agent Roster

| Role | Model | Purpose |
| :--- | :--- | :--- |
| Orchestrator | Primary | Task decomposition, routing, and protocol enforcement |
| Architect | Primary | System design, trade-off analysis, and research |
| Coder | Secondary | High-speed implementation and bug fixing |
| Reviewer | Primary | Code quality, security audit, and logic verification |
| Explorer | Secondary | File finding and codebase mapping |
| Tester | Secondary | Unit, integration, and E2E test generation |
