# Memory System

Neuralgentics does not use a simple "vector search" for context. It implements a **Trust-Weighted Semantic Memory** system that separates raw data from verified patterns.

## 📈 The Trust Engine

Unlike standard RAG, which treats every retrieved chunk as equally valid, Neuralgentics tracks the *reliability* of memories.

```text
   RAW MEMORY
       │
       ▼
 ╔══════════════════╗
 ║  INITIAL TRUST   ║ ◄── All new memories start at 0.5
 ╚══════════════════╝
       │
       ▼
 ╔══════════════════╗       ▲ [ +0.05 ]  Agent successfully used memory
 ║  SIGNAL ENGINE   ║ ◄─────┤ [ +0.10 ]  User explicitly confirmed
 ╚══════════════════╝       ▼ [ -0.05 ]  Agent ignored the memory
                            ▼ [ -0.10 ]  User corrected the memory
       │
       ▼
 ╔══════════════════╗
 ║   DECAY ENGINE    ║ ◄── Trust slowly fades if never used
 ╚══════════════════╝
       │
       ▼
 [ ARCHIVE / PURGE ]  ◄── Trust < 0.3
```
> **Diagram 6 — Trust Scoring Pipeline.** Every piece of information is a "hypothesis" until proven useful. Trust signals enable the system to remember *how* to solve a problem (high trust) while ignoring failed attempts from previous sessions.

---

## 층 Tiered Memory Loading

To prevent context window saturation, Neuralgentics loads memory in three distinct tiers:

```text
    SESSION START
          │
          ▼
 ╔══════════════════════════════════════════╗
 ║ TIER 0: GLOBAL SUMMARY (~100 tokens)     ║ ◄── high-trust project context
 ╚══════════════════════════════════════════╝
          │
          ▼
 ╔══════════════════════════════════════════╗
 ║ TIER 1: KEY DECISIONS (~2K tokens)       ║ ◄── trust ≥ 0.8; laws/rules
 ╚══════════════════════════════════════════╝
          │
          ▼
 ╔══════════════════════════════════════════╗
 ║ TIER 2: FULL SEMANTIC SEARCH             ║ ◄── L2 full-vector retrieval
 ╚══════════════════════════════════════════╝
```
> **Diagram 7 — Tiered Memory Loading.** This pyramid ensures the agent always knows the overall goal (L0) and the golden rules (L1) before diving into the specific technical details of a file (L2).

---

## 🕸️ Knowledge Graph (KG)

Beyond vectors, Neuralgentics tracks relationships between entities (Projects, Files, Agents, Skills).

```text
   ┌──────────┐                      ┌──────────┐
   │ PROJECT  │ ────── RELATED ──────► │   AGENT  │
   └──────────┘                      └──────────┘
         │                                  │
         │ SUPERSEDES                       │ DERIVED_FROM
         ▼                                  ▼
   ┌──────────┐                      ┌──────────┐
   │ MEMORY A │ ◄── CONTRADICTS ──── │  MEMORY B │
   └──────────┘                      └──────────┘
```
> **Diagram 12 — Knowledge Graph Entity Model.** The KG allows the system to handle contradictions. If Memory B is marked as `SUPERSEDES` Memory A, the orchestrator will ignore A even if its vector similarity is higher.

### Relationship Types
| Type | Description |
| :--- | :--- |
| `SUPERSEDES` | Replace an old decision with a new one. |
| `PARTIAL_UPDATE`| Add context to an existing memory. |
| `RELATED_TO` | Semantic connection without hierarchy. |
| `CONTRADICTS` | Explicit conflict (triggering a dialectic resolution). |
| `DERIVED_FROM` | A memory based on another (e.g., summary $\rightarrow$ detail). |
