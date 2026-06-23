# Embedding Sidecar Productionization Design

**Status:** Design complete (Architect phase)  
**Card:** T-ARCH-SIDECAR-001  
**Date:** 2026-06-22  
**Author:** boomerang-architect (deepseek-v4-pro)  
**Working directory:** `/home/jcharles/Projects/MCP-Servers/neuralgentics/`

---

## 1. Summary

**Recommended approach: Option D — Hybrid systemd user unit with PID-file fallback.**

The embedding sidecar (`packages/memory/cmd/embedding-sidecar/`) is currently started manually via `setsid` in a shell script (`scripts/sidecar.sh`). This design replaces that with a **systemd user unit** (`neuralgentics-sidecar.service`) as the primary lifecycle manager on systemd-capable systems, and retains the existing PID-file wrapper (`scripts/sidecar.sh`) as a fallback for non-systemd environments (raw containers, WSL1, macOS). The install script (`scripts/install.sh`) auto-detects systemd availability at install time and generates the appropriate configuration. The Go backend remains a **client only** — it does not attempt to start or restart the sidecar, but provides clear error messages pointing users to the correct lifecycle command. This approach maximizes reliability (auto-restart, journald, watchdog) on developer workstations while preserving zero-dependency simplicity everywhere else, and is fully compliant with the Container Deletion Policy (no new containers).

---

## 2. Current State Analysis

### What Exists Today

| Component | File | Purpose |
|-----------|------|---------|
| Sidecar entry point | `packages/memory/cmd/embedding-sidecar/main.py` | Python gRPC server, listens on Unix socket, handles SIGINT/SIGTERM |
| Embedding engine | `packages/memory/cmd/embedding-sidecar/embedding_sidecar/embed.py` | Multi-model support (MiniLM 384-dim, BGE-Large 1024-dim) via `MODEL_REGISTRY` |
| gRPC server | `packages/memory/cmd/embedding-sidecar/embedding_sidecar/server.py` | `EmbeddingServiceServicer` with `Embed`, `EmbedBatch`, `Health` RPCs |
| Health service | `packages/memory/cmd/embedding-sidecar/embedding_sidecar/health.py` | Standard gRPC health check (SERVING) |
| Lifecycle script | `scripts/sidecar.sh` | `start`/`stop`/`restart`/`status` via PID file + `setsid` |
| Dev setup script | `scripts/dev-up.sh` | Brings up DB + sidecar for development (lines 177–271) |
| Go gRPC client | `packages/memory/src/neuralgentics/memory/embed/grpc.go` | `GRPCEmbedder` with `Connect`, `Embed`, `Embed1024`, `EmbedBatch`, `Health`, reconnect logic |
| Go config | `packages/memory/src/neuralgentics/memory/core/config.go` | Reads `MEMINI_EMBEDDING_ADDR` (default: `unix:///tmp/neuralgentics-embed.sock`) and `EMBEDDING_MODE` |
| Broker launcher | `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` | Manages stdio MCP server subprocesses (not gRPC servers) |
| Install script | `scripts/install.sh` | Downloads tarball, extracts, runs `npm install` (no sidecar setup) |

### Pain Points

1. **No auto-restart on crash.** If the sidecar process dies (OOM, segfault, Python exception), it stays dead until a human re-runs `scripts/sidecar.sh start`. The Go backend's reconnect logic (`grpc.go:167–185`) handles transient disconnections but cannot resurrect a dead process.

2. **Manual startup required.** Every reboot, every new terminal session — the user must remember to start the sidecar. `dev-up.sh` does this for development, but there is no production equivalent.

3. **No structured logging.** Output goes to `/tmp/neuralgentics-embed.log` as raw text. No log rotation, no JSON formatting, no correlation with the Go backend's structured logs.

4. **PID file race conditions.** `scripts/sidecar.sh` writes a PID to `/tmp/neuralgentics-embed.pid` but has no atomic locking. Two concurrent `start` calls could race, leaving two sidecars fighting over the same socket.

5. **No health monitoring.** The Go backend's `Health()` method (`grpc.go:138–156`) is only called on-demand. There is no periodic health check, no alerting, no degraded-state detection.

6. **Socket cleanup is fragile.** `scripts/sidecar.sh` does `rm -f "$SOCKET"` on start, which could delete a socket owned by a still-running sidecar if the PID file is stale.

7. **No integration with the install flow.** `scripts/install.sh` sets up the plugin but says nothing about the sidecar. Users discover the sidecar only when the Go backend fails with a connection error.

8. **Broker launcher is stdio-only.** The existing `launcher.go` only handles `"stdio"` type servers (line 191). It cannot manage a gRPC server without a significant redesign of the transport layer.

