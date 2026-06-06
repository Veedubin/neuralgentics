# Session Lifecycle

A Neuralgentics session is not a stream of chat messages; it is a strict sequence of states. Every single task MUST follow the **9-Step Mandatory Protocol**.

## ⚙️ The Protocol State Machine

The Protocol Advisor enforces these transitions. Any attempt to skip a step (without a valid waiver) will block execution.

```text
   IDLE
     │
     ▼
 ╔══════════════════╗
 ║  MEMORY_QUERY    ║ ◄── Fetch L0/L1 Context
 ╚══════════════════╝
     │
     ▼
 ╔══════════════════╗
 ║  THOUGHT_CHAIN   ║ ◄── Reason through the goal
 ╚══════════════════╝
     │
     ▼
 ╔══════════════════╗
 ║      PLAN        ║ ◄── Implementation roadmap
 ╚══════════════════╝
     │
     ▼
 ╔══════════════════╗
 ║    DELEGATE      ║ ◄── Route to Specialist
 ╚══════════════════╝
     │
     ▼
 ╔══════════════════╗
 ║    GIT_CHECK     ║ ◄── Verify clean working tree
 ╚══════════════════╝
     │
     ▼
  ╔══════════════════╗
  ║  QUALITY_GATES  ║ ◄── Lint $\rightarrow$ Typecheck $\rightarrow$ Test
  ╚══════════════════╝
      │
      ▼
  ╔══════════════════╗
  ║     IMPROVE      ║ ◄── Extract patterns, bump trust
  ╚══════════════════╝
      │
      ▼
  ╔══════════════════╗
  ║   DOC_UPDATE     ║ ◄── Update TASKS.md / AGENTS.md
  ╚══════════════════╝
     │
     ▼
 ╔══════════════════╗
 ║   MEMORY_SAVE    ║ ◄── Store wrap-up in Memini
 ╚══════════════════╝
     │
     ▼
   COMPLETE
```
> **Diagram 9 — 9-Step Protocol State Machine.** This state machine is a hard requirement for all agents. It ensures that no code is written before the plan is approved, no patterns are committed to shared memory before quality gates pass, and no task is marked "done" before documents are updated and memory is saved.

---

## ⏳ Session Timeline

A typical feature implementation unfolds over a coordinated timeline:

```text
  T+00:00  [ USER ] ───────► Prompt: "Implement OAuth2 Flow"
             │
             ▼
  T+00:05  [ ORCH ] ───────► Load L0 Summary $\rightarrow$ Start Thought Chain
             │
             ▼
  T+00:20  [ ARCH ] ───────► Create Design Doc $\rightarrow$ Seed Kanban
             │
             ▼
  T+01:00  [ CODER ] ──────► Fetch Context $\rightarrow$ Implement $\rightarrow$ Git Check
             │
             ▼
  T+02:00  [ TESTER ] ──────► Write Integration Tests $\rightarrow$ Run Gates
             │
             ▼
  T+03:00  [ WRITER ] ──────► Update API Reference $\rightarrow$ Doc Update
             │
             ▼
  T+03:30  [ ORCH ] ───────► Memory Save (Wrap-up) $\rightarrow$ Session End
```
> **Diagram 11 — Session Lifecycle Timeline.** The timeline illustrates the hand-off between specialists. Note how the `writer` is the final agent in the chain, ensuring the documentation is always in sync with the implemented code.

---

## Why IMPROVE (Step 7)

The IMPROVE step enforces **execution/learning separation**: workers (dispatched sub-agents) never write to shared memory during execution; only the IMPROVE phase writes. After quality gates pass, the orchestrator analyzes the outcomes of the completed work and extracts patterns, anti-patterns, and architecture decisions into shared memory.

This ensures shared knowledge reflects **verified outcomes**, not speculative predictions made before quality gates pass.

The IMPROVE phase uses these tools:
- `memory.triggerExtraction` — Extract structured entities and relationships from completed work.
- `memory.getTier1Summary` — Promote high-value decisions to the L1 key-decisions tier.
- `memory.getRelationshipSummary` — Link new memories to existing ones via relationships.
- `memory.adjustTrust` — Bump trust for proven memories (`agent_used` +0.05), correct flawed ones (`user_corrected` -0.10).

## 🔑 Protocol Waivers

While the protocol is mandatory, certain "escape hatches" exist for trivial tasks:

- `skip planning`: Use for simple edits (<20 lines).
- `just do it`: Immediate execution (dangerous).
- `skip tests`: Use only for non-functional documentation updates.
- `git is fine`: Skip the working tree check.
- `no docs needed`: Use for internal debugging a-priority tasks.
