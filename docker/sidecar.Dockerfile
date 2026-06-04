# docker/sidecar.Dockerfile
# Python gRPC embedding service for Neuralgentics
# Multi-stage: builder installs deps, final image is slim
FROM python:3.11-slim-bookworm@sha256:3385a8b7e32c5b3e8e3a5b74c7e8ea31a8b6e144e0e0fb8694f2b73c881e8c2 AS builder

# Install build dependencies for native extensions (grpcio, etc.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
RUN pip install --no-cache-dir uv

WORKDIR /app

# Copy requirements first for cache-efficient builds
COPY packages/memory/cmd/embedding-sidecar/requirements.txt .

# Install Python dependencies using uv (much faster than pip)
RUN uv pip install --system --no-cache -r requirements.txt

# ── Final stage ──────────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm@sha256:3385a8b7e32c5b3e8e3a5b74c7e8ea31a8b6e144e0e0fb8694f2b73c881e8c2

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages/ /usr/local/lib/python3.11/site-packages/

WORKDIR /app

# Copy sidecar source code
COPY packages/memory/cmd/embedding-sidecar/main.py .
COPY packages/memory/cmd/embedding-sidecar/embedding_sidecar/ embedding_sidecar/
COPY packages/memory/cmd/embedding-sidecar/proto/ proto/

# gRPC embedding service port
EXPOSE 50051

# Set Python path so imports resolve correctly
ENV PYTHONPATH=/app
ENV NEURAL_EMBED_ADDR=0.0.0.0:50051

# Health check via Python gRPC channel ready probe
HEALTHCHECK --interval=10s --timeout=7s --start-period=30s --retries=5 \
    CMD python -c "import grpc; ch=grpc.insecure_channel('localhost:50051'); grpc.channel_ready_future(ch).result(timeout=5)" || exit 1

CMD ["python", "main.py"]