9. **No graceful degradation.** When the sidecar is down, the Go backend returns raw errors. There is no "sidecar unavailable, using fallback" mode, no degraded-state metrics.

10. **Environment variable sprawl.** `NEURALGENTICS_EMBED_DEVICE`, `NEURAL_EMBED_ADDR`, `MEMINI_EMBEDDING_ADDR`, `EMBEDDING_MODE` — four env vars across three files with overlapping concerns and no single source of truth.

---

## 3. Options Evaluated

### Scoring Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **Simplicity** | High | How easy is this to understand, configure, and debug? Fewer moving parts = better. |
| **Reliability** | High | Does it auto-restart on crash? Handle edge cases (double-start, stale PID)? Survive reboots? |
| **Observability** | Medium | Logs, metrics, health status visibility. Can we tell what's happening without SSH? |
| **Security** | Medium | Least privilege, no root, no race conditions, no information leaks. |
| **Container-policy compliance** | Critical | Must NOT propose new containers. Must NOT touch existing containers. |
| **Debuggability** | Medium | When something breaks, how fast can a developer find the root cause? |

### Comparison Table

| Option | Simplicity | Reliability | Observability | Security | Container Policy | Debuggability | **Total** |
|--------|:----------:|:-----------:|:-------------:|:--------:|:----------------:|:-------------:|:---------:|
| **A. systemd user unit** | 7 | 9 | 9 | 8 | 10 | 7 | **50/60** |
| **B. Broker launcher** | 4 | 6 | 5 | 7 | 10 | 5 | **37/60** |
| **C. PID-file wrapper** | 8 | 3 | 3 | 6 | 10 | 8 | **38/60** |
| **D. Hybrid (systemd + PID-file)** | 6 | 8 | 7 | 7 | 10 | 7 | **45/60** |

### Detailed Rationale

#### Option A: systemd User Unit (Score: 50/60)

**Pros:**
- **Auto-restart on crash** via `Restart=on-failure` + `RestartSec=5s`. The sidecar becomes self-healing.
- **journald integration** — structured logs, `journalctl --user -u neuralgentics-sidecar -f`, log rotation built-in.
- **Watchdog support** — systemd can ping the sidecar's health endpoint and restart if unresponsive.
- **Socket activation** — systemd can create the Unix socket and pass it to the sidecar, eliminating the stale-socket problem entirely.
- **User-scoped** — runs as the user's systemd instance (`systemctl --user`), no root required.
- **`loginctl enable-linger`** — keeps the user's systemd instance alive across SSH sessions, so the sidecar survives logout.
- **Standard Linux init** — every Linux developer understands `systemctl status`.

**Cons:**
- **Requires systemd** — won't work in raw Docker/Podman containers (no init system), WSL1, or macOS.
- **`loginctl enable-linger` required** — one-time setup step that some users may not know about.
- **systemd unit file must be generated** — the install script needs to template and install a `.service` file to `~/.config/systemd/user/`.

**Why not higher on simplicity:** The unit file itself is simple (~20 lines), but the install-time detection and `loginctl enable-linger` step add complexity.

#### Option B: Broker Launcher (Score: 37/60)

**Pros:**
- **Single process tree** — the Go backend supervises the Python sidecar as a child process. No external init system needed.
- **Broker already has lifecycle management** — `launcher.go` has `Start`, `Stop`, `Health` methods with proper signal handling and 5-second graceful shutdown.
- **Natural fit for plugin model** — the sidecar is a dependency of the Go backend; having the backend manage it is architecturally clean.

**Cons:**
- **Requires redesigning the transport** — the broker launcher only handles `"stdio"` type servers (line 191 of `launcher.go`). The sidecar uses gRPC over Unix sockets. To make the broker manage it, we would need to either:
  - Add gRPC transport support to the launcher (significant code change, new `"grpc"` server type).
  - Convert the sidecar to stdio JSON-RPC (loses gRPC benefits: streaming, protobuf, health protocol).
- **Go-Python IPC over stdio is fragile** — stdin/stdout pipes are not designed for long-running bidirectional RPC. gRPC is purpose-built for this.
- **Broker now has more responsibilities** — process supervision is a complex domain (OOM handling, restart backoff, resource limits). The broker should focus on MCP tool routing, not process management.
- **No auto-restart if the Go backend crashes** — if the Go process dies, the sidecar dies with it (child process). systemd can restart both independently.
- **Breaks the existing gRPC health protocol** — the sidecar already has a standard gRPC health check (`health.py`). Converting to stdio would lose this.

**Verdict:** The transport redesign cost outweighs the lifecycle benefit. The sidecar's gRPC interface is well-designed and battle-tested. Breaking it for process supervision is the wrong trade-off.

#### Option C: PID-file Wrapper (Score: 38/60)

