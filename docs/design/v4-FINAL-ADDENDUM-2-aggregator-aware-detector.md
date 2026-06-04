# v4-FINAL Addendum #2: Aggregator-Aware Opportunity Detector

**Author:** boomerang-architect (deepseek-v4-pro:cloud)  
**Date:** 2026-06-04  
**Status:** Complete — Addendum #2 to v4-FINAL  
**Task ID:** T-RFC-004-final-addendum-2  

> **Addendum #2 to v4-FINAL.** Extends the Opportunity Detector (addendum 1) with aggregator-aware lookup. Before suggesting "build a new skill," the detector consults mcpservers.org, the official MCP Registry, orchestra-research/AI-research-SKILLs, the Anthropic Skills Hub, npm, PyPI, and our own skills directory. If a match exists, the user gets a 1-line install command instead of a build task. This shifts the detector from "always suggest build" to "first check if someone else has solved this."

**Supersedes:** Nothing — purely additive. All addendum 1 content carries forward unchanged.  
**Builds on:** [v4-FINAL-ADDENDUM-opportunity-detector.md](v4-FINAL-ADDENDUM-opportunity-detector.md) (addendum 1) and [v4-roll-your-own-app-FINAL.md](v4-roll-your-own-app-FINAL.md) (v4-FINAL).

**Reason for this addendum:** User feedback — "We could also try to suggest MCP servers from the aggregator sites. Plus there are skills aggregation sites too." The user correctly observed that many detected patterns have ALREADY been solved by the community. Suggesting "build" when "install" would take minutes is wasteful.

---

## 1. Executive Summary

The addendum 1 Opportunity Detector surfaces patterns (sequential tool chains, repeated calls, high-cost turns, etc.) and suggests "want a skill for this?" Its default answer to every pattern is **build**. Addendum 2 adds a pre-check: before suggesting "build," the detector queries the open web's aggregators — the official MCP Registry, mcpservers.org, Orchestra Research's 98-skill library, the Anthropic Skills Hub, npm, PyPI, and our own internal skills — to find **existing solutions**. If a match exists, the user receives a 1-line install command (e.g., `npx @context7/mcp` or `npx @orchestra-research/ai-research-skills install litgpt`) instead of a multi-hour build task. If no match exists, the detector falls back to addendum 1's "build" suggestion. This transforms the detector from a **builder** (always suggests creation) into a **librarian** (first checks the catalog, builds only as a last resort). The user gets:

- **Faster value** — install takes minutes vs. hours/days for build
- **Battle-tested code** — community skills with 9.3k stars > our 1-day build
- **Lower token cost** — no development time, no learning curve
- **Exponential skill library** — 98 orchestra skills + hundreds of MCP servers + npm/pypi packages = essentially unlimited

---

## 2. Aggregator Catalog

The detector consults 7 aggregators organized by trust tier and category. Each aggregator has a defined lookup method, result schema, per-lookup cost, freshness window, and trust tier.

### 2.1 Active Aggregators (Consulted on Every Detection)

| # | Aggregator | Category | Lookup Method | Result Schema | Per-Lookup Cost | Freshness | Trust Tier |
|---|-----------|----------|---------------|---------------|----------------|-----------|------------|
| **1** | **Official MCP Registry** | MCP servers | REST API: `GET registry.modelcontextprotocol.io/v0.1/servers?search=<query>` | `{ name, description, version, status, publisher, install_command }` | ~200 tokens | Real-time | **Tier 1** — Official, authenticated namespaces, Linux Foundation-hosted |
| **2** | **mcpservers.org** | MCP servers | Web scrape (no public API). Scrape category pages + search results | `{ name, description, category, install_command, stars }` | ~500 tokens per page | Community-updated (hours) | **Tier 2** — Largest community catalog, but no authentication/vetting |
| **3** | **Orchestra Research AI-Research-SKILLs** | Skills | GitHub API: fetch CLAUDE.md for skill tree, read individual SKILL.md files | `{ name, category, description, install_command, star_count, license }` | ~200 tokens for tree fetch | GitHub release-based (weeks) | **Tier 1** — Curated, MIT, 9.3k stars, auto-detects OpenCode |
| **4** | **Anthropic Skills Hub** | Skills | GitHub API: search repos with `topic:claude-skills` or `topic:agent-skills`. Official repo: `anthropics/skills` | `{ name, description, install_command, official (bool), source_repo }` | ~300 tokens for search + manifest | GitHub activity (hours-days) | **Tier 1** (official) / **Tier 2** (community) — Official plugins are curated; community SKILL.md repos are unvetted |
| **5** | **npm Registry** | Packages | REST API: `registry.npmjs.org/-/v1/search?text=<query>&size=5` | `{ name, description, version, weekly_downloads, keywords }` | ~100 tokens | Real-time | **Tier 2** — Verified packages, but spam exists. Filter by downloads > 1,000/week |
| **6** | **PyPI** | Packages | JSON API: `pypi.org/pypi/<package>/json` or search via `pypi.org/simple/` | `{ name, summary, version, keywords }` | ~100 tokens | Real-time | **Tier 2** — Standard Python index. Filter by recent releases |
| **7** | **Internal Skills Directory** | Skills | Local filesystem: glob `neuralgentics/.opencode/skills/*/SKILL.md` | `{ name, description, path, category }` | ~0 tokens | Real-time (local) | **Tier 1** — We built them, we trust them |

