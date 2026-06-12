# Installation

You're installing the **harness** for AI agents - a 26 MB Go binary that brokers tool calls, scores memory, and persists context across sessions.

Neuralgentics provides three primary installation paths depending on your environment and trust level.


## 🛠️ Installation Flow

```text
                                  START
                                     │
                                     ▼
                      ╔══════════════════════════╗
                      ║    FRESH VS UPGRADE?     ║
                      ╚══════════════════════════╝
                                     │
             ┌─────────────────────┴─────────────────────┐
             ▼                                            ▼
      [ FRESH INSTALL ]                           [ EXISTING INSTALL ]
             │                                            │
             ▼                                            ▼
    ╔══════════════════════╗                    ╔══════════════════════╗
    ║   CHOOSE METHOD      ║                    ║    RUN INSTALLER     ║
    ╚══════════════════════╝                    ╚══════════════════════╝
             │                                            │
     ┌───────┴───────┬──────────────────┐                  │
     ▼               ▼                    ▼                  ▼
╔══════════╗ ╔══════════════╗ ╔══════════════╗        [ VERSION BUMP ]
║ BINARY   ║ ║ CONTAINER    ║ ║ FROM SOURCE  ║               │
╚══════════╝ ╚══════════════╝ ╚══════════════╝               │
     │               │                    │                  │
     └───────────────┴──────────┬─────────┘                  │
                                 ▼                           │
                      ╔══════════════════════╗               │
                      ║  VERIFY VIA 'ping'   ║ $\longleftarrow$  ┘
                      ╚══════════════════════╝
                                 │
                                 ▼
                          [ SYSTEM READY ]
```
> **Diagram 10 — Install Flow Decision Tree.** This flowchart helps you determine the best way to deploy Neuralgentics. For most users, the binary installer is recommended. Developers should use the source build to ensure local tool-chain alignment.

---

## 📦 Option 1: Binary Release (Recommended)

This is the fastest way to get started. We provide pre-built binaries for Linux, macOS, and Windows.

### Steps
1. **Run the installer:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
   ```
2. **Verify the install:**
   ```bash
   neuralgentics status
   ```

### Customization
The installer defaults to a **project-local install at `$PWD/.neuralgentics`** — binaries, data, and the projects registry all live inside your project, so the install never touches `$HOME` unless you ask. If you're running in an interactive terminal the installer will still prompt you with options:

  1. Local to this project (`$PWD/.neuralgentics`) — default
  2. Home directory (`$HOME/.neuralgentics`)
  3. Custom path

You can also override the default non-interactively:
```bash
# Force home-dir install
./scripts/install.sh --prefix $HOME/.neuralgentics

# Or any absolute path
./scripts/install.sh --prefix /opt/neuralgentics
```

---

## 🐳 Option 2: Containerized (Podman/Docker)

Ideal for isolated development or CI environments.

### Steps

1. **Ensure Podman or Docker is installed.**
2. **Clone the repo (or download compose files from the latest release):**
   ```bash
   git clone https://github.com/Veedubin/neuralgentics.git
   cd neuralgentics
   ```
3. **Copy the example env file:**
   ```bash
   cp compose.example.env .env
   $EDITOR .env  # set NEURALGENTICS_DB_PASSWORD
   ```
4. **Spin up the stack:**
   ```bash
   docker compose up -d
   # or
   podman-compose up -d
   ```
5. **Verify the stack is up:**
   ```bash
   docker compose ps
   ```

This brings up PostgreSQL 18 + pgvector, the embedding sidecar, the Go backend, and the TUI (commented out by default; uncomment in `docker-compose.yml` to enable).

Users can browse and activate from a curated catalog of populares MCP servers using the `/catalog` command in the TUI.


Images are published to `ghcr.io/veedubin/neuralgentics-{postgres,sidecar,backend,tui}:vX.Y.Z`.

---

## 💻 Option 3: Build From Source

Required for contributors or those modifying the core Go/Python logic.

1. **Prerequisites:**
   - Go 1.22+
   - Python 3.12+
   - Node.js 20+
   - PostgreSQL with `pgvector` extension
2. **Build the backend:**
   ```bash
   make build
   ```
3. **Initialize the TUI overlay:**
   ```bash
   cd overlay/packages/opencode
   npm install && npm run build
   ```

---

## ⚠️ Special Environments

### WSL / WSL2 Support
Neuralgentics fully supports Windows Subsystem for Linux. 
- ** Detection:** The installer automatically detects WSL and provides specific path warnings.
- **Recommendation:** Always install to `~/.local/bin` inside the Linux distro. **Do not** attempt to call Linux binaries from the Windows CMD/PowerShell prompt unless using `wslpath`.

### Upgrade Paths
To upgrade an existing installation to the latest version:
```bash
curl -fsSL https://raw.githubusercontent.com/Veedubin/neuralgentics/main/scripts/install.sh | bash
```
The installer will detect the existing prefix and overwrite binaries while preserving your `.env` and `memini-core` data.