**Pros:**
- **Zero new dependencies** — pure bash, works everywhere (Linux, macOS, WSL, containers).
- **What we essentially have now** — `scripts/sidecar.sh` already implements `start`/`stop`/`restart`/`status` with PID file and socket detection.
- **Easy to debug** — `cat /tmp/neuralgentics-embed.log`, `kill -0 $(cat /tmp/neuralgentics-embed.pid)`.

**Cons:**
- **No auto-restart on crash** — if the sidecar dies, it stays dead until a human or cron job re-runs the script.
- **No log rotation** — `/tmp/neuralgentics-embed.log` grows unbounded.
- **PID file race conditions** — two concurrent `start` calls can both pass the `is_running` check and spawn two sidecars.
- **No proper service semantics** — no dependency ordering, no startup timeout enforcement, no watchdog.
- **Not production-ready** — fine for development, but unacceptable for a plugin that claims to "just work."

**Verdict:** This is our current state. It works for development but is not a productionization solution.

#### Option D: Hybrid systemd + PID-file Fallback (Score: 45/60) — **RECOMMENDED**

**Pros:**
- **Best UX on developer workstations** — systemd provides auto-restart, journald, and `systemctl status` on 95%+ of Linux developer machines.
- **Still works in minimal environments** — the PID-file fallback covers raw containers, WSL1, and macOS.
- **Auto-detection at install time** — `scripts/install.sh` checks for systemd and generates the appropriate configuration. No user decision required.
- **Single source of truth for env vars** — both the systemd unit and the PID-file wrapper source the same `.env` file.
- **Graceful degradation** — if systemd is unavailable, the user gets a clear message: "systemd not detected, use `scripts/sidecar.sh start` to manage the sidecar manually."

**Cons:**
- **Two code paths to maintain** — the systemd unit template and the PID-file wrapper must stay in sync (env vars, socket path, log location).
- **More install-script complexity** — `install.sh` grows by ~40 lines for systemd detection and unit file generation.
- **`loginctl enable-linger` is a one-time setup** — users who skip this step will find the sidecar stops when they log out.

**Verdict:** The hybrid approach gives us systemd's reliability where it's available while maintaining the zero-dependency fallback for edge cases. The two code paths are simple enough that the maintenance burden is low. This is the recommended approach.

---

## 4. Recommended Design: Hybrid systemd + PID-file Fallback

### 4.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER'S MACHINE                                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    install.sh (auto-detect)                    │   │
│  │                                                               │   │
│  │  systemd detected?                                            │   │
│  │    ├── YES → Generate ~/.config/systemd/user/                 │   │
│  │    │         neuralgentics-sidecar.service                    │   │
│  │    │         + systemctl --user daemon-reload                 │   │
│  │    │         + loginctl enable-linger (if needed)             │   │
│  │    │                                                          │   │
│  │    └── NO  → Print: "systemd not detected.                    │   │
│  │               Use scripts/sidecar.sh {start|stop|status}"     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────┐     ┌──────────────────────────────────┐   │
│  │   systemd (user)     │     │   PID-file fallback              │   │
│  │                      │     │                                  │   │
│  │  neuralgentics-      │     │  scripts/sidecar.sh              │   │
│  │  sidecar.service     │     │  ├── start (setsid + PID file)  │   │
│  │  ├── Restart=on-     │     │  ├── stop  (SIGTERM → SIGKILL)  │   │
│  │  │   failure         │     │  ├── restart                     │   │
│  │  ├── WatchdogSec=30  │     │  └── status (kill -0)            │   │
│  │  ├── ExecStart=      │     │                                  │   │
│  │  │   python main.py  │     │  /tmp/neuralgentics-embed.pid    │   │
│  │  └── journald logs   │     │  /tmp/neuralgentics-embed.log    │   │
│  └──────────┬───────────┘     └──────────────┬───────────────────┘   │
│             │                                 │                       │
│             └────────────┬────────────────────┘                       │
│                          │                                            │
│                          ▼                                            │
│           ┌──────────────────────────────┐                           │
│           │   Python gRPC Sidecar         │                           │
│           │   (embedding-sidecar)         │                           │
│           │                               │                           │
│           │   Unix socket:                 │                           │
│           │   /tmp/neuralgentics-embed    │                           │
│           │   .sock                        │                           │
│           │                               │                           │
│           │   Models:                      │                           │
│           │   ├── MiniLM (384-dim)         │                           │
│           │   └── BGE-Large (1024-dim)    │                           │
│           └──────────────┬───────────────┘                           │
│                          │                                            │
│                          │ gRPC (Unix socket)                         │
│                          ▼                                            │
│           ┌──────────────────────────────┐                           │
│           │   Go Backend                   │                           │
│           │   (neuralgentics-backend)      │                           │
│           │                               │                           │
│           │   GRPCEmbedder (grpc.go)      │                           │
│           │   ├── Connect()                │                           │
│           │   ├── Embed() / Embed1024()   │                           │
│           │   ├── Health() (every 30s)    │                           │
│           │   └── reconnect() on failure  │                           │
│           │                               │                           │
│           │   Config:                      │                           │
│           │   MEMINI_EMBEDDING_ADDR       │                           │
│           │   EMBEDDING_MODE              │                           │
│           └──────────────────────────────┘                           │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │   neuralgentics-postgres (Podman, port 6000)                   │   │
│  │   ⚠ DO NOT TOUCH — Container Deletion Policy                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Lifecycle State Machine

