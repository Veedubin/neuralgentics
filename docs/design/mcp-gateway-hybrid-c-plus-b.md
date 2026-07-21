# MCP Gateway — Hybrid C+B (Broker-First, Egress Gateway)

**Status:** Draft — awaiting implementation  
**Author:** boomerang-architect  
**Date:** 2026-07-19  
**References:**
- Prior design doc: `mcp-gateway-architecture-options.md` (Options A/B/C/D)
- Broker source: `packages/broker-go/src/neuralgentics/broker/proxy/http_client.go` (outbound HTTP)
- Broker source: `packages/broker-go/src/neuralgentics/broker/proxy/proxy.go` (stdio MCP proxy)
- Broker source: `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` (child process spawn)

---

## Section 1: Refined Architecture

The user chose a **hybrid of Option C (universal gateway) and Option B (sidecar split)**, but with a critical inversion: the gateway sits **behind** the broker, not in front of it. The broker remains the model-facing surface. The gateway is an egress proxy that intercepts the broker's outbound calls.

```
┌──────────────────┐
│  OpenCode/Model  │ (LLM)
└────────┬─────────┘
         │ MCP JSON-RPC (unchanged)
         ▼
┌──────────────────┐
│  broker-go       │  ← FIRST in the chain (model-facing)
│  (router + audit)│     - intent matching, tool dispatch
│  - existing      │     - access control (role → server)
│  - unchanged     │     - catalog, skills, prompt injection
└────────┬─────────┘
         │ outbound HTTP/DB/stdio (NEW: routed through gateway)
         ▼
┌──────────────────┐
│  egress-gateway  │  ← BEHIND the broker
│  (Kong clone)    │     - domain whitelist/blacklist
│                  │     - DB host whitelist
│                  │     - audit log of every outbound call
│                  │     - rate limit per domain
│                  │     - child process spawn + stdio audit
└────────┬─────────┘
         │
         ▼
    [Internet, DB, MCP servers, external APIs]
```

### Why this is better than the standard "gateway in front" pattern

1. **Zero impact on the model-facing surface.** The LLM talks to the broker via MCP JSON-RPC — exactly as it does today. No new protocol, no new port, no new handshake. The broker's `Initialize`, `tools/list`, `tools/call` flow is untouched.

2. **Egress is where the actual security/audit/governance pain lives.** The broker already has access control (role → server allow-lists in `access.go`). What it doesn't have is visibility into what those servers *do* — which domains they call, which databases they query, which child processes they spawn. The gateway adds that visibility at the only layer that can see it: the outbound network boundary.

3. **Clean separation of concerns.** The broker is MCP-aware (it speaks JSON-RPC, matches intents, manages tool registries). The gateway is MCP-agnostic — it inspects TCP/UDP/HTTP from the local process tree. This means the gateway works with any orchestrator (neuralgentics, Hermes, LangChain) without modification.

4. **The "universal port" goal is preserved.** The gateway becomes an egress proxy that's MCP-agnostic. The broker is the MCP-aware layer. When the user ports `neuralgentics-core` to Hermes or LangChain, the gateway stays. The broker (MCP-specific) gets replaced by whatever the new platform uses for tool routing. The gateway keeps working.

---

## Section 2: What the Egress Gateway Actually Does

### Outbound HTTP/HTTPS interception

When the broker (or any child MCP server it spawns) makes an HTTP call — e.g., the broker's `HTTPClient.doRequestRaw()` in `proxy/http_client.go` calling a remote MCP server, or a spawned Prefect MCP server calling `api.prefect.io` — the gateway:

