-- Phase 3: Project indexer chunks table
-- Stores file chunks for semantic code search

CREATE TABLE IF NOT EXISTS project_chunks (
    id VARCHAR(36) PRIMARY KEY,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(384),
    start_line INTEGER NOT NULL DEFAULT 0,
    end_line INTEGER NOT NULL DEFAULT 0,
    content_hash VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fast path-based deletion
CREATE INDEX IF NOT EXISTS idx_project_chunks_file_path ON project_chunks (file_path);

-- Index for vector similarity search (HNSW by default)
CREATE INDEX IF NOT EXISTS idx_project_chunks_embedding ON project_chunks USING hnsw (embedding vector_cosine_ops);

-- Index for content hash lookups
CREATE INDEX IF NOT EXISTS idx_project_chunks_content_hash ON project_chunks (content_hash);