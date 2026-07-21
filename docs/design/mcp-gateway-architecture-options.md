# MCP Gateway Architecture Options for Neuralgentics

**Status:** Draft — awaiting user decision  
**Author:** boomerang-architect  
**Date:** 2026-07-19  
**References:**
- Kong AI MCP Proxy plugin: https://developer.konghq.com/plugins/ai-mcp-proxy/
- Docker MCP Gateway: https://github.com/docker/mcp-gateway (1.5k stars, Go)
- Microsoft MCP Gateway: https://github.com/microsoft/mcp-gateway (745 stars)
- TrueFoundry MCP Gateway vs Proxy vs Router: https://www.truefoundry.com/blog/mcp-gateway-vs-proxy-vs-router
- Docker MCP Catalog: https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/
- Docker Dynamic MCP Discovery: https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/
- ContextForge (IBM): https://ibm.github.io/mcp-context-forge/
- MCP Spec 2025-11-25 (Authorization): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

---

## Section 1: What a "gateway" actually adds over a "router"

A **router** answers one question: "which backend should handle this request?" It matches intents, dispatches to tools, and returns results. A **proxy** adds a single concern on top (e.g., auth, or caching). A **gateway** subsumes both and adds an **L7 control plane** — the layer where enterprise operations actually happen. This is the framing from TrueFoundry's "MCP Gateway vs. Proxy vs. Router" (May 2026). The gateway adds: (1) an **identity plane** (who is calling? SSO/OAuth2), (2) an **audit plane** (what was called, by whom, with what result?), (3) a **policy plane** (rate limits, egress whitelists/blacklists, per-role tool allow-lists), (4) a **dashboard** (real-time visibility into all of the above), and (5) **lifecycle management** (start/stop/register MCP servers at runtime). The existing neuralgentics broker is a router. The user wants to add a gateway layer on top — opt-in, so the router still works standalone.

---

## Section 2: The 4 architectural options

### Option A: In-Process Gateway ("Monolith Plus")

Add access control, audit, rate limiting, and a small embedded dashboard as new Go packages inside the existing `broker-go` binary. The gateway is a set of middleware that wraps the router's JSON-RPC handler.

```
Client → [broker-go binary]
            ├── Gateway Middleware (auth → rate-limit → audit → egress-filter)
            ├── Router (intent match → dispatch)
            └── Embedded Dashboard (net/http on :9090)
```

| Dimension | Assessment |
|-----------|-----------|
| **What you get** | Auth, rate limiting, audit, egress filtering, dashboard — all in one binary. Zero new processes. |
| **What it costs** | Broker binary grows from 783 LOC facade to ~3K+ LOC. Every gateway concern is coupled to the broker's release cycle. Dashboard is a Go `html/template` — limited interactivity. |
| **Lock-in risk** | HIGH. Gateway and router are the same binary. You can't use the gateway without the router, or vice versa. |
| **Hermes/LangChain portability** | LOW. The gateway is neuralgentics-specific. To reuse it with Hermes, you'd need to extract the gateway code into a library — essentially a rewrite. |
| **Ephemeral MCP support** | Possible but awkward. The broker would need to spawn child processes (MCP servers) from within the same binary, which complicates lifecycle management. |
| **Real-world example** | Docker MCP Gateway (1.5k stars) is a single Go binary that does routing + auth + catalog management. But it's a gateway-first design, not a router with gateway bolted on. |

### Option B: Sidecar Gateway + Thin Broker ("Control Plane / Data Plane Split")

Keep `broker-go` as-is (the data plane). Build a new `neuralgentics-gateway` binary (the control plane) that sits in front of the broker. The gateway handles auth, audit, rate limiting, egress filtering, and the dashboard. It forwards tool calls to the broker via JSON-RPC over localhost. Pattern from TrueFoundry (NATS-based control plane) and Microsoft MCP Gateway (separate data/control planes).

```
Client → [neuralgentics-gateway :8443]  ← control plane (auth, audit, rate-limit, dashboard)
              │  JSON-RPC over localhost
              ▼
         [broker-go :8080]              ← data plane (router only, unchanged)
              │
              ▼
         [MCP Servers]                  ← 15+ MCP servers
```

