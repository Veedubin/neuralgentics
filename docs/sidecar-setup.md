# Python Embedding Sidecar Setup

The Neuralgentics TUI can use a Python gRPC sidecar for BGE-Large (1024-dim)
embeddings. **Without the sidecar, memory operations still work — they use
noop (384-dim) embeddings instead.** The sidecar is an advanced feature for
users who need high-quality semantic search.

## Quick Start (Source Tree)

If you cloned the repo:

```bash
cd neuralgentics
./scripts/sidecar.sh start
```

This creates a venv, installs dependencies, and starts the sidecar on
`/tmp/neuralgentics-embed.sock`. The TUI detects it automatically.

## Manual Setup

1. **Create a venv** in the sidecar directory:

   ```bash
   cd packages/memory/cmd/embedding-sidecar
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   ```

2. **Start the sidecar**:

   ```bash
   NEURAL_EMBED_ADDR=unix:///tmp/neuralgentics-embed.sock \
     .venv/bin/python -m embedding_sidecar.main
   ```

3. **Point the TUI to it** (if not using the default socket):

   ```bash
   export NEURAL_EMBED_ADDR=unix:///tmp/neuralgentics-embed.sock
   neuralgentics
   ```

## Installed Binary (No Source Tree)

Set `NEURALGENTICS_SIDECAR_DIR` to tell the TUI where to find the sidecar:

```bash
export NEURALGENTICS_SIDECAR_DIR=/path/to/embedding-sidecar
neuralgentics
```

Or install the sidecar to the standard location:

```bash
mkdir -p ~/.neuralgentics/share/neuralgentics/sidecar
# Copy the sidecar source there, then create venv + pip install
```

The TUI checks `$NEURALGENTICS_SIDECAR_DIR`, then
`$NEURALGENTICS_INSTALL_PREFIX/share/neuralgentics/sidecar/`, then the
source-tree path.

## GPU Acceleration

Set `NEURALGENTICS_EMBED_DEVICE=cuda` before starting the sidecar:

```bash
NEURALGENTICS_EMBED_DEVICE=cuda ./scripts/sidecar.sh start
```

## Stopping

```bash
./scripts/sidecar.sh stop
```

Or kill the PID in `/tmp/neuralgentics-embed.pid`.