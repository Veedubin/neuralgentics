# Transport Architecture & Multi-Provider Registry

**Version:** v0.4.0 Design  
**Date:** 2026-06-07  
**Author:** boomerang-architect (deepseek-v4-pro)  
**Repo:** `Veedubin/neuralgentics` (GHCR: `veedubin/neuralgentics-*`)  
**Working directory:** `/home/jcharles/Projects/MCP-Servers/neuralgentics`  

---

## Executive Summary

This document designs the transport abstraction and multi-provider LLM registry for neuralgentics v0.4.0. The two features are closely related: both require the runtime to pick between multiple implementations (which LLM to use, which transport to launch an MCP with). They share the same TUI picker pattern and the same broker extension points.

**User mandate (verbatim):** "Just get it done. It's mostly related. Maybe we could let the user decide if they want to do NPX/UVX, install locally, or Docker MCPs. We can have all of it. We should add DMR as another provider. I also think we should add in OpenRouter support."

**Key constraints:**
- All 4 Go modules must remain green after every card.
- Zero-Error Rule: gates failing → fix inline or block the card.
- `opencode.json` provider ID is `ollama-cloud` (with hyphen).

---

## 1. Multi-Provider LLM Registry

### 1.1 Current State

**File:** `.opencode/opencode.json` lines 3-42  

```json
"provider": {
  "ollama-cloud": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Ollama Cloud",
    "options": { "baseURL": "https://ollama.com/v1" },
    "models": { ... }
  }
}
```

**File:** `.opencode/opencode.json` line 118:  

```json
"small_model": "ollama-cloud/devstral-small-2:24b-cloud"
```

The current `provider` block is a single-key object. There is no runtime selection—the opencode provider ID is hardcoded.

### 1.2 New Shape

Replace `"provider": { "ollama-cloud": {...} }` with a plural `"providers"` object where each key is the provider id and each value follows an isomorphic shape. Add a `"defaultProvider": "ollama-cloud"` field so OpenCode knows which provider to use as the default.

```jsonc
"defaultProvider": "ollama-cloud",
"providers": {
  "ollama-cloud": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Ollama Cloud",
    "url": "https://ollama.com/v1",
    "type": "openai-compatible",
    "description": "Ollama Cloud API (default, primary)",
    "models": {
      "kimi-k2.6:cloud":       { "name": "Kimi K2.6 (Cloud)" },
      "glm-5.1:cloud":         { "name": "GLM 5.1 (Cloud)" },
      "deepseek-v4-pro:cloud": { "name": "DeepSeek V4 Pro (Cloud)" },
      "devstral-2:123b-cloud": { "name": "Devstral 2 (Cloud)" },
      "deepseek-v4-flash:cloud": { "name": "DeepSeek V4 Flash (Cloud)" },
      "qwen3-coder-next:cloud": { "name": "Qwen3 Coder Next (Cloud)" },
      "minimax-m2.7:cloud":    { "name": "MiniMax M2.7 (Cloud)" },
      "gemma4:31b-cloud":      { "name": "Gemma 4 31B (Cloud)" },
      "qwen3.5:cloud":         { "name": "Qwen 3.5 (Cloud)" },
      "devstral-small-2:24b-cloud": { "name": "Devstral Small 2 (Cloud)" }
    }
  },
  "dmr-local": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Docker Model Runner (Local)",
    "url": "http://localhost:12434/engines/v1",
    "type": "openai-compatible",
    "description": "Docker Model Runner for local inference via GPU",
    "models": {
      "ai/qwen2.5-coder:7b":       { "name": "Qwen 2.5 Coder 7B (Local)" },
      "ai/llama3.2:3b":            { "name": "Llama 3.2 3B (Local)" },
      "ai/devstral-small-2:24b":   { "name": "Devstral Small 2 24B (Local)" }
    }
  },
  "openrouter": {
    "npm": "@openrouter/ai-sdk-provider",
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1",
    "type": "openrouter",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "description": "OpenRouter aggregator for multi-model access",
    "models": {
      "anthropic/claude-3.5-sonnet":          { "name": "Claude 3.5 Sonnet" },
      "openai/gpt-4o":                        { "name": "GPT-4o" },
      "google/gemini-pro-1.5":                { "name": "Gemini Pro 1.5" },
      "meta-llama/llama-3.1-405b-instruct":   { "name": "Llama 3.1 405B" },
      "mistralai/mistral-large-latest":       { "name": "Mistral Large" }
    }
  }
}
```

**Design decisions:**
- Provider key names match the OpenCode provider ID format (used in agent `.md` files as `model: ollama-cloud/kimi-k2.6:cloud`).
- `dmr-local` uses `type: "openai-compatible"` because DMR exposes an OpenAI-compatible endpoint at `http://localhost:12434/engines/v1`.
- `openrouter` uses `type: "openrouter"` because the `@openrouter/ai-sdk-provider` npm package wraps the Vercel AI SDK with OpenRouter-specific auth header injection (API key via `Authorization: Bearer`).
- `openrouter` has a `apiKeyEnv: "OPENROUTER_API_KEY"` field that the TUI/plugin reads to pass the API key to the provider.
- Model names use the exact API model IDs (e.g. `anthropic/claude-3.5-sonnet` for OpenRouter, `ai/qwen2.5-coder:7b` for DMR).

