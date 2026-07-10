DROP INDEX IF EXISTS idx_memories_embedding_model;
ALTER TABLE memories DROP COLUMN IF EXISTS embedding_model;