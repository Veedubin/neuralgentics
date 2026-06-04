# Environment Variables

Neuralgentics uses a multi-layered environment configuration to allow seamless transition from local development to production clouds.

## ⛓️ The Inheritance Chain

Configuration is not read from a single place. It follows a strict precedence order where the **right-most** source always wins.

```text
 lowest trust  ◄───────────────────────────────────────────────── highest trust
 ┌────────────┐    ┌────────────┐    ┌───────────┐    ┌───────────┐    ┌─────────┐
 │ SYSTEM ENV │ ──► │ SHELL RC   │ ──► │  .env    │ ──► │ DIRENV   │ ──► │ CLI    │
 └────────────┘    └────────────┘    └───────────┘    └───────────┘    └─────────┘
   (Global)          (/etc/bashrc)      (Project)      (Local)       (Runtime)
```
> **Diagram 5 — Env Var Inheritance Chain.** This sequence defines how Neuralgentics resolves configuration. If `OLLAMA_API_KEY` is defined in both the `.env` file and as a CLI flag, the CLI flag takes precedence.

---

## 📋 Variable Reference

### Core Runtime (`NEURALGENTICS_*`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NEURALGENTICS_PREFIX` | `~/.neuralgentics` | Installation root for binaries. |
| `NEURALGENTICS_API_KEY` | `None` | Authentication key for the Go backend. |
| `NEURALGENTICS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Memory Engine (`MEMINI_*`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MEMINI_DB_URL` | `postgres://...` | Connection string for PostgreSQL + pgvector. |
| `MEMINI_EMBEDDING_MODE` | `auto` | `cpu` (384), `gpu` (1024), or `auto` (dual). |
| `THOUGHT_CHAINS` | `true` | Enable/disable sequential reasoning logs. |
| `MEMINI_SVR_PORT` | `8000` | Port for the Python memory server. |

### LLM Infrastructure (`OLLAMA_*`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OLLAMA_API_KEY` | `None` | Key for Ollama Cloud. |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | API endpoint for model requests. |
| `OLLAMA_DEFAULT_MODEL` | `gemma4:31b` | Fallback model if no specialist is defined. |

---

## 🛠️ Practical Usage

### Setting a Local Override
To use a custom prefix without modifying your shell:
```bash
NEURALGENTICS_PREFIX="/opt/neural" ./scripts/install.sh
```

### Managing Multiple Profiles
We recommend using `direnv` for project-specific memory servers:
```bash
echo "export MEMINI_SVR_PORT=8001" > .envrc
direnv allow
```