- **Checks the URL against a whitelist** (glob patterns: `*.prefect.io`, `*.github.com`, `*.openai.com`, `*.ollama.com`)
- **Checks against a blacklist** (e.g., `169.254.169.254` AWS metadata IP, `*.malware.com`, `localhost` for servers that shouldn't reach local services)
- **Adds a request ID header** (`X-Egress-Request-Id: <uuid>`) for tracing across the broker → gateway → internet chain
- **Captures request/response** for audit log: method, URL, status code, bytes sent/received, latency
- **Rate-limits per domain** (token bucket: max 100 req/min to `github.com`, max 10 req/min to `api.prefect.io`)

Implementation: the broker's `http.Client` transport is swapped from `http.DefaultTransport` to a custom transport that dials `localhost:9090` (the gateway's HTTP proxy port). The gateway runs an HTTP forward proxy (like `goproxy` or a custom `net/http/httputil.ReverseProxy` with policy middleware).

### Outbound DB interception

When the broker talks to PostgreSQL (e.g., the memini-ai cluster on port 5434, or the neuralgentics-postgres on port 6200):

- **Enforces which DB hosts are reachable** (whitelist: `localhost:5434`, `localhost:6200`; blacklist: everything else)
- **Captures queries for audit** (optional, configurable — off by default for performance)
- **Connection pool management** (the gateway can enforce max connections per DB host)

Implementation: the gateway runs a TCP proxy on `localhost:6432` (PgBouncer-style). The broker's DB connection string changes from `localhost:5434` to `localhost:6432`. The gateway inspects the PostgreSQL wire protocol enough to extract the database name and first query statement for audit, then passes bytes through.

### Child-process stdio interception

When the broker spawns an MCP server via `podman run` or `npx` (the `launcher.BuildCommand` path in `launcher.go`):

- **Resolves the command** — does it match a catalog entry? Is the image hash trusted?
- **Wraps the stdio in an audit layer** — the gateway sits between the broker and the child process's stdin/stdout, logging every JSON-RPC message
- **Enforces resource limits** — max memory, max CPU, max runtime per child process

Implementation: the broker's `launcher.BuildCommand` is modified to accept an optional `gateway *GatewayClient`. When set, instead of `cmd.Start()`, the broker calls `gateway.SpawnChild(config)` which returns the child's stdin/stdout handles (already proxied through the gateway). The gateway runs the actual `podman run` / `npx` command and pipes stdio through itself.

### Ephemeral MCP gating

When a skill says "use Prefect", the catalog spawn fetches the server, but the gateway:

- **Prompts the user for approval** (first time) — "Skill 'data-pipeline' wants to use Prefect MCP server. Allow? [y/N]"
- **Records the approval** in a "learned skill" entry in the gateway's policy store
- **Allows future invocations** without prompting (the learned skill entry acts as a persistent allow-rule)

---

## Section 3: Dashboard for the Hybrid

The dashboard shows both sides of the broker↔gateway boundary:

```
┌─────────────────────────────────────────────────────────────┐
│  neuralgentics-gateway dashboard            [Policy] [Live] │
├──────────────────────────┬──────────────────────────────────┤
│  BROKER AUDIT (inbound)  │  GATEWAY AUDIT (outbound)        │
│                          │                                  │
│  Tool calls from model:  │  HTTP requests to internet:      │
│  ✓ filesystem/read_file  │  ✓ POST api.prefect.io (200, 2KB)│
│  ✓ memory/search_mems   │  ✓ GET github.com (200, 45KB)    │
│  ✗ playwright/browse    │  ✗ 169.254.169.254 (BLOCKED)     │
│     (access denied)      │     (blacklist: AWS metadata)    │
│                          │                                  │
│  Latency: 12ms avg       │  Latency: 340ms avg              │
│  Success rate: 98%       │  Blocked today: 3                │
├──────────────────────────┴──────────────────────────────────┤
│  LIVE STREAM (SSE)                          [Filter: ______] │
│  19:42:01 broker  tools/call → filesystem/read_file         │
│  19:42:01 gateway HTTP GET github.com/repos/... → 200       │
│  19:42:03 broker  tools/call → memory/search_memories       │
│  19:42:05 gateway HTTP POST api.prefect.io/... → 200        │
└─────────────────────────────────────────────────────────────┘
```

