-- Track which embedding model produced the vector for each memory.
-- Enables migration between embedding models (BGE-Large → BGE-M3) and
-- multi-model storage (BGE-M3 + BGE-Large in same DB).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'bge-large-en-v1.5';

-- Index for fast "find all memories embedded with model X" queries
-- (used by the migration script and the embedding-model-aware search).
CREATE INDEX IF NOT EXISTS idx_memories_embedding_model ON memories(embedding_model);