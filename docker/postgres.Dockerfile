# docker/postgres.Dockerfile
# PostgreSQL 18 + pgvector + TimescaleDB for Neuralgentics memory backend.
#
# pgvector/pgvector:pg18 already includes pgvector. We add TimescaleDB
# on top for time-series memory analytics (trust decay, audit logs,
# session metrics).
FROM pgvector/pgvector:pg18

# Install TimescaleDB. The timescaledb-toolkit-postgresql-18 package
# provides the extension. We use the TimescaleDB APT repository for
# the latest version compatible with PG18.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        gnupg \
        wget && \
    # Add TimescaleDB APT repository
    echo "deb https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" \
        > /etc/apt/sources.list.d/timescaledb.list && \
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | \
        gpg --dearmor > /etc/apt/trusted.gpg.d/timescaledb.gpg && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        timescaledb-2-postgresql-18 \
        timescaledb-toolkit-postgresql-18 && \
    apt-get purge -y ca-certificates gnupg wget && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Enable TimescaleDB in shared_preload_libraries. Only timescaledb needs
# preloading: pgvector's library file is vector.so (not pgvector.so), and
# pgvector requires no preload at all — it works via CREATE EXTENSION
# vector. timescaledb_toolkit and vectorscale (pgvectorscale) likewise need
# no preload (they are plain CREATE EXTENSION extensions). Listing
# "pgvector" here previously FATALed the container on boot because no
# pgvector.so exists for PostgreSQL to load.
RUN echo "shared_preload_libraries = 'timescaledb'" \
        >> /usr/share/postgresql/18/postgresql.conf.sample && \
    echo "timescaledb.telemetry_level = 'off'" \
        >> /usr/share/postgresql/18/postgresql.conf.sample

# Copy database migration scripts — they run automatically on first
# container start via PostgreSQL's docker-entrypoint-initdb.d mechanism.
COPY packages/memory/src/neuralgentics/memory/store/migrations/postgres/*.up.sql \
     /docker-entrypoint-initdb.d/

# Add TimescaleDB activation to the init sequence. This runs AFTER
# the schema migrations so the hypertables can be created.
RUN echo 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;' \
        > /docker-entrypoint-initdb.d/99_timescaledb.sql && \
    echo 'CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;' \
        >> /docker-entrypoint-initdb.d/99_timescaledb.sql

# Set default database name (can be overridden by POSTGRES_DB env var).
ENV POSTGRES_DB=neuralgentics

# Default PostgreSQL port.
EXPOSE 5432

# Health check: verify the DB is accepting connections.
HEALTHCHECK --interval=5s --timeout=3s --retries=10 --start-period=10s \
    CMD pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-neuralgentics} || exit 1
