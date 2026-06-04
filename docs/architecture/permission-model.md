# Permission Model

Neuralgentics employs a rigid Role-Based Access Control (RBAC) model. This is not just for security; it is fundamentally about **token optimization**. By restricting the tool catalog available to a specific agent, we prevent "tool-drift" and reduce prompt noise.

## 📊 The Permission Matrix

The following matrix is the **authoritative** view of the `DefaultServerRoles` map in
`packages/broker-go/src/neuralgentics/broker/access/access.go`. Empty cells (`-`) mean
"denied" for that role/server pair; checkmarks (`✓`) mean "allowed." The
`orchestrator` role is implicitly allowed everywhere (enforced in `CanAccess()`).

```text
                | mem | neu | gh  | ply | srx | wfb | mkd
 ───────────────┼─────┼─────┼─────┼─────┼─────┼─────┼─────
 orchestrator   │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓  │  ✓   (superuser)
 architect      │  ✓  │  ✓  │  -  │  -  │  ✓  │  ✓  │  ✓
 coder          │  ✓  │  ✓  │  -  │  -  │  ✓  │  ✓  │  -
 explorer       │  ✓  │  ✓  │  -  │  -  │  -  │  -  │  -
 tester         │  ✓  │  ✓  │  -  │  ✓  │  -  │  ✓  │  -
 writer         │  ✓  │  ✓  │  -  │  -  │  -  │  -  │  ✓
 git            │  ✓  │  ✓  │  -  │  -  │  ✓  │  ✓  │  ✓
 researcher     │  ✓  │  ✓  │  -  │  ✓  │  ✓  │  ✓  │  -
 release        │  ✓  │  ✓  │  -  │  -  │  -  │  -  │  ✓
 linter         │  ✓  │  ✓  │  -  │  -  │  ✓  │  ✓  │  -
 mcp-specialist │  ✓  │  ✓  │  -  │  -  │  -  │  -  │  -

  Column keys:  mem = memini-ai-dev   (allow-all)
                neu = neuralgentics   (allow-all)
                gh  = github-mcp      (boomerang-git + orchestrator only)
                ply = playwright      (tester, scraper, researcher)
                srx = searxng         (architect, coder, scraper, researcher, linter, git)
                wfb = webfetch        (architect, coder, scraper, researcher, tester, linter, git)
                mkd = markitdown      (architect, writer, git, release)
```

> **Note on `boomerang-*` roles.** For every base role above, there is a matching
> `boomerang-*` role (e.g. `boomerang-coder`, `boomerang-architect`) used by the
> `boomerang-v3` plugin. The `boomerang-*` role inherits the same permissions as
> its base role, **plus** any role-specific grants listed in the source
> `DefaultServerRoles` map. See `access.go` for the canonical list.
> **Diagram 4 — Permission Matrix Heatmap.** This matrix visualizes the authority levels of the agent swarm. Most agents have access to the "Core" servers (memini and neuralgentics), but specific capabilities like GitHub API access or Headless Browser control are locked to the specialists who actually need them.

---

## 🛡️ Enforcement Logic

### The "Allow-All" Baseline
Two servers are configured as `allow-all`:
1. `memini-ai-dev`: Every agent needs memory access.
2. `neuralgentics`: Every agent needs to interact with the core runtime.

### Restricted Servers
For any other server, the Broker checks if the `Role` of the requesting agent is present in the `DefaultServerRoles` map in `packages/broker-go/src/neuralgentics/broker/access/access.go`.

### The Superuser
The `orchestrator` role is globally permitted to access every server. This ensures the orchestrator can always audit the state of any tool without needing explicit role grants.

### Error State: `ErrUnauthorized`
When a permission check fails, the Broker returns:
- **Code:** `-32001`
- **Message:** `unauthorized: role "writer" cannot access server "github-mcp"`
- **Suggestion:** A list of servers the agent *is* permitted to use.
