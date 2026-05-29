package store

// SQL query constants for the PostgreSQL/pgvector storage layer.
// Ported from memini-ai-dev/src/memini_ai/postgres/queries.py.
// All queries use pgx $N parameter placeholders.

// ─── Vector Search Queries ───────────────────────────────────────────────────

const SearchMemoriesVector = `
SELECT id, text, source_type, trust_score, retrieval_count, is_archived, metadata,
       embedding, supersedes_id, structured_fields, change_ratio, created_at_ms,
       created_at, updated_at, content_hash, source_path,
       embedding <=> $1::vector as distance
FROM memories
WHERE embedding <=> $1::vector < $2
AND is_archived = FALSE
ORDER BY embedding <=> $1::vector
LIMIT $3
`

const SearchMemoriesWithPeer = `
SELECT DISTINCT m.id, m.text, m.source_type, m.trust_score, m.retrieval_count,
       m.is_archived, m.metadata
FROM memories m
JOIN memory_sharing ms ON m.id = ms.memory_id
WHERE ms.peer_id = $1
AND ms.permission IN ('SHARED', 'INHERITED')
AND m.is_archived = FALSE
ORDER BY m.retrieval_count DESC
LIMIT $2
`

const GetSimilarMemories = `
SELECT id, text, source_type, trust_score, retrieval_count, is_archived, metadata,
       embedding, supersedes_id, structured_fields, change_ratio, created_at_ms,
       created_at, updated_at, content_hash, source_path,
       embedding <=> (SELECT embedding FROM memories WHERE id = $1)::vector as distance
FROM memories
WHERE id != $1
AND is_archived = FALSE
AND embedding IS NOT NULL
ORDER BY embedding <=> (SELECT embedding FROM memories WHERE id = $1)::vector
LIMIT $2
`

// ─── Memory CRUD Queries ─────────────────────────────────────────────────────

const InsertMemory = `
INSERT INTO memories (id, text, embedding, source_type, content_hash, metadata, created_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id
`

const InsertMemoryDelta = `
INSERT INTO memories (id, text, embedding, source_type, content_hash, metadata,
                      supersedes_id, structured_fields, change_ratio, created_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id
`

const GetMemoryByID = `
SELECT id, text, embedding, source_type, content_hash, metadata,
       trust_score, retrieval_count, is_archived, last_accessed_at,
       created_at, updated_at, source_path,
       supersedes_id, structured_fields, change_ratio, created_at_ms
FROM memories
WHERE id = $1 AND ($2::boolean OR is_archived = FALSE)
`

const GetMemoryByIDIncludeArchived = `
SELECT id, text, embedding, source_type, content_hash, metadata,
       trust_score, retrieval_count, is_archived, last_accessed_at,
       created_at, updated_at, source_path,
       supersedes_id, structured_fields, change_ratio, created_at_ms
FROM memories
WHERE id = $1
`

const UpdateMemoryText = `
UPDATE memories
SET text = $2, updated_at = NOW()
WHERE id = $1 AND is_archived = FALSE
RETURNING id
`

const UpdateMemoryMetadata = `
UPDATE memories
SET metadata = $2, updated_at = NOW()
WHERE id = $1 AND is_archived = FALSE
RETURNING id
`

const DeleteMemory = `
UPDATE memories
SET is_archived = TRUE, updated_at = NOW()
WHERE id = $1
RETURNING id
`

// ─── Trust Engine Queries ────────────────────────────────────────────────────

const UpdateTrustScore = `
UPDATE memories
SET trust_score = $1, last_accessed_at = NOW()
WHERE id = $2
RETURNING id, trust_score
`

const IncrementRetrievalCount = `
UPDATE memories
SET retrieval_count = retrieval_count + 1, last_accessed_at = NOW()
WHERE id = $1
RETURNING id, retrieval_count
`

// ─── Relationship Queries ─────────────────────────────────────────────────────

const InsertRelationship = `
INSERT INTO memory_relationships (id, source_id, target_id, relationship_type, confidence, metadata)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE
SET confidence = $5, metadata = $6
RETURNING id
`

const DeleteRelationship = `
DELETE FROM memory_relationships
WHERE id = $1
RETURNING id
`

const GetMemoryRelationships = `
SELECT id, source_id, target_id, relationship_type, confidence, created_at, metadata
FROM memory_relationships
WHERE source_id = $1 OR target_id = $1
`

const GetSupersessionChain = `
WITH RECURSIVE chain AS (
    SELECT id, text, trust_score, is_archived, supersedes_id,
           structured_fields, change_ratio, source_type, metadata,
           created_at_ms,
           1 as depth,
           ARRAY[id] as path
    FROM memories WHERE id = $1
    UNION ALL
    SELECT m.id, m.text, m.trust_score, m.is_archived, m.supersedes_id,
           m.structured_fields, m.change_ratio, m.source_type, m.metadata,
           m.created_at_ms,
           c.depth + 1,
           c.path || m.id
    FROM memories m
    JOIN chain c ON m.id = c.supersedes_id
    WHERE c.depth < $2
    AND c.depth < 20
)
SELECT * FROM chain ORDER BY created_at_ms DESC
`