### 1.3 `small_model` Update

**Before (line 118):**  
```json
"small_model": "ollama-cloud/devstral-small-2:24b-cloud"
```

**After:**  
```json
"small_model": "ollama-cloud/devstral-small-2:24b-cloud"
```

This stays unchanged for backward compatibility. The TUI `/provider` command does not change `small_model`—only the active provider for agent dispatching.

### 1.4 TUI Runtime Provider Picker

**New slash command:** `/provider [name|list|status]`

**Sub-commands:**
| Command | Action |
|---------|--------|
| `/provider` | Show current active provider |
| `/provider list` | List all providers with health status |
| `/provider <name>` | Switch active provider to `<name>` |
| `/provider status` | Show all 3 providers with health checks |

**Health checks implemented via the broker:**
- `ollama-cloud`: HTTP GET `https://ollama.com/v1/models` → expect 200
- `dmr-local`: HTTP GET `http://localhost:12434/engines/v1/models` → expect 200 (or `connection refused` = offline)
- `openrouter`: HTTP GET `https://openrouter.ai/api/v1/models` with `Authorization: Bearer $OPENROUTER_API_KEY` → expect 200

**Provider persistence:**
- The TUI writes the active provider to `~/.config/neuralgentics/provider-pref.json`: `{"activeProvider": "ollama-cloud"}`.
- On startup, the TUI reads this file. If absent, defaults to the `defaultProvider` from `opencode.json`.
- The orchestrator reads the active provider from `provider-pref.json` and writes the provider ID into the agent's Context Package.
- The Context Package includes: `provider: "ollama-cloud"`, `model: "ollama-cloud/kimi-k2.6:cloud"`.

**Env var override:** `NEURALGENTICS_DEFAULT_PROVIDER=openrouter` (takes precedence over config file if set; useful for CI).

**File reference:** Provider picker reuses the pattern from the `/model` command handler at `packages/tui/src/commands.ts` lines 766-885 (`handleModelCommand` / `handleModelCommandAsync`).

### 1.5 Agent Model Format Update

Currently, agent `.md` files use:  
```yaml
model: ollama/kimi-k2.6:cloud
```

This does NOT change for v0.4.0. The `ollama/` prefix maps to the OpenCode provider ID `ollama-cloud`. In the future, agents could be tagged for specific providers:  
```yaml
model: openrouter/anthropic/claude-3.5-sonnet
```

This is out of scope for v0.4.0—the `/provider` TUI command controls which provider OpenCode uses for ALL agents.

---

## 2. MCP Transport Abstraction

### 2.1 Current State

**File:** `.opencode/opencode.json` lines 45-85  

Each MCP entry is a single flat object with `type`, `command`, `environment`:

```jsonc
"github-mcp": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
  "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PERSONAL_ACCESS_TOKEN}" },
  "enabled": true
}
```

**File:** `packages/broker-go/src/neuralgentics/broker/types/types.go` lines 3-12  

```go
type ServerConfig struct {
    Name         string
    Command      string
    Args         []string
    Env          map[string]string
    Type         string   // "stdio", "http", "sse"
    Description  string
    Capabilities []string
}
```

**File:** `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` lines 160-195  

`buildCommand()` currently only handles `Type: "stdio"` with `exec.Command(config.Command, config.Args...)`. The `"http"` and `"sse"` cases are empty (commented as "future phase").

### 2.2 New Transport Shape

Replace the flat MCP entry with a `transports` array:

```jsonc
"github-mcp": {
  "enabled": true,
  "transports": [
    {
      "type": "npx",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "default": true,
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    },
    {
      "type": "docker",
      "image": "ghcr.io/veedubin/neuralgentics-github-mcp:v0.1.0",
      "runtime": "auto",               // "docker" | "podman" | "auto" (= detect)
      "args": ["--github-token", "$GITHUB_PERSONAL_ACCESS_TOKEN"],
      "environment": {}
    },
    {
      "type": "local",
      "bin": "github-mcp-server",
      "installHint": "cargo install github-mcp-server",
      "environment": {}
    },
    {
      "type": "uvx",
      "package": "github-mcp-server",
      "args": [],
      "environment": {}
    }
  ]
}
```

**Transport types defined:**

| Type | Spawn Method | Config Fields | Description |
|------|-------------|--------------|-------------|
| `npx` | `npx -y <package>` | `command` (optional, default "npx"), `args`, `environment` | Node.js MCP via npx (existing pattern) |
| `uvx` | `uvx <package>` | `command` (optional, default "uvx"), `args`, `environment` | Python MCP via uvx |
| `local` | `./binary` | `bin` (path to binary), `installHint` (string), `environment` | Pre-installed binary (e.g. `~/.local/bin/`) |
| `docker` | `docker run -i --rm <image>` | `image`, `runtime` (docker/podman/auto), `args`, `environment` | Containerized MCP |
| `http` | HTTP POST to URL | `url` (string), `headers` (optional map) | Hosted MCP (e.g. Cloudflare Workers) |
| `sse` | SSE stream from URL | `url` (string), `headers` (optional map) | Server-Sent Events MCP |

**Transport selection:**
- The first transport with `"default": true` is the default. If none has this flag, the first in the list is the default.
- The user picks at runtime via `/mcp activate <name> --transport npx`.
- If the selected transport fails (binary missing, docker not running, HTTP 503), the broker auto-falls-back to the next transport in the list (ordered by the array position).

