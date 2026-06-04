# Troubleshooting

This guide covers the most common errors encountered when running Neuralgentics.

## 🚨 Common Errors

### 1. "Kimi K2.6 not valid" / Model Not Found
**Symptom:** The TUI crashes or the orchestrator fails to dispatch with a `ProviderModelNotFoundError`.

**Root Cause:** Usually a mismatch between the model name in `.opencode/agents/*.md` and the `models` list in `.opencode/opencode.json`. OpenCode requires exact string matches.

**Fix:**
1. Open `.opencode/opencode.json`.
2. Ensure the `ollama` provider block contains a `models` array.
3. Verify the model name is exactly `kimi-k2.6` (without the `:cloud` suffix if using the Ollama API directly).
4. **Restart OpenCode** to clear the config cache.

### 2. Broker 401 / Unauthorized
**Symptom:** An agent receives `unauthorized: role "writer" cannot access server "github-mcp"`.

**Root Cause:** The agent is attempting to use a tool it is not permitted to use according to the Routing Matrix.

**Fix:**
- If the agent *should* have access, update `packages/broker-go/src/neuralgentics/broker/access/access.go`.
- If it's a routing error, the Orchestrator must be corrected to route the task to `boomerang-git`.

### 3. Memini-AI Down / Connection Refused
**Symptom:** `failed to connect to memory server at localhost:8000`.

**Root Cause:** The Python memory server is not running or the PostgreSQL backend has crashed.

**Fix:**
```bash
# Restart the dev stack
./scripts/dev-up.sh
```
Verify the DB is healthy: `docker ps | grep postgres`.

### 4. Kanban Card "Stuck" in Running
**Symptom:** A card remains in `running` status but the agent has stopped responding.

**Root Cause:** A sub-agent crashed or the session timed out without a wrap-up.

**Fix:**
1. Issue the `/resume` command in the TUI.
2. This resets the failure counter and moves the card back to `ready`.
3. The orchestrator will re-dispatch the task.

---

## 🛠️ Debugging Commands

| Command | Purpose |
| :--- | :--- |
| `neuralgentics status` | Check connectivity to Backend and Memory. |
| `curl http://localhost:8000/status` | Check health of the Python memory engine. |
| `make lint` | Verify Go source code quality. |
| `make smoke` | Run the JSON-RPC integration test. |