const GetSupersededMemory = `
SELECT id, text, trust_score, is_archived, supersedes_id,
       structured_fields, change_ratio, source_type, metadata,
       created_at_ms
FROM memories
WHERE id = (SELECT supersedes_id FROM memories WHERE id = $1)
`

// ─── Entity Queries (Knowledge Graph) ─────────────────────────────────────────

const UpsertEntity = `
INSERT INTO entities (id, name, entity_type, canonical_name, confidence, mention_count, last_seen_at, metadata)
VALUES ($1, $2, $3, $4, $5, 1, NOW(), $6)
ON CONFLICT (name, entity_type) DO UPDATE
SET canonical_name = EXCLUDED.canonical_name,
    confidence = GREATEST(entities.confidence, EXCLUDED.confidence),
    mention_count = entities.mention_count + 1,
    last_seen_at = NOW()
RETURNING id
`

const GetEntityByID = `
SELECT id, name, entity_type, canonical_name, confidence, mention_count,
       first_seen_at, last_seen_at
FROM entities
WHERE id = $1
`

const GetEntitiesByType = `
SELECT id, name, entity_type, canonical_name, confidence, mention_count,
       first_seen_at, last_seen_at
FROM entities
WHERE entity_type = $1
ORDER BY mention_count DESC
LIMIT $2
`

const InsertEntityRelationship = `
INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, relationship_type, confidence)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (source_entity_id, target_entity_id, relationship_type) DO UPDATE
SET confidence = EXCLUDED.confidence
RETURNING id
`

const GetEntityRelationships = `
SELECT id, source_entity_id, target_entity_id, relationship_type, confidence, created_at
FROM entity_relationships
WHERE source_entity_id = $1 OR target_entity_id = $1
`

// ResolveEntityGraphRecursive performs a recursive CTE to find all entities
// reachable from the given entity within the specified depth.
const ResolveEntityGraphRecursive = `
WITH RECURSIVE entity_graph AS (
    SELECT id, name, entity_type, canonical_name, confidence, mention_count, first_seen_at, last_seen_at
    FROM entities WHERE id = $1
    UNION
    SELECT e.id, e.name, e.entity_type, e.canonical_name, e.confidence, e.mention_count, e.first_seen_at, e.last_seen_at
    FROM entities e
    JOIN entity_relationships er ON (
        (er.source_entity_id = e.id OR er.target_entity_id = e.id)
        AND (er.source_entity_id IN (SELECT id FROM entity_graph) OR er.target_entity_id IN (SELECT id FROM entity_graph))
    )
    WHERE e.id NOT IN (SELECT id FROM entity_graph)
)
SELECT id, name, entity_type, canonical_name, confidence, mention_count, first_seen_at, last_seen_at
FROM entity_graph
`

// GetEntityRelationshipsForGraph retrieves all relationships between the given entity IDs.
const GetEntityRelationshipsForGraph = `
SELECT id, source_entity_id, target_entity_id, relationship_type, confidence, created_at
FROM entity_relationships
WHERE source_entity_id = ANY($1::text[]) OR target_entity_id = ANY($1::text[])
`

// FindInferencePath uses a recursive CTE to find the shortest path between two entities.
// It returns the chain of relationships from start to end within maxDepth hops.
const FindInferencePath = `
WITH RECURSIVE search_path(id, source_id, target_id, rel_type, confidence, path, depth) AS (
    SELECT er.id, er.source_entity_id, er.target_entity_id, er.relationship_type, er.confidence,
           ARRAY[er.id]::text[], 1
    FROM entity_relationships er
    WHERE er.source_entity_id = $1 OR er.target_entity_id = $1
    UNION
    SELECT er.id, er.source_entity_id, er.target_entity_id, er.relationship_type, er.confidence,
           sp.path || er.id::text, sp.depth + 1
    FROM entity_relationships er
    JOIN search_path sp ON (
        (er.source_entity_id = sp.target_id OR er.target_entity_id = sp.source_id)
        AND er.id <> ALL(sp.path)
    )
    WHERE sp.depth < $3
    AND sp.target_id != $2
)
SELECT id, source_entity_id, target_entity_id, relationship_type, confidence, created_at
FROM entity_relationships
WHERE id = ANY(
    SELECT unnest(path) FROM search_path WHERE target_id = $2 ORDER BY depth LIMIT 1
)
ORDER BY depth
`

// ─── Peer Queries ─────────────────────────────────────────────────────────────