```
                    ┌──────────┐
                    │  STOPPED  │ ◄──────────────────────────────────┐
                    └─────┬─────┘                                    │
                          │                                          │
              systemctl start / sidecar.sh start                     │
                          │                                          │
                          ▼                                          │
                    ┌──────────┐                                     │
                    │ STARTING  │                                     │
                    └─────┬─────┘                                     │
                          │                                          │
              Socket bound + Health check passes                     │
                          │                                          │
                          ▼                                          │
                    ┌──────────┐     Health check fails              │
                    │  READY    │────────────────────┐               │
                    └─────┬─────┘                    │               │
                          │                          ▼               │
                          │                    ┌───────────┐         │
                          │                    │ DEGRADED   │         │
                          │                    └─────┬──────┘         │
                          │                          │               │
                          │              systemd: Restart=on-failure  │
                          │              PID-file: manual restart    │
                          │                          │               │
                          │                          ▼               │
                          │                    ┌──────────┐          │
                          │                    │ STARTING  │ (retry) │
                          │                    └──────────┘          │
                          │                                          │
              systemctl stop / sidecar.sh stop / SIGTERM             │
                          │                                          │
                          ▼                                          │
                    ┌──────────┐                                     │
                    │ STOPPING  │───(5s grace)──► SIGKILL ──────────┘
                    └──────────┘
```

**State definitions:**

| State | Description | Detection | Recovery |
|-------|-------------|-----------|----------|
| **STOPPED** | Process not running, socket absent, PID file absent | `systemctl is-active` returns inactive; `kill -0` fails | User or systemd starts |
| **STARTING** | Process spawned, waiting for socket bind + model load | Socket not yet present; process alive | Timeout → STOPPED + error log |
| **READY** | Socket bound, gRPC health check returns SERVING | `grpc_health_probe` or Go `Health()` returns nil | — |
| **DEGRADED** | Process alive but health check fails (model OOM, gRPC hang) | `Health()` returns error after 5s timeout | systemd: `Restart=on-failure`; PID-file: manual |
| **STOPPING** | SIGTERM sent, waiting for graceful shutdown (5s) | Process alive but shutting down | After 5s → SIGKILL → STOPPED |

### 4.3 Failure Modes & Recovery

| Failure Mode | Detection | Who Detects | Recovery |
|-------------|-----------|-------------|----------|
| **Sidecar process crashes** (OOM, segfault) | Process exits, socket disappears | systemd: `Restart=on-failure` auto-restarts. PID-file: user must re-run `sidecar.sh start` | systemd: auto-restart with 5s backoff. PID-file: manual. |
| **Sidecar hangs** (deadlock, infinite loop) | Health check timeout (5s) | Go backend's periodic `Health()` call. systemd `WatchdogSec=30` | systemd: watchdog kills + restarts. PID-file: user must `kill -9` + restart. |
| **Model fails to load** (corrupt cache, disk full) | Sidecar exits with error during startup | systemd: `Restart=on-failure` retries 3 times then stops. PID-file: `sidecar.sh start` fails with log output. | Fix underlying issue (clear model cache, free disk). systemd: `systemctl --user reset-failed` then start. |
| **Socket file stolen/deleted** | gRPC dial fails with "connection refused" or "no such file" | Go backend's `Connect()` or `reconnect()` | systemd: `Restart=on-failure` recreates socket. PID-file: `sidecar.sh restart`. |
| **Two sidecars fighting over socket** | Second sidecar fails to bind (address in use) | systemd: socket activation prevents this (systemd owns the socket). PID-file: `sidecar.sh start` checks PID file first. | systemd: second start is a no-op. PID-file: `is_running()` check prevents double-start. |
| **Go backend starts before sidecar** | `Connect()` fails | Go backend's `NewGRPCEmbedder` → `Connect()` returns error | Go backend logs clear error: "Embedding sidecar not available. Start it with: systemctl --user start neuralgentics-sidecar". Retries on next embed call. |
| **systemd user instance not lingering** | Sidecar stops when user logs out | User notices sidecar is down after re-login | `loginctl enable-linger` (one-time). install.sh prompts for this. |

