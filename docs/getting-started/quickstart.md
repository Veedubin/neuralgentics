# Quickstart

Get Neuralgentics from "Clone" to "First Dispatch" in under 5 minutes.

## 🚀 5-Minute Bootstrap

### 1. Install the Runtime
If you haven't already, run the binary installer:
```bash
curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
```

### 2. Initialize Infrastructure
Neuralgentics requires a PostgreSQL instance with `pgvector` and the Memini-AI server.
```bash
# Start the development database and memory server
./scripts/dev-up.sh
```

### 3. Configure Your LLM
Edit your `.env` file or export the required keys:
```bash
export OLLAMA_API_KEY="your_key_here"
export NEURALGENTICS_API_KEY="your_key_here"
```

### 4. Launch the TUI
```bash
neuralgentics
```

### 5. Your First Dispatch
Once inside the TUI, try a simple orchestrator task:
`"Analyze the current project structure and create a high-level map of the Go modules."`

**What happens under the hood:**
1. **Orchestrator** queries memory for project context.
2. **Architect** is dispatched to design the map.
3. **Explorer** is dispatched to find the files.
4. **Writer** is dispatched to format the final report.

---

## ✅ Verification Checklist

| Step | Action | Expected Result |
| :--- | :--- | :--- |
| 1 | `neuralgentics status` | All components (Backend, Broker, Memory) show `ONLINE` |
| 2 | `neuralgentics --version` | Returns `v0.1.0` |
| 3 | First Task | Task transitions from `triage` $\rightarrow$ `running` $\rightarrow$ `done` |

If you encounter any issues, check the [Troubleshooting Guide](../troubleshooting/).
