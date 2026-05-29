-- Neuralgentics Memory System: Initial Schema
-- Direct port of memini-ai-dev/src/memini_ai/postgres/schema.py
-- All 11 tables + indexes, preserving identical structure.

-- Enable pgvector extension for vector data type (required)
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable vectorscale extension for StreamingDiskANN index (optional)
-- Fail gracefully if unavailable — we'll use HNSW indexes instead.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vectorscale;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'vectorscale extension unavailable, will use HNSW indexes';
END $$;

-- =============================================================================
-- Peers table (must come first — other tables reference it via FK)
-- =============================================================================

CREATE TABLE IF NOT EXISTS peers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'COLLABORATOR' CHECK (
        role IN ('OWNER', 'COLLABORATOR', 'READONLY', 'GUEST')
    ),
    trust_level FLOAT DEFAULT 1.0 CHECK (trust_level >= 0 AND trust_level <= 1),
    preferences JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE
);

-- =============================================================================
-- Memories table
-- =============================================================================

CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text TEXT NOT NULL,
    embedding vector(384),
    source_type VARCHAR(50) NOT NULL CHECK (
        source_type IN ('session', 'file', 'web', 'boomerang', 'project', 'thought')
    ),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    trust_score FLOAT DEFAULT 0.5 CHECK (trust_score >= 0 AND trust_score <= 1),
    retrieval_count INT DEFAULT 0,
    is_archived BOOLEAN DEFAULT FALSE,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
    content_hash VARCHAR(64),
    source_path TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at_ms BIGINT DEFAULT 0,
    supersedes_id UUID REFERENCES memories(id) ON DELETE SET NULL,
    structured_fields JSONB DEFAULT NULL,
    change_ratio FLOAT DEFAULT 1.0 CHECK (change_ratio >= 0 AND change_ratio <= 1)
);

-- Memories vector index: HNSW (used when vectorscale is unavailable)
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Memories secondary indexes
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_score) WHERE NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at) WHERE NOT is_archived;
CREATE INDEX IF NOT EXISTS idx_memories_peer ON memories(peer_id) WHERE peer_id IS NOT NULL;

-- =============================================================================
-- Memory Relationships table
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL CHECK (
        relationship_type IN ('SUPERSEDES', 'RELATED_TO', 'CONTRADICTS', 'DERIVED_FROM')
    ),
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE(source_id, target_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_mem_rel_source ON memory_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_mem_rel_target ON memory_relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_mem_rel_type ON memory_relationships(relationship_type);

-- =============================================================================
-- Entities table (Knowledge Graph)
-- =============================================================================

CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(500) NOT NULL,
    entity_type VARCHAR(50) NOT NULL CHECK (
        entity_type IN ('PERSON', 'ORGANIZATION', 'CONCEPT', 'CODE', 'PROJECT', 'LOCATION', 'UNKNOWN')
    ),
    canonical_name VARCHAR(500),
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    embedding vector(384),
    peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
    mention_count INT DEFAULT 1,
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(name, entity_type, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_entities_peer ON entities(peer_id) WHERE peer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

-- =============================================================================
-- Entity Relationships table
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL,
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(source_entity_id, target_entity_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_ent_rel_source ON entity_relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_ent_rel_target ON entity_relationships(target_entity_id);

-- =============================================================================
-- Memory Sharing table
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_sharing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    peer_id UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
    permission VARCHAR(50) NOT NULL DEFAULT 'SHARED' CHECK (
        permission IN ('PRIVATE', 'SHARED', 'INHERITED')
    ),
    granted_by UUID REFERENCES peers(id) ON DELETE SET NULL,
    granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(memory_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_mem_sharing_memory ON memory_sharing(memory_id);
CREATE INDEX IF NOT EXISTS idx_mem_sharing_peer ON memory_sharing(peer_id);

-- =============================================================================
-- User Profiles table
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    peer_id UUID UNIQUE REFERENCES peers(id) ON DELETE CASCADE,
    preferences JSONB DEFAULT '{}'::jsonb,
    communication_style VARCHAR(100) DEFAULT 'neutral',
    expertise_level VARCHAR(50) DEFAULT 'intermediate',
    dialectic_notes JSONB DEFAULT '[]'::jsonb,
    warmed_up BOOLEAN DEFAULT FALSE,
    session_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_peer ON user_profiles(peer_id) WHERE peer_id IS NOT NULL;

-- =============================================================================
-- Trust Adjustments table
-- =============================================================================

CREATE TABLE IF NOT EXISTS trust_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    old_score FLOAT NOT NULL,
    new_score FLOAT NOT NULL,
    signal VARCHAR(50) NOT NULL CHECK (
        signal IN ('agent_used', 'agent_ignored', 'user_corrected', 'user_confirmed')
    ),
    adjustment_amount FLOAT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_adj_memory ON trust_adjustments(memory_id);
CREATE INDEX IF NOT EXISTS idx_trust_adj_created ON trust_adjustments(created_at);

-- =============================================================================
-- Thought Chains table
-- =============================================================================

CREATE TABLE IF NOT EXISTS thought_chains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255),
    parent_chain_id UUID REFERENCES thought_chains(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thought_chains_session ON thought_chains(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thought_chains_parent ON thought_chains(parent_chain_id) WHERE parent_chain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thought_chains_status ON thought_chains(status) WHERE status = 'active';

-- =============================================================================
-- Thoughts table
-- =============================================================================

CREATE TABLE IF NOT EXISTS thoughts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id UUID NOT NULL REFERENCES thought_chains(id) ON DELETE CASCADE,
    thought TEXT NOT NULL,
    thought_number INTEGER NOT NULL CHECK (thought_number >= 1),
    total_thoughts INTEGER NOT NULL CHECK (total_thoughts >= 1),
    next_thought_needed BOOLEAN NOT NULL,
    is_revision BOOLEAN DEFAULT FALSE,
    revises_thought_id UUID REFERENCES thoughts(id) ON DELETE SET NULL,
    branch_from_thought_id UUID REFERENCES thoughts(id) ON DELETE SET NULL,
    branch_id VARCHAR(255),
    embedding vector(384),
    content_hash VARCHAR(64),
    memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding ON thoughts
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_thoughts_chain ON thoughts(chain_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_branch ON thoughts(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_revises ON thoughts(revises_thought_id) WHERE revises_thought_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_memory ON thoughts(memory_id) WHERE memory_id IS NOT NULL;

-- =============================================================================
-- Audit Log table
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'auth_failure', 'permission_change', 'config_modification',
        'agent_execution', 'memory_mutation', 'tool_invocation', 'trust_adjustment'
    )),
    severity VARCHAR(20) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
    session_id UUID,
    peer_id VARCHAR(100),
    agent_name VARCHAR(100),
    tool_name VARCHAR(100),
    memory_id UUID,
    description TEXT,
    details JSONB,
    state_before JSONB,
    state_after JSONB,
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log(severity);
CREATE INDEX IF NOT EXISTS idx_audit_log_session_id ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at_brin ON audit_log USING BRIN(created_at);