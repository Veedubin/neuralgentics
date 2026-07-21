# neuralgentics-web — Operator's Configuration Reference

`neuralgentics-web` is a modular FastAPI web shell with a Grafana-style
plugin manifest system. This document is the **operator's reference**:
every CLI flag, every environment variable, every config-file knob, with
examples. For a high-level introduction and quickstart, see
[README.md](./README.md) and the [standalone walkthrough](./STANDALONE.md).

---

## 1. Quickstart

```bash
pip install neuralgentics-web
neuralgentics-web --mode=embedded --port=9876
# Open http://localhost:9876 in a browser.
```

For Postgres-backed team-server mode (multi-user, persistence):

```bash
pip install neuralgentics-web[team-server]
neuralgentics-web --mode=team-server --db-url=postgres://user:pass@host:5432/db
```

See [README.md](./README.md) for install extras and the module-development
guide, and [STANDALONE.md](./STANDALONE.md) for a full first-time walkthrough
that writes a custom module and wires up OIDC.

---

## 2. CLI flags

The `neuralgentics-web` command (and the equivalent `python -m
neuralgentics.web`) accepts the following flags. The source of truth is
`build_parser()` in `src/neuralgentics/web/__main__.py`.

The `neuralgentics-web` console script adds one extra flag (`--version`)
on top of the shared parser; everything below is shared by both entry
points.

### Mode

| Flag | Env var | Default | Description | Example |
|------|--------|---------|-------------|---------|
| `--mode {embedded,team-server}` | `NEURALGENTICS_WEB_MODE` | `embedded` | Run mode. `embedded` = localhost-only, no auth, no DB. `team-server` = binds `0.0.0.0`, requires auth + Postgres for full functionality. | `--mode=team-server` |
| `--modules-path PATH` | `NEURALGENTICS_WEB_MODULES_PATH` | built-in `neuralgentics/web/modules/` directory | Directory the module loader scans for `module.yaml` manifests. | `--modules-path=/etc/neuralgentics-web/modules` |

### Server

| Flag | Env var | Default | Description | Example |
|------|--------|---------|-------------|---------|
| `--host HOST` | `NEURALGENTICS_WEB_HOST` | `127.0.0.1` (embedded) / `0.0.0.0` (team-server) | Bind host passed to `uvicorn.run`. | `--host=0.0.0.0` |
| `--port PORT` | `NEURALGENTICS_WEB_PORT` | `9876` (embedded) / `9877` (team-server) | Listen port passed to `uvicorn.run`. | `--port=9877` |
| `-v`, `--verbose` | — | off | Enable `DEBUG`-level logging. | `--verbose` |
| `--version` | — | — | Print version and exit. Console-script only (`neuralgentics-web`); not available via `python -m neuralgentics.web`. | `neuralgentics-web --version` |

### Auth

| Flag | Env var | Default | Description | Example |
|------|--------|---------|-------------|---------|
| `--auth {off,jwt,oauth2}` | `NEURALGENTICS_WEB_AUTH` | `jwt` | `off` disables auth entirely (embedded only, never for production). `jwt` = username + password against the local SQLite user store. `oauth2` = JWT plus the `/auth/login` form, refresh-token rotation, and OIDC providers (GitHub/Google/generic). | `--auth=oauth2` |
| `--jwt-secret SECRET` | `WEB_JWT_SECRET` | random per-process value (loud warning) | HS256 shared secret used to sign access + refresh JWTs. Must be identical across all replicas in a multi-replica deployment. | `--jwt-secret=$(openssl rand -hex 32)` |
| `--auth-db-path PATH` | `WEB_AUTH_DB_PATH` | `~/.neuralgentics/web-users.db` | SQLite user-store path. The first run seeds three default users (`admin/admin`, `operator/operator`, `viewer/viewer`) and prints a loud warning. | `--auth-db-path=/var/lib/neuralgentics-web/users.db` |
| `--rbac-mode {permissive,strict}` | `NEURALGENTICS_WEB_RBAC_MODE` | `permissive` | Per-module RBAC strictness. `permissive` falls back to the global role table when a module's `module.yaml` doesn't declare an action in `rbac.actions`. `strict` denies the request with `403` — the manifest is the single source of truth. | `--rbac-mode=strict` |

### OIDC

> All OIDC knobs are CLI-flag-only. The `NEURALGENTICS_WEB_OIDC_*` env
> vars listed in section 3 are **Planned** and not yet read by the app.