| Dimension | Assessment |
|-----------|-----------|
| **What you get** | Clean separation. Gateway can be updated independently of the router. Dashboard can be a real web app (React/HTMX) served by the gateway. |
| **What it costs** | Two binaries to deploy, two processes to monitor. Gateway ↔ broker communication adds ~1-2ms latency per call. Need a shared secret or mTLS between them. |
| **Lock-in risk** | MEDIUM. The gateway depends on the broker's JSON-RPC API, but the broker can still be used standalone (opt-in achieved). |
| **Hermes/LangChain portability** | MEDIUM. The gateway is protocol-aware (MCP JSON-RPC) but not neuralgentics-specific. You could swap the broker backend for a Hermes router by implementing the same JSON-RPC contract. |
| **Ephemeral MCP support** | GOOD. The gateway can manage MCP server lifecycle (spawn, health-check, register tools) independently of the router. The router just sees "here are the tools available now." |
| **Real-world example** | TrueFoundry's federated MCP gateway uses this exact split: control plane manages config/policies, data plane (gateway plane) handles request routing. NATS is the config distribution channel. Microsoft MCP Gateway also separates data plane (POST /mcp routing) from control plane (server lifecycle). |

### Option C: Universal MCP Gateway ("Protocol-Native Kong Clone")

Build `neuralgentics-gateway` as a from-scratch, protocol-native MCP gateway in Go. It implements a Kong-style plugin chain: OAuth2 → rate-limit → ACL → audit → egress-filter → router. The broker becomes one of many "backends" the gateway can route to. The gateway speaks pure MCP JSON-RPC and doesn't know about neuralgentics at all — it just routes `tools/call` requests. This is the "universal port" pattern.

```
Client → [neuralgentics-gateway :8443]  ← plugin chain (OAuth2 → rate-limit → ACL → audit → egress)
              │  JSON-RPC
              ├──→ [broker-go]          ← neuralgentics router (one backend)
              ├──→ [Hermes router]      ← future backend
              └──→ [LangChain router]   ← future backend
```

| Dimension | Assessment |
|-----------|-----------|
| **What you get** | Maximum portability. The gateway is a standalone product that works with any MCP-compatible backend. Plugin chain is extensible — add new filters without touching the router. Dashboard is a first-class feature. |
| **What it costs** | Most upfront work. You're building a Kong-like gateway from scratch. Plugin chain, session affinity, streaming responses (MCP uses SSE), config hot-reload — all need to be built. ~5-8K LOC estimate for v0.1. |
| **Lock-in risk** | LOW. The gateway is a standalone product. The broker can be used without it. The gateway can be used with any MCP backend. |
| **Hermes/LangChain portability** | HIGH. The gateway is protocol-native. Hermes and LangChain just need to speak MCP JSON-RPC to be routed through it. |
| **Ephemeral MCP support** | EXCELLENT. The gateway owns MCP server lifecycle. It can implement a catalog, spawn servers on demand, register their tools dynamically, and tear them down. This is the natural home for ephemeral MCP. |
| **Real-world example** | Kong's AI MCP Proxy plugin (enterprise, Lua/OpenResty) does exactly this — it's a protocol bridge that sits between MCP clients and any backend, with a plugin chain for auth, rate limiting, and logging. ContextForge (IBM, Apache 2.0) is a Go-based MCP gateway with plugin architecture, registry, and centralized governance. |

### Option D: Wrap an Existing OSS Gateway ("Stand on Shoulders")

Use an existing OSS gateway (Kong, Envoy with a custom MCP filter, or ContextForge) as the gateway layer. Write a thin adapter that teaches it about neuralgentics' tool catalog and skill system. Lowest build cost, highest external dependency.

```
Client → [Kong / ContextForge]  ← existing OSS gateway (auth, rate-limit, audit, dashboard)
              │  JSON-RPC
              ▼
         [neuralgentics adapter]  ← thin Go/Python service (catalog sync, skill mapping)
              │
              ▼
         [broker-go]              ← neuralgentics router (unchanged)
```