### 2.2 Backup/Secondary Aggregators (Not in Primary Query, Referenced When Needed)

These are consulted only when the primary 7 return no results, or the user explicitly asks for a broader search:

| Aggregator | Category | Why Secondary |
|-----------|----------|---------------|
| **PulseMCP** (pulsemcp.com) | MCP servers | 16,810+ servers but no search API — scrape-heavy, high latency |
| **Glama** (glama.ai/mcp/servers) | MCP servers | 30,650+ servers but also scrape-dependent |
| **Skills.sh** | Skills | Growing marketplace but young; web-scrape only |
| **SkillHub** (skillhub.club) | Skills | 2,400+ skills, auto-indexes GitHub SKILL.md repos. Good but duplicate of GitHub API search |
| **OpenAI Skills** (github.com/openai/skills) | Skills | Codex-specific; smaller catalog. Lower priority for OpenCode/neuralgentics |
| **pkg.go.dev** (Go packages) | Packages | Relevant only if neuralgentics uses Go packages (Go backend already exists) |
| **crates.io** (Rust packages) | Packages | Relevant only if the pattern involves Rust tooling |

### 2.3 Aggregator Index (Weekly Snapshot)

For the LLM-based lookup (see §4), the detector maintains a **weekly aggregator index** — a flat list of names + one-line descriptions from each aggregator. This index is:

- **Generated** by a weekly cron job (or on `/opportunities --refresh`)
- **Stored** in memini-ai as `type: "aggregator_index"` memories, one per aggregator
- **Cached** per trust tier (§7)
- **Passed as context** to the gemma4:31b lookup call

Example index entry:
```
MCP Registry: 1,247 servers (names + descriptions, ~25K tokens)
Orchestra: 98 skills (names + categories, ~5K tokens)
npm top-500: package names + descriptions for search-relevant keywords (~10K tokens)
```

The index is deliberately a **flat list** — not full documentation. This keeps the lookup context small (~40K tokens for all 7 aggregators) and makes the LLM's job simple: "match this pattern against these names and rank matches."

---

## 3. Updated Detection Flow (4-Tier Candidate Ranking)

### 3.1 The New Flow

The original addendum 1 flow:
```
Detect pattern → Generate candidate spec → Surface with "build this?"
```

The new addendum 2 flow:
```
Detect pattern
  │
  ├─→ Generate search query (LLM, gemma4:31b)
  │     Input: pattern type + description + context
  │     Output: 3-5 natural language search queries
  │     Example: "codebase search with content snippets and line numbers",
  │              "ripgrep wrapper for AI agents",
  │              "file find + grep + read consolidation tool"
  │
  ├─→ Search aggregators (in parallel)
  │     1. Official MCP Registry: REST API call
  │     2. mcpservers.org: web scrape search page
  │     3. Orchestra Research: LLM match against weekly index
  │     4. Anthropic Skills Hub: LLM match against weekly index
  │     5. npm: REST API search
  │     6. PyPI: REST API search
  │     7. Internal Skills: local glob match
  │
  ├─→ Score & rank all results
  │     Score = (name_match * 0.3) + (description_match * 0.4) + (trust_tier * 0.2) + (install_simplicity * 0.1)
  │     Where name_match and description_match are cosine similarity (0-1)
  │
  ├─→ Surface candidates in priority order
  │
  │   Tier 1 — Aggregator Skill/MCP Match (highest priority)
  │   │   "Install `context7/mcp` (MCP Registry, Tier 1 trust).
  │   │    npx -y @context7/mcp
  │   │    Estimated to solve your 'find_files+grep+read 23 times' pattern in 2 minutes instead of 4 hours."
  │   │
  │   Tier 2 — Package Match (npm/PyPI)
  │   │   "Install `ripgrep-tree` from npm (12k weekly downloads, MIT).
  │   │    npm install -g ripgrep-tree
  │   │    Solves your pattern in 5 minutes."
  │   │
  │   Tier 3 — Internal Skill Match
  │   │   "We already have `boomerang-explorer` in our skills.
  │   │    Consider extending it to handle file-content-search in one call."
  │   │
  │   Tier 4 — Build New (fallback)
  │   │   "No match found in any aggregator.
  │   │    Estimated build: 0.5 day. Want to build?"
  │
  └─→ User picks → Auto-draft install command or card
```

### 3.2 The Search Query Generator

The search query is generated by gemma4:31b with a simple prompt:

```
You are a search query generator. Given a detected pattern, generate 3-5 natural language 
search queries that would find existing tools, MCP servers, skills, or packages that solve 
this pattern. Focus on tool names, functionality descriptions.

Pattern: {pattern_type} — {pattern_description}
Context: {context}
Example tools that already exist for other patterns: ripgrep, tree-sitter, firecrawl, 
context7, exa, litgpt, transformer-lens

Output: A JSON array of search queries.
```

