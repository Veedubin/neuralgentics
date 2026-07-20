# neuralgentics-web — overview

`neuralgentics-web` is the **modular web UI shell** for the neuralgentics
ecosystem. It runs as a sub-package inside the neuralgentics repository at
`packages/web/` and ships as part of the same release train.

## Why it exists

The neuralgentics ecosystem has several backends (gateway, broker,
memini-ai memory server) that each produce operational data — audit logs,
tool-call metrics, memory contents. Operators and team leads need a
single dashboard to see all of it. `neuralgentics-web` provides the
shell; individual **modules** provide the dashboards.

## Design inspiration

The module system is a hybrid of:

- **Grafana's plugin.json** — route/dashboard registration via a JSON manifest.
- **VS Code's package.json `contributes`** — contribution points for commands, views, menus.

A module is just a directory with a `module.yaml` manifest. The shell
discovers it at startup, validates it, and renders it in the UI.

## Two modes

The SAME codebase runs in two modes:

| | Embedded | Team-server |
|---|---|---|
| Start | `python -m neuralgentics.web` | `docker run neuralgentics-web` |
| Bind | `127.0.0.1:9876` | `0.0.0.0:9877` |
| Auth | None (localhost) | JWT+OAuth2 (T-109) |
| Data | Local files | PostgreSQL |
| Multi-tenant | No | Yes |
| Use case | Solo dev watching their own gateway | Team shared dashboard |

Mode is selected via `--mode=embedded|team-server` or the
`NEURALGENTICS_WEB_MODE` env var.

## v0.1 ships 3 stub modules

| Module | Purpose | Real implementation |
|--------|---------|---------------------|
| `gateway-audit` | Egress traffic monitoring | T-106 |
| `broker-audit` | Tool call metrics | T-107 |
| `memini-browser` | Memory explorer | T-108 |

Each stub shows up in the UI with a placeholder page that says
"Module: gateway-audit — coming in T-106".

## Where it lives

- **Repo:** `neuralgentics/packages/web/`
- **Entry:** `python -m neuralgentics.web`
- **Docs:** `packages/web/README.md`, `packages/web/docs/`
- **Design doc:** `docs/design/ecosystem-architecture.md` Section 4

See `architecture.md` for the module system and mode internals.