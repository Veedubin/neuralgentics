# docker/postgres.Dockerfile
# PostgreSQL + pgvector for Neuralgentics
# Single-stage: pulls official pgvector/pgvector:pg18 base, bakes in schema migrations.
FROM pgvector/pgvector:pg18

# Copy database migration scripts — they run automatically on first container start
# thanks to the PostgreSQL entrypoint's initdb.d mechanism.
COPY packages/memory/src/neuralgentics/memory/store/migrations/postgres/*.up.sql \
     /docker-entrypoint-initdb.d/

# Set default database name (can be overridden by POSTGRES_DB env var).
ENV POSTGRES_DB=neuralgentics

# Default PostgreSQL port.
EXPOSE 5432

# Health check: verify the DB is accepting connections on the default DB.
HEALTHCHECK --interval=5s --timeout=3s --retries=10 --start-period=10s \
    CMD pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-neuralgentics} || exit 1