**Transport merge:** When a user activates a specific transport, that transport's config is merged into a single `types.ServerConfig` for the launcher. The launcher's `buildCommand` is extended to handle each transport type.

### 2.3 Go Type Updates

**NEW: `packages/broker-go/src/neuralgentics/broker/types/types.go`** (extends existing 28-line file):

```go
// TransportType defines how an MCP server process is launched.
type TransportType string

const (
    TransportNPX    TransportType = "npx"
    TransportUVX    TransportType = "uvx"
    TransportLocal  TransportType = "local"
    TransportDocker TransportType = "docker"
    TransportHTTP   TransportType = "http"
    TransportSSE    TransportType = "sse"
)

// TransportConfig holds a single transport option for launching an MCP server.
type TransportConfig struct {
    Type        TransportType       `json:"type"`
    Command     string              `json:"command,omitempty"`     // npx/uvx command
    Args        []string            `json:"args,omitempty"`
    Env         map[string]string   `json:"environment,omitempty"`
    Bin         string              `json:"bin,omitempty"`         // local binary path
    InstallHint string              `json:"installHint,omitempty"` // how to install the local binary
    Image       string              `json:"image,omitempty"`       // docker image name
    Runtime     string              `json:"runtime,omitempty"`     // "docker" | "podman" | "auto"
    URL         string              `json:"url,omitempty"`         // http/sse URL
    Headers     map[string]string   `json:"headers,omitempty"`     // http/sse headers
    Default     bool                `json:"default,omitempty"`     // default transport for this MCP
    Status      string              `json:"status,omitempty"`      // "available" | "unavailable" | "unknown"
}

// MCPServerConfig wraps the legacy flat config with multi-transport support.
type MCPServerConfig struct {
    Name        string            `json:"name"`
    Enabled     bool              `json:"enabled"`
    Transports  []TransportConfig `json:"transports"`
    // Legacy fields for backward compatibility (auto-converted to TransportConfig).
    LegacyType    string            `json:"type,omitempty"`
    LegacyCommand []string          `json:"command,omitempty"`
    LegacyEnv     map[string]string `json:"environment,omitempty"`
}
```

**Existing `ServerConfig` is preserved** (no deletion—used by broker internally after transport resolution). The new `MCPServerConfig` wraps it.

### 2.4 Launcher Extensions

**File:** `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` lines 160-195  

Extend `buildCommand()` with per-transport handling:

```go
func buildCommandForTransport(tc types.TransportConfig) (*exec.Cmd, io.WriteCloser, io.ReadCloser, error) {
    switch tc.Type {
    case types.TransportNPX:
        return buildStdioCommand(tc.Command, tc.Args, tc.Env) // defaults to "npx"

    case types.TransportUVX:
        return buildStdioCommand(tc.Command, tc.Args, tc.Env) // defaults to "uvx"

    case types.TransportLocal:
        cmd := exec.Command(tc.Bin, tc.Args...)
        // ... same pipe setup as stdio ...

    case types.TransportDocker:
        runtime := detectContainerRuntime(tc.Runtime) // "docker" or "podman"
        args := []string{"run", "-i", "--rm"}
        for k, v := range tc.Env {
            args = append(args, "-e", k+"="+v)
        }
        args = append(args, tc.Image)
        args = append(args, tc.Args...)
        cmd := exec.Command(runtime, args...)
        // ... pipe setup ...

    case types.TransportHTTP, types.TransportSSE:
        // HTTP/SSE: no subprocess. Validate URL, mark as "ready" in registry.
        // The proxy layer handles HTTP/SSE calls directly via http.Client.
        // Return a sentinel indicating no subprocess needed.
        return nil, nil, nil, fmt.Errorf("http transport: no subprocess (use proxy layer)")

    default:
        return nil, nil, nil, fmt.Errorf("unknown transport type: %q", tc.Type)
    }
}

func detectContainerRuntime(preferred string) string {
    if preferred == "docker" { return "docker" }
    if preferred == "podman" { return "podman" }
    // Auto-detect: prefer docker, fallback to podman.
    if _, err := exec.LookPath("docker"); err == nil { return "docker" }
    if _, err := exec.LookPath("podman"); err == nil { return "podman" }
    return "docker" // fallback, will fail with "docker: command not found" (correct error).
}
```

**Transport fallback logic:** The broker's new `ActivateMCPServer()` method iterates the transport list, attempts each, and records which succeeded. If all fail, returns a multi-transport error.

### 2.5 Backward Compatibility

**Auto-conversion rules in the broker:**

1. **`type: "local"` with `command: ["npx", ...]`** → auto-converts to `transport: { type: "npx", command: "npx", args: ["-y", "<pkg>"], default: true }`.
2. **`type: "local"` with `command: ["uvx", ...]`** → auto-converts to `transport: { type: "uvx", command: "uvx", args: ["<pkg>"], default: true }`.
3. **`type: "local"` with `command: ["./binary"]`** → auto-converts to `transport: { type: "local", bin: "./binary", default: true }`.
4. **All existing `environment` fields** → copied to the auto-generated transport's `environment`.
5. **`enabled` flag** → preserved as-is at MCP level.

**Conversion happens in the broker's config loader**, not in the config file. The `opencode.json` file can still use the old format and the broker will parse it correctly. No existing user config requires change.

