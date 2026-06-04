# Broker Wave 2 Hardening

**Design Document**
**Version:** 1.0
**Author:** boomerang-orchestrator
**Date:** 2026-05-31
**Status:** Ready for Implementation

---

## 1. Executive Summary

### Scope
Two independent hardening features for the MCP broker:
1. **Dynamic Server Reloading** — `ReloadServer(name, newConfig)` API for zero-downtime config updates
2. **Permission Shadowing** — Role hierarchy with inheritance + explicit DENY overrides

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Reload trigger** | Explicit `ReloadServer()` API | File watchers add complexity; explicit API is simpler and callable from orchestrator |
| **Drain strategy** | Wait for in-flight calls (5s max) | Prevents orphaned proxy readers/writers |
| **Rollback** | Keep old instance alive until new one passes health check | Atomic swap; no downtime window |
| **Role hierarchy** | Hardcoded chain: orchestrator > architect > coder > all agents | Simple, no config file needed |
| **DENY rules** | Append `-deny` suffix to role in serverRoles map | Backward-compatible; existing `[]Role` entries still work |
| **Audit** | Reuse existing `audit/logger.go` from memory package | Already implemented; just add access decision events |

---

## 2. Dynamic Server Reloading

### 2.1 API

```go
// ReloadServer stops a running server, updates its config, and restarts it.
// In-flight calls are drained with a configurable timeout (default 5s).
// If the new instance fails health check, the old config is restored and the
// old instance is restarted (rollback).
func (b *Broker) ReloadServer(ctx context.Context, name string, newConfig types.ServerConfig) error
```

### 2.2 Flow

```
ReloadServer(name, newConfig)
  │
  ├─ 1. Get current entry from registry
  │     → ErrServerNotRegistered if not found
  │
  ├─ 2. Get current config (save for rollback)
  │     oldConfig := entry.Config
  │
  ├─ 3. Signal drain (set entry.Status = "draining")
  │     → New Call() requests are rejected for this server
  │
  ├─ 4. Wait for in-flight calls (5s timeout)
  │     → Track via atomic counter (entry.activeCalls)
  │     → If timeout: force-stop (log warning)
  │
  ├─ 5. Stop old instance
  │     b.StopServer(name) → kill process, close pipes
  │
  ├─ 6. Update config
  │     entry.Config = newConfig
  │
  ├─ 7. Start new instance + handshake + tools/list
  │     b.StartServer(name) → launch, initialize, discover
  │
  ├─ 8. Health check
  │     b.Health(name) → must return "healthy"
  │
  ├─ 9. SUCCESS: entry.Status = "healthy", return nil
  │
  └─ 10. ROLLBACK (on failure):
        entry.Config = oldConfig
        b.StartServer(name)  // restart with old config
        return error describing what failed
```

### 2.3 File Changes

| File | Action | Description |
|------|--------|-------------|
| `broker.go` | MODIFY | Add `ReloadServer()` method (~40 lines) |
| `broker_test.go` | MODIFY | Add `TestReloadServer` (success + rollback cases) |
| `broker_integration_test.go` | MODIFY | Add `TestReloadServerE2E` |
| `types/types.go` | MODIFY | Add `ServerStatus` type: "healthy", "draining", "stopped", "unhealthy" |
| `registry/registry.go` | MODIFY | Add `activeCalls int64` to entry, `SetStatus()`, `GetStatus()` |
| `broker.go` | MODIFY | `Call()` must check status != "draining" before proxying |

### 2.4 Drain Mechanism

```go
// In registry entry:
type serverEntry struct {
    // ...existing fields...
    activeCalls atomic.Int64  // tracks in-flight proxy calls
    status      ServerStatus  // "healthy" | "draining" | "stopped"
}

// In broker.Call():
if entry.Status() == types.StatusDraining {
    return ErrServerDraining
}
entry.activeCalls.Add(1)
defer entry.activeCalls.Add(-1)
// ...proxy call...
```

---

## 3. Permission Shadowing

### 3.1 Role Hierarchy

```
orchestrator           (top — inherits all)
  ├─ architect         (inherits: architect servers + all below)
  │   ├─ coder         (inherits: coder servers + all below)
  │   │   ├─ tester
  │   │   ├─ linter
  │   │   ├─ git
  │   │   ├─ writer
  │   │   ├─ explorer
  │   │   └─ researcher
  │   └─ (coder inherits tester/linter/git/writer/explorer/researcher)
  └─ (architect inherits coder + all below)
```

**Rule:** A role automatically gets all permissions of roles below it in the hierarchy.

### 3.2 Explicit DENY Rules

**Syntax:** Add `-deny` suffix to a role name in `DefaultServerRoles`:

```go
var DefaultServerRoles = map[string][]Role{
    "github-mcp":    {RoleOrchestrator, RoleCoder, "coder-deny", RoleGit},
    // coder-deny overrides coder's inherited access to github-mcp
}
```

**Processing:**
1. Parse role list into ALLOW set and DENY set (strip `-deny` suffix)
2. Expand each ALLOW role via hierarchy (include inherited roles)
3. Expand each DENY role via hierarchy (include all roles below it)
4. Remove any role from ALLOW set that appears in DENY set
5. DENY always wins if both apply

### 3.3 API Changes

```go
// ExpandRole returns all roles implied by a given role via hierarchy.
func ExpandRole(role Role) []Role

// ExpandRoles expands all roles in the list, respecting hierarchy inheritance.
// DENY rules (with -deny suffix) override ALLOW rules.
func (ac *AccessControl) ResolveRoles(serverName string) []Role
```

### 3.4 File Changes

| File | Action | Description |
|------|--------|-------------|
| `access/access.go` | MODIFY | Add hierarchy constants, `ExpandRole()`, `ResolveRoles()` |
| `access/access_test.go` | MODIFY | Add hierarchy + deny tests (~15 new tests) |
| `access/hierarchy.go` | NEW | Hierarchy tree definition + expansion logic |
| `access/hierarchy_test.go` | NEW | Hierarchy expansion tests |
| `catalog/catalog.go` | MODIFY | Use `ResolveRoles()` instead of direct role lookup |

---

## 4. Audit Integration

Reuse the existing `audit/logger.go` from the memory module. Access control decisions should emit audit events.

### Events to Log

| Event | When | Fields |
|-------|------|--------|
| `broker.access_denied` | `CanAccess()` returns false | role, server, reason (not in ALLOW set / explicitly DENIED) |
| `broker.server_reloaded` | `ReloadServer()` succeeds | server, old_cmd, new_cmd |
| `broker.server_reload_failed` | `ReloadServer()` rollback | server, error, old_config_restored=true |

### Integration

The memory module already has `audit/logger.go` with `Event` struct + `Logger.Log()` method. Since broker-go is a separate module, we have two options:
1. **Import memory module** — creates dependency, works but tight coupling
2. **Define audit interface in broker** — cleaner, but adds abstraction

**Decision:** Add a lightweight audit callback interface in broker-go that can be wired to the memory audit logger at initialization time:

```go
// In broker types:
type AuditSink interface {
    LogEvent(ctx context.Context, eventType, server, description string) error
}

// In broker:
func NewBrokerWithAudit(auditSink AuditSink) *Broker
```

---

## 5. Implementation Order

### Parallel Tracks (3 can run simultaneously)

| Track | Files | Description |
|-------|-------|-------------|
| A | `access/hierarchy.go`, `access/hierarchy_test.go`, `access/access.go` (modify), `access/access_test.go` (modify) | Role hierarchy + DENY rules |
| B | `types/types.go` (add ServerStatus), `registry/registry.go` (add status + activeCalls) | Drain infrastructure |
| C | `access/access.go` (add AuditSink), `catalog/catalog.go` (use ResolveRoles) | Audit interface + catalog update |

### Sequential (after Track A+B+C complete)

| Step | Files | Description |
|------|-------|-------------|
| 4 | `broker.go` (add ReloadServer + drain check in Call), `broker_test.go` (add tests) | Reload logic |
| 5 | `broker_integration_test.go` (add E2E reload test) | Integration test |

---

## 6. Test Plan

### Hierarchy Tests (~15)
- `TestExpandRole_Orchestrator` — returns all roles
- `TestExpandRole_Architect` — returns architect + below
- `TestExpandRole_Coder` — returns coder + below
- `TestExpandRole_Tester` — returns tester only (leaf)
- `TestExpandRole_Unknown` — returns just the role itself
- `TestResolveRoles_BasicAllow` — no deny rules
- `TestResolveRoles_DenyOverridesAllow` — "coder-deny" blocks coder even though "coder" is in ALLOW
- `TestResolveRoles_HierarchyDeny` — "architect-deny" blocks architect + coder + everything below
- `TestResolveRoles_OrchestratorAlwaysWins` — orchestrator can't be denied
- `TestResolveRoles_BackwardCompat` — existing DefaultServerRoles still work

### Reload Tests (~5)
- `TestReloadServer_Success` — reload with same config
- `TestReloadServer_NewConfig` — reload with different command
- `TestReloadServer_NotRegistered` — returns error
- `TestReloadServer_Rollback` — new config fails, old config restored
- `TestReloadServer_RejectsCallsDuringDrain` — Call() returns ErrServerDraining