const AddPeer = `
INSERT INTO peers (id, name, role, trust_level, preferences, is_active)
VALUES ($1, $2, $3, $4, $5, TRUE)
RETURNING id
`

const GetPeer = `
SELECT id, name, role, trust_level, preferences, is_active, created_at, last_active_at
FROM peers
WHERE id = $1
`

const ListPeersQuery = `
SELECT id, name, role, trust_level, preferences, is_active, created_at, last_active_at
FROM peers
ORDER BY created_at DESC
LIMIT $1
`

// ─── Memory Sharing Queries ───────────────────────────────────────────────────

const ShareMemoryQuery = `
INSERT INTO memory_sharing (id, memory_id, peer_id, permission)
VALUES ($1, $2, $3, $4)
RETURNING id
`

const RevokeShareMemory = `
DELETE FROM memory_sharing
WHERE memory_id = $1 AND peer_id = $2
RETURNING id
`

const GetSharedMemories = `
SELECT m.id, m.text, m.source_type, m.metadata, ms.permission, ms.created_at
FROM memories m
JOIN memory_sharing ms ON m.id = ms.memory_id
WHERE ms.peer_id = $1
AND ms.permission IN ('SHARED', 'INHERITED')
AND m.is_archived = FALSE
ORDER BY ms.created_at DESC
LIMIT $2
`

// ─── Thought Chain Queries ────────────────────────────────────────────────────

const InsertThoughtChain = `
INSERT INTO thought_chains (id, session_id, parent_chain_id, status)
VALUES ($1, $2, $3, $4)
RETURNING id, session_id, parent_chain_id, status, created_at, updated_at
`

const GetThoughtChainByID = `
SELECT id, session_id, parent_chain_id, status, created_at, updated_at
FROM thought_chains
WHERE id = $1
`

const InsertThought = `
INSERT INTO thoughts (id, chain_id, thought, thought_number, total_thoughts,
                     next_thought_needed, is_revision, revises_thought_id,
                     branch_from_thought_id, branch_id, embedding, content_hash, memory_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, chain_id, thought, thought_number, total_thoughts,
           next_thought_needed, is_revision, revises_thought_id,
           branch_from_thought_id, branch_id, content_hash, memory_id, created_at
`

const GetThoughtsByChain = `
SELECT id, chain_id, thought, thought_number, total_thoughts,
       next_thought_needed, is_revision, revises_thought_id,
       branch_from_thought_id, branch_id, content_hash, memory_id, created_at
FROM thoughts
WHERE chain_id = $1
ORDER BY thought_number ASC, created_at ASC
`

// GetThoughtByNumber retrieves a single thought by chain ID and thought number.
const GetThoughtByNumber = `
SELECT id, chain_id, thought, thought_number, total_thoughts,
       next_thought_needed, is_revision, revises_thought_id,
       branch_from_thought_id, branch_id, content_hash, memory_id, created_at
FROM thoughts
WHERE chain_id = $1 AND thought_number = $2
ORDER BY created_at DESC
LIMIT 1
`

// UpdateThoughtChainStatus updates the status and updated_at timestamp of a thought chain.
const UpdateThoughtChainStatus = `
UPDATE thought_chains
SET status = $1, updated_at = NOW()
WHERE id = $2
RETURNING id, status
`

// UpdateThoughtRevision marks an existing thought as having a revision by setting
// the revises_thought_id field (no, we don't actually update the old thought — the
// revises_thought_id is set on the NEW revision thought, not the old one).
// This query is kept for potential future use.
const MarkThoughtRevised = `
UPDATE thoughts
SET is_revision = TRUE
WHERE id = $1
`

// InsertThoughtRevision inserts a new thought that revises an existing one.
// Sets is_revision=TRUE and revises_thought_id on the new row.
const InsertThoughtRevision = `
INSERT INTO thoughts (id, chain_id, thought, thought_number, total_thoughts,
                      next_thought_needed, is_revision, revises_thought_id,
                      branch_from_thought_id, branch_id, embedding, content_hash, memory_id)
VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, NULL, NULL, $8, $9, $10)
RETURNING id, chain_id, thought, thought_number, total_thoughts,
           next_thought_needed, is_revision, revises_thought_id,
           branch_from_thought_id, branch_id, content_hash, memory_id, created_at
`

// InsertThoughtBranch inserts a new thought that branches from an existing one.
// Sets branch_from_thought_id and branch_id.
const InsertThoughtBranch = `
INSERT INTO thoughts (id, chain_id, thought, thought_number, total_thoughts,
                      next_thought_needed, is_revision, revises_thought_id,
                      branch_from_thought_id, branch_id, embedding, content_hash, memory_id)
VALUES ($1, $2, $3, $4, $5, $6, FALSE, NULL, $7, $8, $9, $10, $11)
RETURNING id, chain_id, thought, thought_number, total_thoughts,
           next_thought_needed, is_revision, revises_thought_id,
           branch_from_thought_id, branch_id, content_hash, memory_id, created_at
`

