# Changelog

All notable changes to `neuralgentics-web` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.14.1] — 2026-07-19

### Added
- **Auth layer (JWT + OAuth2 stub + RBAC)** (T-109):
  - Three auth modes via `--auth=off|jwt|oauth2` (default `jwt`):
    - `off` — no auth (dev only, loud warning)
    - `jwt` — Bearer JWT access tokens required
    - `oauth2` — JWT path plus `POST /auth/login`, refresh rotation, `GET /auth/me`
  - SQLite user store at `~/.neuralgentics/web-users.db`; bcrypt-hashed
    passwords; three default dev users (`admin/admin`, `operator/operator`,
    `viewer/viewer`) seeded on first run with a stderr warning.
  - HS256 JWT, 24h access tokens, 7d refresh tokens, refresh-token rotation
    ON by default (old refresh token revoked on each refresh).
  - RBAC: three global roles (`admin`, `operator`, `viewer`) enforced via
    the `require_role(...)` FastAPI dependency. Trust-adjust endpoint is
    gated to `admin`/`operator`.
  - Routes: `POST /auth/login`, `POST /auth/login/json`, `POST /auth/refresh`,
    `POST /auth/logout`, `GET /auth/me`.
  - CLI flags: `--auth`, `--jwt-secret`, `--auth-db-path`.
  - `AuthMiddleware` installed in both modes — in `off`/embedded mode it
    attaches `request.state.user = None`; in `jwt`/`oauth2` it validates the
    Bearer token, resolves the user from the store, and attaches it to
    `request.state.user`.
  - Password-change CLI: `python -m neuralgentics.web.auth.users set-password <user>`.
- `AuthConfig` added to `WebConfig` (`WebConfig.auth: AuthConfig`).
- Health endpoint now reports `auth_mode` and `users_seeded`.
- 33 new tests (15 unit + 8 E2E + 10 across auth submodules) — total 66
  passing, 4 PG-skipped.

### Changed
- `TeamServerMode.configure` now installs `AuthMiddleware` + the `/auth/*`
  router synchronously at app-build time (before module routes).
- `EmbeddedMode.configure` installs an `off`-mode `AuthMiddleware` so
  `request.state.user` is always defined for downstream handlers.
- Version bump: `0.14.0` → `0.14.1`.
- New deps: `pyjwt>=2.8.0`, `bcrypt>=4.1.0`.
- Pre-existing `test_memini_detail.py` mypy errors fixed inline (unused
  `# type: ignore` comments removed, missing `Any` annotation added).

### Security
- This is a **stub** implementation. The OAuth2 form is functional but not
  production-grade. Real OIDC (Google, GitHub, etc.), RS256/asymmetric JWT,
  per-module RBAC, CSRF protection, account lockout, and rate limiting are
  deferred to future cards. See `README.md` for the full list of out-of-scope
  items.
- HS256 is acceptable for v0.14.x because the team-server is intended for a
  trusted network. Rotate `WEB_JWT_SECRET` regularly and never commit it.

## [0.14.0] — 2026-07-19

### Added
- `memini-browser` module (T-108): search, detail page, trust-adjust POST,
  graph SVG. JSON endpoint `GET /api/v1/memini-browser/search`.
- `broker-audit` module (T-107): JSONL data source + PostgreSQL source
  with `LISTEN/NOTIFY`, SSE stream, table view.
- `gateway-audit` module (T-106): JSONL + SSE, table view, filtering by
  domain/status/since/until.
- Shell + 3 stub modules (T-105): module discovery from `modules/*/module.yaml`,
  FastAPI app factory, embedded vs team-server modes, Pydantic settings,
  `--mode`/`--port`/`--host`/`--db-url`/`--modules-path` CLI flags.
- 33 tests (now 66 after T-109) covering the shell, loader, registry,
  module YAML schema, and per-module embedded/team-server behavior.