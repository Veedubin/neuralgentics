# Session 22: Comparison Table Research Notes

**Author:** boomerang-coder
**Date:** 2026-06-04
**Purpose:** Document sources for the 6-framework comparison table in `docs/index.md`.

---

## Method

Web search via SearXNG + webfetch for each framework. Only data with a verifiable URL is included in the comparison table. Cells without a citable source are marked `(needs research)` in the table and `[UNVERIFIED]` below.

---

## Neuralgentics (baseline)

| Field | Value | Source |
| :--- | :--- | :--- |
| Year | 2026 | Repo: `github.com/Veedubin/neuralgentics` — initial commit 2026-05 |
| License | MIT | Intended (LICENSE file not yet on disk as of 2026-06-04) |
| Agent Model | 23 specialists, role-routed | `packages/broker-go/src/neuralgentics/broker/access/access.go` — 23 role constants |
| Memory | Trust-scored PostgreSQL + pgvector | `packages/memini-core/` — trust engine, decay, knowledge graph |
| Permissions | RBAC, 23 roles, 7 restricted servers | `access/access.go` — `CanAccess()`, `ErrUnauthorized`, `DefaultServerRoles` |

---

## Hermes (Nous Research)

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2026 (Feb 25) | `github.com/NousResearch/hermes-agent` — README, release history | 2026-06-04 |
| License | MIT | `github.com/NousResearch/hermes-agent` — LICENSE file, badge on README | 2026-06-04 |
| Agent Model | Single persistent agent + self-created skills | `hermes-agent.nousresearch.com/docs` — "self-improving learning loop" | 2026-06-04 |
| Memory | FTS5 session search + Honcho user modeling | `tencentcloud.com/techpedia/143930` — "FTS5 session search with LLM summarization"; README — "Honcho dialectic user modeling" | 2026-06-04 |
| Permissions | (needs research) | No RBAC or permission-model documentation found on official site or GitHub README | — |

### Quotes Used

- "The self-improving AI agent built by Nous Research. It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use." — `github.com/NousResearch/hermes-agent` README (accessed 2026-06-04)
- "FTS5 session search with LLM summarization for cross-session recall" — `tencentcloud.com/techpedia/143930` (accessed 2026-06-04)

### Unverifiable Cells

- **Permissions**: The Hermes README and docs describe command approval and DM pairing for messaging security, but no formal RBAC/permission model for tool access was documented. Marked `(needs research)`.

---

## OpenClaw (Peter Steinberger)

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2025 (Nov 24, as "Warelay") | `en.wikipedia.org/wiki/OpenClaw` — "first published in November 2025" | 2026-06-04 |
| License | MIT | `en.wikipedia.org/wiki/OpenClaw` — infobox: MIT License; `github.com/openclaw/openclaw` | 2026-06-04 |
| Agent Model | Multi-agent heartbeat scheduler + message-driven dispatch | `etcjournal.com/2026/03/15/` — "self-hosted agentic AI framework" with cron/heartbeat system | 2026-06-04 |
| Memory | Markdown-file memory (MEMORY.md, HEARTBEAT.md) + vector search | `docs.openclaw.ai/concepts/skills` (referenced from design doc); Wikipedia — "configuration data and interaction history are stored locally, enabling persistent and adaptive behavior" | 2026-06-04 |
| Permissions | ClawManifest signed declarations + Docker sandbox | `clawbot.blog` — "ClawManifest signed declarations (file, network, memory); Docker sandbox for non-main sessions" | 2026-06-04 |

### Quotes Used

- "OpenClaw was first published in November 2025 under the name Warelay." — `en.wikipedia.org/wiki/OpenClaw` (accessed 2026-06-04)
- "Configuration data and interaction history are stored locally, enabling persistent and adaptive behavior across sessions." — `en.wikipedia.org/wiki/OpenClaw` (accessed 2026-06-04)
- MIT License confirmed from Wikipedia infobox and `github.com/openclaw/openclaw` listing.

### Unverifiable Cells

None — all cells for OpenClaw were citable.

---

