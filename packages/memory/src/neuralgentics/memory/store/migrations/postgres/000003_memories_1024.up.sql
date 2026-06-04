-- Dual-Model RRF: memories_1024 sidecar table
-- Stores 1024-dim BGE-Large embeddings alongside the 384-dim MiniLM embeddings
-- in the memories table. Both are written on every AddMemory in auto mode.
-- RRF fuses both vector dimensions + text search on every query.

CREATE TABLE IF NOT EXISTS memories_1024 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL
);

-- Vector index for 1024-dim cosine similarity search
CREATE INDEX IF NOT EXISTS idx_memories_1024_embedding ON memories_1024
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index for fast JOIN back to memories table
CREATE INDEX IF NOT EXISTS idx_memories_1024_memory_id ON memories_1024(memory_id);