- **Left panel: Broker audit** — inbound tool calls from the model, which tool, which server, success/failure, latency. Data comes from the broker's existing audit hooks (or new ones added to `broker.go`).
- **Right panel: Gateway audit** — outbound HTTP requests, which domain, response code, bytes transferred, blocked attempts. Data comes from the gateway's policy middleware.
- **Top bar: Policy** — current whitelist/blacklist rules, ephemeral MCP catalog, learned skills, rate limits. Editable inline.
- **Bottom: Live stream** — SSE feed of both sides, filtered by tool or domain.

**Data store:** PostgreSQL (the existing memini-ai cluster on port 5434, or the neuralgentics-postgres on port 6200). The gateway writes audit events to a `gateway_audit_log` table. The dashboard reads from it. SSE is pushed from the gateway process (in-memory channel → SSE endpoint).

---

## Section 4: Ephemeral MCP — Revised Flow

The previous doc had ephemeral MCP at the gateway level (Option C). With broker-first, ephemeral MCP belongs to the **broker** (it knows the tool registry), but the **gateway** owns the spawn lifecycle and the network policy for the spawned server.

```
1. Skill says requires: [prefect]
2. BROKER sees the requirement, looks up catalog (Docker MCP Catalog YAML)
3. BROKER asks GATEWAY: "can I spawn prefect-mcp-server? catalog entry: <signed YAML>"
4. GATEWAY checks:
   - Is the catalog entry signed by a trusted author?
   - Is the image hash in the trusted set?
   - Has the user approved this skill→server mapping?
   - If first time: prompt user. Record approval.
5. GATEWAY spawns the server (podman run -d prefect-mcp), wraps its stdio with audit layer
6. GATEWAY returns child PID + stdio handles to the broker
7. BROKER calls tools/list on the spawned server, registers tools with TTL (1 hour idle)
8. BROKER uses the tools; GATEWAY logs every outbound HTTP/DB call the server makes
9. On session end (or TTL expiry), GATEWAY tears down the server (podman stop, cleanup)
```

**Key change from Option C:** The broker initiates the spawn request. The gateway is the executor, not the initiator. This preserves the broker's role as the tool registry owner while giving the gateway the process lifecycle and network policy enforcement it needs.

---

## Section 5: Universal Port — How This Works with Hermes / LangChain

The egress gateway is **MCP-agnostic** — it inspects outbound TCP/UDP/HTTP from the local process tree. Any orchestrator that spawns child processes can be configured to route their egress through the gateway.

| Orchestrator | What changes | What stays |
|-------------|-------------|------------|
| **neuralgentics** (today) | Broker's `http.Client` transport → `localhost:9090`; DB connection → `localhost:6432` | Gateway binary, dashboard, policy rules |
| **Hermes Agent** (future) | Hermes's HTTP client → `localhost:9090`; child process spawn → gateway's `SpawnChild` API | Gateway binary, dashboard, policy rules |
| **LangChain Deep Agents** (future) | LangChain's `requests.Session` → `localhost:9090`; subprocess → gateway's spawn API | Gateway binary, dashboard, policy rules |

The gateway doesn't know or care that MCP exists. It's a network policy enforcement layer. The broker (MCP-specific) gets replaced by whatever the new platform uses for tool routing. The gateway keeps working.

**Concrete example:** When the user ports `neuralgentics-core` to Hermes, they:
1. Keep the `neuralgentics-egress` binary running on `:9090` and `:9091` (dashboard)
2. Configure Hermes's HTTP client to use `http://localhost:9090` as its proxy
3. Configure Hermes's subprocess spawner to call the gateway's gRPC `SpawnChild` endpoint
4. The gateway's policy rules (whitelist, blacklist, rate limits, learned skills) continue to apply
5. The dashboard continues to show outbound traffic — now from Hermes instead of neuralgentics

---

## Section 6: Build Order