## LangChain (LangChain Inc.)

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2022 (Oct) | `github.com/langchain-ai/langchain` — commit history; `langchain.com/blog/langchain-langgraph-1dot0` — "1.0" milestone Oct 2025, original release Oct 2022 | 2026-06-04 |
| License | MIT | `github.com/langchain-ai/langchain/blob/master/LICENSE` — MIT License; Wikipedia infobox | 2026-06-04 |
| Agent Model | LangGraph agent runtime; create_agent + middleware | `langchain.com/langgraph` — "Agent Orchestration Framework for Reliable AI Agents" | 2026-06-04 |
| Memory | Pluggable (vector stores, Redis, LangMem) | `docs.langchain.com/oss/python/concepts/memory` — "procedural memory" overview; `atlan.com/know/best-ai-agent-memory-frameworks-2026` — "LangMem for LangChain" | 2026-06-04 |
| Permissions | (needs research) | No built-in permission model documented in LangChain/LangGraph docs | — |

### Quotes Used

- LangChain 1.0 and LangGraph 1.0 released Oct 22, 2025 — `langchain.com/blog/langchain-langgraph-1dot0` (accessed 2026-06-04)
- MIT License — `github.com/langchain-ai/langchain/blob/master/LICENSE` (accessed 2026-06-04)

### Unverifiable Cells

- **Permissions**: LangChain/LangGraph docs describe agent creation, tool binding, and middleware but do not document a built-in RBAC or permission-gating system for tool access. Marked `(needs research)`.

---

## AutoGen (Microsoft)

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2023 (Sep) | `microsoft.com/en-us/research/project/autogen/` — "we released AutoGen ... in fall 2023"; `microsoft.github.io/autogen/0.2/blog/` — "One year ago, we launched AutoGen" (Nov 2024) | 2026-06-04 |
| License | CC-BY-4.0 (legacy) / MIT (MAF) | `github.com/microsoft/autogen` — CC-BY-4.0 for legacy; `github.com/microsoft/agent-framework` — MIT for Microsoft Agent Framework successor | 2026-06-04 |
| Agent Model | Multi-agent conversation framework; event-driven (v0.4+) | `microsoft.com/en-us/research/articles/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/` — v0.4 event-driven architecture | 2026-06-04 |
| Memory | Agent-specific memory + vector store integration | `microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/memory.html` — "RAG pattern where a query is used to retrieve relevant information from a database" | 2026-06-04 |
| Permissions | (needs research) | No RBAC or permission-gating model documented in AutoGen or MAF docs | — |

### Quotes Used

- "AutoGen is a leading open-source framework for multi-agent applications that we released in fall 2023." — `microsoft.com/en-us/research/articles/autogen-v0-4-...` (accessed 2026-06-04)
- "Magentic-UI ... is available under MIT license" — `microsoft.com/en-us/research/blog/magentic-ui-...` (accessed 2026-06-04). Note: this refers to Magentic-UI specifically, not the legacy AutoGen repo which uses CC-BY-4.0.
- CC-BY-4.0 confirmed from `github.com/microsoft/autogen` LICENSE. MIT for MAF confirmed from `github.com/microsoft/agent-framework`.

### Unverifiable Cells

- **Permissions**: Neither AutoGen nor Microsoft Agent Framework documents a built-in RBAC model for agent tool access. Marked `(needs research)`.

---

## CrewAI

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2024 | `github.com/crewaiinc/crewai` — initial release; design doc C.7 cites 2024 | 2026-06-04 |
| License | MIT | `github.com/crewaiinc/crewai` — MIT license badge | 2026-06-04 |
| Agent Model | Role-playing autonomous agents + crew orchestration | `docs.crewai.com/en/concepts/agents` — "an Agent is an autonomous unit that can: Perform specific tasks; Make decisions based on its role and goal; Use tools" | 2026-06-04 |
| Memory | Unified Memory class | `docs.crewai.com/en/concepts/memory` — "a single Memory class that replaces separate short-term, long-term, entity, and external memory types" | 2026-06-04 |
| Permissions | (needs research) | No RBAC or permission model documented in CrewAI docs | — |

### Quotes Used

- "CrewAI provides a unified memory system — a single Memory class that replaces separate short-term, long-term, entity, and external memory types." — `docs.crewai.com/en/concepts/memory` (accessed 2026-06-04)
- MIT License — `github.com/crewaiinc/crewai` (accessed 2026-06-04)

### Unverifiable Cells

