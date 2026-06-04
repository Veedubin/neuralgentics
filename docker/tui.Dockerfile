# docker/tui.Dockerfile
# Neuralgentics TUI — multi-stage build using Bun
# Produces a standalone binary from the TypeScript TUI source

# ── Builder stage ────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim@sha256:7e53f4b6b5e7f1e4e4e8c9c2e7e0f2e8f1c9a7e3d5c3e5f1a7e9d3c5b1a4f2e AS builder

WORKDIR /app

# Copy TUI package files for dependency installation
COPY packages/tui/package.json packages/tui/bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy TUI source code
COPY packages/tui/src/ src/
COPY packages/tui/tsconfig.json ./

# Build the standalone binary
ARG VERSION=v0.1.0
RUN bun build --compile \
    --target=bun-linux-x64 \
    --outfile=dist/neuralgentics \
    src/index.ts

# ── Final stage — minimal runtime ─────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot@sha256:c2b69e5a3f4e7b2a31a2e1e2a7b7e3c5d4e1f0a2e3c5b6d7e8f9a0b1c2d3e4f

# Copy the standalone binary
COPY --from=builder /app/dist/neuralgentics /usr/local/bin/neuralgentics

# The TUI communicates with the backend via stdin/stdout (JSON-RPC)
# Interactive terminal required
ENTRYPOINT ["neuralgentics"]