| Dimension | Assessment |
|-----------|-----------|
| **What you get** | Battle-tested gateway features immediately: Kong's plugin ecosystem (OAuth2, rate limiting, ACL, logging, Prometheus), Kong Manager dashboard, or ContextForge's registry + governance. |
| **What it costs** | External dependency on a complex product. Kong Enterprise is commercial (the AI MCP Proxy plugin is enterprise-only). Kong OSS (APISIX?) lacks the MCP plugin. ContextForge is Apache 2.0 but beta-quality. You're debugging someone else's gateway when things break. |
| **Lock-in risk** | HIGH. You're building on someone else's plugin API. If Kong deprecates the MCP plugin or ContextForge stagnates, you're stuck. |
| **Hermes/LangChain portability** | MEDIUM. The gateway is portable, but the adapter is neuralgentics-specific. You'd need a new adapter for each backend. |
| **Ephemeral MCP support** | LIMITED. Kong doesn't natively manage MCP server lifecycle. ContextForge has a registry but dynamic spawn/teardown is not its primary use case. You'd need to build the lifecycle management yourself anyway. |
| **Real-world example** | Kong AI MCP Proxy (enterprise) + Kong Manager dashboard. ContextForge (IBM, Apache 2.0) is a Go gateway with plugin architecture, MCP registry, and centralized governance — the closest OSS option. |

---

## Section 3: Ephemeral MCP pattern

The flow for runtime MCP discovery:

1. **Skill mentions a tool.** A skill definition says `requires: [prefect]`. The broker's intent matcher sees "prefect" but has no registered MCP server for it.

2. **Catalog lookup.** The broker queries a **catalog** — a registry of MCP server definitions. Each entry has: name, description, tools exposed, image/command to run, env vars, health check endpoint. Format options:
   - **Docker MCP Catalog format** (YAML, per-server file, `image` + `tools` list). Already defined at https://github.com/docker/mcp-registry. This is the most interoperable choice.
   - **Custom YAML/JSON** (simpler, but non-standard).
   - **OCI registry** (future-proof, but overengineered for now).

   **Recommendation:** Adopt the Docker MCP Catalog YAML format. It's the emerging standard, and you get compatibility with the Docker ecosystem for free.

3. **Spawn the server.** The gateway (or broker, depending on option) runs the command from the catalog entry — e.g., `podman run -d prefect-mcp` or `npx -y @prefect/mcp-server`. It waits for the health check to pass, then calls `tools/list` to discover the server's tools.

4. **Register tools.** The discovered tools are added to the broker's tool index with a TTL (e.g., 1 hour of inactivity). The MCP server runs for the session.

5. **Persist (optional).** If the skill is marked as `persist: true` or the user approves, the registration is saved to the catalog as a "learned skill → MCP server" mapping. Next time the skill is used, the server is pre-loaded.

6. **User approval.** New MCP servers require approval by default (interactive prompt: "Skill 'data-pipeline' wants to use Prefect MCP server. Allow? [y/N]"). Skills can be pre-approved via a signed allow-list. Auto-allow if the catalog entry is signed by a trusted author.

**Real-world precedent:** Docker's Dynamic MCP Discovery (https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/) allows agents to discover and use MCP servers at runtime from a catalog. The `--catalog` flag points to a YAML registry. Docker MCP Gateway supports `mcp add --from-catalog <name>` for on-the-fly installation.

**MCP protocol note:** The MCP spec (2025-11-25) does NOT define a server-registration RPC. Server discovery is outside the protocol. The `tools/list` method is server→client (the server advertises its tools to the client). There is no "register me" method. Dynamic registration must be built at the gateway/broker layer.

---

## Section 4: Dashboard feasibility