### 4.4 Configuration: Where Env Vars Live

**Single source of truth:** `~/.neuralgentics/.env` (or `$NEURALGENTICS_DATA_DIR/.env`)

```bash
# ~/.neuralgentics/.env — sourced by both systemd unit and sidecar.sh
NEURALGENTICS_EMBED_DEVICE=cpu          # cpu | cuda
NEURAL_EMBED_ADDR=unix:///tmp/neuralgentics-embed.sock
EMBEDDING_MODE=auto                     # cpu | auto | gpu
MEMINI_EMBEDDING_ADDR=unix:///tmp/neuralgentics-embed.sock
```

**systemd unit** (`~/.config/systemd/user/neuralgentics-sidecar.service`):
```ini
[Service]
EnvironmentFile=%h/.neuralgentics/.env
ExecStart=%h/.neuralgentics/packages/memory/cmd/embedding-sidecar/.venv/bin/python \
          -m embedding_sidecar.main
WorkingDirectory=%h/.neuralgentics/packages/memory/cmd/embedding-sidecar
```

**PID-file wrapper** (`scripts/sidecar.sh`):
```bash
# Source the env file if it exists
if [ -f "$HOME/.neuralgentics/.env" ]; then
    set -a; source "$HOME/.neuralgentics/.env"; set +a
fi
```

**Go backend** (`config.go`): Unchanged. Already reads `MEMINI_EMBEDDING_ADDR` and `EMBEDDING_MODE` from the environment. The env file is sourced by the shell before launching the Go binary, or the vars are set in the systemd unit for the backend.

**Env var consolidation (future):** The four env vars have overlapping concerns:
- `NEURAL_EMBED_ADDR` — where the sidecar listens (sidecar-side)
- `MEMINI_EMBEDDING_ADDR` — where the Go backend connects (client-side)
- `EMBEDDING_MODE` — which models to use (both sides)
- `NEURALGENTICS_EMBED_DEVICE` — CPU vs GPU (sidecar-side)

These should eventually be consolidated into a single `NEURALGENTICS_EMBEDDING_*` namespace, but that is out of scope for this design (it would require coordinated changes to the Go backend, Python sidecar, and all scripts). For now, the `.env` file keeps them in one place.

### 4.5 Socket Path Strategy

**Primary: Fixed path — `unix:///tmp/neuralgentics-embed.sock`**

This is the current default and works well for single-user developer machines. The path is:
- Predictable (no discovery needed)
- Easy to debug (`ls -la /tmp/neuralgentics-embed.sock`)
- Already configured in the Go backend (`config.go:31`) and sidecar (`main.py:41`)

**systemd socket activation (future enhancement):**

systemd can create and manage the socket file, passing it to the sidecar as an already-open file descriptor. This eliminates the stale-socket problem entirely:
```ini
[Socket]
ListenStream=%t/neuralgentics-embed.sock
SocketMode=0660

[Install]
WantedBy=sockets.target
```

The sidecar would need a small change to accept a socket FD from systemd (`sd_listen_fds` via `python-systemd`). This is a nice-to-have for v0.8.0+, not required for the initial productionization.

**Abstract namespace (Linux-only, future enhancement):**

Abstract Unix sockets (`\0neuralgentics-embed`) don't create filesystem artifacts, avoiding cleanup issues entirely. However, they're Linux-only and harder to debug (`ss -xlp | grep neuralgentics`). Not recommended for the initial release.

### 4.6 Logs

**systemd path: journald**

```ini
[Service]
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuralgentics-sidecar
```

The Python sidecar already uses `logging.basicConfig(format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")` (`main.py:27–29`). This output goes to journald automatically. To get structured JSON, add a `journald` handler in a future PR:

```python
# Future: structured JSON logging
from systemd.journal import JournalHandler
handler = JournalHandler(SYSLOG_IDENTIFIER='neuralgentics-sidecar')
```

**PID-file fallback path: `/tmp/neuralgentics-embed.log`**

Current behavior, unchanged. Add logrotate integration:

```
# /etc/logrotate.d/neuralgentics-sidecar (or ~/.config/logrotate.d/)
/tmp/neuralgentics-embed.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

### 4.7 Health Check Protocol

**Go backend periodic health check:**

The Go backend's `GRPCEmbedder.Health()` method (`grpc.go:138–156`) already implements a gRPC health check with a 5-second timeout. This should be called:

1. **On startup** — before accepting any embed requests, verify the sidecar is ready.
2. **Periodically** — every 30 seconds in a background goroutine. If the health check fails, log a warning and set a `degraded` flag. The next embed request will trigger a reconnect attempt.
3. **On embed failure** — the existing `reconnect()` logic (`grpc.go:167–185`) already handles this.

**systemd watchdog:**

```ini
[Service]
WatchdogSec=30
```

The sidecar would need to call `sd_notify(0, "WATCHDOG=1")` every 30 seconds. This can be done via the `python-systemd` package or a simple health-check loop in the sidecar's main coroutine. If the sidecar fails to ping, systemd kills and restarts it.

**Health check endpoint:**

The sidecar already exposes:
- Standard gRPC health check (`grpc.health.v1.Health/Check`) via `health.py`
- Custom `Health` RPC (`embedding.v1.EmbeddingService/Health`) via `server.py:71–77`

Both return "ready" when the server is accepting requests. The Go backend uses the custom `Health` RPC.

### 4.8 PID / Lock File Strategy

**systemd: No PID file needed.** systemd tracks the process directly via cgroups. The `PIDFile=` directive is not used.

**PID-file fallback: `/tmp/neuralgentics-embed.pid`**

The existing `scripts/sidecar.sh` already uses this. Improvements needed:

1. **Atomic write:** Write to a temp file, then `mv` to the final path:
   ```bash
   echo "$pid" > "/tmp/neuralgentics-embed.pid.tmp"
   mv "/tmp/neuralgentics-embed.pid.tmp" "/tmp/neuralgentics-embed.pid"
   ```

2. **Stale PID detection:** Before starting, check if the PID in the file is still alive. If not, clean up and proceed.

3. **Lock file for mutual exclusion:** Use `flock` to prevent two `start` calls from racing:
   ```bash
   exec 200>/tmp/neuralgentics-embed.lock
   flock -n 200 || { echo "Another sidecar start is in progress"; exit 1; }
   ```

---

## 5. Migration Path

### Files to Change (in dependency order)

| Order | File | Change | Card |
|-------|------|--------|------|
| 1 | `scripts/sidecar.sh` | Add env file sourcing, atomic PID write, flock locking, logrotate hint | T-IMPL-SIDECAR-002 |
| 2 | `scripts/install.sh` | Add systemd detection, unit file generation, `loginctl enable-linger` prompt | T-IMPL-SIDECAR-003 |
| 3 | `packages/memory/cmd/embedding-sidecar/main.py` | Add `WATCHDOG_USEC` support (sd_notify), structured JSON logging option | T-IMPL-SIDECAR-004 |
| 4 | `packages/memory/src/neuralgentics/memory/embed/grpc.go` | Add periodic health check goroutine, degraded state flag, improved error messages | T-IMPL-SIDECAR-005 |
| 5 | `packages/memory/src/neuralgentics/memory/core/config.go` | Add `SidecarAutoStart` config flag (default false), env file path config | T-IMPL-SIDECAR-006 |
| 6 | `scripts/dev-up.sh` | Update to use new lifecycle (systemctl or sidecar.sh), remove inline sidecar startup | T-IMPL-SIDECAR-007 |
| 7 | `scripts/.env.example` | Add embedding vars (`NEURALGENTICS_EMBED_DEVICE`, `NEURAL_EMBED_ADDR`, `EMBEDDING_MODE`, `MEMINI_EMBEDDING_ADDR`) | T-IMPL-SIDECAR-008 |
| 8 | `README.md` / `docs/index.md` | Document sidecar lifecycle: how to start/stop/check status on systemd and non-systemd systems | T-IMPL-SIDECAR-009 |

### Files NOT to Change

- `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` — Broker launcher remains stdio-only. The sidecar stays gRPC.
- `docker/sidecar.Dockerfile` — Container image is unchanged. The sidecar inside a container uses its own init system (tini or similar).
- `docker-compose.yml` — Unchanged. Container-based deployments manage the sidecar via Docker/Podman's own lifecycle.
- Any Podman container or volume — Container Deletion Policy.

### Rollback Plan

If the systemd unit causes issues, the user can:
```bash
systemctl --user stop neuralgentics-sidecar
systemctl --user disable neuralgentics-sidecar
# Fall back to PID-file wrapper:
./scripts/sidecar.sh start
```

The PID-file wrapper (`scripts/sidecar.sh`) is always available as a fallback, even when systemd is installed.

---

## 6. Open Questions

These decisions should be made by the user before implementation begins:

1. **Auto-start on login vs. on-demand?**
   - **Recommendation:** On-demand (start when neuralgentics is invoked). The systemd unit should be `WantedBy=default.target` but with `ConditionPathExists=%h/.neuralgentics/.env` so it only activates when neuralgentics is installed. The user can `systemctl --user enable neuralgentics-sidecar` for auto-start.
   - **Alternative:** Auto-start on login. Simpler UX but wastes resources when the user isn't using neuralgentics.

2. **Should the Go backend ever attempt to start the sidecar?**
   - **Recommendation:** No. The Go backend is a client, not a process supervisor. It should fail with a clear error message pointing to the correct lifecycle command.
   - **Alternative:** The Go backend could call `systemctl --user start neuralgentics-sidecar` via `os/exec` if `SidecarAutoStart=true` in config. This adds complexity and blurs the separation of concerns.

3. **Should the systemd unit use socket activation?**
   - **Recommendation:** Not in the initial release. Socket activation requires changes to the Python sidecar (`sd_listen_fds`) and adds complexity. The fixed-path socket with PID file locking is sufficient for v0.8.0.
   - **Alternative:** Implement socket activation now for maximum reliability. Requires `python-systemd` dependency and ~20 lines of Python changes.

4. **Should the `.env` file be auto-generated or user-edited?**
   - **Recommendation:** Auto-generated by `install.sh` with sensible defaults (`EMBED_DEVICE=cpu`, `EMBEDDING_MODE=auto`). The user can edit it to enable GPU or change the socket path.
   - **Alternative:** Template file (`.env.example`) that the user copies and edits. More explicit but more steps.

5. **Log format: plain text or structured JSON?**
   - **Recommendation:** Plain text for now (current behavior). Add a `--log-format=json` flag in a future PR. journald can ingest plain text; structured JSON is a nice-to-have.
   - **Alternative:** Structured JSON from day one. Better for log aggregation but requires changes to the Python logging config.

---

## 7. Implementation Breakdown

### T-Cards for Coder Dispatch

All cards follow AGENTS.md Rule 4: one task per coder dispatch. Cards are listed in dependency order.

| Card ID | Description | Files Touched | Dependencies | Est. Lines |
|---------|-------------|---------------|--------------|------------|
| **T-IMPL-SIDECAR-002** | Harden `scripts/sidecar.sh`: add env file sourcing, atomic PID write, `flock` locking, logrotate hint, improved error messages | `scripts/sidecar.sh` | None | ~40 |
| **T-IMPL-SIDECAR-003** | Extend `scripts/install.sh`: add systemd detection, unit file template generation, `loginctl enable-linger` prompt, env file generation | `scripts/install.sh` | T-IMPL-SIDECAR-002 | ~60 |
| **T-IMPL-SIDECAR-004** | Add systemd watchdog support to sidecar: `sd_notify` WATCHDOG=1 in main loop, `--log-format` flag (json/text), graceful shutdown improvements | `packages/memory/cmd/embedding-sidecar/main.py`, `requirements.txt` | None | ~30 |
| **T-IMPL-SIDECAR-005** | Add periodic health check to Go gRPC client: background goroutine every 30s, degraded state flag, improved error messages with lifecycle hints | `packages/memory/src/neuralgentics/memory/embed/grpc.go` | None | ~50 |
| **T-IMPL-SIDECAR-006** | Add `SidecarAutoStart` config flag and env file path to Go config: new `SidecarAutoStart bool` field, `SidecarEnvFile string` field, validation | `packages/memory/src/neuralgentics/memory/core/config.go` | None | ~20 |
| **T-IMPL-SIDECAR-007** | Update `scripts/dev-up.sh`: use systemctl or sidecar.sh for sidecar lifecycle, remove inline `setsid` startup, add status check | `scripts/dev-up.sh` | T-IMPL-SIDECAR-002, T-IMPL-SIDECAR-003 | ~30 |
| **T-IMPL-SIDECAR-008** | Update `scripts/.env.example`: add embedding vars with documentation comments | `scripts/.env.example` | None | ~15 |
| **T-IMPL-SIDECAR-009** | Update documentation: README quickstart, docs/index.md sidecar section, troubleshooting guide | `README.md`, `docs/index.md` | T-IMPL-SIDECAR-003 | ~40 |

**Total estimated lines:** ~285 across 8 files.

### systemd Unit File Template

This is the template that `install.sh` generates at `~/.config/systemd/user/neuralgentics-sidecar.service`:

```ini
[Unit]
Description=Neuralgentics Embedding Sidecar (gRPC)
Documentation=https://github.com/Veedubin/neuralgentics
After=network.target

