# docker/tui.Dockerfile
# Neuralgentics TUI — multi-stage build using Bun.
# Produces a standalone binary from the TypeScript TUI source.

# ── Builder stage ────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim AS builder

WORKDIR /app

# Copy TUI package.json for dependency installation.
# Note: TUI uses package.json without a lockfile (deps installed via bun install
# with exact=true in bunfig.toml). Running `bun install --no-save` would be a
# no-op since node_modules is already populated; we COPY node_modules in.
COPY packages/tui/package.json ./
COPY packages/tui/node_modules/ node_modules/
COPY packages/tui/bunfig.toml ./

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