### 1 week — Gateway skeleton

**New binary:** `packages/egress-gateway/` (sibling of `packages/broker-go/`)

```
packages/egress-gateway/
├── cmd/egress/main.go          # entry point, flag parsing, starts HTTP proxy + dashboard
├── proxy/http_proxy.go         # HTTP forward proxy (net/http/httputil.ReverseProxy + policy middleware)
├── policy/whitelist.go         # domain whitelist/blacklist with glob matching
├── policy/config.go            # YAML config loader (whitelist, blacklist, rate limits)
├── audit/logger.go             # writes audit events to PostgreSQL
├── dashboard/server.go         # htmx dashboard on :9091
└── go.mod                      # module neuralgentics-egress
```

**What ships:**
- `neuralgentics-egress` binary that starts an HTTP forward proxy on `:9090`
- Whitelist/blacklist config in `egress-gateway.yaml` (loaded at startup)
- Audit log to PostgreSQL (shared with memini-ai cluster, port 5434)
- Broker's `http.Client` transport swapped to `http://localhost:9090` (one-line change in `http_client.go`)
- Verify: existing `--init` flow still works, the gateway logs every outbound HTTP call

**Key code paths:**
1. `cmd/egress/main.go` → `proxy.Start(config)` → listens on `:9090`
2. `proxy/http_proxy.go` → `ServeHTTP(w, r)` → `policy.CheckURL(r.URL)` → `audit.Log(event)` → forward
3. `broker-go/.../http_client.go` → `http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(gatewayURL)}}`

### 1 month — Full policy + dashboard

- Domain whitelist/blacklist with glob patterns (`policy/whitelist.go` → `MatchDomain(pattern, host)`)
- DB host whitelist — TCP proxy on `:6432` that inspects PostgreSQL wire protocol (`proxy/db_proxy.go`)
- Rate limiting — token bucket per domain (`policy/rate_limiter.go`)
- Dashboard (htmx + Go) on `:9091` — read from PG audit log, SSE stream for live outbound calls
- Docker MCP Catalog parser (`catalog/parser.go` — reads YAML, validates against schema)
- Ephemeral MCP spawn via gateway's process manager (`spawn/manager.go` — `SpawnChild(config) → (stdin, stdout, pid)`)

### 1 quarter — Production-ready

- Catalog signing + trust chain (`catalog/sign.go` — Ed25519 signature verification)
- Skill-to-MCP persistence ("learned skills" that auto-approve next time) (`policy/learned.go`)
- Prometheus metrics + alerting (`metrics/prometheus.go`)
- Dashboard v1.0 with role-based access (admin / operator / viewer) (`dashboard/auth.go`)
- Proof-of-concept: configure Hermes Agent or LangChain Deep Agents to use the same gateway
- Audit log retention policy + archival to S3 (`audit/retention.go`)

---

## Section 7: Recommendation

### File structure

```
packages/egress-gateway/
├── cmd/egress/main.go              # entry point
├── proxy/
│   ├── http_proxy.go               # HTTP forward proxy with policy middleware
│   └── db_proxy.go                 # TCP proxy for PostgreSQL (port 6432)
├── policy/
│   ├── config.go                   # YAML config loader
│   ├── whitelist.go                # domain/DB host whitelist/blacklist
│   ├── rate_limiter.go             # token bucket per domain
│   └── learned.go                  # skill→server persistence
├── audit/
│   ├── logger.go                   # PostgreSQL audit log writer
│   └── retention.go                # archival to S3
├── dashboard/
│   ├── server.go                   # htmx dashboard on :9091
│   ├── sse.go                      # SSE live stream
│   └── templates/                  # Go html/template files
├── catalog/
│   ├── parser.go                   # Docker MCP Catalog YAML parser
│   └── sign.go                     # Ed25519 signature verification
├── spawn/
│   └── manager.go                  # child process spawn + stdio audit
├── metrics/
│   └── prometheus.go               # Prometheus metrics endpoint
└── go.mod
```

