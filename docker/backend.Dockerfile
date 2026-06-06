# docker/backend.Dockerfile
# Neuralgentics Go backend — multi-stage build.
# Produces a minimal static binary in a distroless final image.

# ── Builder stage ────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Copy go.work first for cache-efficient layer ordering.
COPY go.work go.work.sum ./

# Copy all Go module directories (go.work uses local replace directives).
COPY packages/memory/ packages/memory/
COPY packages/orchestrator-go/ packages/orchestrator-go/
COPY packages/broker-go/ packages/broker-go/
COPY packages/backend-go/ packages/backend-go/

# Download dependencies.
WORKDIR /src/packages/backend-go
RUN go mod download

# Build the backend binary with version injection.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /app/neuralgentics-backend ./cmd/backend/

# ── Final stage ──────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot

# Copy CA certificates for TLS connections to PostgreSQL.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy the binary.
COPY --from=builder /app/neuralgentics-backend /usr/local/bin/neuralgentics-backend

# JSON-RPC over stdio — no exposed ports needed (communicates via stdin/stdout).
# However, an HTTP health endpoint can be added in a future revision.
EXPOSE 8080

ENTRYPOINT ["neuralgentics-backend"]