**Example auto-conversion:**

Input:
```json
"github-mcp": {
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
  "enabled": true
}
```

Broker internally resolves to:
```go
MCPServerConfig{
    Name: "github-mcp",
    Enabled: true,
    Transports: []TransportConfig{{
        Type: "npx",
        Command: "npx",
        Args: []string{"-y", "@modelcontextprotocol/server-github"},
        Default: true,
    }},
}
```

---

## 3. Catalog Discovery

### 3.1 `catalog.json` — Curated MCP Catalog

**New file:** `packages/broker-go/src/neuralgentics/broker/catalog/catalog.json` (committed to repo)

A curated list of **20 popular MCP servers**, each with all supported transports:

```jsonc
{
  "version": "1",
  "updated": "2026-06-07",
  "servers": [
    {
      "name": "github-mcp",
      "description": "GitHub API for issues, PRs, repos, actions",
      "category": "development",
      "homepage": "https://github.com/modelcontextprotocol/servers",
      "transports": [
        {
          "type": "npx",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "default": true,
          "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PERSONAL_ACCESS_TOKEN}" }
        },
        {
          "type": "docker",
          "image": "ghcr.io/veedubin/neuralgentics-github-mcp:v0.1.0",
          "runtime": "auto",
          "args": ["--github-token", "$GITHUB_PERSONAL_ACCESS_TOKEN"]
        }
      ]
    },
    {
      "name": "playwright",
      "description": "Browser automation via Playwright",
      "category": "testing",
      "transports": [
        {
          "type": "npx",
          "command": "npx",
          "args": ["-y", "@anthropic/mcp-server-playwright"],
          "default": true
        },
        {
          "type": "docker",
          "image": "mcr.microsoft.com/playwright/mcp:latest",
          "runtime": "auto"
        }
      ]
    },
    {
      "name": "searxng",
      "description": "Web search via SearXNG",
      "category": "research",
      "transports": [
        {
          "type": "npx",
          "command": "npx",
          "args": ["-y", "mcp-searxng"],
          "default": true,
          "environment": { "SEARXNG_URL": "http://localhost:8080" }
        },
        {
          "type": "docker",
          "image": "searxng/searxng:latest",
          "runtime": "auto",
          "args": ["--env", "SEARXNG_URL=http://localhost:8080"]
        }
      ]
    },
    {
      "name": "markitdown",
      "description": "Convert documents to Markdown",
      "category": "productivity",
      "transports": [
        {
          "type": "uvx",
          "command": "uvx",
          "args": ["markitdown-mcp"],
          "default": true
        },
        {
          "type": "local",
          "bin": "markitdown",
          "installHint": "pip install markitdown-mcp"
        }
      ]
    },
    // ... 16 more entries for:
    // filesystem-mcp, postgres-mcp, sqlite-mcp, brave-search,
    // puppeteer, fetch, sequential-thinking, memory (memini-core),
    // time, google-maps, cloudflare, slack, sentry, resend,
    // todoist, exa-search
  ]
}
```

### 3.2 Broker Methods

Six new JSON-RPC methods exposed on the broker:

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `broker.discoverCatalog` | `{role: string}` | `ServerCatalog` (filtered by role) | List MCPs from catalog.json not yet active |
| `broker.activateMCP` | `{name: string, transport: string}` | `{serverName, transport, status}` | Activate an MCP with the given transport |
| `broker.deactivateMCP` | `{name: string}` | `{serverName, wasRunning}` | Stop MCP, remove from active set |
| `broker.listTransports` | `{name: string}` | `[{type, status, default}]` | List transports for a specific MCP with availability status |
| `broker.listActiveMCPs` | `{role: string}` | `[{name, transport, status, tools}]` | List all currently active MCPs |
| `broker.exportProfile` | `{}` | `{profileId, path, size}` | Export active set to `neuralgentics-profile-{timestamp}.tar.gz` |

### 3.3 Activate Flow

```
1. User types /catalog add github-mcp --transport npx
   └─ TUI calls broker.activateMCP({name: "github-mcp", transport: "npx"})

2. Broker reads catalog.json entry for "github-mcp"
   └─ Finds transport with type="npx"

3. Broker checks permissions:
   └─ access.CanAccess(role, "github-mcp")
   └─ If unauthorized: return ErrUnauthorized with available servers hint

4. Broker converts TransportConfig → ServerConfig
   └─ Calls launcher.StartWithTransport(config, transport)

5. Launcher spawns the process, MCP handshake, discovers tools

6. Broker stores entry in registry with active transport metadata

7. Returns {serverName: "github-mcp", transport: "npx", status: "running", tools: 22}
```

### 3.4 Deactivate Flow

```
1. User types /catalog remove github-mcp
   └─ TUI calls broker.deactivateMCP({name: "github-mcp"})

2. Broker checks: is the MCP in the registry?
   └─ Yes → stop process via launcher.Stop(), deregister from registry
   └─ No → return {wasRunning: false}

3. Returns {serverName: "github-mcp", wasRunning: true}
```

### 3.5 Profile Export/Import (OCI-shareable)

