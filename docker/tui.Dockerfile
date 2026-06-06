# docker/tui.Dockerfile
# Neuralgentics TUI — multi-stage build using Bun.
# Produces a standalone binary from the TypeScript TUI source.

# ── Builder stage ────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS builder

WORKDIR /app

# Copy TUI package.json (no bun.lock — TUI deps are not pinned to a lockfile).
# node_modules is gitignored so we re-install at build time.
COPY packages/tui/package.json ./
COPY packages/tui/bunfig.toml ./

# Install dependencies (uses bunfig.toml for exact-version pinning).
RUN bun install

# Copy TUI source code.
COPY packages/tui/src/ src/
COPY packages/tui/tsconfig.json ./

# Build the standalone binary.
ARG VERSION=dev
RUN bun build --compile \
    --target=bun-linux-x64 \
    --outfile=dist/neuralgentics \
    src/index.ts

# ── Final stage — minimal runtime ─────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot

# Copy the standalone binary.
COPY --from=builder /app/dist/neuralgentics /usr/local/bin/neuralgentics

# The TUI communicates with the backend via stdin/stdout (JSON-RPC).
# Interactive terminal required.
ENTRYPOINT ["neuralgentics"]