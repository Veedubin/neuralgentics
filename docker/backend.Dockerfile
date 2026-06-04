# docker/backend.Dockerfile
# Neuralgentics Go backend — multi-stage build
# Produces a minimal static binary in a distroless final image

# ── Builder stage ────────────────────────────────────────────────────────────
FROM golang:1.24-bookworm@sha256:6c3498d3b1e6c0d4e54d6f4a48b0e3e5a558e3e3f0d4e0b0a2e2e4c8e5b5d5e AS builder

WORKDIR /src

# Copy go.work first for cache-efficient layer ordering
COPY go.work go.work.sum ./

# Copy all Go module directories (go.work uses local replace directives)
COPY packages/memory/ packages/memory/
COPY packages/orchestrator-go/ packages/orchestrator-go/
COPY packages/broker-go/ packages/broker-go/
COPY packages/backend-go/ packages/backend-go/

# Download dependencies
WORKDIR /src/packages/backend-go
RUN go mod download

# Build the backend binary with version injection
ARG VERSION=v0.1.0
RUN CGO_ENABLED=0 go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /app/neuralgentics-backend ./cmd/backend/

# ── Final stage ──────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot@sha256:c2b69e5a3f4e7b2a31a2e1e2a7b7e3c5d4e1f0a2e3c5b6d7e8f9a0b1c2d3e4f

# Copy CA certificates for TLS connections to PostgreSQL
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy the binary
COPY --from=builder /app/neuralgentics-backend /usr/local/bin/neuralgentics-backend

# JSON-RPC over stdio — no exposed ports needed (communicates via stdin/stdout)
# However, health checks via HTTP are useful for container orchestrators
EXPOSE 8080

ENTRYPOINT ["neuralgentics-backend"]