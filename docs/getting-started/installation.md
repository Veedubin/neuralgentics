# Installation

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
   curl -fsSL https://github.com/neuralgentics/neuralgentics/releases/latest/download/install.sh | bash
   ```
2. **Verify the install:**
   ```bash
   neuralgentics status
   ```

### Customization
You can customize the installation root using the `--prefix` flag:
```bash
./scripts/install.sh --prefix /opt/neuralgentics
```

---

## 🐳 Option 2: Containerized (Podman/Docker)

Ideal for isolated development or CI environments.

1. **Ensure Podman or Docker is installed.**
2. **Spin up the stack:**
   ```bash
   podman-compose up -d
   ```
3. **Enter the environment:**
   ```bash
   podman exec -it neuralgentics-backend /bin/sh
   ```

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
curl -fsSL https://github.com/neuralgentics/neuralgentics/releases/latest/download/install.sh | bash
```
The installer will detect the existing prefix and overwrite binaries while preserving your `.env` and `memini-core` data.