**Export:**
```
1. Broker serializes active MCP set: [{name, transport, env, startedAt}]
2. Writes to neuralgentics-profile-{timestamp}.tar.gz containing:
   - profile.json (active MCP list)
   - permission-snapshot.json (current role→server mappings)
   - catalog.lock.json (which catalogue entries are active)
3. Returns {profileId, path, size}
```

**Import:**
```
1. User unpacks .tar.gz
2. Broker reads profile.json
3. For each MCP: calls activateMCP with the recorded transport
4. Permission snapshot is applied via access.Grant() calls
5. Returns confirmation with count of activated MCPs
```

This is a stretch feature included in the design for completeness. Implementation priority: P2 (after the core activate/deactivate flow).

---

## 4. Permission Matrix Interaction

### 4.1 Current State

**File:** `packages/broker-go/src/neuralgentics/broker/access/access.go` lines 43-69  

`DefaultServerRoles` maps 7 server names to explicit role lists plus 2 allow-all entries (`memoryManager`, `neuralgentics`). The `CanAccess` method (line 103) checks if a role is in the server's allow list. Orchestrator always has access (line 105).

23 role constants defined at lines 17-41.

### 4.2 New Permissions

**New role:** `RoleMCPCurator` — can `mcp.activate` from catalog but cannot `mcp.deactivate`. Use case: a curator can add new tools but not remove existing ones (separation of concerns for shared environments).

```go
const RoleMCPCurator Role = "mcp-curator"
```

**Permission matrix rules:**

| Role | mcp.activate (from catalog) | mcp.activate (non-catalog) | mcp.deactivate |
|------|---------------------------|--------------------------|----------------|
| `orchestrator` | ✓ | ✓ | ✓ |
| `developer` | ✓ (catalog only) | ✗ | ✓ (own activations only) |
| `mcp-curator` | ✓ | ✗ | ✗ |
| `boomerang-git` | ✗ | ✗ | ✗ |

**Implementation:** The broker's `ActivateMCPServer()` checks:
1. If the MCP name is in `catalog.json` entries → allow for all roles with catalog access.
2. If the MCP name is NOT in `catalog.json` → only orchestrator can activate (ad-hoc activation).
3. If activating would conflict with an existing restricted server → check `CanAccess(role, name)`.

**Granular permission:** `mcp.activate.<name>` — future per-MCP activate permission. Not implemented in v0.4.0 (the catalog-based gate is sufficient). Reserved for v0.5.0.

### 4.3 Access Control Updates

**Add to `AllRoles()` (access.go line 213):**  

```go
RoleMCPCurator,
```

