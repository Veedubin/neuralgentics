# Kanban System

Neuralgentics manages work using a durable Kanban board located in `TASKS.md`. This prevents the "forgetting" problem common in long LLM sessions by anchoring progress in a physical file.

## 🔄 Card State Machine

Cards move through a linear pipeline, but the **Circuit Breaker** can force them into `blocked` or `archived` states if they fail repeatedly.

```text
    Triage
       │
       ▼
      Todo
       │
       ▼
     Ready ◄────────────────┐
       │                   │
       ▼                   │ /resume
   Running ◄───────────────┤
       │                   │
       ├───────────────────┘
       │
       ▼
 ╔══════════════════╗
 ║   BLOCKED        ║ ◄── 1st Failure (Circuit Breaker)
 ╚══════════════════╝
       │
       ▼
 ╔══════════════════╗
 ║   DONE           ║ ◄── Quality Gates Passed
 ╚══════════════════════╝
       │
       ▼
 ╔══════════════════╗
 ║   ARCHIVED       ║ ◄── Max Failures Reached / Obsolete
 ╚══════════════════╝
```
> **Diagram 8 — Kanban State Machine.** The state machine is enforced by `circuit-breaker.ts`. A card cannot transition to `done` unless it has passed all quality gates. If a card fails twice (by default), the circuit breaker "trips" and auto-archives the card to prevent token wasting on an unsolvable problem.

---

## 🛡️ The Circuit Breaker

To prevent agents from entering an infinite "retry-fail" loop, every card has a failure counter.

### Failure Logic
1. **First Failure:** The card is moved to `blocked`. The agent must log the error and suggest a fix.
2. **Sequential Failures:** If `failureCount >= failureLimit` (default=2), the card is automatically moved to `archived` with a trigger reason.
3. **Success:** A successful completion resets the failure count to $0$ and moves the card to `done`.

### The `/resume` Command
A user can manually override the circuit breaker by issuing a `/resume` command. This:
- Resets the failure count to $0$.
- Moves the card back to `ready`.
- Allows the orchestrator to attempt the task with a different agent.

---

## 📋 Kanban Status Definitions

| Status | Definition | Gateway to Next State |
| :--- | :--- | :--- |
| `triage` | Initial prompt decomposition. | Orchestrator creates card. |
| `todo` | Validated task, waiting for capacity. | Moved to `ready` when target agent is idle. |
| `ready` | Ready for immediate dispatch. | `Task()` call is executed. |
| `running` | Agent is currently processing. | Logic complete + Gates passed. |
| `blocked` | Failed 1+ times; needs human/agent intervention. | `/resume` or manual fix. |
| `done` | Verified success. | Marked as completed. |
| `archived` | Obsolete or permanently failed. | Removed from active view. |
