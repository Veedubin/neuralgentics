# docker/tui.Dockerfile
# Neuralgentics TUI — multi-stage build using Bun.
# Produces a standalone binary from the TypeScript TUI source.

# ── Builder stage ────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS builder

WORKDIR /app

# Copy TUI package files for dependency installation.
COPY packages/tui/package.json packages/tui/bun.lock ./

# Install dependencies.
RUN bun install --frozen-lockfile

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