[Service]
Type=simple
EnvironmentFile=%h/.neuralgentics/.env
ExecStart=%h/.neuralgentics/packages/memory/cmd/embedding-sidecar/.venv/bin/python \
          -m embedding_sidecar.main
WorkingDirectory=%h/.neuralgentics/packages/memory/cmd/embedding-sidecar

# Restart policy
Restart=on-failure
RestartSec=5s
StartLimitBurst=3
StartLimitIntervalSec=60

# Watchdog (requires sd_notify support in sidecar — T-IMPL-SIDECAR-004)
WatchdogSec=30

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=neuralgentics-sidecar

# Security hardening
NoNewPrivileges=yes
PrivateTmp=no
# PrivateTmp=no because we need /tmp/neuralgentics-embed.sock to be shared

# Resource limits
MemoryHigh=4G
MemoryMax=6G
CPUQuota=200%

[Install]
WantedBy=default.target
```

### install.sh systemd Detection Logic (pseudocode)

```bash
# In scripts/install.sh, after extraction and npm install:

detect_systemd() {
    # Check if systemd is available for the user
    if command -v systemctl >/dev/null 2>&1 && \
       systemctl --user >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

setup_sidecar_lifecycle() {
    local sidecar_dir="$PREFIX/packages/memory/cmd/embedding-sidecar"

    # Generate .env file with defaults
    cat > "$PREFIX/.env" <<'EOF'
# Neuralgentics embedding sidecar configuration
NEURALGENTICS_EMBED_DEVICE=cpu
NEURAL_EMBED_ADDR=unix:///tmp/neuralgentics-embed.sock
EMBEDDING_MODE=auto
MEMINI_EMBEDDING_ADDR=unix:///tmp/neuralgentics-embed.sock
EOF

    if detect_systemd; then
        log "systemd detected — installing user unit"
        mkdir -p "$HOME/.config/systemd/user"

        # Generate unit file from template (substitute %h with $HOME)
        sed "s|%h|$HOME|g" "$SCRIPT_DIR/../templates/neuralgentics-sidecar.service" \
            > "$HOME/.config/systemd/user/neuralgentics-sidecar.service"

        systemctl --user daemon-reload

        # Check if linger is enabled
        if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q "yes"; then
            warn "User lingering is not enabled. The sidecar will stop when you log out."
            warn "Run: loginctl enable-linger"
        fi

        log "Sidecar lifecycle: systemctl --user {start,stop,status} neuralgentics-sidecar"
    else
        warn "systemd not detected. Using PID-file fallback."
        log "Sidecar lifecycle: $PREFIX/scripts/sidecar.sh {start,stop,restart,status}"
    fi
}
```

---

## Appendix A: Files Referenced

| File | Lines | Purpose |
|------|-------|---------|
| `packages/memory/cmd/embedding-sidecar/main.py` | 73 | Sidecar entry point, signal handling |
| `packages/memory/cmd/embedding-sidecar/embedding_sidecar/embed.py` | 126 | Multi-model embedding engine |
| `packages/memory/cmd/embedding-sidecar/embedding_sidecar/server.py` | 97 | gRPC server with Embed/EmbedBatch/Health |
| `packages/memory/cmd/embedding-sidecar/embedding_sidecar/health.py` | 23 | gRPC health check service |
| `scripts/sidecar.sh` | 175 | Current PID-file lifecycle wrapper |
| `scripts/dev-up.sh` | 331 | Development environment setup (DB + sidecar) |
| `scripts/install.sh` | 216 | Plugin installer (no sidecar setup currently) |
| `scripts/.env.example` | 25 | Database env vars only (no embedding vars) |
| `packages/memory/src/neuralgentics/memory/embed/grpc.go` | 197 | Go gRPC client with reconnect logic |
| `packages/memory/src/neuralgentics/memory/core/config.go` | 166 | Go config (MEMINI_EMBEDDING_ADDR, EMBEDDING_MODE) |
| `packages/broker-go/src/neuralgentics/broker/launcher/launcher.go` | 208 | Broker process launcher (stdio-only) |
| `docs/design/session-29-container-architecture.md` | 790 | Container stack design (sidecar as container) |

## Appendix B: Design Decisions Log

| Decision | Rationale | Reversible? |
|----------|-----------|-------------|
| systemd as primary, PID-file as fallback | Best reliability on Linux dev machines, zero-dependency fallback for edge cases | Yes — can switch to pure systemd or pure PID-file later |
| Go backend does NOT start the sidecar | Separation of concerns: client vs. process supervisor | Yes — can add `SidecarAutoStart=true` config flag later |
| Fixed socket path (not abstract namespace) | Simpler, already in use, debuggable with `ls -la` | Yes — can add abstract namespace as an option later |
| No socket activation in v0.8.0 | Adds complexity (python-systemd dep, sd_listen_fds) for marginal benefit at this stage | Yes — can add in v0.9.0 |
| Env file as single source of truth | Avoids duplication between systemd unit and PID-file wrapper | Yes — can switch to config file (YAML/TOML) later |
| Plain text logs (not structured JSON) | Current behavior, journald handles plain text fine | Yes — can add `--log-format=json` flag later |
