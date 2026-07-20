# module.yaml Manifest Specification

The `module.yaml` manifest is the contract between a neuralgentics-web
module and the shell. Modeled on Grafana's `plugin.json` + VS Code's
`package.json contributes`.

## Required fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | unique, no whitespace (used in URLs and registry lookups) |
| `version` | string | semver-ish (`0.1.0`) |
| `display_name` | string | human-readable |
| `description` | string | one-line description |

## Optional fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `author` | string | `Veedubin` | — |
| `license` | string | `MIT` | SPDX identifier |
| `routes` | list | `[]` | HTTP routes the module contributes |
| `api_endpoints` | list | `[]` | REST endpoints |
| `sse_channels` | list | `[]` | SSE channels (future cards wire this up) |
| `data_sources` | list | `[]` | declared data sources (future cards) |

### Route object

```yaml
routes:
  - path: /modules/gateway-audit     # URL path, must start with /
    method: GET                       # HTTP method (default GET)
    handler: gateway_audit.routes:dashboard   # python path "module.submod:callable"
    template: module_stub.html        # Jinja template name (shell renders)
    context:                          # arbitrary dict passed to the template
      message: "Coming in T-106"
```

A route MUST have either `handler` or `template`. If both are present,
`handler` wins (the callable is responsible for rendering).

### API endpoint object

```yaml
api_endpoints:
  - path: /api/v1/gateway-audit/recent
    method: GET
    handler: stub              # literal "stub" = placeholder; or "module.sub:callable"
```

### SSE channel object (future)

Reserved for future cards. The v0.1 schema accepts the list but does not
wire channels.

### Data source object (future)

Reserved for future cards.

## Validation

Manifests are validated by `ModuleManifest.model_validate(...)` (Pydantic
v2). Invalid manifests are logged and skipped at startup — they do not
crash the server. Validation rejects:

- missing required fields
- whitespace in `name`
- non-mapping top-level YAML

## Naming conventions

- **Directory name:** underscores (`gateway_audit`, `memini_browser`) —
  must be a valid Python identifier so the module's `__init__.py` is
  importable.
- **Manifest `name`:** hyphens (`gateway-audit`, `memini-browser`) —
  URL-friendly. The loader matches on the manifest `name` field, not the
  directory name.

## Reference

Grafana plugin anatomy: <https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin>
VS Code contributes pattern: <https://code.visualstudio.com/api/references/contribution-points>