This is a ~200-token prompt + ~100-token response. Cost: negligible (~$0.0001).

### 3.3 The Match Scorer

Each result from each aggregator is scored:

```
match_score = (name_similarity * 0.30) 
            + (description_similarity * 0.40) 
            + (trust_tier_score * 0.20) 
            + (install_simplicity * 0.10)

Where:
  name_similarity       = cosine similarity between search query and result name (0-1)
  description_similarity = cosine similarity between search query and result description (0-1)
  trust_tier_score      = 1.0 for Tier 1, 0.7 for Tier 2, 0.4 for Tier 3, 0.2 for Tier 4
  install_simplicity    = 1.0 for "npx -y" or "bun add", 0.7 for "npm install", 0.4 for "go install"
```

Results with `match_score >= 0.7` are shown as Tier 1 candidates. Results with `match_score >= 0.5` are shown as Tier 2. Results with `match_score >= 0.3` are shown as Tier 3. Everything below 0.3 falls to Tier 4 (build new).

### 3.4 User-Facing Output

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 💡 Opportunity Detected: pattern "find_files+grep+read" (23 calls, 18K tokens)
│    Checking aggregators... 7 searched, 3 matches found.
│                                                                           │
│ #1 (Tier 1 ★★★) — CONTEXT7 MCP (Official MCP Registry)                   │
│    "Provides up-to-date documentation and code examples for any library   │
│     directly in your coding agent. Single call: query → docs + snippets." │
│    Install: npx -y @context7/mcp                                         │
│    Trust: Tier 1 (official MCP registry, verified namespace)             │
│    Solves your pattern in ~2 minutes.                                     │
│                                                                           │
│ #2 (Tier 2 ★★☆) — ripgrep-tree (npm, 12k weekly downloads)               │
│    "Tree-sitter powered code search with context snippets."               │
│    Install: npm install -g ripgrep-tree                                   │
│    Trust: Tier 2 (verified npm package, >10k downloads/week)             │
│    Solves your pattern in ~5 minutes.                                     │
│                                                                           │
│ #3 (Tier 4 ☆☆☆) — Build: codebase-search skill                           │
│    "No match found in higher tiers. Estimated build: 0.5 day."           │
│    [Only shown if user explicitly asks for build options]                 │
│                                                                           │
│   [1] Install #1 (Context7 MCP)                                           │
│   [2] Install #2 (ripgrep-tree)                                          │
│   [B] Build #3 (codebase-search skill) — draft T-NNN card                │
│   [N] No, none of these                                                  │
│   [L] Let me think — show full match details for all candidates          │
│   [S] Silence this pattern type for this session                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Lookup Mechanism Decision: Option B (LLM-Based Semantic Search)

### 4.1 The Two Options

| | Option A: TypeScript Aggregator Client | Option B: LLM-Based Semantic Search |
|---|---|---|
| **Approach** | Build a TypeScript module that calls each aggregator's API, parses results, normalizes schemas, and returns a unified list | Pass the pattern + weekly aggregator index to gemma4:31b, have it match and rank results semantically |
| **New code** | ~500 lines of TypeScript (HTTP clients, schema normalization, error handling, rate limiting) | ~100 lines of TypeScript (prompt builder, memini-ai index fetcher, result parser) |
| **New dependencies** | Each aggregator may need its own HTTP client + rate limiter | None — reuses existing gemma4:31b pipeline |
| **One-time setup** | ~3 days to build, test, debug 7 API integrations | ~0.5 day to build index maintenance + prompt |
| **Per-call cost** | ~0 tokens (HTTP calls only), but 7 HTTP round-trips (~2-5s total) | ~200 tokens prompt + ~200 tokens response = ~$0.001 per lookup; 1 LLM call (~1s) |
| **Accuracy** | Exact string matching unless semantic search is built (more code) | Semantic matching by default — "codebase search tool" matches "Context7" even if name is different |
| **Aggregator coverage** | Only works with aggregators that have APIs (excludes mcpservers.org, skills.sh) | Works with ALL aggregators — passes their index context, no API needed |
| **Offline capability** | Fails if API is down | Works with stale index (marked "results may be outdated") |
| **Maintenance** | Each aggregator API change requires code update | Aggregator index is regenerated weekly; prompt handles format changes |
| **Parallelism** | 7 HTTP calls in parallel (fast but brittle) | 1 LLM call (simple, robust) |

### 4.2 Decision: Option B (LLM-Based)

**Chosen: Option B.** Justification:

1. **No new infrastructure** — The gemma4:31b pipeline already exists for compaction extraction (see addendum 1 §4.8). Reusing it for lookup means zero new deployment, zero new monitoring, zero new failure modes.

2. **Aggregator API heterogeneity** — The 7 aggregators use 5 different lookup mechanisms (REST API, web scrape, GitHub API, local filesystem, LLM match). Building a unified client for all of them would be a maintenance nightmare. The LLM-based approach abstracts this away — we pre-build an index and ask an LLM to match against it.

