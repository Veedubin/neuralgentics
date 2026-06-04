# docker/postgres.Dockerfile
# PostgreSQL 17 + pgvector extension for Neuralgentics
# Extends the pgvector base image and adds our migration scripts
FROM pgvector/pgvector:pg17@sha256:8a6a4e93ab4e8d7f9d9d1e0c6c6b3ba0d0d85b5c4dbdf9ef8f9ea8f7640ab3b4

# Copy database migration scripts — they run automatically on first container start
# thanks to the PostgreSQL entrypoint's initdb.d mechanism
COPY packages/memory/src/neuralgentics/memory/store/migrations/postgres/*.up.sql \
     /docker-entrypoint-initdb.d/

# Set default database name (can be overridden by POSTGRES_DB env var)
ENV POSTGRES_DB=neuralgentics