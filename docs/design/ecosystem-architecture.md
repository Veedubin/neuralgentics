# Neuralgentics Ecosystem Architecture

**Status:** Final Design — Ready for Implementation  
**Author:** boomerang-architect  
**Date:** 2026-07-19  
**Supersedes:** `mcp-gateway-architecture-options.md`, `mcp-gateway-hybrid-c-plus-b.md`

---

## Working Assumptions

These are the design-time assumptions made to close open questions. Each is documented so future engineers know what was decided and why.

| # | Assumption | Rationale |
|---|-----------|-----------|
| A1 | **License: MIT** for all new repos. | Matches existing neuralgentics and memini-ai-dev. Most permissive for adoption. |
| A2 | **GitHub org: Veedubin** for all repos. | Existing org. User already has repos there. No need for a new org at v0.1. |
| A3 | **Federation discovery: mDNS on LAN, static config for WAN.** | mDNS is zero-config for same-network peers (like Consul's Serf). Static config for cross-site. Tailscale as optional mesh layer. |
| A4 | **Config sync: Last-Writer-Wins with vector clocks.** | Simpler than Raft consensus. Adequate for config (whitelist/blacklist) which is low-write, human-driven. CRDTs are overkill for this use case. |
| A5 | **Audit aggregation: Push from gateways to team-server.** | Gateways push batches. If team-server is down, gateways buffer locally (SQLite) and retry. Simpler than pull model. |
| A6 | **Web UI framework: FastAPI + Jinja2 + htmx.** | Python matches the existing neuralgentics stack. htmx for interactivity without a JS framework. |
| A7 | **Gateway language: Go.** | Matches existing broker-go. Single binary, no runtime dependency. Container-friendly. |
| A8 | **mTLS cert provisioning: Manual for v0.1, ACME for v0.2.** | Start simple. Self-signed certs with pinning. Automate later. |
| A9 | **Gateway runs as sidecar on same host as broker.** | Localhost communication (no network latency). Separate process for isolation. Container for team deployments. |
| A10 | **First release target: v0.1.0 for all new repos.** | Semantic versioning. Pre-1.0 means "API may change." |

---

## Section 1: The 3-Repo Ecosystem

![Ecosystem Overview](diagrams/ecosystem-3-repos.mmd)

### Repository Summary

| Repo | Purpose | Audience | Default Deployment | License | Public/Private | v0.1 Target |
|------|---------|----------|-------------------|---------|----------------|-------------|
| **neuralgentics-gateway** | Egress proxy + federation + config sync. The "model jail." | Operators, platform engineers, anyone running LLM agents in production. | Container (`docker run neuralgentics-gateway`) | MIT | Public (github.com/Veedubin/neuralgentics-gateway) | v0.1.0 |
| **neuralgentics** | Orchestrator + broker + optional embedded web UI. The "brain." | Developers using OpenCode with neuralgentics. | npm (`npx @veedubin/neuralgentics --init`) | MIT | Public (github.com/Veedubin/neuralgentics) | v0.13.0 (next) |
| **neuralgentics-web** | Modular web UI shell. Part of neuralgentics, optional. | Team leads, operators who want a dashboard. | Embedded: `python -m neuralgentics.web`. Team-server: container. | MIT | Public (ships inside neuralgentics repo) | v0.1.0 (as neuralgentics sub-package) |
| **memini-ai-dev** | Memory backend. Unchanged. | Developers who need semantic memory for agents. | pip (`pip install memini-ai`) | MIT | Public (github.com/Veedubin/memini-ai-dev) | v0.8.2 (current) |

### Why MIT?

All four repos use MIT. Rationale:
- **Adoption:** MIT is the most permissive. Anyone can use, modify, and redistribute without restriction.
- **Consistency:** Existing repos (neuralgentics, memini-ai-dev) are already MIT. Changing would create confusion.
- **Ecosystem compatibility:** MIT is compatible with GPL, Apache 2.0, and proprietary licenses. No downstream restrictions.
- **Industry standard:** Kubernetes, React, VS Code, and most CNCF projects use Apache 2.0. MIT is even more permissive.

### Why Veedubin (not a new org)?

- User already has 10+ repos under `github.com/Veedubin`.
- A new org adds administrative overhead (billing, members, CI secrets) with no benefit at v0.1.
- If the ecosystem grows to 50+ repos, a dedicated `neuralgentics` org can be created later. The GitHub transfer tool preserves stars, issues, and redirects.

---

## Section 2: The "Model Bubble" — What the Gateway DOES and DOESN'T Touch

![Model Bubble Trust Boundary](diagrams/model-bubble.mmd)

### The Core Principle

The gateway is the **model jail**. It enforces policy on everything that leaves the model's process tree. It does NOT re-inspect traffic that is already authenticated at a lower layer.

### ✅ Gateway Inspects (Egress Enforcement)

| Traffic Type | What the Gateway Does |
|-------------|----------------------|
| **Outbound HTTP from broker/MCP servers to internet** | Checks URL against whitelist/blacklist (glob patterns). Adds `X-Egress-Request-Id` header. Captures request/response for audit. Rate-limits per domain. |
| **Outbound DB connections to NEW hosts** | Enforces DB host whitelist. Captures query metadata for audit (optional, off by default). Connection pool management. |
| **Child process spawn (ephemeral MCP)** | Resolves command against catalog. Checks image hash trust. Wraps stdio in audit layer. Enforces resource limits (memory, CPU, runtime). Prompts user for first-time approval. |

### ❌ Gateway Does NOT Inspect (Already Authenticated)

| Traffic Type | Why Not |
|-------------|---------|
| **Broker ↔ memini-ai** | Already SSL + Auth. memini-ai has its own authentication layer. Re-inspecting adds latency with zero security gain. |
| **Model ↔ Broker** | Already role-based ACL in broker (`access.go`). The broker is the model-facing surface — it owns access control. |
| **Gateway ↔ Team-Server** | Mutual TLS (mTLS) with certificate pinning. The gateway and team-server are in the same trust domain. |

### The "Model Jail" Concept

```
Model → can only call → Broker (ACL-gated)
Broker → can call → memini-ai (SSL+Auth, NOT inspected)
Broker → can call → Gateway (localhost proxy)
Gateway → can only call → Internet (policy-enforced)
Gateway → can NOT call → Model, Broker, memini-ai (one-way egress)
```

The model cannot reach the internet directly. The broker cannot reach the internet without going through the gateway. The gateway cannot reach back into the trusted zone. This is a one-way egress valve.

---

## Section 3: Federation — Multi-Gateway Mesh

![Federation Mesh Sequence](diagrams/federation-mesh.mmd)

### Peer Discovery

**LAN (same network):** mDNS (Multicast DNS). Gateways broadcast `_neuralgentics-gateway._tcp.local` on startup. Other gateways discover them automatically. Zero configuration. This is the same mechanism Consul uses via Serf (though Consul uses a custom gossip protocol on top of UDP; mDNS is simpler and adequate for small networks).

**WAN (cross-site):** Static peer list in `gateway.yaml`:
```yaml
federation:
  peers:
    - host: gateway-site-b.example.com
      port: 9443
      cert_fingerprint: "sha256:abc123..."
    - host: 10.0.1.50
      port: 9443
      cert_fingerprint: "sha256:def456..."
```

**Tailscale (optional):** If all gateways are on the same Tailscale tailnet, they can use Tailscale MagicDNS names (`gateway-a.tailnet-name.ts.net`) and Tailscale's built-in WireGuard encryption. This is the recommended approach for teams already using Tailscale.

**Reference:** HashiCorp Consul uses Serf (gossip protocol over UDP) for LAN discovery and WAN federation via TLS-encrypted TCP. Kubernetes federation (KubeFed) uses a central control plane with member cluster registration. Our approach is simpler: mDNS for LAN (zero-config), static config for WAN (explicit trust), Tailscale as optional mesh (encryption + NAT traversal).

### Config Sync

**Mechanism:** Last-Writer-Wins (LWW) with vector clocks.

When an admin adds a domain to the whitelist on Gateway A:
1. Gateway A updates its local config.
2. Gateway A gossips the update to all known peers: `{key: "whitelist", value: "*.prefect.io", clock: {A: 1, B: 0, C: 0}}`.
3. Gateway B receives the update. Its local clock for A is 0. The incoming clock for A is 1. `1 > 0`, so Gateway B accepts the update.
4. If two admins simultaneously add different domains on different gateways, both updates are accepted (they don't conflict — they're different keys). If they edit the same key, the higher vector clock wins.

**Why LWW + vector clocks instead of Raft consensus?**
- Config changes are low-write (human-driven, not machine-driven). Raft's leader election and log replication overhead is unnecessary.
- LWW is eventually consistent. For a whitelist, "eventually consistent" is acceptable — a few seconds of drift is harmless.
- Vector clocks provide causal ordering without a central coordinator.
- **Reference:** Amazon DynamoDB uses vector clocks for eventual consistency. Consul uses Raft for the KV store (strong consistency) but gossip for membership (eventual consistency). We're closer to the gossip model.

**Why not CRDTs?**
- CRDTs (Conflict-Free Replicated Data Types) guarantee strong eventual consistency — all replicas converge to the same state regardless of operation order. This is ideal for collaborative text editing (e.g., Google Docs) but overkill for a simple key-value config store. LWW with vector clocks is simpler to implement and debug.

### Audit Data Aggregation

**Mechanism:** Push from gateways to team-server.

1. Each gateway writes audit events to its local buffer (in-memory ring buffer + SQLite fallback).
2. Every 5 seconds (configurable), the gateway pushes a batch of audit events to the team-server via `POST /api/v1/audit/batch`.
3. The team-server writes them to PostgreSQL.
4. If the team-server is unreachable, the gateway buffers events locally (SQLite) and retries with exponential backoff (max 5 minutes between retries).
5. When the team-server comes back, the gateway flushes its buffer.

**Team-server URL:** Configured in `gateway.yaml`:
```yaml
team_server:
  url: https://team-server.example.com:8443
  cert_fingerprint: "sha256:abc123..."
```

**What happens if the team-server is down?**
- Gateways continue to operate normally (policy enforcement is local).
- Audit events are buffered locally. No data loss as long as the buffer doesn't overflow (configurable max buffer size; default 10,000 events).
- When the team-server returns, buffered events are pushed in order.

### Team-Server Selection

**v0.1:** Static URL in config. One team-server per site.

**v0.2+:** DNS SRV record (`_neuralgentics-team._tcp.example.com`) for automatic discovery. Multiple team-servers for HA (active-passive with PostgreSQL streaming replication).

---

## Section 4: The Modular Web UI (neuralgentics-web)

![Modular Web UI](diagrams/modular-web-ui.mmd)

### Module Manifest Format

Each module is a directory with a `module.yaml` manifest:

```yaml
# modules/gateway-audit/module.yaml
name: gateway-audit
version: 0.1.0
display_name: "Gateway Audit Dashboard"
description: "Real-time egress traffic monitoring and policy management"
author: "Neuralgentics Team"
license: MIT

# Routes the module registers
routes:
  - path: /gateway
    method: GET
    handler: gateway_audit.routes:dashboard
  - path: /gateway/live
    method: GET
    handler: gateway_audit.routes:live_traffic
  - path: /gateway/policy
    method: GET
    handler: gateway_audit.routes:policy_editor
  - path: /api/gateway/policy
    method: POST
    handler: gateway_audit.routes:update_policy

# Dashboards the module contributes
dashboards:
  - id: gateway-overview
    title: "Gateway Overview"
    panel: gateway_audit.panels:overview
  - id: gateway-traffic
    title: "Live Traffic"
    panel: gateway_audit.panels:traffic_stream

# SSE channels the module subscribes to
sse_channels:
  - name: gateway-events
    handler: gateway_audit.sse:gateway_events

# Python dependencies
requires:
  - fastapi>=0.100.0
  - httpx>=0.24.0
```

**Reference:** Grafana's `plugin.json` manifest defines `id`, `name`, `type` (app/datasource/panel), `routes`, and `includes`. VS Code's `package.json` manifest uses `contributes` with `commands`, `views`, `menus`. Our `module.yaml` is a hybrid: Grafana's route/dashboard registration + VS Code's contribution point pattern.

### Registration Lifecycle

1. **Discovery:** On startup, the web core scans `modules/` directory (or a configurable `MODULES_PATH` env var) for directories containing `module.yaml`.
2. **Validation:** Each manifest is validated against a JSON Schema. Invalid manifests are logged and skipped.
3. **Import:** The module's Python package is imported (`importlib.import_module`).
4. **Route Registration:** Routes from the manifest are registered with the FastAPI router.
5. **Dashboard Registration:** Dashboard panels are registered in the dashboard registry.
6. **SSE Subscription:** SSE channel handlers are connected to the SSE hub.
7. **Health Check:** Each module can expose a `/health` endpoint. The core pings it on startup.

### Module Discovery

- **Embedded mode:** Modules are discovered from `neuralgentics/web/modules/` (ships with the package).
- **Team-server mode:** Modules are discovered from a mounted volume (`/etc/neuralgentics/modules/`). Additional modules can be installed via `neuralgentics-web module install <git-url>`.
- **Auto-discovery from gateways:** In team-server mode, the web core queries connected gateways for their available modules and offers them in the UI.

### Modules Shipping in v0.1

| Module | Purpose | Key Features |
|--------|---------|-------------|
| **gateway-audit** | Egress traffic monitoring | Live traffic stream (SSE), domain whitelist/blacklist editor, rate limit configuration, blocked request log |
| **broker-audit** | Tool call metrics | Tool call success/failure rates, latency histograms, per-model usage stats, access control audit |
| **memini-browser** | Memory explorer | Semantic search over memories, trust score visualization, knowledge graph explorer, thought chain viewer |

### Embedded vs Team-Server Mode

The SAME code runs in both modes. The difference is configuration:

| Aspect | Embedded Mode | Team-Server Mode |
|--------|--------------|-----------------|
| **Start command** | `python -m neuralgentics.web` | `docker run neuralgentics-web` |
| **Data source** | Reads from local gateway (localhost:9091) | Reads from PostgreSQL (team audit DB) |
| **Auth** | None (localhost only) | JWT + OAuth2 (Google/GitHub SSO) |
| **Modules** | Built-in only | Built-in + user-installed |
| **Multi-tenant** | No (single user) | Yes (team members with roles) |
| **Persistence** | None (in-memory only) | PostgreSQL |

The mode is detected via env var: `NEURALGENTICS_WEB_MODE=embedded|team`.

### Auth Model

- **Embedded mode:** No auth. Listens on `127.0.0.1` only.
- **Team-server mode:** JWT tokens issued by an OAuth2 proxy (Google/GitHub SSO). Session cookies for the web UI. API keys for service accounts (gateways pushing audit data).
- **mTLS:** Between gateways and team-server for audit push. Certificates are self-signed with fingerprint pinning in v0.1.

---

## Section 5: Repository Structure

### neuralgentics-gateway (NEW)

```
neuralgentics-gateway/
├── cmd/
│   └── gateway/
│       └── main.go                  # Entry point: flag parsing, starts all services
├── internal/
│   ├── proxy/
│   │   ├── http_proxy.go            # HTTP forward proxy with policy middleware
│   │   └── db_proxy.go              # TCP proxy for PostgreSQL (port 6432)
│   ├── policy/
│   │   ├── engine.go                # Policy evaluation engine
│   │   ├── whitelist.go             # Domain/DB host whitelist/blacklist (glob matching)
│   │   ├── rate_limiter.go          # Token bucket per domain
│   │   └── config.go                # YAML config loader + hot-reload
│   ├── federation/
│   │   ├── discovery.go             # mDNS peer discovery + static config
│   │   ├── gossip.go                # Config sync via LWW + vector clocks
│   │   └── peer.go                  # Peer state machine (connected/disconnected/timeout)
│   ├── audit/
│   │   ├── logger.go                # Audit event writer (ring buffer + SQLite fallback)
│   │   ├── pusher.go                # Batch push to team-server
│   │   └── schema.go                # Audit event schema + PG migrations
│   ├── spawn/
│   │   └── manager.go               # Child process spawn + stdio audit + resource limits
│   ├── catalog/
│   │   ├── parser.go                # Docker MCP Catalog YAML parser
│   │   └── trust.go                 # Image hash verification + signature check
│   └── dashboard/
│       ├── server.go                # Embedded dashboard (read-only, localhost only)
│       └── sse.go                   # SSE stream for live traffic
├── config/
│   └── gateway.example.yaml         # Example configuration with all options documented
├── docker/
│   ├── Dockerfile                   # Multi-stage build (scratch final image)
│   └── docker-compose.example.yaml  # Example compose with gateway + team-server + PG
├── docs/
│   ├── ARCHITECTURE.md              # Internal architecture (for contributors)
│   ├── INSTALL.md                   # Installation guide
│   ├── CONFIG.md                    # Configuration reference
│   └── FEDERATION.md                # Federation setup guide
├── go.mod
├── go.sum
├── Makefile                         # build, test, lint, docker-build, docker-push
├── README.md                        # Project overview + quickstart
├── LICENSE                          # MIT
└── .github/
    └── workflows/
        ├── ci.yaml                  # Lint + test + build on PR
        └── release.yaml             # Build container + push to ghcr.io on tag
```

### neuralgentics (EXISTING, MODIFIED)

```
neuralgentics/
├── packages/
│   ├── broker-go/                   # (existing, modified)
│   │   └── src/neuralgentics/broker/
│   │       └── proxy/
│   │           └── http_client.go   # +1 line: transport swap to gateway proxy
│   ├── plugin/                      # (existing, unchanged)
│   ├── sdk/                         # (existing, unchanged)
│   └── web/                         # NEW: modular web UI
│       ├── core/
│       │   ├── __init__.py
│       │   ├── app.py               # FastAPI app factory
│       │   ├── router.py            # Route registry
│       │   ├── sse_hub.py           # SSE channel manager
│       │   ├── auth.py              # JWT + OAuth2 middleware
│       │   └── module_loader.py     # Module discovery + manifest parser
│       ├── modules/
│       │   ├── gateway-audit/       # Gateway audit dashboard module
│       │   │   ├── module.yaml
│       │   │   ├── routes.py
│       │   │   ├── panels.py
│       │   │   └── sse.py
│       │   ├── broker-audit/        # Broker audit dashboard module
│       │   │   ├── module.yaml
│       │   │   ├── routes.py
│       │   │   ├── panels.py
│       │   │   └── sse.py
│       │   └── memini-browser/      # Memory browser module
│       │       ├── module.yaml
│       │       ├── routes.py
│       │       ├── panels.py
│       │       └── kg_viz.py
│       ├── templates/               # Jinja2 templates (shared)
│       ├── static/                  # CSS, JS, htmx (shared)
│       ├── __init__.py
│       └── __main__.py              # python -m neuralgentics.web entry point
├── docker/
│   └── Dockerfile.web               # Team-server container build
└── (existing files unchanged)
```

### memini-ai-dev (EXISTING, UNCHANGED)

No changes. The gateway does not inspect memini-ai traffic. The web UI's `memini-browser` module reads from memini-ai's PostgreSQL directly (read-only).

---

## Section 6: Deployment Topologies

![Deployment Topologies](diagrams/deployment-topologies.mmd)

### Topology 1: Solo Developer

**Use case:** One developer on one machine. No team, no federation.

**docker-compose.yml:**
```yaml
version: "3.8"
services:
  postgres:
    image: timescale/timescaledb-ha:pg18
    environment:
      POSTGRES_USER: neuralgentics
      POSTGRES_PASSWORD: neuralgentics
      POSTGRES_DB: neuralgentics
    ports:
      - "5434:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  memini-ai:
    image: ghcr.io/veedubin/memini-ai-dev:v0.8.2
    environment:
      MEMINI_DB_URL: postgresql://neuralgentics:neuralgentics@postgres:5432/neuralgentics
    ports:
      - "8000:8000"
    depends_on:
      - postgres

  gateway:
    image: ghcr.io/veedubin/neuralgentics-gateway:v0.1.0
    ports:
      - "9090:9090"   # HTTP proxy
      - "9091:9091"   # Dashboard
    volumes:
      - ./gateway.yaml:/etc/neuralgentics/gateway.yaml
    network_mode: host  # So it can intercept broker's localhost traffic

volumes:
  pgdata:
```

**Env vars for the broker:**
```bash
export EGRESS_GATEWAY_URL=http://localhost:9090
export NEURALGENTICS_WEB_MODE=embedded
```

**Start the web UI:**
```bash
python -m neuralgentics.web
# Opens http://localhost:9091
```

### Topology 2: Small Team (3-10 people)

**Use case:** Multiple developers, each with their own gateway. Shared team-server for audit aggregation.

**Per-developer docker-compose.yml:**
```yaml
services:
  gateway:
    image: ghcr.io/veedubin/neuralgentics-gateway:v0.1.0
    ports:
      - "9090:9090"
    volumes:
      - ./gateway.yaml:/etc/neuralgentics/gateway.yaml
    environment:
      GATEWAY_PEER_ID: gw-${HOSTNAME}
      TEAM_SERVER_URL: https://team-server.internal.example.com:8443
      TEAM_SERVER_CERT_FINGERPRINT: sha256:abc123...
    network_mode: host
```

**Team-server docker-compose.yml (shared infrastructure):**
```yaml
services:
  team-server:
    image: ghcr.io/veedubin/neuralgentics-web:v0.1.0
    ports:
      - "8443:8443"
    environment:
      NEURALGENTICS_WEB_MODE: team
      DATABASE_URL: postgresql://neuralgentics:neuralgentics@postgres:5432/neuralgentics
      OAUTH2_CLIENT_ID: ${OAUTH2_CLIENT_ID}
      OAUTH2_CLIENT_SECRET: ${OAUTH2_CLIENT_SECRET}
    volumes:
      - ./certs:/etc/neuralgentics/certs:ro
    depends_on:
      - postgres

  postgres:
    image: timescale/timescaledb-ha:pg18
    environment:
      POSTGRES_USER: neuralgentics
      POSTGRES_PASSWORD: neuralgentics
      POSTGRES_DB: neuralgentics
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

**Network topology:**
- Each developer's gateway listens on `localhost:9090` (HTTP proxy) and `localhost:9091` (dashboard).
- Gateways discover each other via mDNS on the LAN.
- All gateways push audit data to the shared team-server via mTLS.
- Developers access the team-server at `https://team-server.internal.example.com:8443`.

### Topology 3: Enterprise (50+ users)

**Use case:** Multiple sites, each with its own team-server. Central admin for read-only aggregation. Enterprise SSO.

**Per-site docker-compose.yml:**
```yaml
services:
  gateway-primary:
    image: ghcr.io/veedubin/neuralgentics-gateway:v0.1.0
    environment:
      GATEWAY_PEER_ID: gw-site-a-1
      TEAM_SERVER_URL: https://team-server-site-a.internal.example.com:8443
    # ... (same as small team)

  gateway-failover:
    image: ghcr.io/veedubin/neuralgentics-gateway:v0.1.0
    environment:
      GATEWAY_PEER_ID: gw-site-a-2
      GATEWAY_MODE: failover
      GATEWAY_PRIMARY_URL: http://gateway-primary:9090
    # Standby. Takes over if primary health check fails.

  team-server:
    image: ghcr.io/veedubin/neuralgentics-web:v0.1.0
    environment:
      NEURALGENTICS_WEB_MODE: team
      CENTRAL_ADMIN_URL: https://admin.example.com:8443
      # ... (same as small team)
```

**Central admin docker-compose.yml:**
```yaml
services:
  central-admin:
    image: ghcr.io/veedubin/neuralgentics-web:v0.1.0
    environment:
      NEURALGENTICS_WEB_MODE: central-admin
      SITE_SERVERS: "https://team-server-site-a.example.com:8443,https://team-server-site-b.example.com:8443"
      SSO_PROVIDER: oidc
      OIDC_ISSUER: https://sso.example.com
    ports:
      - "443:8443"
```

**Key differences from small team:**
- **Failover gateways** per site (active-passive).
- **Central admin server** aggregates audit data from all site team-servers (read-only).
- **Enterprise SSO** (SAML/OIDC) at the central admin tier.
- **Site team-servers** are the authoritative audit stores. Central admin is a read-only view.

---

## Section 7: Security Model

![Security Model](diagrams/security-model.mmd)

### Trust Zones

| Zone | Name | Contains | Auth Mechanism | Gateway Role |
|------|------|----------|---------------|-------------|
| 0 | Model Jail | LLM/Model | Broker ACL | N/A (model can't reach gateway directly) |
| 1 | Broker | Broker (MCP Router) | Role-based ACL | N/A (broker calls gateway over localhost) |
| 2 | Gateway | Egress Gateway | Policy Engine | **Enforcer** — inspects all outbound traffic |
| 3 | Internal Services | memini-ai, PostgreSQL | SSL + DB passwords | **Does NOT inspect** — already authenticated |
| 4 | Internet | External APIs | API keys, OAuth2 tokens | **Whitelist enforced** — domain + CIDR |
| 5 | Team Infrastructure | Team Server | mTLS + cert pinning | **Pushes audit data** — config sync |

### Auth at Every Boundary

| Boundary | Auth Mechanism | v0.1 | v0.2+ |
|----------|---------------|------|-------|
| Model → Broker | Broker ACL (role-based) | ✅ Existing | ✅ |
| Broker → memini-ai | SSL + API key | ✅ Existing | ✅ |
| Broker → Gateway | Localhost (127.0.0.1 only) | ✅ | mTLS (if gateway moves off-host) |
| Gateway → Internet | Policy engine (whitelist) | ✅ | + egress firewall integration |
| Gateway → Team Server | mTLS + cert pinning | ✅ Self-signed | ACME (Let's Encrypt) |
| User → Team Server (Web UI) | JWT + OAuth2 (Google/GitHub) | ✅ | + SAML/OIDC for enterprise |
| Gateway → Gateway (Federation) | mTLS + cert pinning | ✅ Self-signed | ACME |

### Certificate Management

**v0.1:** Self-signed certificates with SHA-256 fingerprint pinning.
- Each gateway generates a self-signed cert on first run (`gateway cert init`).
- The cert fingerprint is shared out-of-band (pasted into team-server config, peer config).
- Fingerprints are pinned — any cert change requires manual re-pinning.

**v0.2+:** ACME (Let's Encrypt) for team-server. Gateways continue with self-signed + pinning (they're internal).

**Tailscale (optional):** If all gateways and the team-server are on the same Tailscale tailnet, Tailscale's built-in WireGuard encryption provides an additional layer. Cert pinning is still recommended (defense in depth).

### Whitelist/Blacklist Model

```yaml
# gateway.yaml
policy:
  egress:
    # Domain patterns (glob)
    whitelist:
      - "*.github.com"
      - "*.prefect.io"
      - "api.openai.com"
      - "*.ollama.com"
      - "*.anthropic.com"
      - "*.googleapis.com"

    # CIDR ranges
    whitelist_cidr:
      - "10.0.0.0/8"       # Internal network
      - "172.16.0.0/12"    # Docker network

    # Always blocked (takes precedence over whitelist)
    blacklist:
      - "169.254.169.254"  # AWS metadata endpoint
      - "metadata.google.internal"  # GCP metadata endpoint
      - "localhost"         # Prevent loopback attacks
      - "127.0.0.0/8"
      - "::1"

    # DB hosts (host:port patterns)
    db_whitelist:
      - "localhost:5434"    # memini-ai PG
      - "localhost:6200"    # neuralgentics PG

    # Rate limits (requests per minute per domain)
    rate_limits:
      "api.github.com": 100
      "api.prefect.io": 10
      "api.openai.com": 50
      default: 30
```

---

## Section 8: Build Order

### Week 1: Gateway Skeleton

**Goal:** A Go binary that starts an HTTP forward proxy with policy middleware. Broker transport swap is one line.

**Files created:**

| File | Purpose | LOC (est.) |
|------|---------|------------|
| `cmd/gateway/main.go` | Entry point: flag parsing, starts HTTP proxy + dashboard | ~80 |
| `internal/proxy/http_proxy.go` | HTTP forward proxy with policy check middleware | ~200 |
| `internal/policy/whitelist.go` | Domain whitelist/blacklist with glob matching | ~120 |
| `internal/policy/config.go` | YAML config loader | ~80 |
| `internal/audit/logger.go` | Audit event writer (ring buffer + SQLite) | ~150 |
| `internal/audit/schema.go` | Audit event schema + PG migration | ~60 |
| `internal/dashboard/server.go` | Embedded dashboard (read-only, localhost) | ~100 |
| `config/gateway.example.yaml` | Example config | ~50 |
| `go.mod` | Module definition | ~10 |
| `Makefile` | Build targets | ~30 |
| `docker/Dockerfile` | Multi-stage container build | ~30 |

**Files modified:**

| File | Change | LOC |
|------|--------|-----|
| `neuralgentics/packages/broker-go/.../http_client.go` | Transport swap: `http.Client{Transport: proxyTransport(gatewayURL)}` | +3 |

**Acceptance criteria:**
- `neuralgentics-gateway` binary starts, listens on `:9090` (HTTP proxy) and `:9091` (dashboard).
- Broker's outbound HTTP calls are routed through the gateway.
- Whitelisted domains pass through; blacklisted domains are blocked (HTTP 403).
- Audit events are written to SQLite (local buffer).
- Dashboard shows live traffic (SSE).
- Existing `--init` flow still works with `EGRESS_GATEWAY_URL` unset (backward compatible).

### Month 1: Federation + Full Policy

**Goal:** Multi-gateway mesh with config sync. Full policy engine. Team-server audit aggregation.

**Files created:**

| File | Purpose | LOC |
|------|---------|-----|
| `internal/federation/discovery.go` | mDNS peer discovery + static config | ~150 |
| `internal/federation/gossip.go` | Config sync via LWW + vector clocks | ~200 |
| `internal/federation/peer.go` | Peer state machine | ~100 |
| `internal/policy/rate_limiter.go` | Token bucket per domain | ~100 |
| `internal/audit/pusher.go` | Batch push to team-server | ~120 |
| `internal/proxy/db_proxy.go` | TCP proxy for PostgreSQL | ~150 |
| `internal/spawn/manager.go` | Child process spawn + stdio audit | ~200 |
| `internal/catalog/parser.go` | Docker MCP Catalog YAML parser | ~120 |
| `internal/catalog/trust.go` | Image hash verification | ~80 |
| `packages/web/core/*` | Web core shell (FastAPI + module loader) | ~400 |
| `packages/web/modules/gateway-audit/*` | Gateway audit dashboard module | ~300 |
| `packages/web/modules/broker-audit/*` | Broker audit dashboard module | ~250 |
| `packages/web/modules/memini-browser/*` | Memory browser module | ~250 |

**Acceptance criteria:**
- Three gateways on the same LAN discover each other via mDNS.
- Config change on one gateway propagates to all peers within 5 seconds.
- Audit events from all gateways appear in the team-server dashboard.
- Team-server downtime: gateways buffer locally, flush when it returns.
- Ephemeral MCP: broker requests spawn, gateway checks catalog trust, spawns server, returns stdio handles.
- Web UI shows all three dashboards (gateway, broker, memini).

### Quarter 1: Production-Ready

**Goal:** Enterprise features. Central admin. SSO. Prometheus metrics. Documentation.

**Files created:**

| File | Purpose | LOC |
|------|---------|-----|
| `internal/metrics/prometheus.go` | Prometheus metrics endpoint | ~80 |
| `internal/audit/retention.go` | Audit log retention + archival | ~100 |
| `packages/web/core/auth.py` | JWT + OAuth2 + SAML/OIDC | ~300 |
| `packages/web/core/central_admin.py` | Central admin aggregation | ~200 |
| `docs/*` | Full documentation set (see Section 9) | ~2000 lines |

**Acceptance criteria:**
- Prometheus metrics: `gateway_requests_total`, `gateway_blocks_total`, `gateway_latency_seconds`.
- Central admin aggregates audit data from multiple site team-servers.
- Enterprise SSO (SAML/OIDC) at central admin tier.
- Audit log retention: configurable TTL, archival to S3-compatible storage.
- All documentation complete (Section 9).

---

## Section 9: Documentation Deliverables

### Per-Repo Documentation

#### neuralgentics-gateway

| Doc | Path | Audience | Key Content | Diagrams |
|-----|------|----------|-------------|----------|
| **README.md** | Root | Everyone | What it is, quickstart (docker run), key features, link to full docs | ecosystem-3-repos.mmd |
| **ARCHITECTURE.md** | `docs/` | Contributors | Internal architecture, proxy pipeline, policy engine, federation protocol | model-bubble.mmd, federation-mesh.mmd |
| **INSTALL.md** | `docs/` | Operators | Docker install, binary install, config file walkthrough, verification steps | deployment-topologies.mmd (Topology 1) |
| **CONFIG.md** | `docs/` | Operators | Every config option documented with examples, env var reference, YAML schema | — |
| **FEDERATION.md** | `docs/` | Operators | Peer discovery setup, mTLS cert generation, config sync troubleshooting | federation-mesh.mmd |
| **SECURITY.md** | `docs/` | Security teams | Trust model, auth boundaries, cert management, threat model, responsible disclosure | security-model.mmd |
| **CONTRIBUTING.md** | Root | Contributors | Dev setup, build instructions, test commands, PR process, code style | — |
| **RUNBOOK.md** | `docs/` | Operators | Common operations: add peer, rotate certs, update whitelist, troubleshoot federation, backup/restore | — |

#### neuralgentics (web UI additions)

| Doc | Path | Audience | Key Content | Diagrams |
|-----|------|----------|-------------|----------|
| **WEB_UI.md** | `docs/` | Developers | Module system, manifest format, how to build a module, API reference | modular-web-ui.mmd |
| **DEPLOYMENT.md** | `docs/` | Operators | All three topologies with docker-compose examples, env var reference, scaling guide | deployment-topologies.mmd |

#### Ecosystem Overview (root-level)

| Doc | Path | Audience | Key Content | Diagrams |
|-----|------|----------|-------------|----------|
| **ECOSYSTEM.md** | `neuralgentics/docs/` | Everyone | How the 3 repos fit together, what each does, which one to install for your use case, architecture decision records | ecosystem-3-repos.mmd, model-bubble.mmd |

---

## Section 10: The 3-Repo Decision Matrix

| Repo | Public/Private | License | v0.1 Ships In | Owner | Dependencies |
|------|---------------|---------|---------------|-------|-------------|
| **neuralgentics-gateway** | Public | MIT | 1 week (skeleton) | Veedubin | Go 1.22+, SQLite (embedded), PostgreSQL (team-server audit) |
| **neuralgentics** | Public | MIT | v0.13.0 (next release) | Veedubin | TypeScript (plugin), Python 3.12+ (web UI), Go (broker) |
| **neuralgentics-web** | Public (in neuralgentics) | MIT | 1 month (with gateway) | Veedubin | FastAPI, Jinja2, htmx, PostgreSQL (team mode only) |
| **memini-ai-dev** | Public | MIT | v0.8.2 (current, unchanged) | Veedubin | Python 3.12+, PostgreSQL 18 + pgvector |

---

## Section 11: Recommendation — First 3 Cards to Dispatch

### Card 1: Gateway Skeleton (`GATEWAY-001`)

**Scope:** Create the `neuralgentics-gateway` repo with a working HTTP forward proxy, policy engine, and audit logger.

**Files:**
- `cmd/gateway/main.go`
- `internal/proxy/http_proxy.go`
- `internal/policy/whitelist.go`
- `internal/policy/config.go`
- `internal/audit/logger.go`
- `internal/audit/schema.go`
- `internal/dashboard/server.go`
- `config/gateway.example.yaml`
- `go.mod`, `Makefile`, `docker/Dockerfile`, `README.md`, `LICENSE`

**Acceptance criteria:**
1. `make build` produces a `neuralgentics-gateway` binary.
2. Binary starts, listens on `:9090` (proxy) and `:9091` (dashboard).
3. Whitelisted domains pass through; blacklisted domains return HTTP 403.
4. Audit events written to SQLite.
5. Dashboard shows live traffic via SSE.
6. `make test` passes (unit tests for whitelist matching, policy evaluation).
7. `make lint` passes (`go vet`, `golangci-lint`).

**Estimated LOC:** ~900 new Go code + ~100 config/docs.

### Card 2: Broker Transport Swap (`BROKER-001`)

**Scope:** Modify the broker's HTTP client to route through the gateway when `EGRESS_GATEWAY_URL` is set.

**Files:**
- `neuralgentics/packages/broker-go/src/neuralgentics/broker/proxy/http_client.go` (+3 lines)

**Acceptance criteria:**
1. When `EGRESS_GATEWAY_URL=http://localhost:9090` is set, broker's outbound HTTP calls go through the gateway.
2. When `EGRESS_GATEWAY_URL` is unset, broker uses direct HTTP (backward compatible).
3. Existing `--init` flow works in both modes.
4. Gateway audit log shows broker's outbound calls.

**Estimated LOC:** +3 (one-line transport swap).

### Card 3: Federation Peer Discovery (`GATEWAY-002`)

**Scope:** Add mDNS peer discovery and static peer config to the gateway.

**Files:**
- `internal/federation/discovery.go`
- `internal/federation/peer.go`
- `internal/federation/gossip.go` (config sync stub — LWW with vector clocks)

**Acceptance criteria:**
1. Two gateways on the same LAN discover each other via mDNS within 10 seconds of startup.
2. Static peer config works for WAN peers.
3. Peer state machine: connected → disconnected (timeout after 30s no heartbeat) → reconnected.
4. Config sync stub: a config change on one gateway is gossiped to peers (LWW merge).
5. `make test` passes (unit tests for mDNS discovery, peer state machine, vector clock merge).

**Estimated LOC:** ~450 new Go code.

---

## Diagram Index

All diagrams are in `docs/design/diagrams/`. Each is a standalone `.mmd` file (Mermaid syntax) that renders natively on GitHub, in VS Code, and in many documentation tools.

| File | Section | Purpose | What to Look For |
|------|---------|---------|-----------------|
| `ecosystem-3-repos.mmd` | Section 1 | 3-repo ecosystem overview | How gateway, neuralgentics, and memini-ai connect. The gateway sits behind the broker, not in front. |
| `model-bubble.mmd` | Section 2 | Trust boundary | Green = trusted (not inspected). Pink = internet (inspected). Blue = team infra (mTLS). |
| `federation-mesh.mmd` | Section 3 | Multi-gateway config sync | Sequence diagram: peer discovery → config gossip → audit push → buffer on team-server down. |
| `modular-web-ui.mmd` | Section 4 | Module system | Core shell + 3 modules (gateway-audit, broker-audit, memini-browser) + module.yaml manifest. |
| `deployment-topologies.mmd` | Section 6 | 3 reference architectures | Solo (1 machine), Small Team (multi-machine + shared TS), Enterprise (multi-site + central admin). |
| `security-model.mmd` | Section 7 | Security zones | 5 trust zones color-coded. Auth mechanism at every boundary. The "model jail" concept visualized. |

---

## References

- **HashiCorp Consul Gossip Protocol:** https://developer.hashicorp.com/consul/docs/concept/gossip — Serf-based gossip for membership and broadcast. Used as reference for mDNS peer discovery.
- **Kubernetes Federation (KubeFed):** https://www.tigera.io/learn/guides/kubernetes-security/kubernetes-federation/ — Centralized control plane with member cluster registration. Used as reference for multi-site architecture.
- **Grafana Plugin Anatomy:** https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin — `plugin.json` manifest with `routes`, `includes`, panel registration. Used as reference for `module.yaml` format.
- **VS Code Extension Manifest:** https://code.visualstudio.com/api/references/extension-manifest — `package.json` with `contributes` points. Used as reference for module contribution pattern.
- **CRDTs:** https://crdt.tech/ — Conflict-Free Replicated Data Types. Evaluated and rejected for config sync (overkill for low-write key-value store).
- **Prior Design Docs:**
  - `mcp-gateway-architecture-options.md` — Options A/B/C/D analysis. Option C (universal gateway) selected, then refined to hybrid C+B (egress proxy behind broker).
  - `mcp-gateway-hybrid-c-plus-b.md` — Hybrid design with broker-first, gateway-behind. This doc supersedes it with the full 3-repo ecosystem.