| Flag | Default | Description | Example |
|------|---------|-------------|---------|
| `--oidc-github-client-id ID` | — | GitHub OAuth2 client ID. Both ID + secret required to enable GitHub. Get one at https://github.com/settings/developers. | `--oidc-github-client-id=Iv1.abc123` |
| `--oidc-github-client-secret SECRET` | — | GitHub OAuth2 client secret. | `--oidc-github-client-secret=...` |
| `--oidc-google-client-id ID` | — | Google OIDC client ID. Both ID + secret required to enable Google. Get one at https://console.cloud.google.com. | `--oidc-google-client-id=abc.apps.googleusercontent.com` |
| `--oidc-google-client-secret SECRET` | — | Google OIDC client secret. | `--oidc-google-client-secret=GOCSPX-...` |
| `--oidc-redirect-base URL` | — | Base URL for OIDC callbacks. The callback URL is `{redirect_base}/auth/callback/{provider}`. Must match the redirect URI registered with the IdP. | `--oidc-redirect-base=https://neuralgentics.example.com` |
| `--oidc-default-role {admin,operator,viewer}` | `viewer` | Role assigned to new OIDC users on first login. Users matching an `--oidc-role-mapping` rule override this. | `--oidc-default-role=viewer` |
| `--oidc-generic-discovery-url NAME=URL` | `[]` (repeatable) | Generic OIDC provider discovery URL. Format: `NAME=URL`. Repeatable for multiple providers. Requires matching `--oidc-generic-client-id` and `--oidc-generic-client-secret` flags. | `--oidc-generic-discovery-url=okta=https://idp.example/.well-known/openid-configuration` |
| `--oidc-generic-client-id NAME=ID` | `[]` (repeatable) | Client ID for a generic OIDC provider (paired by `NAME` with the discovery URL). | `--oidc-generic-client-id=okta=0oa...` |
| `--oidc-generic-client-secret NAME=SECRET` | `[]` (repeatable) | Client secret for a generic OIDC provider (paired by `NAME`). | `--oidc-generic-client-secret=okta=...` |
| `--oidc-generic-groups-claim NAME=CLAIM` | `[]` (repeatable) | Override the userinfo claim that holds the group list for a generic OIDC provider (default: `groups`). The claim value may be a list of strings (Google, Keycloak) or a list of objects with a `name` key (Okta). | `--oidc-generic-groups-claim=okta=groups` |
| `--oidc-role-mapping PROVIDER:GROUP_PATTERN=ROLE` | `[]` (repeatable) | Map an OIDC group to a role. Format: `PROVIDER:GROUP_PATTERN=ROLE`. Repeatable; comma-separated lists accepted. The highest-privilege matching rule wins (`admin > operator > viewer`); users matching no rule get `--oidc-default-role`. Only affects OIDC-created users (`users.source='oidc'`) — local users (including the seeded `admin/admin`) are never changed. Examples: `--oidc-role-mapping=github:myorg=operator` (anyone in GitHub org `myorg` gets `operator`), `--oidc-role-mapping=github:myorg/admins=admin` (GitHub team `admins` in org `myorg` gets `admin`), `--oidc-role-mapping=google:admin@example.com=admin` (Google group email gets `admin`). | `--oidc-role-mapping=github:myorg/admins=admin` |

### Database

| Flag | Env var | Default | Description | Example |
|------|--------|---------|-------------|---------|
| `--db-url DSN` | `NEURALGENTICS_WEB_DB_URL` | — | PostgreSQL DSN (team-server mode only). Required for PG-backed features (audit persistence, multi-user user store via asyncpg). Non-fatal if missing in team-server mode — health endpoint still works, file-based modules still work, but PG-backed features are no-ops. | `--db-url=postgres://user:pass@host:5432/neuralgentics` |

### Modules