**New `DefaultServerRoles` entry** (no changes needed—catalog-based activation doesn't modify the server role map; it only gates which users can call `activateMCP`).

**New method in `AccessControl`:**  

```go
// CanActivateFromCatalog checks if a role can activate MCPs from the catalog.
func (ac *AccessControl) CanActivateFromCatalog(role string) bool {
    if role == string(RoleOrchestrator) || role == string(RoleMCPCurator) {
        return true
    }
    // developer can activate from catalog (not arbitrary MCPs)
    if role == "developer" {
        return true
    }
    return false
}

// CanDeactivate checks if a role can deactivate an MCP.
func (ac *AccessControl) CanDeactivate(role string, serverName string) bool {
    if role == string(RoleOrchestrator) {
        return true
    }
    // mcp-curator cannot deactivate.
    if role == string(RoleMCPCurator) {
        return false
    }
    // developer can deactivate MCPs they (or the orchestrator) activated.
    // In v0.4.0 we track who activated each MCP; if unknown, allow.
    return true
}
```

---

## 5. Backward Compatibility

### 5.1 OpenCode Config

| Old config format | Auto-resolution |
|-------------------|-----------------|
| `"provider": { "ollama-cloud": {...} }` | Broker reads old key, wraps in `"providers"` with `"defaultProvider": "ollama-cloud"`. OpenCode itself needs `"providers"` (plural) to support multiple providers; the broker can translate but OpenCode must also be updated to read the new key. |
| `"mcp": { "github-mcp": { "type": "local", "command": ["npx", ...] } }` | Broker auto-converts to single-transport list (see Section 2.5). |
| `"small_model": "ollama-cloud/devstral-small-2:24b-cloud"` | No change. |

### 5.2 Broker Types

| Old type | Behavior |
|----------|----------|
| `types.ServerConfig` | Preserved unchanged. Used internally after transport resolution. |
| `types.ServerConfig.Type: "stdio"` | Treated as legacy. Launcher auto-detects from command (npx/uvx/binary). |
| `launcher.buildCommand()` | Extended with new transport types; old `"stdio"` path unchanged. |

### 5.3 TUI Commands

| Old command | Behavior |
|-------------|----------|
| `/model <name>` | Works as before; model names include provider prefix (unchanged). |
| `/memory <query>` | Unchanged. |
| All 20 existing commands | Unchanged. |

**No existing user config requires change.** If a user has a v0.3.1 `opencode.json`, the broker handles auto-conversion on startup and writes a migration note to stderr (not to the config file).

### 5.4 Migration to New Format

The new `opencode.json` format with `"providers"` (plural) and `"transports"` arrays is the **canonical format**. The broker auto-converts old configs but does NOT rewrite the file. Users can manually migrate when convenient.

**Migration command (future TUI feature):**
```
/migrate config
```
Prompts user, shows diff, writes new `opencode.json` with `.old` backup.

---

## 6. File-Overlap Analysis & Parallel Dispatch Wave Plan

### 6.1 Card Definitions

| Card ID | Name | Files Touched | Lines |
|---------|------|--------------|-------|
| **T-OPENROUTER-PROVIDER** | Add OpenRouter to provider registry | `.opencode/opencode.json` (new `providers` block) | ~20 new lines in provider section |
| **T-DMR-PROVIDER** | Add DMR-local to provider registry | `.opencode/opencode.json` (same `providers` block) | ~15 new lines in provider section |
| **T-COMPOSE-MODELS** | Add DMR & provider compose services | `docker-compose.yml` | ~30 new lines |
| **T-TRANSPORT-ABSTRACTION** | Implement transport types + launcher + backend handlers | `packages/broker-go/src/neuralgentics/broker/types/types.go` (+40 lines), `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` (+60 lines), `packages/broker-go/src/neuralgentics/broker/broker.go` (+120 lines for activate/deactivate), `packages/backend-go/cmd/backend/main.go` (+80 lines for handler registrations + handlers), `packages/tui/src/neuralgentics-client/types.ts` (+30 lines for MethodRegistry entries) | |
| **T-CATALOG-001** | Create catalog.json + broker catalog methods + TUI catalog commands | `packages/broker-go/src/neuralgentics/broker/catalog/catalog.json` (NEW, ~400 lines), `packages/broker-go/src/neuralgentics/broker/broker.go` (+50 lines for discover/export), `packages/backend-go/cmd/backend/main.go` (+60 lines), `packages/tui/src/commands.ts` (+150 lines for /catalog, /mcp commands) | |
| **T-DUAL-PROVIDER** | TUI /provider command + provider picker logic | `packages/tui/src/commands.ts` (+120 lines), `packages/tui/src/neuralgentics-client/types.ts` (+20 lines) | |
| **T-DOCS-V040** | Update architecture docs, README, CHANGELOG | `docs/architecture/overview.md`, `README.md`, `CHANGELOG.md` | |
| **T-REL-V040** | Release bump: version 0.3.1 → 0.4.0, tag, publish | `package.json` (root), `packages/tui/package.json`, `packages/opencode/package.json`, 4× Go `var version` (ldflags in release workflow) | |

### 6.2 Overlap Matrix

```
                    opencode.json   docker-compose.yml  broker/types  broker/launcher  broker/broker  backend/main  TUI/types  TUI/commands  catalog.json
T-OPENROUTER            ●
T-DMR-PROVIDER          ● (SAME FILE)
T-COMPOSE-MODELS                          ●
T-TRANSPORT-ABSTRACT                                 ●              ●               ●              ●            ●
T-CATALOG-001                                                                       ● (SHARED)      ●           ● (SHARED)    ● (NEW)
T-DUAL-PROVIDER                                                                                                 ●            ● (SHARED)
```

**Overlaps identified:**
1. **T-OPENROUTER ↔ T-DMR-PROVIDER**: Both touch `opencode.json` lines 3-42 (provider block). NOT parallel-safe.
2. **T-TRANSPORT-ABSTRACTION ↔ T-CATALOG-001**: Both touch `packages/broker-go/src/neuralgentics/broker/broker.go`. NOT parallel-safe.
3. **T-TRANSPORT-ABSTRACTION ↔ T-CATALOG-001**: Both touch `packages/backend-go/cmd/backend/main.go`. NOT parallel-safe.
4. **T-CATALOG-001 ↔ T-DUAL-PROVIDER**: Both touch `packages/tui/src/commands.ts`. NOT parallel-safe.

### 6.3 Parallel-Safe Wave Structure

```
╔════════════════════════════════════════════════════════════════╗
║ Wave 1 (PARALLEL — file-disjoint)                             ║
║   T-OPENROUTER-PROVIDER  → boomerang-coder  (opencode.json)   ║
║   T-COMPOSE-MODELS       → boomerang-coder  (docker-compose)  ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 2 (SEQUENTIAL — waits for T-OPENROUTER)                  ║
║   T-DMR-PROVIDER         → boomerang-coder  (opencode.json)   ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 3 (SOLO — no file overlap with prior waves)              ║
║   T-TRANSPORT-ABSTRACTION → boomerang-coder                   ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 4 (SOLO — waits for T-TRANSPORT, shares broker.go)       ║
║   T-CATALOG-001           → boomerang-coder                   ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 5 (SOLO — waits for T-CATALOG, shares commands.ts)       ║
║   T-DUAL-PROVIDER         → boomerang-coder (commands.ts)     ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 6 (PARALLEL — file-disjoint from all prior)              ║
║   T-DOCS-V040             → boomerang-writer                  ║
║   T-TEST-ALL              → boomerang-tester (runs all tests) ║
╠════════════════════════════════════════════════════════════════╣
║ Wave 7 (SOLO — release)                                       ║
║   T-REL-V040              → boomerang-release                 ║
╚════════════════════════════════════════════════════════════════╝
```

**Total: 7 waves, 8 cards. Max parallelism: 2 concurrent coders (Wave 1 only).**

### 6.4 Why Only 2-Way Parallelism?

The file-overlap analysis reveals that only Wave 1 has genuinely file-disjoint cards. Every other wave touches at least one shared file with a prior wave. This is significantly fewer parallel waves than the "all parallel" claim from Session 31.

**Root cause:** The provider block in `opencode.json` is a single JSON object (lines 3-42) — OpenRouter and DMR share the same key path. The broker's `broker.go` (427 lines) is the central orchestrator file — transport activation and catalog discovery both extend its methods. The TUI's `commands.ts` (1625 lines) is the centralized command registry — both catalog and provider commands add to the same file.

**Recommendation:** Future refactoring that splits `broker.go` into `broker.go` (core) + `transports.go` (transport abstraction) + `catalog_commands.go` (catalog discovery) would enable more parallelism. This is a v0.5.0 consideration.

---

## 7. Release Sequencing

### 7.1 Single Minor Bump

v0.4.0 ships ALL cards together. User explicitly rejected multi-session stretch: "I don't see why we need to stretch it to multiple sessions. Just get it done."

**Bump targets:**
| File | From | To |
|------|------|----|
| `package.json` (root) | `0.3.1` | `0.4.0` |
| `packages/tui/package.json` | `0.3.1` | `0.4.0` |
| `packages/opencode/package.json` | `0.3.1` | `0.4.0` |
| `packages/memory/src/neuralgentics/memory/core/version.go` (or `var version = "dev"`) | `dev` | Set via `-ldflags` in release workflow |
| `packages/broker-go/src/neuralgentics/broker/version.go` | `dev` | Set via `-ldflags` |
| `packages/orchestrator-go/src/neuralgentics/orchestrator/version.go` | `dev` | Set via `-ldflags` |
| `packages/backend-go/cmd/backend/main.go` line 34 | `var version = "dev"` | Set via `-ldflags="-X main.version=v0.4.0"` |

**Go version auto-inheritance:** The release workflow (`.github/workflows/release.yml`) passes `VERSION` as a build arg, setting `-ldflags="-X main.version=$VERSION"`. The Go modules with `var version = "dev"` do NOT change in source — the release pipeline injects the version at build time. ✅ Confirmed: no Go source changes needed for version bumps.

### 7.2 Artifacts

- Single changelog section for v0.4.0 in `CHANGELOG.md`
- Single hero copy update in `docs/index.md`
- Single git tag `v0.4.0`
- Single release workflow run (GitHub Actions)
- Container images: `ghcr.io/veedubin/neuralgentics-backend:v0.4.0`, `ghcr.io/veedubin/neuralgentics-postgres:v0.4.0`, `ghcr.io/veedubin/neuralgentics-sidecar:v0.4.0`

### 7.3 Plan B: Quality Gate Failure

If quality gates block (tests fail, lint fails, Go build fails):

| Scenario | Action |
|----------|--------|
| Config-only cards (T-OPENROUTER, T-DMR, T-COMPOSE) pass, but code cards (T-TRANSPORT, T-CATALOG, T-DUAL-PROVIDER) fail | Ship cards 1-3 as **v0.3.2 patch** (config-only, no code changes). Then cards 4-6 as **v0.4.0 minor** in a follow-up session. |
| All 6 code cards pass | Ship as v0.4.0 minor (single batch). |
| Any card blocks with unfixable error | Block the card, ship the rest. The blocked card becomes a follow-up card in the next session. |

**Plan B is for emergency only.** The ideal outcome is all 6 cards passing quality gates and shipping as a single v0.4.0.

---

## 8. Game Plan for Orchestrator

### 8.1 Card Dispatch Table

| Wave | Card | Agent | File List | Dependencies |
|------|------|-------|-----------|--------------|
| 1 | T-OPENROUTER-PROVIDER | boomerang-coder | `.opencode/opencode.json` (add openrouter provider block in `providers` object, set `defaultProvider`) | None |
| 1 | T-COMPOSE-MODELS | boomerang-coder | `docker-compose.yml` (add dmr-local service, openrouter sidecar if needed) | None |
| 2 | T-DMR-PROVIDER | boomerang-coder | `.opencode/opencode.json` (add dmr-local provider block) | T-OPENROUTER (shares same file) |
| 3 | T-TRANSPORT-ABSTRACTION | boomerang-coder | `packages/broker-go/src/neuralgentics/broker/types/types.go` (+TransportConfig, +MCPServerConfig, +TransportType), `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` (+buildCommandForTransport, +detectContainerRuntime), `packages/broker-go/src/neuralgentics/broker/broker.go` (+SetTransport, +convertLegacyConfig), `packages/backend-go/cmd/backend/main.go` (+broker.activateMCP handler, +broker.deactivateMCP handler), `packages/tui/src/neuralgentics-client/types.ts` (+MethodRegistry entries) | T-DMR-PROVIDER (for full config context) |
| 4 | T-CATALOG-001 | boomerang-coder | `packages/broker-go/src/neuralgentics/broker/catalog/catalog.json` (NEW), `packages/broker-go/src/neuralgentics/broker/broker.go` (+discoverCatalog, +activateMCP, +deactivateMCP, +listTransports, +exportProfile), `packages/backend-go/cmd/backend/main.go` (+4 handler registrations + 4 handlers), `packages/tui/src/commands.ts` (+/catalog handler, +/mcp handler) | T-TRANSPORT-ABSTRACTION (shares broker.go and backend/main.go) |
| 5 | T-DUAL-PROVIDER | boomerang-coder | `packages/tui/src/commands.ts` (+/provider handler, +provider health check), `packages/tui/src/neuralgentics-client/types.ts` (+provider method entries) | T-CATALOG-001 (shares commands.ts) |
| 6 | T-DOCS-V040 | boomerang-writer | `docs/architecture/overview.md`, `README.md`, `CHANGELOG.md` | All 5 code cards done |
| 6 | T-TEST-ALL | boomerang-tester | Run `go test ./...` (4 modules), `bun test` (TUI), linter scan | All 5 code cards done |
| 7 | T-REL-V040 | boomerang-release | `package.json` (root + tui + opencode), `CHANGELOG.md`, git tag, release workflow | T-DOCS-V040 done, T-TEST-ALL green |

### 8.2 Quality Gates Per Card

| Card | Lint | Typecheck | Test | Go Build |
|------|------|-----------|------|----------|
| T-OPENROUTER | `prettier --check .opencode/opencode.json` | N/A (JSON) | `jsonlint` (if available) | N/A |
| T-COMPOSE-MODELS | `prettier --check docker-compose.yml` | N/A (YAML) | `docker compose config` (dry-run) | N/A |
| T-DMR-PROVIDER | Same as T-OPENROUTER | N/A | Same | N/A |
| T-TRANSPORT-ABSTRACTION | `gofmt -d`, `go vet ./...` (broker-go) | `tsc --noEmit` (TUI) | `go test ./...` (broker-go) | `go build ./...` (broker-go + backend-go) |
| T-CATALOG-001 | `gofmt -d`, `go vet ./...` (broker-go), `eslint` (TUI) | `tsc --noEmit` | `go test ./...` (broker-go), `bun test` (TUI) | `go build ./...` (broker-go + backend-go) |
| T-DUAL-PROVIDER | `eslint` (TUI) | `tsc --noEmit` | `bun test` (TUI) | N/A |
| T-DOCS-V040 | `markdownlint` (if installed) | N/A | N/A | N/A |
| T-TEST-ALL | `gofmt -d` (all Go) + `eslint` (TUI) | `tsc --noEmit` | `go test ./...` (all 4 modules) + `bun test` (TUI, 744 tests) | `go build ./...` (all 4 modules) |

### 8.3 Orchestrator Instructions

1. **Before dispatching any cards:** Run `git status` to verify clean working tree (or handle dirty state from design work).
2. **Wave 1 dispatch:** Two parallel `boomerang-coder` tasks for T-OPENROUTER-PROVIDER and T-COMPOSE-MODELS. No file overlap. Wait for both to complete before Wave 2.
3. **Between waves:** Run `gofmt -d`, `go vet`, `bun test` on changed files to catch regressions early.
4. **Card wrap-up format:** Each coder returns `{memory_id, description, files_changed, quality_gates: {lint: pass|fail, test: pass|fail, build: pass|fail}}`.
5. **After Wave 7:** Run `npm version minor --no-git-tag-version` in root, `packages/tui`, `packages/opencode`. Update `CHANGELOG.md`. Git tag `v0.4.0`. Push. Trigger release workflow.
6. **Save to memini-ai:** After each card completes, save the wrap-up with tags `transport-architecture`, `v0.4.0`, and the card ID.

### 8.4 Risks & Open Questions

| Risk | Mitigation |
|------|-----------|
| **OpenCode `providers` support**: OpenCode's config schema may not support the plural `providers` key. | If OpenCode rejects `providers`, use the existing `provider` key with a single default provider and add `additionalProviders` as a separate key (not read by OpenCode, only by neuralgentics broker). Research before Wave 1. |
| **OpenRouter npm package**: `@openrouter/ai-sdk-provider` may not be compatible with `@ai-sdk/openai-compatible`. | Test with `npm install @openrouter/ai-sdk-provider` before writing the config. If incompatible, fall back to `@ai-sdk/openai-compatible` with custom `headers: { Authorization: "Bearer $OPENROUTER_API_KEY" }`. |
| **DMR GPU access**: Docker containers need GPU passthrough (`--gpus all`). | Add `runtime: nvidia` option to docker transport for GPU-accelerated MCPs. Note in design that DMR-local itself runs outside Docker (it's a local Docker Model Runner instance). |
| **20 curated MCPs**: Some may not have all 4 transports. | Each catalog entry only lists transports that actually exist for that MCP. Some may have only 1 transport. |
| **Health check reliability**: HTTP health checks may fail transiently. | Add retry (3 attempts, 1s apart) with exponential backoff. Cache health status for 30s. |
| **`small_model` provider awareness**: If user switches to OpenRouter, `small_model` should pick from OpenRouter's models. | Defer to v0.5.0. v0.4.0 keeps `small_model` hardcoded to `ollama-cloud/devstral-small-2:24b-cloud`. |

### 8.5 Pre-Wave 0: Research Card (Architect)

Before dispatching Wave 1, the orchestrator MUST dispatch a research-only architect card to verify:

1. OpenCode supports the `providers` (plural) config key. If not, design the `additionalProviders` escape hatch.
2. `@openrouter/ai-sdk-provider` npm package exists and is compatible with OpenCode's provider model.
3. DMR's OpenAI-compatible endpoint at `http://localhost:12434/engines/v1` is the correct URL.

**Research card ID:** T-RESEARCH-V040 (architect, read-only, no code).

---

**End of design document.** ~850 lines.
