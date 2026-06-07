# Deferred Follow-ups

> **Status:** Parked ideas for future releases. None are blocking v0.5.0 (current). They live here so they don't get lost across sessions.

This file tracks ideas that came up during v0.4.0 → v0.5.0 development but were explicitly deferred. Each entry has: scope, target version, why deferred, and what would unblock it.

---

## F-1. OCI Registry Push/Pull for Profiles (target: v0.5.1)

**What**: Extend v0.5.0's tar.gz profile format into a true OCI artifact so users can `docker push ghcr.io/me/neuralgentics-profile` and `docker pull` on another machine. Optionally sign with cosign for non-repudiation.

**Why deferred**: v0.5.0's tar.gz covers the local + email + file-share use cases. OCI registry integration requires either (a) shipping an embedded ORAS-style client in the Go binary (~2MB binary bloat), or (b) shelling out to `oras` or `docker` CLI. The latter is simpler but adds a runtime dependency.

**Unblocks when**: A user explicitly needs cross-team distribution (e.g. a platform team wants to publish a "neuralgentics-default" profile that all engineers consume). At that point, decide between embedded ORAS or shell-out.

**Files affected**: `packages/broker-go/src/neuralgentics/broker/profile/profile.go` (add OCI manifest writer), `packages/tui/src/commands.ts` (`/profile push` + `/profile pull` sub-commands).

**Memory anchor**: memini-ai `21d46e85-4ef0-48e7-b632-ce0a65d488d7` (v0.5.0 release summary).

---

## F-2. Unify `small_model` Source of Truth (target: v0.6.0)

**What**: TUI's `/provider` writes `smallModel` to `provider-pref.json` (v0.5.0), but opencode itself reads `small_model` from `.opencode/opencode.json` (still hardcoded to `ollama-cloud/devstral-small-2:24b-cloud` since v0.1.0). This split is documented as a trade-off. v0.6.0 should unify: have opencode read from a runtime source (env var? a new `runtime-config.json`?), or have the TUI write the equivalent field back to `opencode.json` and trigger a session restart warning.

**Why deferred**: v0.5.0 ships a working two-source system that's backward compatible. The unification touches opencode core config semantics and would benefit from a focused design pass on "what is the runtime model selection API".

**Unblocks when**: A user reports confusion about which `small_model` is actually being used (TUI shows one, opencode uses another). Or when opencode adds native support for runtime model selection.

**Files affected**: `.opencode/opencode.json` (read-time override mechanism), `packages/tui/src/commands.ts` (write to runtime source), `docs/architecture/overview.md` (update trade-off note).

**Memory anchor**: memini-ai `9f71456a-a63a-44ef-9d5c-673ee1f1efaf` (T-SMALL-MODEL wrap-up).

---

## F-3. HTTP/SSE Curated Catalog Entries (target: v0.6.0)

**What**: `TransportType = "http"` is implemented (v0.5.0) and `/mcp activate <hosted-mcp>` works for any URL the user provides. But `mcp_catalog.json` (the curated list of 20 popular MCPs) has zero HTTP-transport entries. v0.6.0 should add 5-10 entries for hosted MCPs (Cloudflare MCP, Anthropic-hosted MCP if/when public, any other major hosted MCP providers).

**Why deferred**: The HTTP transport type is new (shipped in v0.5.0). Curating hosted MCPs requires research into which providers are public, what their auth models are, and whether their APIs are stable enough to commit to in a catalog. The existing 20 entries are all stable, well-known npm/pypi packages.

**Unblocks when**: A user explicitly asks for a hosted MCP in the catalog. Or when 3+ hosted MCPs become stable and widely-used enough to justify a curated entry.

**Files affected**: `packages/broker-go/src/neuralgentics/broker/catalog/mcp_catalog.json` (add 5-10 entries), `docs/architecture/overview.md` (note the new transport variety).

**Memory anchor**: memini-ai `fd44a5a2-2a07-424c-b0e3-6ca66f6d6d07` (T-HTTP-TRANSPORT wrap-up).

---

## F-4. Profile Conflict Resolution UI (target: v0.6.0)

**What**: v0.5.0's `/profile import` skips MCPs that already exist in the registry (the `applied` count excludes them, the `conflicts` list shows what was skipped). v0.6.0 should add a `--merge` flag (apply non-conflicting MCPs, prompt for conflicting ones) and a `--replace` flag (deregister existing MCPs before importing). The TUI could also add an interactive prompt: "MCP `github-mcp` already exists. [S]kip, [R]eplace, [A]bort?"

**Why deferred**: The current "skip on conflict" behavior is the safe default — it never loses data. The interactive prompt is a UX improvement that needs design (terminal vs web UI, how to handle 50 conflicts at once, etc.).

**Unblocks when**: A user reports that profile import is "useless" because all their MCPs already exist. Or when profile sharing becomes a regular workflow (multiple engineers sharing configs).

**Files affected**: `packages/broker-go/src/neuralgentics/broker/profile/profile.go` (add `mergeStrategy` field), `packages/backend-go/cmd/backend/main.go` (extend `broker.importProfile` params), `packages/tui/src/commands.ts` (add `--merge`/`--replace` flags + interactive prompt).

**Memory anchor**: memini-ai `16fc0af6-843a-4476-a530-571275b4f57c` (T-PROFILE-OCI wrap-up).

---

## Process

When a user mentions one of these (or when a session naturally touches the area):
1. Read this file
2. Read the linked memini-ai memory for full context
3. Decide: is this the right time to do it, or should it stay parked?
4. If doing: convert `F-N` to a `T-XXX` card in `TASKS.md` (or create a `docs/design/<feature>.md` design doc)
5. If staying parked: update the "Why deferred" section with new context

**Last reviewed**: 2026-06-07 (after v0.5.0 release)