### Most important code paths (in order)

1. **HTTP proxy with policy check** — `proxy/http_proxy.go` `ServeHTTP` → `policy.CheckURL` → `audit.Log` → forward. This is the core of the gateway. Everything else builds on this.

2. **Broker transport swap** — `broker-go/.../http_client.go` line ~35: change `http.Client{Timeout: 30s}` to `http.Client{Transport: proxyTransport(gatewayURL)}`. One-line change, zero impact on the broker's API.

3. **Child process spawn with stdio audit** — `spawn/manager.go` `SpawnChild(config)` → `launcher.BuildCommand` → wrap stdin/stdout → return handles. The broker calls this instead of `cmd.Start()` directly.

4. **Dashboard SSE stream** — `dashboard/sse.go` → in-memory channel → `text/event-stream` to browser. Both broker audit events and gateway audit events flow through the same channel.

5. **Ephemeral MCP flow** — broker calls `gateway.SpawnChild(catalogEntry)` → gateway checks policy → spawns → returns handles → broker calls `tools/list` → registers tools.

### What gets released in v0.16.0

`neuralgentics-egress` v0.1.0 ships as a new Go binary alongside the existing `broker-go`. The broker gets a one-line transport change. The gateway is opt-in: if `EGRESS_GATEWAY_URL` is not set, the broker uses direct HTTP as before. The release includes:

- `neuralgentics-egress` binary (HTTP proxy + dashboard skeleton)
- `egress-gateway.yaml` example config
- Broker transport swap (backward-compatible)
- `gateway_audit_log` table migration for PostgreSQL

---

## Section 8: Open Questions

1. **Where does the egress gateway run?** Sidecar in the same container as the broker? Separate container? Separate host? Assumption for v0.1: same host, separate process (like the memini-ai sidecar). The broker connects to `localhost:9090`.

2. **Does the gateway need mTLS to the broker, or is localhost trust enough?** Assumption: localhost trust is sufficient for v0.1. The gateway only listens on `127.0.0.1:9090` (not `0.0.0.0`). mTLS can be added later if the gateway moves to a separate host.

3. **How does the gateway handle long-lived SSE connections (MCP streaming)?** The HTTP proxy must support streaming responses (the broker's `CallSSE` method in `http_client.go`). Assumption: the proxy passes through `text/event-stream` responses without buffering, but still logs the connection open/close and bytes transferred.

4. **What happens if the gateway is down — does the broker fail open or closed?** Assumption: fail closed (the broker returns an error to the LLM). This is the secure default. An env var `EGRESS_GATEWAY_MODE=open` can be added later for development.

5. **When a user wants to disable the gateway, what's the escape hatch?** Env var `EGRESS_GATEWAY_URL=` (empty) means the broker uses direct HTTP. This is the current behavior. Setting `EGRESS_GATEWAY_URL=http://localhost:9090` enables the gateway. No code change needed to toggle.

6. **Does the gateway need to intercept the broker's own MCP JSON-RPC calls to child processes, or only the child processes' outbound calls?** The broker→child MCP communication is already local stdio (not network). The gateway only needs to intercept the child's *outbound* calls (HTTP to external APIs, DB queries). The stdio audit layer is for visibility, not policy enforcement.

7. **How does the gateway discover which process a TCP connection belongs to?** On Linux, `/proc/<pid>/net/tcp` and `ss -tp` can map connections to PIDs. The gateway can use this to tag audit events with the originating process (broker vs. child MCP server). Assumption: best-effort for v0.1, precise in v0.2.

8. **What's the performance overhead of proxying all outbound HTTP through the gateway?** The gateway adds one extra hop on localhost (~0.1-0.5ms). Policy checks are in-memory (microseconds). The audit log write to PostgreSQL is async (fire-and-forget). Total overhead: <1ms per outbound call. Acceptable for v0.1.