// SearchThoughtsByVector searches for thoughts by vector similarity.
const SearchThoughtsByVector = `
SELECT id, chain_id, thought, thought_number, total_thoughts,
       next_thought_needed, is_revision, revises_thought_id,
       branch_from_thought_id, branch_id, embedding, content_hash, memory_id, created_at,
       (1.0 - (embedding <=> $1::vector)) as score
FROM thoughts
WHERE embedding IS NOT NULL
AND (1.0 - (embedding <=> $1::vector)) >= $2
ORDER BY embedding <=> $1::vector
LIMIT $3
`

// GetChainsByIDs retrieves multiple thought chains by their IDs.
const GetChainsByIDs = `
SELECT id, session_id, parent_chain_id, status, created_at, updated_at
FROM thought_chains
WHERE id = ANY($1::text[])
ORDER BY created_at DESC
`

// ─── Audit Log Queries ────────────────────────────────────────────────────────

const InsertAuditEvent = `
INSERT INTO audit_log (id, event_type, severity, session_id, peer_id, agent_name,
                      tool_name, memory_id, description, details, state_before, state_after)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id
`

// GetAuditEventsQuery retrieves audit events with optional filters for session_id and event_type.
// Dynamic WHERE clauses are built at runtime in GetAuditEvents; this constant is the base query.
const GetAuditEventsQuery = `
SELECT id, event_type, severity, session_id, peer_id, agent_name,
       tool_name, memory_id, description, details, state_before, state_after,
       ip_address, occurred_at, created_at
FROM audit_log
ORDER BY occurred_at DESC
LIMIT $1
`

// ─── Stats & Count Queries ────────────────────────────────────────────────────

const GetMemoryCount = `
SELECT COUNT(*) as total,
       COUNT(*) FILTER (WHERE is_archived = FALSE) as active,
       COUNT(*) FILTER (WHERE is_archived = TRUE) as archived
FROM memories
`

const ContentExistsQuery = `
SELECT COUNT(*) FROM memories
WHERE content_hash = $1 AND is_archived = FALSE
`

const ListMemoriesQuery = `
SELECT id, text, embedding, source_type, content_hash, metadata,
       trust_score, retrieval_count, is_archived, last_accessed_at,
       source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
       created_at, updated_at
FROM memories
WHERE is_archived = FALSE
ORDER BY created_at DESC
LIMIT $1
`

const ListMemoriesBySourceQuery = `
SELECT id, text, embedding, source_type, content_hash, metadata,
       trust_score, retrieval_count, is_archived, last_accessed_at,
       source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
       created_at, updated_at
FROM memories
WHERE is_archived = FALSE AND source_type = $1
ORDER BY created_at DESC
LIMIT $2
`

// ─── Full-Text Search Queries ─────────────────────────────────────────────────

const SearchMemoriesText = `
SELECT id, text, source_type, trust_score, retrieval_count, is_archived, metadata,
       content_hash, supersedes_id, structured_fields, change_ratio, created_at_ms,
       created_at, updated_at,
       ts_rank(to_tsvector('english', text), websearch_to_tsquery('english', $1)) as rank
FROM memories
WHERE to_tsvector('english', text) @@ websearch_to_tsquery('english', $1)
AND is_archived = FALSE
ORDER BY rank DESC
LIMIT $2
`

// ─── Trust Adjustment Queries ──────────────────────────────────────────────────

const InsertTrustAdjustment = `
INSERT INTO trust_adjustments (id, memory_id, old_score, new_score, signal, adjustment_amount, reason)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id
`

// ─── Vectorscale Auto-Detect ──────────────────────────────────────────────────

const CheckVectorscale = `
SELECT 1 FROM pg_available_extensions WHERE name = 'vectorscale'
`

// ─── Project Chunk Queries ─────────────────────────────────────────────────────

const InsertProjectChunk = `
INSERT INTO project_chunks (id, file_path, content, embedding, start_line, end_line, content_hash)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id
`

const DeleteChunksByPath = `
DELETE FROM project_chunks
WHERE file_path = $1
`

const SearchChunksVector = `
SELECT id, file_path, content, start_line, end_line,
       embedding <=> $1::vector as distance
FROM project_chunks
WHERE embedding <=> $1::vector < $2
`

const SearchChunksVectorFiltered = `
SELECT id, file_path, content, start_line, end_line,
       embedding <=> $1::vector as distance
FROM project_chunks
WHERE embedding <=> $1::vector < $2
`

const GetChunksByPath = `
SELECT id, file_path, content, start_line, end_line
FROM project_chunks
WHERE file_path = $1
ORDER BY start_line ASC
`
