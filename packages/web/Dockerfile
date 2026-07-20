# Multi-stage Dockerfile for neuralgentics-web team-server mode.
#
# Build:  docker build -t neuralgentics-web:0.13.0 -f Dockerfile .
# Run:    docker run -p 9877:9877 -e NEURALGENTICS_WEB_DB_URL=postgresql://... \
#           neuralgentics-web:0.13.0
#
# The image ships in two stages:
#   1. builder — installs the package + optional [team-server] extras
#   2. runtime — distroless python:3.12-slim, no shell, no compilers

# ---------- stage 1: builder ----------
FROM python:3.12-slim AS builder

WORKDIR /build

# Install build deps for asyncpg (the only native-ish dep).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy just the package + pyproject for cache-friendly install.
COPY pyproject.toml README.md /build/
COPY src/ /build/src/

RUN pip install --no-cache-dir --prefix=/install -e .[team-server]

# ---------- stage 2: runtime ----------
FROM python:3.12-slim AS runtime

LABEL org.opencontainers.image.title="neuralgentics-web"
LABEL org.opencontainers.image.description="Modular web UI shell for neuralgentics"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/Veedubin/neuralgentics"

# Only the shared libs needed by asyncpg at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 web

COPY --from=builder /install /usr/local

USER web
WORKDIR /home/web

ENV NEURALGENTICS_WEB_MODE=team-server
ENV NEURALGENTICS_WEB_HOST=0.0.0.0
ENV NEURALGENTICS_WEB_PORT=9877

EXPOSE 9877

# No shell in distroless; here we use python:slim so the entry is python -m.
CMD ["python", "-m", "neuralgentics.web"]