| Option | Dashboard approach | Data source | Real-time | Reference |
|--------|-------------------|-------------|-----------|-----------|
| **A: In-Process** | Go `html/template` + htmx on `:9090`. Limited interactivity. | In-memory counters + SQLite for audit log. | Polling (5s interval). | Docker MCP Gateway's built-in status page (minimal). |
| **B: Sidecar** | React or htmx web app served by the gateway binary. Full interactivity. | PostgreSQL (shared with memini-ai or dedicated). Gateway writes audit events; dashboard reads them. | SSE from gateway for live tool calls; polling for stats. | TrueFoundry's Gateway Plane dashboard (real-time metrics, config management). |
| **C: Universal** | Same as B, but the dashboard is a first-class product feature. Can be a separate micro-frontend. | PostgreSQL + optional ClickHouse for high-volume audit. | WebSocket for live tool-call stream; SSE for config updates. | Kong Manager (https://konghq.com/kong-manager) — full admin UI with service maps, traffic graphs, plugin config. |
| **D: Wrap OSS** | Use the existing gateway's dashboard (Kong Manager, ContextForge UI). | Whatever the gateway uses (PostgreSQL, Cassandra). | Whatever the gateway supports. | Kong Manager (enterprise) or ContextForge's built-in registry UI. |

**Recommendation for all options:** Start with a simple htmx dashboard backed by PostgreSQL (the same Postgres cluster already running for memini-ai). Add WebSocket/SSE for live updates in v2. Kong Manager is the gold standard for gateway dashboards — service maps, traffic graphs, plugin configuration, all in one UI.

---

## Section 5: Recommendation

**Recommended path: Option C — Universal MCP Gateway ("Protocol-Native Kong Clone")**

**Justification:**

1. **It's the "universal port" the user described.** The gateway speaks pure MCP JSON-RPC. It works with neuralgentics today, Hermes tomorrow, LangChain next year. The broker becomes one backend among many. This is the only option that truly decouples the MCP layer from the orchestration layer.

2. **Ephemeral MCP is a natural fit.** The gateway owns server lifecycle — spawn, health-check, register tools, tear down. This is awkward in Option A (monolith), possible but split across processes in Option B, and a bolt-on in Option D. Option C makes it a first-class feature.

3. **Plugin chain is the right abstraction.** Kong's plugin model (request transformer → rate limiter → OAuth2 → ACL → logging) has proven itself over a decade. Building a Go-native version of this for MCP JSON-RPC gives you extensibility without coupling. New plugins can be added without touching the router.

4. **The existing broker stays untouched.** Opt-in is achieved by design. The broker continues to work as a standalone router. The gateway is a separate binary that wraps it.

5. **Industry validation.** Kong (enterprise), ContextForge (IBM, Apache 2.0), and Microsoft MCP Gateway all converge on this pattern: a protocol-aware gateway with a plugin/ middleware chain, separate from the backend routers. This is not a novel idea — it's the emerging standard.

**First 3 things to build (in order):**

1. **Gateway skeleton + plugin chain** — A Go binary that accepts MCP JSON-RPC over HTTP, runs requests through a plugin chain (auth → rate-limit → audit → router), and forwards to the broker. ~2 weeks.
2. **Catalog + ephemeral MCP** — Docker MCP Catalog format parser, server spawn/health-check/register/teardown lifecycle, skill-to-catalog mapping. ~2 weeks.
3. **Dashboard + audit log** — PostgreSQL-backed audit log, htmx dashboard with live tool-call stream (SSE), rate-limit configuration UI. ~2 weeks.

**Risks:**
- Building a Kong clone is ambitious. Scope creep is the #1 risk. Mitigation: ship the plugin chain with exactly 4 plugins (OAuth2, rate-limit, ACL, audit) and stop. Add more later.
- MCP's Streamable HTTP transport (SSE) adds complexity for streaming tool responses. Mitigation: start with request/response only; add streaming in v2.
- The Docker MCP Catalog format may evolve. Mitigation: pin to a specific version and add a compatibility layer.

**Timeline:**

| Milestone | What ships |
|-----------|-----------|
| **1 week** | Gateway skeleton: JSON-RPC proxy with plugin chain (auth stub, rate-limit stub, audit stub). Forwards to broker. |
| **1 month** | Full plugin chain (OAuth2 via GitHub/Google SSO, token-bucket rate limiter, PostgreSQL audit log). Catalog parser + ephemeral MCP spawn. htmx dashboard v0.1. |
| **1 quarter** | Production-ready gateway. Dashboard v1.0 with live SSE stream. Egress whitelist/blacklist. Skill persistence. Hermes adapter proof-of-concept. |

---

## Section 6: The next decision

The user needs to choose between Options A, B, C, D. Once they pick, the next agent (coder or further architect) will draft the implementation plan with file paths, interface definitions, and a phased build order.

**Option A** is fastest to build but couples everything.  
**Option B** is a pragmatic middle ground.  
**Option C** is the universal port — most work upfront, most value long-term.  
**Option D** is the lowest build cost but highest external dependency risk.