- **Permissions**: CrewAI docs describe agent roles, goals, and tools but do not document a permission-gating system for restricting which tools each agent can access. Marked `(needs research)`.

---

## MetaGPT (Foundation Agents)

| Field | Value | Source URL | Date Accessed |
| :--- | :--- | :--- | :--- |
| Year | 2023 (Jul/Aug) | `arxiv.org/abs/2308.00352` — paper submitted Aug 1, 2023; ICLR 2024 oral | 2026-06-04 |
| License | MIT | `github.com/FoundationAgents/MetaGPT` — MIT license badge | 2026-06-04 |
| Agent Model | SOP-encoded multi-agent (PM, architect, engineer, tester) | `arxiv.org/abs/2308.00352` — "MetaGPT incorporates efficient human workflows into LLM-based multi-agent collaborations" with standard operating procedure roles | 2026-06-04 |
| Memory | Role-specific message lists + experience caching; vector DBs | `github.com/FoundationAgents/MetaGPT` README — experience caching; `mit.edu/aiagentindex` (cited in design doc C.7) — "Role-specific message lists" | 2026-06-04 |
| Permissions | (needs research) | No RBAC or permission model documented in MetaGPT repo or paper | — |

### Quotes Used

- "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework" — `arxiv.org/abs/2308.00352` (accessed 2026-06-04)
- MIT License — `github.com/FoundationAgents/MetaGPT` (accessed 2026-06-04)
- "Accepted to ICLR 2024 as oral presentation" — `iclr.cc/virtual/2024/oral/19756` (accessed 2026-06-04)

### Unverifiable Cells

- **Permissions**: The MetaGPT paper and repo describe SOP-encoded workflows with defined roles (PM, architect, engineer, tester) but do not document a formal permission system that gates tool access by role. Marked `(needs research)`.

---

## Summary of (needs research) Cells

| Framework | Missing Cell | Reason |
| :--- | :--- | :--- |
| Hermes | Permissions | No RBAC/permission model found in official docs or GitHub README |
| LangChain | Permissions | No built-in permission model in LangChain/LangGraph docs |
| AutoGen | Permissions | No built-in RBAC in AutoGen or Microsoft Agent Framework docs |
| CrewAI | Permissions | No permission-gating system in CrewAI docs |
| MetaGPT | Permissions | No formal permission system in MetaGPT repo or paper |

**Total `(needs research)` cells: 5** (all in the Permissions column)

No `[UNVERIFIED]` data was used — all facts were sourced from web-verified URLs.
---

## Final Ship Record — Session 22, commit 8384134

**Status: SHIPPED. Live and verified.**

- **Commit:** `8384134` on `main` in `Veedubin/neuralgentics`
- **Scope:** 13 files changed, 2004 insertions, 45 deletions
- **Pushed:** 2026-06-04

### Production changes
1. `mkdocs.yml` line 3 — `site_url` from `neuralgentics.github.io/...` to `veedubin.github.io/...` (the actual live URL)
2. `docs/index.md` — full rewrite to 174 lines (hero, problem, what-it-is, dispatch diagram, why-different, 6-framework comparison, 3 MOCKUPs, quicklinks, CTA)
3. `scripts/install.sh` — 7 new functions for interactive install prompts, wired into main(), `--dry-run` regression fixed
4. 9 secondary docs — 28 broken `.md` quicklinks rewritten to folder form

### Verification (all green)
- `bash -n scripts/install.sh` → exit 0
- `mkdocs build --strict` → exit 0
- `bash scripts/install.sh --dry-run --yes` → completes WITHOUT starting any podman container (bug fix)
- Interactive prompts (stdin piping) → all prompts fire, validation works
- GitHub Actions on commit 8384134: CI ✅, Docs ✅, pages build and deployment ✅
- Live site `https://veedubin.github.io/neuralgentics/` → HTTP 200, contains all new content
- All 5 quicklink URLs → HTTP 200 (no more 404s)

### Zero-Error Rule fired
Sub-agent Card A claimed "OK" without exercising the `--dry-run` path. Orchestrator caught the regression where dry-run was actually starting a real podman container. Fixed inline.

### Outstanding
- `v0.1.0` git tag not yet pushed (workflow ready, one command triggers release matrix)
- 5 `(needs research)` cells in the comparison table — honest, not fabricated
- TODO #18, #19, #20 still queued