Module behavior is governed by `module.yaml` manifests (see
[section 9](#9-module-configuration)) rather than CLI flags. The
`--modules-path` flag (see [Mode](#mode) above) controls where the loader
looks for manifests. Individual modules read these env vars at runtime:

| Env var | Module | Default | Description |
|---------|--------|---------|-------------|
| `NEURALGENTICS_AUDIT_FILE` | `gateway-audit` | `$TMPDIR/neuralgentics-audit.jsonl` | Path to the JSONL audit log (embedded mode only; team-server mode reads from Postgres). |
| `NEURALGENTICS_BROKER_AUDIT_FILE` | `broker-audit` | `$TMPDIR/neuralgentics-broker-audit.jsonl` | Path to the JSONL broker-audit log (embedded mode only). |
| `NEURALGENTICS_MEMINI_BACKEND` | `memini-browser` | `sdk` | Selects the memini backend: `sdk` (use the `memini_ai` SDK against a live `memini-ai` server), `pg` (team-server mode with a `db_url`, read from Postgres directly), or `mock` (no external service — used for tests and smoke mode). |
| `NEURALGENTICS_POLICIES_DIR` | `policy-editor` | `~/.neuralgentics/policies` | Directory the policy editor reads/writes gateway policy YAML files. Matches the gateway's `policy.policies_dir` config block. |
| `TMPDIR` | audit modules | `/tmp` | System temp dir, used as the fallback location for JSONL audit files when `NEURALGENTICS_*_AUDIT_FILE` is unset. |

### Logging

| Flag | Env var | Default | Description | Example |
|------|--------|---------|-------------|---------|
| `-v`, `--verbose` | — | `INFO` | Enable `DEBUG`-level logging via `logging.basicConfig`. | `--verbose` |

---

## 3. Environment variables

The app reads the following environment variables. The naming convention
is `NEURALGENTICS_WEB_*` for shell-level settings and `WEB_*` for auth
secrets; module-level env vars use `NEURALGENTICS_<MODULE>_*`.

### Shell-level (read by `WebConfig.from_args`)

| Env var | CLI flag it overrides | Default | Example |
|---------|----------------------|---------|---------|
| `NEURALGENTICS_WEB_MODE` | `--mode` | `embedded` | `NEURALGENTICS_WEB_MODE=team-server` |
| `NEURALGENTICS_WEB_PORT` | `--port` | `9876` (embedded) / `9877` (team-server) | `NEURALGENTICS_WEB_PORT=9877` |
| `NEURALGENTICS_WEB_HOST` | `--host` | `127.0.0.1` (embedded) / `0.0.0.0` (team-server) | `NEURALGENTICS_WEB_HOST=0.0.0.0` |
| `NEURALGENTICS_WEB_DB_URL` | `--db-url` | — | `NEURALGENTICS_WEB_DB_URL=postgres://user:pass@host:5432/db` |
| `NEURALGENTICS_WEB_MODULES_PATH` | `--modules-path` | built-in modules dir | `NEURALGENTICS_WEB_MODULES_PATH=/etc/neuralgentics-web/modules` |
| `NEURALGENTICS_WEB_AUTH` | `--auth` | `jwt` | `NEURALGENTICS_WEB_AUTH=oauth2` |
| `NEURALGENTICS_WEB_RBAC_MODE` | `--rbac-mode` | `permissive` | `NEURALGENTICS_WEB_RBAC_MODE=strict` |

> CLI flags take precedence over env vars. Env vars are read only when
> the corresponding CLI flag is `None` (not passed on the command line).

### Auth secrets

| Env var | CLI flag it overrides | Default | Notes |
|---------|----------------------|---------|-------|
| `WEB_JWT_SECRET` | `--jwt-secret` | random per-process value (loud warning to stderr) | If unset, a fresh random secret is generated per process. This means JWTs issued by one process (or one restart) are invalid on the next. **Set this in any production deployment.** |
| `WEB_AUTH_DB_PATH` | `--auth-db-path` | `~/.neuralgentics/web-users.db` | SQLite user-store path. |

### Module-level (read by module data sources)

| Env var | Used by | Default | Notes |
|---------|---------|---------|-------|
| `NEURALGENTICS_AUDIT_FILE` | `gateway-audit` (embedded mode only) | `$TMPDIR/neuralgentics-audit.jsonl` | Path to the JSONL audit log. Ignored in team-server mode (Postgres is used instead). |
| `NEURALGENTICS_BROKER_AUDIT_FILE` | `broker-audit` (embedded mode only) | `$TMPDIR/neuralgentics-broker-audit.jsonl` | Path to the JSONL broker-audit log. Ignored in team-server mode. |
| `NEURALGENTICS_MEMINI_BACKEND` | `memini-browser` | `sdk` | `sdk` / `pg` / `mock`. `mock` requires no external service — useful for smoke testing. |
| `NEURALGENTICS_POLICIES_DIR` | `policy-editor` | `~/.neuralgentics/policies` | Directory the policy editor reads/writes gateway policy YAML files. Matches the gateway's `policy.policies_dir` config block. |
| `TMPDIR` | audit modules | `/tmp` | System temp dir, used as the fallback location for JSONL audit files. |

### Planned env vars (not yet implemented)

The following env vars are **Planned** — they are listed in the task
spec but are not yet read by the app. Use the corresponding CLI flag
instead.

| Planned env var | CLI flag to use today | Notes |
|-----------------|----------------------|-------|
| `NEURALGENTICS_WEB_JWT_SECRET` | `--jwt-secret` (or `WEB_JWT_SECRET`) | The current convention uses the `WEB_*` prefix for secrets. A `NEURALGENTICS_WEB_*` alias may be added in a future release. |
| `NEURALGENTICS_WEB_AUTH_DB_PATH` | `--auth-db-path` (or `WEB_AUTH_DB_PATH`) | Same — current convention uses the `WEB_*` prefix. |
| `NEURALGENTICS_WEB_OIDC_GITHUB_CLIENT_ID` | `--oidc-github-client-id` | OIDC settings are CLI-flag-only today. |
| `NEURALGENTICS_WEB_OIDC_GITHUB_CLIENT_SECRET` | `--oidc-github-client-secret` | — |
| `NEURALGENTICS_WEB_OIDC_GOOGLE_CLIENT_ID` | `--oidc-google-client-id` | — |
| `NEURALGENTICS_WEB_OIDC_GOOGLE_CLIENT_SECRET` | `--oidc-google-client-secret` | — |
| `NEURALGENTICS_WEB_OIDC_REDIRECT_BASE` | `--oidc-redirect-base` | — |
| `NEURALGENTICS_WEB_OIDC_DEFAULT_ROLE` | `--oidc-default-role` | — |
| `NEURALGENTICS_WEB_OIDC_GENERIC_DISCOVERY_URL` | `--oidc-generic-discovery-url` | — |
| `NEURALGENTICS_WEB_OIDC_GENERIC_CLIENT_ID` | `--oidc-generic-client-id` | — |
| `NEURALGENTICS_WEB_OIDC_GENERIC_CLIENT_SECRET` | `--oidc-generic-client-secret` | — |
| `NEURALGENTICS_WEB_OIDC_GENERIC_GROUPS_CLAIM` | `--oidc-generic-groups-claim` | — |
| `NEURALGENTICS_WEB_OIDC_ROLE_MAPPING` | `--oidc-role-mapping` | — |

---

## 4. Config file (`config.yaml`)

> **Planned.** The app does not yet read a `config.yaml` file. All
> configuration is via CLI flags and environment variables today. The
> schema below is the **design** for a future `--config-file` flag; it
> is not yet implemented. Use CLI flags + env vars for now.

When implemented, the config file will mirror the CLI surface one-to-one.
The planned schema:

```yaml
mode: team-server
host: 0.0.0.0
port: 9877
db_url: postgres://user:pass@host:5432/neuralgentics
modules_path: /etc/neuralgentics-web/modules
auth:
  mode: jwt              # off | jwt | oauth2
  jwt_secret: ${WEB_JWT_SECRET}
  auth_db_path: /var/lib/neuralgentics-web/users.db
  rbac_mode: strict      # permissive | strict
oidc:
  github:
    client_id: ${GITHUB_CLIENT_ID}
    client_secret: ${GITHUB_CLIENT_SECRET}
  google:
    client_id: ${GOOGLE_CLIENT_ID}
    client_secret: ${GOOGLE_CLIENT_SECRET}
  redirect_base: https://neuralgentics.example.com
  default_role: viewer
  generic_providers:
    okta:
      discovery_url: https://idp.example/.well-known/openid-configuration
      client_id: ${OKTA_CLIENT_ID}
      client_secret: ${OKTA_CLIENT_SECRET}
      groups_claim: groups
  role_mapping:
    - provider: github
      group_pattern: "myorg/admins"
      role: admin
    - provider: google
      group_pattern: "admin@example.com"
      role: admin
logging:
  verbose: false
```

`${VAR}` syntax will expand environment variables at load time (mirroring
the `WEB_JWT_SECRET` env-var fallback that exists today).

Precedence (highest to lowest): **CLI flag > env var > config file >
default.**

---

## 5. Embedded mode in detail

Embedded mode is the default and the zero-config starting point:

```bash
neuralgentics-web --mode=embedded
# (or just `neuralgentics-web` — embedded is the default)
```

### What binds to localhost

- **Host:** `127.0.0.1` (override via `--host`).
- **Port:** `9876` (override via `--port`).
- The server is reachable **only from the same machine**. This is the
  security boundary — there is no auth.

### No auth

Auth is **always off** in embedded mode regardless of the `--auth` flag.
The shell ignores `--auth`, `--jwt-secret`, and `--auth-db-path` in
embedded mode. Requests are anonymous; RBAC is not enforced.

### Reads from local files

The four shipped modules read from local files (or mock data) in
embedded mode:

- `gateway-audit` — reads `$NEURALGENTICS_AUDIT_FILE` (default
  `$TMPDIR/neuralgentics-audit.jsonl`).
- `broker-audit` — reads `$NEURALGENTICS_BROKER_AUDIT_FILE` (default
  `$TMPDIR/neuralgentics-broker-audit.jsonl`).
- `memini-browser` — uses the `memini_ai` SDK against a local
  `memini-ai` server by default. Set `NEURALGENTICS_MEMINI_BACKEND=mock`
  for a no-external-service smoke mode.
- `policy-editor` — reads/writes gateway policy YAML files from
  `$NEURALGENTICS_POLICIES_DIR` (default `~/.neuralgentics/policies`,
  matching the gateway's `policy.policies_dir`).

Module manifests are loaded from the built-in
`neuralgentics/web/modules/` directory (override via `--modules-path`).

### When to use it

- Local development and iteration on a custom module.
- Single-user demo or screenshot capture.
- Smoke-testing the shell after an install or upgrade.
- Running on a laptop with no external services available.

### How to stop it

`Ctrl-C` — uvicorn shuts down gracefully. There is no supervisor,
systemd unit, or container required.

### No data persistence

The JSONL audit logs are **read-only** from the shell's perspective in
embedded mode — the shell does not write to them. (The upstream
`neuralgentics-gateway` / `neuralgentics-broker` processes write to them;
the shell only displays them.) Restarting the shell loses no shell state
because there is none — all state lives in the JSONL files (or the
upstream services), not in the shell process.

---

## 6. Team-server mode in detail

Team-server mode is the production shape:

```bash
pip install neuralgentics-web[team-server]   # adds asyncpg
neuralgentics-web --mode=team-server \
  --db-url=postgres://user:pass@host:5432/neuralgentics \
  --auth=jwt \
  --jwt-secret=$(openssl rand -hex 32) \
  --rbac-mode=strict
```

### Binds to `--host:--port`

- **Host:** `0.0.0.0` by default (override via `--host`). Listens on all
  interfaces — put it behind a reverse proxy for TLS termination.
- **Port:** `9877` by default (override via `--port`).

### Database required (Postgres)

`--db-url` is the Postgres DSN. Without it, team-server mode still boots
(the health endpoint and file-based modules work), but every PG-backed
feature is a no-op and a warning is logged:

```
team-server mode without --db-url — PG-backed features will be no-ops
until a DSN is provided
```

The `[team-server]` pip extra installs `asyncpg`. If you see
`asyncpg not installed`, you forgot the extra — see
[Troubleshooting](#11-troubleshooting).

### Auth required (jwt or oauth2)

Team-server mode refuses to run with `--auth=off` without printing a loud
warning to stderr. **Never use `--auth=off` in production.** Use `--auth=jwt`
(local user store) or `--auth=oauth2` (OIDC providers). See
[section 7](#7-auth-modes).

### Multiple users supported

The SQLite user store (`--auth-db-path`, default
`~/.neuralgentics/web-users.db`) holds local users. On first run (empty
DB), three default users are seeded with a loud warning:

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin` | `admin` |
| `operator` | `operator` | `operator` |
| `viewer` | `viewer` | `viewer` |

**Change these immediately** in any deployment that is not a throwaway
dev box. See the [production checklist](#10-production-deployment-checklist).

### When to use it

- Production deployment.
- Team use (multiple users, roles, OIDC SSO).
- Multi-user deployments where persistence across restarts matters.
- Any deployment reachable from a network you don't fully control.

### What scales

- **Postgres connection pool** — asyncpg uses a pool; tune via the DSN
  (e.g. `?pool_size=10`).
- **asyncpg** — async-native Postgres driver, no thread-pool overhead.
- **Module loading** — manifests are loaded once at startup; hot-reload
  is supported per-module via the shell's reload endpoint (see
  `shell/reload.py`).

### What doesn't scale (yet)

- **Hot-reload across replicas** — the reload endpoint is per-process;
  replicas do not coordinate reloads. Run a single replica, or accept
  that a reload must be issued to each replica individually.
- **mTLS** — not yet implemented. Terminate TLS at a reverse proxy
  (nginx, caddy, traefik) in front of the shell.
- **Prometheus metrics** — **Planned.** The `/api/v1/health` endpoint
  exists today; a `/metrics` endpoint is on the roadmap. See the
  [production checklist](#10-production-deployment-checklist).
- **Distributed JWT secret rotation** — `WEB_JWT_SECRET` is a single
  shared secret. There is no JWKS / key-rotation story yet. Rotate by
  bumping the secret and restarting all replicas simultaneously.

---

## 7. Auth modes

The `--auth` flag selects the auth backend. **Embedded mode ignores
this flag** (embedded is always anonymous).

### `--auth=off` — embedded only, never for production

Disables auth entirely. The shell prints a loud warning in team-server
mode. Use only for local dev where the network boundary is the only
protection. Never expose a `--auth=off` team-server to any network you
don't fully control.

### `--auth=jwt` — username + password against the local SQLite user store

The default. Users log in via `POST /auth/login` with username +
password; the server issues a JWT access token (24h TTL) and a refresh
token (7d TTL, rotated on every refresh). Passwords are bcrypt-hashed in
the SQLite store at `--auth-db-path`. On first run, three default users
are seeded (`admin/admin`, `operator/operator`, `viewer/viewer`) with a
loud warning.

### `--auth=oauth2` — OIDC providers (GitHub, Google, generic)

Enables the JWT path (same as `--auth=jwt`) **plus** the OIDC provider
flow. Users click "Sign in with GitHub" / "Sign in with Google" / a
generic provider button; the IdP redirects back to
`{--oidc-redirect-base}/auth/callback/{provider}`; the shell exchanges
the code for a token, fetches userinfo, creates a local user row with
`source='oidc'` (or looks up an existing one), and issues the same JWT
access + refresh tokens as the `jwt` path.

OIDC-created users get `--oidc-default-role` unless an
`--oidc-role-mapping` rule matches. See [section 8](#8-oidc-provider-examples)
for provider-specific setup.

---

## 8. OIDC provider examples

OIDC is enabled by passing both the client ID and secret for at least one
provider, plus `--oidc-redirect-base`. The callback URL is always
`{redirect_base}/auth/callback/{provider}` — register this exact URL
with your IdP.

### GitHub

GitHub uses OAuth2 (not full OIDC — no discovery document). The shell
hardcodes GitHub's endpoints.

1. Create an OAuth App at https://github.com/settings/developers.
2. Set the Authorization callback URL to
   `https://neuralgentics.example.com/auth/callback/github`.
3. Copy the Client ID and Client Secret.
4. Run:

   ```bash
   neuralgentics-web --mode=team-server \
     --auth=oauth2 \
     --oidc-redirect-base=https://neuralgentics.example.com \
     --oidc-github-client-id=Iv1.abc123 \
     --oidc-github-client-secret=...
   ```

GitHub scopes requested: `read:user user:email read:org`. Groups are
derived from org membership (`myorg`) and team membership
(`myorg/admins`). GitHub does **not** support refresh-token grants for
OAuth Apps — the shell issues its own JWT refresh tokens after the
one-time GitHub exchange.

### Google

Google uses proper OIDC (the shell fetches
`https://accounts.google.com/.well-known/openid-configuration`).

1. Create an OAuth 2.0 Client ID at
   https://console.cloud.google.com (APIs & Services → Credentials).
2. Set the Authorized redirect URI to
   `https://neuralgentics.example.com/auth/callback/google`.
3. Run:

   ```bash
   neuralgentics-web --mode=team-server \
     --auth=oauth2 \
     --oidc-redirect-base=https://neuralgentics.example.com \
     --oidc-google-client-id=abc.apps.googleusercontent.com \
     --oidc-google-client-secret=GOCSPX-...
   ```

Google scopes requested: `openid email profile`. Group membership comes
from the `groups` claim (must be configured in your Google Workspace /
Cloud Identity setup).

### Generic Okta

For any Okta tenant with a custom domain:

1. Create an OIDC Application in your Okta admin console
   (Applications → Applications → Create App Integration → OIDC - OpenID
   Connect → Web Application).
2. Set the Sign-in redirect URIs to
   `https://neuralgentics.example.com/auth/callback/okta`.
3. Copy the Client ID and Client Secret from the General tab.
4. Find your discovery URL — it's
   `https://{your-okta-domain}/.well-known/openid-configuration` (e.g.
   `https://dev-123456.okta.com/oauth2/default/.well-known/openid-configuration`
   for the default authorization server).
5. Run:

   ```bash
   neuralgentics-web --mode=team-server \
     --auth=oauth2 \
     --oidc-redirect-base=https://neuralgentics.example.com \
     --oidc-generic-discovery-url=okta=https://dev-123456.okta.com/oauth2/default/.well-known/openid-configuration \
     --oidc-generic-client-id=okta=0oa... \
     --oidc-generic-client-secret=okta=...
   ```

Okta's userinfo groups claim returns a list of objects with a `name`
key (not a flat list of strings). The shell handles both shapes. If your
Okta tenant uses a custom claim name, override it:

```bash
--oidc-generic-groups-claim=okta=groups
```

### Generic Auth0

Auth0 exposes a standard OIDC discovery document.

1. Create a Regular Web Application in the Auth0 dashboard
   (Applications → Applications → Create Application → Regular Web
   Applications).
2. Set the Allowed Callback URLs to
   `https://neuralgentics.example.com/auth/callback/auth0`.
3. Copy the Client ID and Client Secret from the Settings tab.
4. Your discovery URL is
   `https://{your-tenant}.auth0.com/.well-known/openid-configuration`.
5. Run:

   ```bash
   neuralgentics-web --mode=team-server \
     --auth=oauth2 \
     --oidc-redirect-base=https://neuralgentics.example.com \
     --oidc-generic-discovery-url=auth0=https://your-tenant.auth0.com/.well-known/openid-configuration \
     --oidc-generic-client-id=auth0=abc... \
     --oidc-generic-client-secret=auth0=...
   ```

### Generic Keycloak

Keycloak exposes a standard OIDC discovery document per realm.

1. Create a Client in your Keycloak realm (Clients → Create client →
   OpenID Connect).
2. Set the Valid redirect URIs to
   `https://neuralgentics.example.com/auth/callback/keycloak`.
3. Copy the Client ID and Client Secret from the Credentials tab.
4. Your discovery URL is
   `https://{keycloak-host}/realms/{realm}/.well-known/openid-configuration`.
5. Run:

   ```bash
   neuralgentics-web --mode=team-server \
     --auth=oauth2 \
     --oidc-redirect-base=https://neuralgentics.example.com \
     --oidc-generic-discovery-url=keycloak=https://keycloak.example.com/realms/myrealm/.well-known/openid-configuration \
     --oidc-generic-client-id=keycloak=myclient \
     --oidc-generic-client-secret=keycloak=...
   ```

Keycloak's userinfo groups claim returns a list of strings (group
paths like `/mygroup/admins`). The default `groups` claim works without
override.

---

## 9. Module configuration

A module is a directory under `--modules-path` containing a
`module.yaml` manifest and (for full modules) a Python package with route
handlers. See [module-manifest-spec.md](./module-manifest-spec.md) for
the full spec and [module-development.md](./module-development.md) for
the walkthrough.

### Required fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | unique, no whitespace (used in URLs and registry lookups); hyphens, not underscores (e.g. `gateway-audit`) |
| `version` | string | semver-ish (`0.1.0`) |
| `description` | string | one-line description shown in the module grid |

> `display_name` is also expected in practice (human-readable name shown
> in the UI) but is not enforced by the validator — a missing
> `display_name` falls back to `name`.

### Optional fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `author` | string | `Veedubin` | — |
| `license` | string | `MIT` | SPDX identifier |
| `routes` | list | `[]` | HTTP routes the module contributes (UI pages) |
| `api_endpoints` | list | `[]` | REST API endpoints |
| `sse_channels` | list | `[]` | SSE channels (Server-Sent Events streams) |
| `data_sources` | list | `[]` | declared data sources (JSONL, Postgres, mock, memini-ai SDK) |
| `rbac.actions` | dict | `{}` | per-action role allow-lists; see [Per-module RBAC](#per-module-rbac-optional) below |
| `extra` | dict | `{}` | arbitrary dict passed to the module at runtime; modules read module-specific knobs from here (e.g. `audit_file`, `memini_backend`) |

> `depends_on` is **Planned** — not yet implemented. The current loader
> does not resolve inter-module dependencies. List modules in
> dependency order in your `--modules-path` if load order matters.

### Example manifest

```yaml
# src/neuralgentics/web/modules/broker_audit/module.yaml
name: broker-audit
version: 0.14.0
display_name: "Broker Audit"
description: "Live view of tool calls through the broker (inbound audit)"
author: Veedubin
license: MIT
rbac:
  actions:
    view_audit: [viewer, operator, admin]
routes:
  - path: /modules/broker-audit
    method: GET
    template: tool_calls_table.html
  - path: /modules/broker-audit/sse
    method: GET
    handler: sse
api_endpoints:
  - path: /api/v1/broker-audit/recent
    method: GET
    handler: recent
sse_channels:
  - name: broker_audit_new
    path: /modules/broker-audit/sse
data_sources:
  - type: jsonl
    mode: embedded
  - type: postgres
    mode: team-server
    table: broker_audit_log
```

### Per-module RBAC (optional)

In team-server mode, restrict which roles can perform which actions in a
module by adding an `rbac:` block:

```yaml
rbac:
  actions:
    view_audit: [viewer, operator, admin]
    adjust_trust: [operator, admin]
    forget: [admin]
```

The action names are arbitrary — they are matched against the `action`
argument passed to the `require_role(action)` dependency in the module's
route handlers. The `--rbac-mode` flag controls what happens when a
module's manifest doesn't declare an action:

- `permissive` (default) — falls back to the global role table.
- `strict` — denies the request with `403`. The manifest is the single
  source of truth.

### How to register a Python route handler

A route or API endpoint's `handler` field can be either the literal
`stub` (placeholder) or a Python callable path
`module.submodule:callable`. The callable must return a FastAPI
`APIRouter`. See [module-development.md](./module-development.md) for
the full walkthrough; the short version:

```python
# src/neuralgentics/web/modules/my_module/routes.py
from fastapi import APIRouter

router = APIRouter()

@router.get("/modules/my-module")
async def dashboard() -> dict:
    return {"hello": "world"}
```

```yaml
# module.yaml
routes:
  - path: /modules/my-module
    method: GET
    handler: neuralgentics.web.modules.my_module.routes:dashboard
```

---

## 10. Production deployment checklist

Before exposing a team-server instance to any network you don't fully
control:

- [ ] Set `--auth=jwt` or `--auth=oauth2` (never `--auth=off`).
- [ ] Set `--rbac-mode=strict` so the manifest is the single source of
      truth for who-can-do-what.
- [ ] **Change the default users.** The first run seeds
      `admin/admin`, `operator/operator`, `viewer/viewer` with a loud
      warning. Either delete them after creating real users, or change
      their passwords immediately via the `/auth/login` flow.
- [ ] Use a strong `--jwt-secret` (or `WEB_JWT_SECRET` env var) — at
      least 32 bytes (256 bits). `openssl rand -hex 32` is the one-liner.
      **The same secret must be set on every replica** — JWTs issued by
      one replica must validate on the others.
- [ ] Use `--db-url` pointing to a managed Postgres (RDS, Cloud SQL,
      Aiven, etc.). The `[team-server]` pip extra installs `asyncpg`.
- [ ] Run behind a reverse proxy (nginx, caddy, traefik) for TLS
      termination. The shell does not terminate TLS itself.
- [ ] Set up log aggregation (stdout JSON logs via `--verbose` + a log
      collector, or pipe uvicorn's access log to your aggregator).
- [ ] Monitor `/api/v1/health` (liveness + readiness — returns mode,
      version, and module count). A Prometheus `/metrics` endpoint is
      **Planned** — not yet implemented; instrument at the reverse-proxy
      layer for now.
- [ ] Rotate `WEB_JWT_SECRET` on a schedule. There is no JWKS / key
      rotation story yet — rotation requires bumping the secret and
      restarting all replicas simultaneously (all existing refresh tokens
      are invalidated).

---

## 11. Troubleshooting

### `ModuleNotFoundError: No module named 'asyncpg'`

You tried to run team-server mode without the `[team-server]` extra.

```bash
pip install neuralgentics-web[team-server]
```

`asyncpg` is an optional dependency because it's only needed for
Postgres-backed features. The shell imports it lazily inside the PG
data sources so the rest of the app works without it.

### `ModuleNotFoundError: No module named 'memini_ai'`

You tried to use the `memini-browser` module's default `sdk` backend
without `memini-ai` installed. The `memini_ai` SDK is a **soft import**
— the shell boots fine without it, but exercising the `memini-browser`
module's search endpoint raises a clear `RuntimeError` with an
install-hint message.

Two fixes:

1. Install memini-ai (only if you want the SDK backend):
   ```bash
   pip install memini-ai
   ```
2. Or switch to a backend that doesn't need it:
   ```bash
   NEURALGENTICS_MEMINI_BACKEND=mock neuralgentics-web --mode=embedded
   ```

### `module not found` or `module.yaml: missing required field`

The module loader scans `--modules-path` for directories containing a
`module.yaml`. Invalid manifests are logged and skipped — they do not
crash the server. Check:

1. `--modules-path` points at the directory **containing** the module
   directories (not at a module directory itself).
2. Each module directory has a `module.yaml` with the required fields
   (`name`, `version`, `description`). `name` must have no whitespace
   and use hyphens (not underscores) — `gateway-audit`, not
   `gateway_audit`.
3. The YAML is valid (`python -c "import yaml; yaml.safe_load(open('module.yaml'))"`).

### `OIDC callback fails` / `redirect_uri_mismatch`

The IdP rejected the callback because the redirect URI registered with
the IdP doesn't match what the shell sent. The shell always sends
`{--oidc-redirect-base}/auth/callback/{provider}`. Check:

1. `--oidc-redirect-base` is set to the **public-facing** URL (e.g.
   `https://neuralgentics.example.com`), not `http://localhost:9877`.
2. The IdP's allowed redirect URIs include exactly
   `{redirect_base}/auth/callback/{provider}` — no trailing slash, no
   query string.
3. You're behind a reverse proxy that preserves the original Host header
   (nginx `proxy_set_header Host $host;` / caddy default behavior).

### `JWT invalid` / `401 Unauthorized` across replicas

The `--jwt-secret` (or `WEB_JWT_SECRET`) is different across replicas.
A JWT issued by replica A is signed with A's secret; replica B (with a
different secret) rejects it. Fix by setting the **same** secret on every
replica — ideally via the `WEB_JWT_SECRET` env var, sourced from a
secret manager (Vault, AWS Secrets Manager, Kubernetes secrets).

### `team-server mode without --db-url — PG-backed features will be no-ops`

Non-fatal. The shell boots, `/api/v1/health` works, file-based modules
work, but every Postgres-backed feature (audit persistence, PG user
store) is a no-op. Either set `--db-url` (or `NEURALGENTICS_WEB_DB_URL`)
or accept the degraded mode.

### `WARNING: neuralgentics-web — seeding 3 default users`

Expected on first run with an empty `--auth-db-path`. Three default
users (`admin/admin`, `operator/operator`, `viewer/viewer`) are created
in the SQLite user store. **Change their passwords immediately** in any
non-throwaway deployment. The warning stops appearing on subsequent runs
once the DB is non-empty.