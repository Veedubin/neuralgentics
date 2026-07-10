-- Multi-model embedding support (v0.12.0)
-- Adds embedding_bge_m3 column to the memories table for storing a second
-- 1024-dim embedding (BGE-M3) alongside the existing embedding column (384-dim
-- MiniLM by default, or 1024-dim BGE-Large if migrated).
--
-- This enables multi-model RRF (Reciprocal Rank Fusion): queries are embedded
-- with each model, searched against the corresponding column, and the ranked
-- lists are fused using RRF to produce a single ranked result set.
--
-- The existing memories_1024 sidecar table (migration 000003) remains for
-- backward compatibility with the dual-model elevation path. This column-based
-- approach is the preferred path for v0.12.0+.

-- Add the BGE-M3 embedding column (1024-dim, nullable — only populated when
-- the sidecar produces BGE-M3 vectors).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_bge_m3 vector(1024);

-- HNSW index for cosine similarity search on the BGE-M3 column.
-- Only indexes non-null rows, keeping the index small when the column is
-- sparsely populated.
CREATE INDEX IF NOT EXISTS idx_memories_embedding_bge_m3 ON memories
USING hnsw (embedding_bge_m3 vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE embedding_bge_m3 IS NOT NULL;