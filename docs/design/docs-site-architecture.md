# Neuralgentics Documentation Site — Design

**Author:** boomerang-architect (deepseek-v4-pro:cloud)
**Date:** 2026-06-04
**Status:** Approved (Session 21)
**Parent:** _(no parent doc; this design stands alone — release pipeline was delivered via `.github/workflows/release.yml` and `scripts/install.sh`)_

---

## 1. Overview

Neuralgentics ships with a real documentation site — not a 35-line README, not a pile
of disconnected `.md` files. The site is built with **mkdocs-material** and deployed
to GitHub Pages via `ghp-import` on every push to `main`.

**Design goals:**

1. Multi-page navigation with sidebar, search, dark mode, code-copy buttons
2. 12 hand-crafted Unicode box-drawing diagrams (NO mermaid)
3. Complete coverage of env vars, inheritance order, and every system flow
4. Source lives in `docs/`; the build artifact `site/` is gitignored
5. Renders locally with `mkdocs serve` and in production at
   <https://neuralgentics.github.io/neuralgentics/>
6. Every page is plain Markdown — no proprietary syntax

**Design anti-goals:**

- No docusaurus, no docsify, no Antora (mkdocs-material picked for best-in-class theme)
- No mermaid in `.md` files (user explicit — Unicode only)
- No multi-version docs (we ship v0.1.0 only; revisit at v0.2.0)
- No external commenting system, no analytics (privacy + simplicity)
- No PDF export (mkdocs-material supports it; we don't enable it)

---

## 2. Tooling

| Tool                | Version  | Purpose                                          |
|---------------------|----------|--------------------------------------------------|
| `mkdocs`            | 1.6+     | Static site generator for Markdown               |
| `mkdocs-material`   | 9.5+     | Material theme, search, code copy, dark mode     |
| `mkdocs-minify-plugin` | 0.8+ | Minifies HTML/CSS/JS for production              |
| `ghp-import`        | 2.1+     | Pushes built site to `gh-pages` branch           |

All installed via `pip install mkdocs mkdocs-material mkdocs-minify-plugin ghp-import`
in the GitHub Actions runner. No `requirements.txt` needed in the repo (the workflow
pins versions in its `pip install` line).

For local preview, developers run `pip install -r docs/requirements.txt && mkdocs serve`
or use the `Makefile` target `make docs-serve` (added by this design).

---

## 3. Repository Layout

```
neuralgentics/
├── mkdocs.yml                       # mkdocs-material config (nav, theme, plugins)
├── docs/                            # source for the docs site (mkdocs input)
│   ├── index.md                     # Home page (replaces old README.md intro)
│   ├── stylesheets/
│   │   └── extra.css                # Custom CSS overrides
│   ├── getting-started/
│   │   ├── installation.md          # Install + upgrade + container
│   │   └── quickstart.md            # 5-minute bootstrap
│   ├── architecture/
│   │   ├── overview.md              # High-level system
│   │   ├── broker-flow.md           # Broker permission gating
│   │   ├── dispatch-flow.md         # Orchestrator → agent dispatch
│   │   └── permission-model.md      # Agent permission matrix
│   ├── reference/
│   │   ├── env-vars.md              # All env vars + inheritance order
│   │   ├── memory-system.md         # Trust, decay, L0/L1/L2, KG
│   │   ├── kanban-system.md         # Card state machine
│   │   └── session-lifecycle.md     # 8-step protocol
│   ├── troubleshooting.md           # Common errors
│   ├── development.md               # Local dev + contributing
│   └── archive/                     # Old v0 docs (already moved)
│       └── v0-pre-docs/
│           ├── ARCHITECTURE.md
│           ├── BROKER.md
│           ├── API_REFERENCE.md
│           └── MIGRATION_GUIDE.md
├── .github/
│   └── workflows/
│       ├── release.yml              # existing — binary releases
│       └── docs.yml                 # NEW — mkdocs build + ghp-import
├── Makefile                         # add `docs-serve`, `docs-build` targets
└── .gitignore                       # add `site/`
```

`docs/design/` (the existing 8 design docs) stays where it is. mkdocs-material
scans the entire `docs/` tree so the design docs are still linked from the nav
under "Design" → each as a sub-page.

---

## 4. Page Inventory

| File                                | Nav Title             | Purpose                                                                |
|-------------------------------------|-----------------------|------------------------------------------------------------------------|
| `index.md`                            | Home                  | Hero, 30-second pitch, link tree to all sections, badges                |
| `getting-started/installation.md`    | Installation          | GH binary install, container install, upgrade paths, WSL/2             |
| `getting-started/quickstart.md`      | Quickstart            | Clone → config → run → verify first dispatch in 5 minutes              |
| `architecture/overview.md`           | System Overview       | Birds-eye architecture + 1 ASCII diagram                               |
| `architecture/broker-flow.md`        | Broker Flow           | Intent → Jaccard → catalog → permission → tool call (diagram 2)        |
| `architecture/dispatch-flow.md`      | Dispatch Flow         | User prompt → decompose → route → context → execute (diagram 3)        |
| `architecture/permission-model.md`   | Permission Model      | 23 roles × 14 MCP servers matrix, wildcard removal rationale           |
| `reference/env-vars.md`              | Environment Variables | All 30 env vars, **inheritance order** (diagram 5)                     |
| `reference/memory-system.md`         | Memory System         | Trust engine (diagram 6), tiered loading (diagram 7), KG (diagram 12)  |
| `reference/kanban-system.md`         | Kanban System         | Card state machine (diagram 8)                                         |
| `reference/session-lifecycle.md`     | Session Lifecycle     | 8-step protocol state machine (diagram 9), session timeline (diagram 11) |
| `troubleshooting.md`                 | Troubleshooting       | Common errors, fixes, debug commands                                   |
| `development.md`                     | Development           | Local dev, test commands, contribution                                 |
| `design/*`                            | Design Docs (8)       | Existing v4 designs, release pipeline, broker wave 2, etc.             |

**Total: 13 brand-new pages + 8 existing design docs surfaced in nav.**

---

## 5. Diagram Inventory (12 ASCII Diagrams)

All diagrams are fenced ` ```text ` blocks. NO mermaid. All use Unicode
box-drawing characters (`╔═╗║╚╝╠╣╦╩╬ ┌─┐│└┘├┤┬┴┼ ▼ ▲ ► ◄ ──>`). Renders
identically on GitHub, mkdocs-material, VS Code, fish terminal, and any
modern monospace font.

| #   | Diagram                         | Lives in                          | Shows                                                                                                                          |
|-----|---------------------------------|-----------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| 1   | **System Architecture**         | `architecture/overview.md`        | Go backend ↔ Python memoryManager ↔ PostgreSQL/pgvector; MCP boundary; TS plugin in OpenCode; broker as the gate                  |
| 2   | **Broker Permission Gating**    | `architecture/broker-flow.md`     | Agent request → role check → catalog filter → Jaccard intent match → expand server → permission recheck → JSON-RPC call → reply  |
| 3   | **Orchestrator Dispatch Pipeline** | `architecture/dispatch-flow.md` | User prompt → orchestrator thought chain → task decomposition → routing matrix lookup → context package build → Task() → agent   |
| 4   | **Permission Matrix Heatmap**   | `architecture/permission-model.md` | Table-form diagram: 8 agent roles (rows) × 14 MCP server categories (columns); cells = allow/deny                              |
| 5   | **Env Var Inheritance Chain**   | `reference/env-vars.md`           | System env (lowest) → shell rc → `.env` file → `direnv` → wrapper script → CLI flag (highest)                                  |
| 6   | **Trust Scoring Pipeline**      | `reference/memory-system.md`      | Memory add (trust=0.5) → signals (agent_used +0.05, user_confirmed +0.10, agent_ignored −0.05, user_corrected −0.10) → decay     |
| 7   | **Tiered Memory Loading**       | `reference/memory-system.md`      | Session start → L0 (~100 tok, trust≥0.5) → planning → L1 (~2K tok, trust≥0.8) → deep research → L2 (full)                       |
| 8   | **Kanban State Machine**        | `reference/kanban-system.md`      | Card FSM: `triage → todo → ready → running ↔ blocked → done → archived` with allowed transitions and gate events               |
| 9   | **8-Step Protocol State Machine** | `reference/session-lifecycle.md` | `IDLE → MEMORY_QUERY → THOUGHT_CHAIN → PLAN → DELEGATE → GIT_CHECK → QUALITY_GATES → DOC_UPDATE → MEMORY_SAVE → COMPLETE`       |
| 10  | **Install Flow Decision Tree**  | `getting-started/installation.md` | Decision: fresh install vs upgrade? → binary download OR podman-compose OR build from source → verify ping                      |
| 11  | **Session Lifecycle Timeline**  | `reference/session-lifecycle.md`  | Vertical timeline: 00:00 prompt arrives → orchestrator loads L0 → dispatch loop → quality gates → handoff → memory save → end   |
| 12  | **Knowledge Graph Entity Model** | `reference/memory-system.md`     | Entities (Memory, Project, Agent, Skill) → edges (SUPERSEDES, PARTIAL_UPDATE, RELATED_TO, CONTRADICTS, DERIVED_FROM)            |

Each diagram has a **1-paragraph caption** explaining what the user should look at
and what it means in practice. Diagrams are not decorative — they're operational
documentation the user can use to verify behavior.

---

## 6. mkdocs.yml Configuration

```yaml
site_name: Neuralgentics
site_description: Agentic coding orchestration with a trust-weighted memory engine
site_url: https://neuralgentics.github.io/neuralgentics/
repo_url: https://github.com/Veedubin/neuralgentics
repo_name: Veedubin/neuralgentics
edit_uri: edit/main/docs/

theme:
  name: material
  features:
    - navigation.tabs
    - navigation.tabs.sticky
    - navigation.sections
    - navigation.indexes
    - navigation.top
    - search.suggest
    - search.highlight
    - search.share
    - content.code.copy
    - content.code.annotate
    - content.tabs.link
    - content.tooltips
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: green
      accent: lime
      toggle:
        icon: material/weather-night
        name: Switch to dark mode
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: green
      accent: lime
      toggle:
        icon: material/weather-sunny
        name: Switch to light mode
  font:
    text: Inter
    code: JetBrains Mono
  icon:
    repo: fontawesome/brands/github

plugins:
  - search
  - minify:
      minify_html: true
      minify_js: true
      minify_css: true
      htmlmin_opts:
        remove_comments: true

markdown_extensions:
  - admonition
  - attr_list
  - def_list
  - footnotes
  - md_in_html
  - tables
  - toc:
      permalink: true
  - pymdownx.details
  - pymdownx.highlight:
      anchor_linenums: true
      line_spans: __span
      pygments_lang_class: true
  - pymdownx.inlinehilite
  - pymdownx.snippets
  - pymdownx.superfences
  - pymdownx.tabbed:
      alternate_style: true
  - pymdownx.tasklist:
      custom_checkbox: true
  - pymdownx.tilde
  - pymdownx.caret
  - pymdownx.keys
  - pymdownx.mark
  - pymdownx.smartsymbols

nav:
  - Home: index.md
  - Getting Started:
      - Installation: getting-started/installation.md
      - Quickstart: getting-started/quickstart.md
  - Architecture:
      - System Overview: architecture/overview.md
      - Broker Flow: architecture/broker-flow.md
      - Dispatch Flow: architecture/dispatch-flow.md
      - Permission Model: architecture/permission-model.md
  - Reference:
      - Environment Variables: reference/env-vars.md
      - Memory System: reference/memory-system.md
      - Kanban System: reference/kanban-system.md
      - Session Lifecycle: reference/session-lifecycle.md
  - Troubleshooting: troubleshooting.md
  - Development: development.md
  - Design:
      - v4 Roll Your Own App: design/v4-roll-your-own-app-FINAL.md
      - v0.1.0 Release Pipeline: design/v0.1.0-release-pipeline.md
      - Broker Wave 2 Hardening: design/broker-wave2-hardening.md
      - Broker Server Catalog: design/broker-server-catalog-prompting.md
      - Neuralgentics Memory Port v2: design/neuralgentics-memory-port-plan-v2-final.md
      - Plugin/Backend Integration: design/plugin-backend-integration.md
      - Opportunity Detector: design/v4-FINAL-ADDENDUM-opportunity-detector.md
      - Aggregator-Aware Detector: design/v4-FINAL-ADDENDUM-2-aggregator-aware-detector.md
  - Archive:
      - Pre-docs (v0): archive/v0-pre-docs/ARCHITECTURE.md
      - Pre-docs: Broker: archive/v0-pre-docs/BROKER.md
      - Pre-docs: API: archive/v0-pre-docs/API_REFERENCE.md
      - Pre-docs: Migration: archive/v0-pre-docs/MIGRATION_GUIDE.md

extra:
  generator: false
  social:
    - icon: fontawesome/brands/github
      link: https://github.com/Veedubin/neuralgentics
      name: Neuralgentics on GitHub
```

---

## 7. GitHub Actions Workflow (docs.yml)

```yaml
name: Docs

on:
  push:
    branches: [main]
    paths:
      - "docs/**"
      - "mkdocs.yml"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install mkdocs
        run: |
          pip install \
            mkdocs==1.6.1 \
            mkdocs-material==9.5.49 \
            mkdocs-minify-plugin==0.8.0

      - name: Build site
        run: mkdocs build --strict

      - name: Deploy to gh-pages
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git remote set-url origin "https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${{ github.repository }}.git"
          mkdocs gh-deploy --force --clean
```

`mkdocs build --strict` treats warnings as errors so broken links and missing
nav entries fail the build. `mkdocs gh-deploy --force` pushes the built `site/`
folder to the `gh-pages` branch in a single commit.

Once the workflow runs successfully, GitHub Pages is configured at
`Settings → Pages → Source = "Deploy from a branch" → Branch = gh-pages / root`.
This is a one-time manual repo setting; the workflow doesn't touch it.

---

## 8. README.md Updates

The root `README.md` becomes a short pointer to the docs site:

```markdown
# Neuralgentics

> Specialized coding agent built on OpenCode. Trust-weighted memory. Permission-gated MCP.

📖 **Full documentation: <https://neuralgentics.github.io/neuralgentics/>**

## Quick links

- [Installation](https://neuralgentics.github.io/neuralgentics/getting-started/installation/)
- [Quickstart](https://neuralgentics.github.io/neuralgentics/getting-started/quickstart/)
- [Architecture overview](https://neuralgentics.github.io/neuralgentics/architecture/overview/)
- [Environment variables](https://neuralgentics.github.io/neuralgentics/reference/env-vars/)
- [Troubleshooting](https://neuralgentics.github.io/neuralgentics/troubleshooting/)

## 30-second pitch

Neuralgentics is a coding-agent runtime that:

1. **Routes tasks to specialist sub-agents** (coder, architect, tester, ...)
   via a typed routing matrix
2. **Stores everything in a trust-weighted memory engine** (PostgreSQL + pgvector)
3. **Mediates all external tool access through an MCP broker** that enforces
   role-based permissions and reduces tool-catalog tokens by 95%
4. **Speaks MCP to the world** (42 JSON-RPC methods, stdio transport)
5. **Installs in one command** (`./scripts/install.sh`) or one
   `podman-compose up`

HACK THE PLANET. See the [docs](https://neuralgentics.github.io/neuralgentics/)
for everything else.
```

The detailed README content (install, env vars, architecture) is **removed**
from the root and moved into the docs site. The root README is a pointer only.

---

## 9. Implementation Checklist

- [ ] T-041: Archive stale `docs/ARCHITECTURE.md`, `MIGRATION_GUIDE.md`, `API_REFERENCE.md`, `BROKER.md` to `docs/archive/v0-pre-docs/` (DONE this session)
- [ ] T-042: Write `mkdocs.yml` with full nav, theme, plugins (coder, ~30 min)
- [ ] T-043: Write 13 new docs pages (writer, ~5-6 hours)
- [ ] T-044: Create 12 Unicode box-drawing diagrams inline in those pages (writer, ~2-3 hours)
- [ ] T-045: Add `.github/workflows/docs.yml` (coder, ~15 min)
- [ ] T-046: Add `site/` to `.gitignore` (coder, ~1 min)
- [ ] T-047: Update root `README.md` to point at docs site (writer, ~10 min)
- [ ] T-048: Add `make docs-serve`, `make docs-build` targets to `Makefile` (coder, ~5 min)
- [ ] T-049: Local validation — `mkdocs build --strict` passes, `mkdocs serve` renders all pages (boomerang-tester, ~15 min)
- [ ] T-050: Push to `main`, verify GitHub Pages deploys successfully (boomerang-git, ~10 min)
- [ ] T-051: Configure GitHub Pages repo setting (one-time, manual) (user)
- [ ] T-052: Add `docs/requirements.txt` for local dev (coder, ~1 min)
- [ ] T-053: Update `CONTEXT.md`, `TASKS.md`, `HANDOFF.md` to reflect new docs site (orchestrator, ~10 min)

**Total estimated time:** 8-10 hours, mostly the writer agent.

---

## 10. Diagram Style Guide

All diagrams use the same visual language for consistency. The writer agent
**must** follow these rules:

### Box characters

| Use                       | Characters             |
|---------------------------|------------------------|
| Outer box corners         | `╔ ╗ ╚ ╝` (or `┌ ┐ └ ┘` for thin) |
| Horizontal lines          | `═` (or `─` for thin)   |
| Vertical lines            | `║` (or `│` for thin)   |
| Inner T-junctions         | `╠ ╣ ╦ ╩` (or `├ ┤ ┬ ┴`) |
| Cross                     | `╬` (or `┼`)            |

### Arrows

| Direction       | Arrow            |
|-----------------|------------------|
| Right           | `──►`            |
| Left            | `◄──`            |
| Bidirectional   | `◄──►`           |
| Down            | `▼`              |
| Up              | `▲`              |
| Dashed flow     | `─ ─►`           |

### Layout rules

- Diagrams are **never wider than 78 characters** (fits a 80-col terminal with margin)
- **Maximum 6 columns** of boxes; wider flows get split into 2 diagrams
- Every box has a **title** on its top line in CAPS
- Every arrow has a **label** on or above it describing the action
- Every diagram has a **caption paragraph** below it explaining "what to look at"
- Use **consistent padding** (2 spaces inside boxes minimum)

### Example (small)

```
╔═══════════════════╗       ╔═══════════════════╗
║   USER PROMPT     ║ ────► ║   ORCHESTRATOR    ║
╚═══════════════════╝       ╚═══════════════════╝
                                     │
                                     ▼
                            ╔═══════════════════╗
                            ║   TASK DECOMPOSE  ║
                            ╚═══════════════════╝
```

### Example (caption)

> **Diagram 1 — System Architecture.** The user prompt enters the TUI and
> reaches the orchestrator. The orchestrator consults the routing matrix,
> fetches context from memini-core, and dispatches tasks to specialist
> sub-agents. All external tool access flows through the MCP broker;
> memory operations go directly to memini-core over HTTP to avoid MCP
> overhead for hot-path operations.

---

## 11. References

- [mkdocs-material docs](https://squidfunk.github.io/mkdocs-material/)
- [ghp-import](https://github.com/davisp/ghp-import)
- [mkdocs-minify-plugin](https://github.com/byrnereese/mkdocs-minify-plugin)
- [Unicode box-drawing reference](https://en.wikipedia.org/wiki/Box-drawing_character)
- Internal: _(no parent doc; release pipeline is `.github/workflows/release.yml` + `scripts/install.sh`)_
- Internal: [BROKER.md (archived)](../archive/v0-pre-docs/BROKER.md)
- Internal: [ARCHITECTURE.md (archived)](../archive/v0-pre-docs/ARCHITECTURE.md)