3. **Semantic matching by default** — "find_files+grep+read pattern" won't appear verbatim in any aggregator. The LLM can map it to "codebase search," "context lookup," "documentation retrieval" — concepts that exist in the aggregators. String matching would miss most matches.

4. **Established pattern** — We already use gemma4:31b for compaction extraction (a ~200-token prompt that classifies conversation content). The lookup is the same pattern: small model, small prompt, structured output. Proven, tested, reliable.

5. **Cost is negligible** — ~$0.001 per lookup. At 100 detections per month (generous), that's $0.10/month. This is less than the electricity cost of keeping a TypeScript HTTP client alive.

6. **Offline resilience** — If the aggregators are down, the LLM-based approach still works with the cached weekly index (marked "results from last refresh: 2026-06-01; may be outdated"). A TypeScript client would fail entirely.

### 4.3 The Aggregator Index (Weekly Snapshot)

The index is the key enabler for Option B. It's regenerated weekly:

```
Cron job (or /opportunities --refresh):
  1. Official MCP Registry: curl registry.modelcontextprotocol.io/v0.1/servers?per_page=5000
     Parse: name, description → flat list
  2. mcpservers.org: scrape category pages → name, description, install command
  3. Orchestra Research: fetch CLAUDE.md from GitHub → parse skill tree → name, category, description
  4. Anthropic Skills Hub: search GitHub topics "claude-skills" + "agent-skills" → top-200 repos
  5. npm: registry.npmjs.org/-/v1/search?text=agent+tools&size=500
  6. PyPI: pypi.org/simple/ (top packages via download stats)
  7. Internal: glob .opencode/skills/*/SKILL.md

Output: 7 memini-ai memories, type: "aggregator_index"
  - Each memory is a flat JSON array of { name, description, install, trust_tier } entries
  - Total size across all 7: ~40K tokens (the LLM's context when doing a lookup)
```

The index is **not** the full documentation for each entry — it's a flat list of name + one-line description + install command. This keeps the LLM context small enough for gemma4:31b to process in a single call.

### 4.4 The Lookup Prompt

```
You are an aggregator-aware skill matcher. Given a detected pattern and an aggregator index, 
find the best matching existing tools, MCP servers, skills, or packages.

PATTERN:
  Type: {pattern_type}
  Description: {pattern_description}
  Context: {pattern_context}

AGGREGATOR INDEX (7 sources, ~40K tokens):
  [Index JSON from memini-ai]

TASK:
  1. For each aggregator entry, score how well it matches the pattern (0-1)
  2. Rank all matches by score descending
  3. Return the top 5 matches in JSON format

OUTPUT FORMAT:
{
  "matches": [
    {
      "rank": 1,
      "name": "...",
      "source": "MCP Registry | mcpservers.org | Orchestra | Anthropic | npm | PyPI | Internal",
      "description": "...",
      "install_command": "...",
      "trust_tier": "1 | 2 | 3 | 4",
      "match_score": 0.92,
      "match_rationale": "One sentence: why this matches the pattern"
    }
  ],
  "no_match": true/false,
  "searched": ["MCP Registry", "mcpservers.org", "Orchestra", "Anthropic", "npm", "PyPI", "Internal"],
  "searched_freshness": "2026-06-04"
}
```

### 4.5 Fallback: When the LLM Lookup Fails

If gemma4:31b is unreachable (cloud API down, rate limited, etc.), the detector falls back to:

1. **Local internal skills match** — simple name/description grep against internal skill SKILL.md files
2. **Stale aggregator results** — if we have previous lookup results cached in memini-ai (from the same or similar pattern), show those with a "Cached from {date}" label
3. **Direct Tier 4 fallback** — "Aggregators unreachable. No matches found. Build option only."

---

## 5. Install Command Generation

Once the user selects a tier-1 or tier-2 candidate, the detector auto-generates the exact install command. The detector **suggests** the command — it does NOT auto-install. The user must explicitly approve.

### 5.1 Per-Aggregator Command Templates

| Aggregator / Source | Install Command Template | Example |
|---------------------|------------------------|---------|
| **Official MCP Registry** | Add to `.opencode/opencode.json`: `{"mcpServers": {"<name>": {"command": "npx", "args": ["-y", "<package>"]}}}` | `{"mcpServers": {"context7": {"command": "npx", "args": ["-y", "@context7/mcp"]}}}` |
| **mcpservers.org** | Same as MCP Registry — extract the install command from the server page | `npx -y @anthropic/mcp-server-brave-search` |
| **Orchestra Research** | `npx @orchestra-research/ai-research-skills install <skill-name>` | `npx @orchestra-research/ai-research-skills install litgpt` |
| **Anthropic Skills Hub (official)** | `claude plugins install anthropics/skills` (for Claude Code) or copy SKILL.md to skills dir | Copy `anthropics/skills/pdf/SKILL.md` → `.opencode/skills/pdf/` |
| **Anthropic Skills Hub (community)** | Clone repo, copy SKILL.md to skills dir | `cp community-repo/SKILL.md .opencode/skills/my-skill/` |
| **npm package** | `bun add <package>` (neuralgentics uses Bun) or `npm install -g <package>` | `bun add ripgrep-tree` |
| **PyPI package** | `uv add <package>` (neuralgentics uses uv) | `uv add codebase-search` |
| **Go package** | `go install <package>@latest` | `go install github.com/user/repo@latest` |
| **Internal skill** | Copy from source to user's skills dir | `cp neuralgentics/.opencode/skills/boomerang-explorer/ .opencode/skills/my-custom-explorer/` |

