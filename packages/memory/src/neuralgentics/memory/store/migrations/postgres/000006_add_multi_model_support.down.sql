-- Drop the BGE-M3 embedding column and its index.
-- The embedding_model column was added in 000005 and is NOT dropped here.
DROP INDEX IF EXISTS idx_memories_embedding_bge_m3;
ALTER TABLE memories DROP COLUMN IF EXISTS embedding_bge_m3;