### 5.2 Auto-Install vs Suggest-Install

**Decision: Suggest-install (user approves).** Rationale:

1. **Safety** — Installing third-party code without user review is a security risk. Even "official" MCP servers can have vulnerabilities or unexpected behavior.

2. **Configuration** — MCP servers often need API keys, environment variables, or other configuration. Auto-installing without this would result in a broken setup.

3. **User awareness** — The user should know what's being added to their system. "We added Context7 MCP to your opencode.json" is information they need.

4. **Trust building** — The detector is a consultant, not a sysadmin. Suggesting "here's what I recommend — install it?" is collaborative. Auto-installing "I went ahead and installed this" is presumptuous.

**Exception:** Internal skills (Tier 3) and our own boomerang skills directory entries can be auto-registered (they're our code, we trust them, and the install is a cp command). But even then, the user should be notified.

---

## 6. Trust Scoring

Not every aggregator is equal. The detector weights results by trust tier so the user knows what they're installing.

### 6.1 The 4 Trust Tiers

| Tier | Label | Aggregators | Criteria | Visual |
|------|-------|-------------|----------|--------|
| **Tier 1** | ★★★ Highly Trusted | Official MCP Registry, Orchestra Research (curated, MIT), Anthropic official plugins, Internal skills | Official source, authenticated, curated, high GitHub stars (>5k), verified namespace | Green badge |
| **Tier 2** | ★★☆ Community Vetted | mcpservers.org (community catalog), Anthropic community SKILL.md repos, npm (verified + >1k weekly downloads), PyPI (active maintainers) | Community source, not authenticated but widely used, has stars/downloads | Yellow badge |
| **Tier 3** | ★☆☆ Use With Caution | mcpservers.org (low-activity entries), npm (<1k weekly downloads), PyPI (inactive, new packages) | Unvetted, low adoption, could be abandoned | Orange badge |
| **Tier 4** | ☆☆☆ Build New | N/A — our own skill creation | We build it, we own it, we trust it | Blue badge (build) |

### 6.2 Trust Score Mapping

```
trust_tier_score = {
  "Tier 1": 1.0,    // Full trust weight in match_score formula
  "Tier 2": 0.7,    // 70% weight
  "Tier 3": 0.4,    // 40% weight
  "Tier 4": 0.2     // 20% weight (build new is always last resort)
}
```

This mapping means that a Tier 1 match with 0.6 description similarity outranks a Tier 2 match with 0.8 description similarity. Trust matters more than semantic similarity — a less-perfect official match is better than a highly-matched unvetted package.

### 6.3 Trust Signals Updated After Use

When the user installs a tier-1 or tier-2 result, memini-ai records the action with a trust signal:

```
If user installs match:
  → memini-ai-dev_add_memory with type: "aggregator_install", trusted: true
  → memini-ai-dev_adjust_trust on aggregator_index memory: signal = "agent_used" (+0.05)
  → Future lookups: this aggregator gets a slight trust boost

If user rejects match:
  → memini-ai-dev_add_memory with type: "aggregator_reject"
  → memini-ai-dev_adjust_trust: signal = "agent_ignored" (-0.05)
  → Future lookups: this specific result is down-ranked
```

This creates a feedback loop: aggregators that produce good matches get prioritized; aggregators that produce noise get deprioritized.

---

## 7. Caching Strategy

### 7.1 Caching Levels

| What | Cache Location | TTL | Rationale |
|------|---------------|-----|-----------|
| **Weekly aggregator index** | memini-ai (type: `aggregator_index`) | 7 days for Tier 1-2 aggregators; 24h for Tier 3 | Aggregators change slowly. Weekly refresh is sufficient for most. |
| **Previous lookup results** | memini-ai (type: `aggregator_lookup`) | Per-session (cleared at handoff) | The same pattern in the same session should return the same results. Avoid re-querying. |
| **User install/reject history** | memini-ai (type: `aggregator_install` / `aggregator_reject`) | Indefinite (persistent) | "User rejected Context7 MCP last week" — don't suggest it again for at least 30 days. |
| **Forced refresh** | `/opportunities --refresh` | Immediate | Regenerates the full aggregator index from live sources. Expensive (~30 seconds, 7 HTTP calls + LLM calls). Use sparingly. |

### 7.2 Cache Invalidation

- **Weekly index refresh:** Cron job runs every Sunday at 03:00 UTC. Regenerates all 7 aggregator index memories.
- **Stale index warning:** If the index is >7 days old, the lookup prompt includes: "⚠️ Aggregator index is 8 days old. Results may be outdated. Run `/opportunities --refresh` to update."
- **Offline mode:** If aggregators are unreachable and index is stale, the detector says: "Aggregators unreachable, cached index is 12 days old. Results may be incomplete. Showing only internal skills and build suggestions."

---

## 8. Build Plan Addition

### 8.1 New Tasks (Addendum 2)

| # | Task | Effort | Phase | Description |
|---|------|--------|-------|-------------|
| **7** | Aggregator index builder (`aggregator-index.ts`) | 0.5 day | P1-c (EXTEND) | Build the weekly cron job that fetches from 7 aggregators, normalizes to flat JSON, stores as memini-ai memories. Includes error handling for each source (one failure doesn't block others). |
| **8** | LLM-based lookup engine (`aggregator-lookup.ts`) | 0.75 day | P1-c (EXTEND) | Prompt builder for gemma4:31b: pattern → search queries → aggregator index → match scoring. Includes result parser, fallback to internal-only, offline mode. |
| **9** | Install command generator (`install-generator.ts`) | 0.25 day | P1-c (EXTEND) | Template engine for per-aggregator install commands (MCP config generation, npx commands, npm/bun/uv/go installs, cp commands for internal skills). |
| **10** | Trust scoring + caching (`trust-scorer.ts`) | 0.25 day | P1-c (EXTEND) | Implements the 4-tier trust model, trust_signal feedback loop, TTL-based cache invalidation, user install/reject history tracking. |
| **11** | Integration: wire into detector flow | 0.5 day | P1-c (EXTEND) | Modify `detector.ts` (from addendum 1) to add aggregator pre-check step before "build" suggestion. Modify `prompter.ts` to show 4-tier results instead of just build. Add `/opportunities --refresh` flag. |
| **12** | Tests | 0.5 day | P2-c (EXTEND) | Unit tests for each aggregator source mock, LLM lookup with mock responses, install command generation, trust scoring, cache invalidation. Integration test: pattern → lookup → install suggest → user accept → config written. |
| **13** | Opportunity detector SKILL.md update | 0.25 day | P1-c (EXTEND) | Update `skills/opportunity-detector/SKILL.md` to document aggregator-aware lookup, the 7 sources, 4-tier ranking, trust scoring, and `/opportunities --refresh`. |
| **14** | Aggregator index initial build + seed | 0.25 day | P1-c (EXTEND) | Run the index builder once at deploy time to seed memini-ai with the initial aggregator index. This ensures the first opportunity detection has data to search. |

### 8.2 Effort Summary

| Category | Days | Notes |
|----------|------|-------|
| Aggregator index + maintenance | 0.5 days | Weekly cron, error handling, normalization |
| LLM lookup engine | 0.75 days | Prompt + result parser + fallback |
| Install command generation | 0.25 days | Template engine |
| Trust scoring + caching | 0.25 days | 4-tier model, feedback loop |
| Integration | 0.5 days | Wire into existing detector flow |
| Tests | 0.5 days | Mocks + integration test |
| Doc update + initial seed | 0.5 days | SKILL.md + initial index build |
| **Addendum 2 total** | **3.25 days** | |
| **Addendum 1 total** | **3.5 days** | (from original addendum) |
| **Combined detector total** | **6.75 days** | Full opportunity detector with aggregator awareness |

### 8.3 Updated P1 Build Plan

The addendum 2 tasks extend the detector build. Updated P1 sequence:

```
P1-a: TUI surface (2 days)
P1-b: Token accountant — counter + reporter (1 day)
P1-c: Opportunity detector — patterns + ranker + prompter (2.5 days, addendum 1)
P1-c-ext: Aggregator-aware lookup + install + trust + caching (3.25 days, addendum 2) ← NEW
P1-d: Kanban board with circuit breaker (1 day)
P1-e: Comments on cards (0.5 day)
P1-f: Attempts history (0.5 day)
P1-g: Slash commands (1 day)
P1-h: Broker permission-gated dispatch (1 day)
```

**P1 total: 12.75 days** (was 9.5 days in addendum 1; net +3.25 days for addendum 2).

**v0.1.0 total: 30.75 days** (~6.2 weeks, was 27.5 days in addendum 1).

---

## 9. Backwards Compatibility

Addendum 2 is **purely additive**. The original addendum 1 detector still works exactly as specified for all cases:

- **No aggregator match?** Fall back to addendum 1's Tier 4 "build new" suggestion. All addendum 1 patterns (sequential tool chains, repeated calls, high-cost turns, long card retries, re-reading files, missed parallel ops, manual aggregation, error-and-retry loops) still trigger. The aggregator lookup is a pre-check, not a replacement.

- **Aggregators unreachable (offline mode)?** The detector skips the aggregator lookup entirely and falls back to addendum 1's behavior. The user sees "Aggregators unreachable. Showing build suggestions only." — and the original patterns + ranker + prompter work unchanged.

- **gemma4:31b unavailable (cloud API down)?** Fall back to direct internal skills match + stale aggregator results (if cached). If those also fail, fall back to addendum 1 Tier 4.

- **No network at all?** The detector works fully offline: internal skills match (Tier 3) + Tier 4 build suggestions. No aggregator queries are made.

- **User explicitly wants to build?** The `[B] Build` option is always available, even when tier-1 matches exist. The detector is a consultant — the user has the final say.

### 9.1 Addendum 1 Content Unchanged

No content from addendum 1 is modified. The 8 detection patterns, candidate ranking formula, output format, card auto-draft format, skill-self-audit integration, and success criteria all carry forward unchanged. Addendum 2 adds a pre-lookup step; it doesn't change what happens after the match (or non-match) is determined.

---

## 10. Worked Example

**Scenario:** Session `sess-d7f2` is running long (3 hours, 250K tokens, 60 LLM calls). The opportunity detector triggers at session end (trigger #1: duration > 2 hours). Pattern #1 (Sequential Tool Chains) detects `find_files` (7×) → `grep` (12×) → `read` (4×) across task T-007, totalling 23 calls and ~18K tokens.

### 10.1 Aggregator Lookup

**Search queries generated by gemma4:31b:**
1. "codebase search with content snippets and line numbers tool for AI agents"
2. "ripgrep wrapper MCP server code search"
3. "sourcegraph context API for coding agents"
4. "library documentation retrieval tool for LLM"
5. "file content search agent skill"

**7 aggregators queried in parallel (via LLM match against weekly index):**

| Aggregator | Result | Match Score | Trust Tier |
|-----------|--------|-------------|------------|
| Official MCP Registry | **Context7 MCP** — "Provides up-to-date documentation and code examples for any library directly in your coding agent." | 0.87 | Tier 1 |
| mcpservers.org | **Search1API MCP** — "Web search, news, crawling, and more in one API." | 0.42 | Tier 2 |
| Orchestra Research | No match (skills are AI research-focused, not tooling) | — | — |
| Anthropic Skills Hub | No match | — | — |
| npm | **ripgrep-tree** — "Tree-sitter powered code search with context snippets." 12k weekly downloads. | 0.72 | Tier 2 |
| npm | **codebase-digger** — "Semantic codebase search for LLMs." 480 weekly downloads. | 0.64 | Tier 3 |
| PyPI | No match | — | — |
| Internal Skills | **boomerang-explorer** — "File finding with memini-ai semantic search." | 0.38 | Tier 1 |

### 10.2 User-Facing Output

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 💡 Opportunity Detected: pattern "find_files+grep+read" (23 calls, 18K tokens)
│    Checking aggregators... 7 searched, 3 matches found.
│                                                                           │
│ #1 (Tier 1 ★★★) — CONTEXT7 MCP (Official MCP Registry)                   │
│    "Provides up-to-date documentation and code examples for any library   │
│     directly in your coding agent. Single call: query → docs + snippets." │
│    Install: Add to opencode.json →                                        │
│      {"mcpServers": {"context7": {"command": "npx",                      │
│       "args": ["-y", "@context7/mcp"]}}}                                  │
│    Trust: Tier 1 (official MCP registry, verified namespace)             │
│    Solves your pattern in ~2 minutes.                                     │
│                                                                           │
│ #2 (Tier 2 ★★☆) — ripgrep-tree (npm, 12k weekly downloads)               │
│    "Tree-sitter powered code search with context snippets."               │
│    Install: bun add ripgrep-tree                                          │
│    Trust: Tier 2 (verified npm package, >10k downloads/week)             │
│    Solves your pattern in ~5 minutes.                                     │
│                                                                           │
│ #3 (Tier 3 ★☆☆) — codebase-digger (npm, 480 weekly downloads)            │
│    "Semantic codebase search for LLMs."                                   │
│    Install: bun add codebase-digger                                       │
│    Trust: Tier 3 (low adoption, use with caution)                        │
│                                                                           │
│   [1] Install #1 (Context7 MCP)                                           │
│   [2] Install #2 (ripgrep-tree)                                          │
│   [3] Install #3 (codebase-digger)                                       │
│   [B] Build (no match found in aggregators — draft card)                 │
│   [N] No, none of these                                                  │
│   [L] Let me think — show full match details                             │
│   [S] Silence this pattern type for this session                         │
└──────────────────────────────────────────────────────────────────────────┘
```

### 10.3 User Selects #1

The detector generates the exact install:

```
Adding Context7 MCP to .opencode/opencode.json...

{
  "mcpServers": {
    ...existing servers...,
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp"]
    }
  }
}

✅ Added. Restart OpenCode or reload MCP servers to use Context7.
📝 Saved to memini-ai: aggregator_install, trusted=true, trust_signal=agent_used
```

The next session, the coder can call Context7 directly instead of doing `find_files` → `grep` → `read` loops.

### 10.4 Memini-ai Records

After the install:

| Memory | Type | Content |
|--------|------|---------|
| `agg-install-001` | `aggregator_install` | `{ aggregator: "Official MCP Registry", entry: "Context7 MCP", pattern: "sequential_tool_chains", session: "sess-d7f2", timestamp: "2026-06-04T...", trusted: true }` |
| `agg-index-mcp-registry` | `aggregator_index` | Trust adjusted: `agent_used` (+0.05). This aggregator produced a good match — boost its trust slightly. |
| `agg-result-context7` | `aggregator_result` | `{ source: "MCP Registry", name: "context7", matched_pattern: "find_files+grep+read", install_command: "npx -y @context7/mcp", user_accepted: true }` |

For the next 30 days, the detector won't suggest Context7 MCP again for the same pattern (from the user's install history). But if a different pattern matches Context7, it WILL suggest it again — because Context7 is now "trusted" (proven useful).

---

## 11. Why This Is Nextgen

No competitor does aggregator-aware skill acquisition. Here's the competitive landscape as of June 2026:

| Competitor | Skill/MCP Mechanism | Aggregator-Aware? |
|-----------|-------------------|-------------------|
| **Cursor** | `@`-references to local files, `.cursorrules` files, MCP servers (manual config) | No — all references are local. You bring your own. |
| **Cline** | MCP servers (manual config), `.clinerules` files | No — local only. No catalog browsing. |
| **Claude Code** | `claude plugins install`, Skills Marketplace (Anthropic-hosted) | Partial — has its own marketplace, but only Anthropic-official plugins. No cross-aggregator search. |
| **Codex (OpenAI)** | Skills via `openai/skills` repo, MCP servers via config | Partial — has its own catalog, but doesn't search mcpservers.org, orchestra, npm, or PyPI. |
| **Devin (Cognition)** | Opaque — no public skill/MCP mechanism | No — Devin is a black box. You can't extend it. |
| **Aider** | Conventions via `.aider.conf.yml`, no skill/MCP system | No — no skill system at all. |
| **Windsurf** | MCP servers via config | No — manual config only. |
| **Neuralgentics + Boomerang** | **Opportunity detector + 7-aggregator lookup + 4-tier ranking + 1-line install** | **YES — the only agent that grows its own skill library by pulling from mcpservers.org, the official MCP Registry, Orchestra Research (9.3k stars), the Anthropic Skills Hub, npm, PyPI, and its own internal skills directory.** |

The competitive moat:

1. **Cross-aggregator search** — Nobody searches mcpservers.org, npm, and PyPI simultaneously for skill matches. Neuralgentics is the first.

2. **Pattern-to-skill mapping** — The detector doesn't just search for "codebase search tool." It detects the pattern `find_files+grep+read` repeated 23 times and translates that into semantically-relevant search queries. This is AI understanding the pattern, not the user typing a keyword.

3. **Trust-graded results** — Official MCP Registry (Tier 1) vs. community npm package (Tier 2) vs. low-adoption PyPI (Tier 3). The user knows what they're installing and how much to trust it.

4. **Zero-friction install** — One keypress ([1]) → install command generated → config updated. No browsing, no copy-paste, no manual config writing.

5. **Feedback loop** — Install something? Trust signal +0.05 for that aggregator. Reject something? Trust signal -0.05. Over time, the detector learns which aggregators are useful for which patterns. This is self-improving, not static.

6. **Compounding advantage** — Every skill installed from an aggregator makes the system more capable. Context7 MCP installed? Now the coder can query library docs directly. ripgrep-tree installed? Now codebase searches are 3× faster. Each install improves every future session. Competitors that require manual MCP config don't compound — they stay at the same capability level until a human intervenes.

**Metaphor:** Other coding agents are like a carpenter who only uses the tools in their own toolbox. Neuralgentics is like a carpenter who walks into Home Depot, Lowe's, and the local hardware store, checks what's available, and installs the best tool for the job — in 2 minutes, with one keypress. The toolbox grows every session.

---

## 12. Document Metadata

| Field | Value |
|-------|-------|
| **Version** | v4-FINAL-ADDENDUM-2 |
| **Status** | Complete — Addendum #2 to v4-FINAL |
| **Supersedes** | Nothing — purely additive |
| **Builds on** | [v4-FINAL-ADDENDUM-opportunity-detector.md](v4-FINAL-ADDENDUM-opportunity-detector.md) (addendum 1), [v4-roll-your-own-app-FINAL.md](v4-roll-your-own-app-FINAL.md) (v4-FINAL) |
| **v4-FINAL Memory ID** | `400a2db3-af29-4d76-9f09-c95c95d0ea88` |
| **Addendum 1 Memory ID** | `359f0dcd-c973-430f-971c-c3e6b7df49a6` |
| **Line count** | ~430 |
| **Aggregators in catalog** | 7 active + 7 secondary |
| **Build effort** | 3.25 days (addendum 2 alone); 6.75 days (combined addendum 1 + 2) |
| **Net P1 impact** | +3.25 days (9.5 → 12.75 days P1; 27.5 → 30.75 days v0.1.0 total) |
| **Lookup mechanism** | Option B — LLM-based semantic search with gemma4:31b + weekly aggregator index |
| **Install mechanism** | Suggest-install (user approves) |
| **Trust tiers** | 4 (Highly Trusted, Community Vetted, Use With Caution, Build New) |
