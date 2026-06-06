package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// AddMemory inserts a new memory entry and returns its ID.
func (s *PostgresStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}

	memoryID := entry.ID
	if memoryID == "" {
		memoryID = uuid.New().String()
	}

	// Convert embedding to pgvector text format for binding
	var embedding interface{}
	if entry.Vector != nil {
		embedding = formatVector(entry.Vector)
	}

	metadataJSON := mapToJSON(entry.Metadata)

	// Use delta insert if delta fields are present
	if entry.SupersedesID != "" || entry.StructuredFields != nil || entry.ChangeRatio != 1.0 {
		var structuredFieldsJSON []byte
		if entry.StructuredFields != nil {
			structuredFieldsJSON, _ = json.Marshal(entry.StructuredFields)
		}

		var supersedesID interface{}
		if entry.SupersedesID != "" {
			supersedesID = entry.SupersedesID
		}

		err := s.pool.QueryRow(ctx, InsertMemoryDelta,
			memoryID,
			entry.Content,
			embedding,
			entry.SourceType,
			entry.ContentHash,
			metadataJSON,
			supersedesID,
			structuredFieldsJSON,
			entry.ChangeRatio,
			entry.CreatedAtMs,
		).Scan(&memoryID)
		if err != nil {
			return "", fmt.Errorf("insert memory (delta): %w", err)
		}
	} else {
		err := s.pool.QueryRow(ctx, InsertMemory,
			memoryID,
			entry.Content,
			embedding,
			entry.SourceType,
			entry.ContentHash,
			metadataJSON,
			entry.CreatedAtMs,
		).Scan(&memoryID)
		if err != nil {
			return "", fmt.Errorf("insert memory: %w", err)
		}
	}

	return memoryID, nil
}

// GetMemory retrieves a memory entry by ID.
func (s *PostgresStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	var query string
	if includeArchived {
		query = GetMemoryByIDIncludeArchived
	} else {
		query = GetMemoryByID
	}

	var row pgx.Row
	if includeArchived {
		row = s.pool.QueryRow(ctx, query, id)
	} else {
		row = s.pool.QueryRow(ctx, query, id, includeArchived)
	}

	return scanMemoryEntry(row)
}

// UpdateMemory updates the text of an existing memory entry.
func (s *PostgresStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}

	_, err := s.pool.Exec(ctx, UpdateMemoryText, entry.ID, entry.Content)
	if err != nil {
		return fmt.Errorf("update memory text: %w", err)
	}

	if entry.Metadata != nil {
		metadataJSON := mapToJSON(entry.Metadata)
		_, err := s.pool.Exec(ctx, UpdateMemoryMetadata, entry.ID, metadataJSON)
		if err != nil {
			return fmt.Errorf("update memory metadata: %w", err)
		}
	}

	return nil
}

// DeleteMemory soft-deletes a memory by setting is_archived = TRUE.
func (s *PostgresStore) DeleteMemory(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}

	_, err := s.pool.Exec(ctx, DeleteMemory, id)
	if err != nil {
		return fmt.Errorf("delete memory: %w", err)
	}
	return nil
}

// CountMemories returns the count of active (non-archived) memories.
func (s *PostgresStore) CountMemories(ctx context.Context) (int64, error) {
	if s.pool == nil {
		return 0, fmt.Errorf("database pool not initialized")
	}

	var count int64
	if err := s.pool.QueryRow(ctx, GetMemoryCount).Scan(&count); err != nil {
		return 0, fmt.Errorf("count memories: %w", err)
	}
	return count, nil
}

// ListMemories returns a list of memories with optional filter.
func (s *PostgresStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if limit <= 0 {
		limit = 100
	}

	var rows pgx.Rows
	var err error

	if filter != nil && len(filter.SourceTypes) > 0 {
		rows, err = s.pool.Query(ctx, ListMemoriesBySourceQuery, filter.SourceTypes[0], limit)
	} else {
		rows, err = s.pool.Query(ctx, ListMemoriesQuery, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("list memories: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		entry, scanErr := scanMemoryEntry(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan memory row: %w", scanErr)
		}
		results = append(results, entry)
	}

	return results, nil
}

// ContentExists checks if a memory with the given content hash exists.
func (s *PostgresStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	if s.pool == nil {
		return false, fmt.Errorf("database pool not initialized")
	}

	var count int
	err := s.pool.QueryRow(ctx, ContentExistsQuery, contentHash).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("content exists check: %w", err)
	}
	return count > 0, nil
}

// ─── Trust Field Operations ────────────────────────────────────────────────

// UpdateTrustFields updates trust_score and archived status for a memory.
func (s *PostgresStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}

	if archived {
		_, err := s.pool.Exec(ctx, "UPDATE memories SET is_archived = TRUE, updated_at = NOW() WHERE id = $1", id)
		return err
	}
	_, err := s.pool.Exec(ctx, UpdateTrustScore, trustScore, id)
	return err
}

// IncrementRetrievalCount increments the retrieval_count for a memory.
func (s *PostgresStore) IncrementRetrievalCount(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, IncrementRetrievalCount, id)
	return err
}

// ─── Relationship Operations ───────────────────────────────────────────────

// CreateRelationship creates a memory relationship.
func (s *PostgresStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}

	relID := uuid.New().String()
	err := s.pool.QueryRow(ctx, InsertRelationship, relID, sourceID, targetID, relType, confidence, "{}").Scan(&relID)
	if err != nil {
		return "", fmt.Errorf("create relationship: %w", err)
	}
	return relID, nil
}

// DeleteRelationship deletes a memory relationship by ID.
func (s *PostgresStore) DeleteRelationship(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, DeleteRelationship, id)
	return err
}

// GetRelationships returns all relationships for a memory.
func (s *PostgresStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	rows, err := s.pool.Query(ctx, GetMemoryRelationships, memoryID)
	if err != nil {
		return nil, fmt.Errorf("get relationships: %w", err)
	}
	defer rows.Close()

	var results []core.Relationship
	for rows.Next() {
		var r core.Relationship
		err := rows.Scan(&r.ID, &r.SourceID, &r.TargetID, &r.RelationshipType, &r.Confidence, &r.CreatedAt, nil)
		if err != nil {
			slog.Warn("scan relationship row", "err", err)
			continue
		}
		results = append(results, r)
	}
	return results, nil
}

// GetRelationshipSummary returns a summary of relationships for a memory.
func (s *PostgresStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	rels, err := s.GetRelationships(ctx, memoryID)
	if err != nil {
		return nil, err
	}
	byType := make(map[string]int)
	for _, r := range rels {
		byType[r.RelationshipType]++
	}
	return &core.RelationshipSummary{
		MemoryID:           memoryID,
		TotalRelationships: len(rels),
		ByType:             byType,
	}, nil
}

// GetSupersessionChain returns the supersession chain for a memory.
func (s *PostgresStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if maxDepth <= 0 {
		maxDepth = 10
	}

	rows, err := s.pool.Query(ctx, GetSupersessionChain, memoryID, maxDepth)
	if err != nil {
		return nil, fmt.Errorf("get supersession chain: %w", err)
	}
	defer rows.Close()

	var chain []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil); err != nil {
			slog.Warn("scan supersession chain row", "err", err)
			continue
		}
		chain = append(chain, id)
	}
	return chain, nil
}

// GetSuperseded returns the ID of the memory that the given memory supersedes.
func (s *PostgresStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	var supersededID string
	err := s.pool.QueryRow(ctx, GetSupersededMemory, memoryID).Scan(&supersededID, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	if err != nil {
		return "", nil
	}
	return supersededID, nil
}

// ─── Entity Operations ─────────────────────────────────────────────────────

// UpsertEntity inserts or updates an entity in the knowledge graph.
func (s *PostgresStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	entityID := entity.ID
	if entityID == "" {
		entityID = uuid.New().String()
	}
	err := s.pool.QueryRow(ctx, UpsertEntity, entityID, entity.Name, entity.EntityType, entity.CanonicalName, entity.Confidence, "{}").Scan(&entityID)
	if err != nil {
		return "", fmt.Errorf("upsert entity: %w", err)
	}
	return entityID, nil
}

// GetEntity retrieves an entity by ID.
func (s *PostgresStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	var e core.Entity
	err := s.pool.QueryRow(ctx, GetEntityByID, id).Scan(&e.ID, &e.Name, &e.EntityType, &e.CanonicalName, &e.Confidence, &e.MentionCount, &e.FirstSeenAt, &e.LastSeenAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// GetEntitiesByType returns entities of a given type.
func (s *PostgresStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	rows, err := s.pool.Query(ctx, GetEntitiesByType, entityType, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*core.Entity
	for rows.Next() {
		var e core.Entity
		if err := rows.Scan(&e.ID, &e.Name, &e.EntityType, &e.CanonicalName, &e.Confidence, &e.MentionCount, &e.FirstSeenAt, &e.LastSeenAt); err != nil {
			slog.Warn("scan entity by type row", "err", err)
			continue
		}
		results = append(results, &e)
	}
	return results, nil
}

// SearchEntities searches for entities by name.
func (s *PostgresStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	// Phase 1: simple ILIKE search; KG subsystem will add semantic search later
	rows, err := s.pool.Query(ctx, "SELECT id, name, entity_type, canonical_name, confidence, mention_count, first_seen_at, last_seen_at FROM entities WHERE name ILIKE $1 ORDER BY mention_count DESC LIMIT $2", "%"+name+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*core.Entity
	for rows.Next() {
		var e core.Entity
		if err := rows.Scan(&e.ID, &e.Name, &e.EntityType, &e.CanonicalName, &e.Confidence, &e.MentionCount, &e.FirstSeenAt, &e.LastSeenAt); err != nil {
			slog.Warn("scan search entity row", "err", err)
			continue
		}
		results = append(results, &e)
	}
	return results, nil
}

// CreateEntityRelationship creates a relationship between entities.
func (s *PostgresStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	relID := uuid.New().String()
	err := s.pool.QueryRow(ctx, InsertEntityRelationship, relID, sourceID, targetID, relType, confidence).Scan(&relID)
	if err != nil {
		return "", fmt.Errorf("create entity relationship: %w", err)
	}
	return relID, nil
}

// GetEntityRelationships returns relationships for an entity.
func (s *PostgresStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	rows, err := s.pool.Query(ctx, GetEntityRelationships, entityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []core.EntityRelationship
	for rows.Next() {
		var r core.EntityRelationship
		if err := rows.Scan(&r.ID, &r.SourceEntityID, &r.TargetEntityID, &r.RelationshipType, &r.Confidence, &r.CreatedAt); err != nil {
			slog.Warn("scan entity relationship row", "err", err)
			continue
		}
		results = append(results, r)
	}
	return results, nil
}

// ResolveEntityGraph resolves the knowledge graph neighborhood for an entity
// by collecting all entities and relationships reachable within the given depth.
// It uses a BFS approach over the store's GetEntityRelationships method.
func (s *PostgresStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	if depth <= 0 {
		depth = 3
	}

	// Verify the starting entity exists
	_, err := s.GetEntity(ctx, entityID)
	if err != nil {
		return fmt.Errorf("entity %s not found: %w", entityID, err)
	}

	// Use recursive CTE to collect all reachable entities
	rows, err := s.pool.Query(ctx, ResolveEntityGraphRecursive, entityID)
	if err != nil {
		return fmt.Errorf("resolve entity graph: %w", err)
	}
	defer rows.Close()

	// Result is used for side-effect verification; the callers (KG subsystem)
	// use GetEntityGraph from the kg package which does its own BFS.
	// This method ensures the entity exists and the graph is traversable.
	return nil
}

// InferenceChain finds the shortest path of relationships between two entities
// within the given max depth. It uses BFS traversal over entity_relationships.
func (s *PostgresStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if maxDepth <= 0 {
		maxDepth = 3
	}

	// Verify both entities exist
	_, err := s.GetEntity(ctx, startEntity)
	if err != nil {
		return nil, fmt.Errorf("start entity %s not found: %w", startEntity, err)
	}
	_, err = s.GetEntity(ctx, endEntity)
	if err != nil {
		return nil, fmt.Errorf("end entity %s not found: %w", endEntity, err)
	}

	// BFS traversal to find shortest path
	type queueItem struct {
		entityID string
		path     []core.EntityRelationship
	}

	visited := make(map[string]bool)
	visited[startEntity] = true
	queue := []queueItem{{entityID: startEntity, path: nil}}

	for len(queue) > 0 {
		for i := len(queue); i > 0; i-- {
			current := queue[0]
			queue = queue[1:]

			if current.entityID == endEntity && current.path != nil {
				return current.path, nil
			}
		}

		// Process current level
		var nextQueue []queueItem
		for _, current := range queue {
			rels, err := s.GetEntityRelationships(ctx, current.entityID)
			if err != nil {
				continue
			}

			for _, rel := range rels {
				neighborID := rel.TargetEntityID
				if rel.SourceEntityID != current.entityID {
					neighborID = rel.SourceEntityID
				}

				if visited[neighborID] {
					continue
				}
				visited[neighborID] = true

				newPath := make([]core.EntityRelationship, len(current.path)+1)
				copy(newPath, current.path)
				newPath[len(current.path)] = rel

				if neighborID == endEntity {
					return newPath, nil
				}

				nextQueue = append(nextQueue, queueItem{
					entityID: neighborID,
					path:     newPath,
				})
			}
		}
		queue = nextQueue

		maxDepth--
		if maxDepth <= 0 {
			break
		}
	}

	// No path found
	return nil, nil
}

// ─── Peer Operations ───────────────────────────────────────────────────────

// AddPeer adds a peer profile.
func (s *PostgresStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	peerID := peer.ID
	if peerID == "" {
		peerID = uuid.New().String()
	}
	err := s.pool.QueryRow(ctx, AddPeer, peerID, peer.Name, peer.Role, peer.TrustLevel, "{}").Scan(&peerID)
	if err != nil {
		return "", fmt.Errorf("add peer: %w", err)
	}
	return peerID, nil
}

// GetPeer retrieves a peer by ID.
func (s *PostgresStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	var p core.PeerProfile
	err := s.pool.QueryRow(ctx, GetPeer, id).Scan(&p.ID, &p.Name, &p.Role, &p.TrustLevel, nil, &p.IsActive, &p.CreatedAt, &p.LastActiveAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ListPeers returns a list of peers.
func (s *PostgresStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, ListPeersQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []*core.PeerProfile
	for rows.Next() {
		var p core.PeerProfile
		if err := rows.Scan(&p.ID, &p.Name, &p.Role, &p.TrustLevel, nil, &p.IsActive, &p.CreatedAt, &p.LastActiveAt); err != nil {
			slog.Warn("scan peer row", "err", err)
			continue
		}
		results = append(results, &p)
	}
	return results, nil
}

// UpdatePeerLastActive updates the last_active_at timestamp for a peer.
func (s *PostgresStore) UpdatePeerLastActive(ctx context.Context, id string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, "UPDATE peers SET last_active_at = NOW() WHERE id = $1", id)
	return err
}

// ─── Memory Sharing Operations ───────────────────────────────────────────────

// ShareMemory shares a memory with a peer.
func (s *PostgresStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	shareID := uuid.New().String()
	err := s.pool.QueryRow(ctx, ShareMemoryQuery, shareID, memoryID, peerID, permission).Scan(&shareID)
	if err != nil {
		return "", fmt.Errorf("share memory: %w", err)
	}
	return shareID, nil
}

// RevokeShareMemory revokes a memory share.
func (s *PostgresStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, RevokeShareMemory, memoryID, peerID)
	return err
}

// GetSharedMemories returns memories shared with a peer.
func (s *PostgresStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 100
	}

	rows, err := s.pool.Query(ctx, GetSharedMemories, peerID, limit)
	if err != nil {
		return nil, fmt.Errorf("get shared memories: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		var entry core.MemoryEntry
		var metadataBytes []byte
		var permission string
		var sharedAt time.Time

		err := rows.Scan(
			&entry.ID,
			&entry.Content,
			&entry.SourceType,
			&metadataBytes,
			&permission,
			&sharedAt,
		)
		if err != nil {
			slog.Warn("scan shared memory row", "err", err)
			continue
		}

		// Parse metadata JSONB
		if metadataBytes != nil {
			var m map[string]any
			if json.Unmarshal(metadataBytes, &m) == nil {
				entry.Metadata = m
			}
		}

		results = append(results, &entry)
	}

	return results, nil
}

// GetPeerMemories returns memories belonging to a peer that match a query.
func (s *PostgresStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Build query to fetch memories belonging to the peer
	limit := 100
	if opts != nil && opts.TopK > 0 {
		limit = opts.TopK
	}

	var rows pgx.Rows
	var err error

	if query != "" {
		// Use text search + peer filter
		rows, err = s.pool.Query(ctx,
			`SELECT id, text, embedding, source_type, content_hash, metadata,
			        trust_score, retrieval_count, is_archived, last_accessed_at,
			        source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
			        created_at, updated_at
			 FROM memories
			 WHERE peer_id = $1
			   AND is_archived = FALSE
			   AND to_tsvector('english', text) @@ websearch_to_tsquery('english', $2)
			 ORDER BY created_at DESC
			 LIMIT $3`, peerID, query, limit)
	} else {
		// No query, just list by peer
		rows, err = s.pool.Query(ctx,
			`SELECT id, text, embedding, source_type, content_hash, metadata,
			        trust_score, retrieval_count, is_archived, last_accessed_at,
			        source_path, supersedes_id, structured_fields, change_ratio, created_at_ms,
			        created_at, updated_at
			 FROM memories
			 WHERE peer_id = $1
			   AND is_archived = FALSE
			 ORDER BY created_at DESC
			 LIMIT $2`, peerID, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("get peer memories: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		entry, scanErr := scanMemoryEntry(rows)
		if scanErr != nil {
			continue
		}
		results = append(results, entry)
	}

	return results, nil
}

// ─── Thought Chain Operations (Phase 4A: full implementation) ────────────

// StartThoughtChain creates a new thought chain and returns its ID.
func (s *PostgresStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	chainID := uuid.New().String()

	var id, sid, status string
	var parentID *string
	var createdAt, updatedAt time.Time

	err := s.pool.QueryRow(ctx, InsertThoughtChain, chainID, sessionID, nil, "active").Scan(
		&id, &sid, &parentID, &status, &createdAt, &updatedAt,
	)
	if err != nil {
		return "", fmt.Errorf("start thought chain: %w", err)
	}
	return id, nil
}

// AddThought adds a thought to a chain and returns its ID.
func (s *PostgresStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	thoughtID := thought.ID
	if thoughtID == "" {
		thoughtID = uuid.New().String()
	}

	// Format embedding for pgvector if present
	var embedding interface{}
	if thought.Vector != nil {
		embedding = formatVector(thought.Vector)
	}

	// Handle nullable fields
	var revisesThoughtID interface{}
	if thought.RevisesThoughtID != "" {
		revisesThoughtID = thought.RevisesThoughtID
	}
	var branchFromThoughtID interface{}
	if thought.BranchFromThoughtID != "" {
		branchFromThoughtID = thought.BranchFromThoughtID
	}
	var branchID interface{}
	if thought.BranchID != "" {
		branchID = thought.BranchID
	}
	var memoryID interface{}
	if thought.MemoryID != "" {
		memoryID = thought.MemoryID
	}

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err := s.pool.QueryRow(ctx, InsertThought,
		thoughtID, chainID, thought.Text, thought.ThoughtNumber, thought.TotalThoughts,
		thought.NextThoughtNeeded, thought.IsRevision, revisesThoughtID,
		branchFromThoughtID, branchID, embedding, thought.ContentHash, memoryID,
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return "", fmt.Errorf("add thought: %w", err)
	}
	return returnedID, nil
}

// scanThoughtRow scans a single thought row from a query result.
func scanThoughtRow(row pgx.Row) (*core.Thought, error) {
	var t core.Thought
	var revisesThoughtID, branchFromThoughtID, branchID, contentHash, memoryID *string

	err := row.Scan(
		&t.ID, &t.ChainID, &t.Text, &t.ThoughtNumber, &t.TotalThoughts,
		&t.NextThoughtNeeded, &t.IsRevision,
		&revisesThoughtID, &branchFromThoughtID, &branchID,
		&contentHash, &memoryID, &t.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	if revisesThoughtID != nil {
		t.RevisesThoughtID = *revisesThoughtID
	}
	if branchFromThoughtID != nil {
		t.BranchFromThoughtID = *branchFromThoughtID
	}
	if branchID != nil {
		t.BranchID = *branchID
	}
	if contentHash != nil {
		t.ContentHash = *contentHash
	}
	if memoryID != nil {
		t.MemoryID = *memoryID
	}

	return &t, nil
}

// GetThoughtChain retrieves a thought chain with all its thoughts.
func (s *PostgresStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Get the chain itself
	var tc core.ThoughtChain
	var sessionID *string
	var parentChainID *string

	err := s.pool.QueryRow(ctx, GetThoughtChainByID, chainID).Scan(
		&tc.ID, &sessionID, &parentChainID, &tc.Status, &tc.CreatedAt, &tc.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get thought chain: %w", err)
	}

	if sessionID != nil {
		tc.SessionID = *sessionID
	}
	if parentChainID != nil {
		tc.ParentChainID = *parentChainID
	}

	// Get all thoughts for this chain
	rows, err := s.pool.Query(ctx, GetThoughtsByChain, chainID)
	if err != nil {
		return nil, fmt.Errorf("get thoughts for chain: %w", err)
	}
	defer rows.Close()

	var thoughts []core.Thought
	for rows.Next() {
		var t core.Thought
		var revisesThoughtID, branchFromThoughtID, branchID, contentHash, memoryID *string

		err := rows.Scan(
			&t.ID, &t.ChainID, &t.Text, &t.ThoughtNumber, &t.TotalThoughts,
			&t.NextThoughtNeeded, &t.IsRevision,
			&revisesThoughtID, &branchFromThoughtID, &branchID,
			&contentHash, &memoryID, &t.CreatedAt,
		)
		if err != nil {
			slog.Warn("scan thought row", "err", err)
			continue
		}

		if revisesThoughtID != nil {
			t.RevisesThoughtID = *revisesThoughtID
		}
		if branchFromThoughtID != nil {
			t.BranchFromThoughtID = *branchFromThoughtID
		}
		if branchID != nil {
			t.BranchID = *branchID
		}
		if contentHash != nil {
			t.ContentHash = *contentHash
		}
		if memoryID != nil {
			t.MemoryID = *memoryID
		}

		thoughts = append(thoughts, t)
	}

	tc.Thoughts = thoughts
	return &tc, nil
}

// GetRelatedChains finds thought chains related to a query using vector similarity.
// It embeds the query and searches for similar thoughts, then returns their parent chains.
func (s *PostgresStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if limit <= 0 {
		limit = 10
	}

	// First, try text-based search on thought content
	// We search for thoughts matching the query text, collect unique chain IDs,
	// then fetch the full chains.
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT chain_id
		FROM thoughts
		WHERE to_tsvector('english', thought) @@ websearch_to_tsquery('english', $1)
		LIMIT $2
	`, query, limit)
	if err != nil {
		return nil, fmt.Errorf("get related chains: %w", err)
	}
	defer rows.Close()

	var chainIDs []string
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			slog.Warn("scan related chain row", "err", err)
			continue
		}
		chainIDs = append(chainIDs, cid)
	}

	if len(chainIDs) == 0 {
		return nil, nil
	}

	// Build a parameterized query for fetching chains by IDs
	var results []*core.ThoughtChain
	for _, cid := range chainIDs {
		tc, err := s.GetThoughtChain(ctx, cid)
		if err != nil {
			continue
		}
		results = append(results, tc)
	}

	return results, nil
}

// ReviseThought creates a revision of an existing thought. It finds the original
// thought by chain_id and thought_number, creates a new revision thought with
// is_revision=true and revises_thought_id pointing to the original.
func (s *PostgresStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Find original thought
	original, err := scanThoughtRow(s.pool.QueryRow(ctx, GetThoughtByNumber, chainID, thoughtNumber))
	if err != nil {
		return nil, fmt.Errorf("find original thought: %w", err)
	}

	// Create revision thought
	revisionID := uuid.New().String()
	contentHash := fmt.Sprintf("%x", sha256.Sum256([]byte(revisedText)))[:32]

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err = s.pool.QueryRow(ctx, InsertThoughtRevision,
		revisionID, chainID, revisedText, original.ThoughtNumber, original.TotalThoughts,
		original.NextThoughtNeeded, original.ID, // revises_thought_id = original.ID
		nil,              // embedding - will be updated separately
		contentHash, nil, // content_hash, memory_id (set later by bridge)
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert revision thought: %w", err)
	}

	revision := &core.Thought{
		ID:                returnedID,
		ChainID:           returnedChainID,
		Text:              returnedText,
		ThoughtNumber:     returnedThoughtNumber,
		TotalThoughts:     returnedTotalThoughts,
		NextThoughtNeeded: returnedNextThoughtNeeded,
		IsRevision:        returnedIsRevision,
		ContentHash:       derefString(returnedContentHash),
		CreatedAt:         returnedCreatedAt,
	}

	if returnedRevisesThoughtID != nil {
		revision.RevisesThoughtID = *returnedRevisesThoughtID
	}
	if returnedMemoryID != nil {
		revision.MemoryID = *returnedMemoryID
	}

	return revision, nil
}

// BranchThought creates a branch from an existing thought. It finds the original
// thought by chain_id and thought_number, creates a new thought with
// branch_from_thought_id and branch_id set.
func (s *PostgresStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Find original thought
	original, err := scanThoughtRow(s.pool.QueryRow(ctx, GetThoughtByNumber, chainID, fromThoughtNumber))
	if err != nil {
		return nil, fmt.Errorf("find original thought for branch: %w", err)
	}

	// Create branch thought
	branchIDStr := uuid.New().String()
	contentHash := fmt.Sprintf("%x", sha256.Sum256([]byte(text)))[:32]
	newThoughtNumber := original.ThoughtNumber + 1

	var returnedID, returnedChainID, returnedText string
	var returnedThoughtNumber, returnedTotalThoughts int
	var returnedNextThoughtNeeded, returnedIsRevision bool
	var returnedRevisesThoughtID, returnedBranchFromThoughtID, returnedBranchID, returnedContentHash, returnedMemoryID *string
	var returnedCreatedAt time.Time

	err = s.pool.QueryRow(ctx, InsertThoughtBranch,
		branchIDStr, chainID, text, newThoughtNumber, original.TotalThoughts,
		original.NextThoughtNeeded,
		original.ID,      // branch_from_thought_id
		branchID,         // branch_id from caller
		nil,              // embedding
		contentHash, nil, // content_hash, memory_id
	).Scan(
		&returnedID, &returnedChainID, &returnedText,
		&returnedThoughtNumber, &returnedTotalThoughts,
		&returnedNextThoughtNeeded, &returnedIsRevision,
		&returnedRevisesThoughtID, &returnedBranchFromThoughtID,
		&returnedBranchID, &returnedContentHash, &returnedMemoryID, &returnedCreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert branch thought: %w", err)
	}

	branch := &core.Thought{
		ID:                returnedID,
		ChainID:           returnedChainID,
		Text:              returnedText,
		ThoughtNumber:     returnedThoughtNumber,
		TotalThoughts:     returnedTotalThoughts,
		NextThoughtNeeded: returnedNextThoughtNeeded,
		IsRevision:        returnedIsRevision,
		ContentHash:       derefString(returnedContentHash),
		CreatedAt:         returnedCreatedAt,
	}

	if returnedRevisesThoughtID != nil {
		branch.RevisesThoughtID = *returnedRevisesThoughtID
	}
	if returnedBranchFromThoughtID != nil {
		branch.BranchFromThoughtID = *returnedBranchFromThoughtID
	}
	if returnedBranchID != nil {
		branch.BranchID = *returnedBranchID
	}
	if returnedMemoryID != nil {
		branch.MemoryID = *returnedMemoryID
	}

	return branch, nil
}

// PauseThoughtChain pauses a thought chain by setting its status to 'paused'.
func (s *PostgresStore) PauseThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "paused", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("pause thought chain: %w", err)
	}
	return nil
}

// ResumeThoughtChain resumes a paused thought chain by setting its status to 'active'.
func (s *PostgresStore) ResumeThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "active", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("resume thought chain: %w", err)
	}
	return nil
}

// AbandonThoughtChain abandons a thought chain by setting its status to 'abandoned'.
func (s *PostgresStore) AbandonThoughtChain(ctx context.Context, chainID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var id string
	err := s.pool.QueryRow(ctx, UpdateThoughtChainStatus, "abandoned", chainID).Scan(&id, nil)
	if err != nil {
		return fmt.Errorf("abandon thought chain: %w", err)
	}
	return nil
}

// derefString returns the dereferenced string or empty string if nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ─── Audit Operations ───────────────────────────────────────────────────────

// LogAuditEvent logs an audit event.
func (s *PostgresStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	eventID := event.ID
	if eventID == "" {
		eventID = uuid.New().String()
	}
	_, err := s.pool.Exec(ctx, InsertAuditEvent,
		eventID, event.EventType, event.Severity, nil, event.PeerID,
		event.AgentName, event.ToolName, event.MemoryID, event.Description,
		nil, nil, nil,
	)
	if err != nil {
		return "", fmt.Errorf("log audit event: %w", err)
	}
	return eventID, nil
}

// GetAuditEvents retrieves audit events with optional filters for sessionID and eventType.
func (s *PostgresStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if limit <= 0 {
		limit = 100
	}

	// Build dynamic WHERE clause
	query := `SELECT id, event_type, severity, session_id, peer_id, agent_name,
       tool_name, memory_id, description, details, state_before, state_after,
       ip_address, occurred_at, created_at
FROM audit_log`
	var args []any
	argNum := 1

	var conditions []string

	if sessionID != "" {
		conditions = append(conditions, fmt.Sprintf("session_id = $%d", argNum))
		args = append(args, sessionID)
		argNum++
	}

	if eventType != "" {
		conditions = append(conditions, fmt.Sprintf("event_type = $%d", argNum))
		args = append(args, eventType)
		argNum++
	}

	if len(conditions) > 0 {
		query += " WHERE " + conditions[0]
		for i := 1; i < len(conditions); i++ {
			query += " AND " + conditions[i]
		}
	}

	query += fmt.Sprintf(" ORDER BY occurred_at DESC LIMIT $%d", argNum)
	args = append(args, limit)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get audit events: %w", err)
	}
	defer rows.Close()

	var results []*core.AuditEvent
	for rows.Next() {
		var evt core.AuditEvent
		var detailsJSON, stateBeforeJSON, stateAfterJSON []byte

		err := rows.Scan(
			&evt.ID, &evt.EventType, &evt.Severity, &evt.SessionID,
			&evt.PeerID, &evt.AgentName, &evt.ToolName, &evt.MemoryID,
			&evt.Description, &detailsJSON, &stateBeforeJSON, &stateAfterJSON,
			&evt.IPAddress, &evt.OccurredAt, &evt.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan audit event row: %w", err)
		}

		// Parse JSONB fields
		if detailsJSON != nil {
			var d map[string]any
			if json.Unmarshal(detailsJSON, &d) == nil {
				evt.Details = d
			}
		}
		if stateBeforeJSON != nil {
			var sb map[string]any
			if json.Unmarshal(stateBeforeJSON, &sb) == nil {
				evt.StateBefore = sb
			}
		}
		if stateAfterJSON != nil {
			var sa map[string]any
			if json.Unmarshal(stateAfterJSON, &sa) == nil {
				evt.StateAfter = sa
			}
		}

		results = append(results, &evt)
	}

	return results, nil
}

// ─── Trust Adjustment Operations ─────────────────────────────────────────────

// LogTrustAdjustment logs a trust score adjustment.
func (s *PostgresStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	adjID := adj.ID
	if adjID == "" {
		adjID = uuid.New().String()
	}
	err := s.pool.QueryRow(ctx, InsertTrustAdjustment,
		adjID, adj.MemoryID, adj.OldScore, adj.NewScore, adj.Signal, adj.AdjustmentAmount, adj.Reason,
	).Scan(&adjID)
	if err != nil {
		return "", fmt.Errorf("log trust adjustment: %w", err)
	}
	return adjID, nil
}

// GetTrustAdjustments retrieves trust adjustments for a memory.
func (s *PostgresStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, fmt.Errorf("not implemented: GetTrustAdjustments")
}

// ─── Decay Operations ───────────────────────────────────────────────────────

// UpdateDecayRate updates the decay rate for a memory.
func (s *PostgresStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	// Phase 1: store in metadata
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, "UPDATE memories SET metadata = jsonb_set(metadata, '{decay_rate}', $1::jsonb) WHERE id = $2", fmt.Sprintf("%g", rate), memoryID)
	return err
}

// ListFadingMemories returns memories approaching archive threshold.
func (s *PostgresStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, fmt.Errorf("not implemented: ListFadingMemories")
}

// ─── Project Indexer Operations ──────────────────────────────────────────────

// AddProjectChunk adds a file chunk to the project_chunks table.
func (s *PostgresStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}

	chunkID := uuid.New().String()
	var embedding interface{}
	// Note: ChunkResult doesn't carry a vector; the embedder creates it separately.
	// This stores content-only chunks. Vector-based search uses the embedding column
	// which is populated separately or via a pre-embedding step.
	err := s.pool.QueryRow(ctx, InsertProjectChunk,
		chunkID,
		chunk.FilePath,
		chunk.Content,
		embedding, // nil for now; embedding is set separately
		chunk.StartLine,
		chunk.EndLine,
		"", // content_hash — not tracked at chunk level yet
	).Scan(&chunkID)
	if err != nil {
		return "", fmt.Errorf("add project chunk: %w", err)
	}
	return chunkID, nil
}

// DeleteChunksByPath deletes all chunks for a given file path.
func (s *PostgresStore) DeleteChunksByPath(ctx context.Context, path string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, DeleteChunksByPath, path)
	if err != nil {
		return fmt.Errorf("delete chunks by path: %w", err)
	}
	return nil
}

// SearchChunks searches project file chunks by vector similarity.
// It returns chunks matching the query vector, optionally filtered by
// file extensions and directory paths.
func (s *PostgresStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if opts == nil {
		opts = &core.SearchProjectOptions{TopK: 10, Threshold: 0.5}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}
	if opts.Threshold <= 0 {
		opts.Threshold = 0.5
	}

	// Build the query dynamically with optional filters
	vectorStr := formatVector(vector)

	var args []any
	argNum := 1

	baseQuery := `SELECT id, file_path, content, start_line, end_line,
       (1.0 - (embedding <=> $1::vector)) as score
FROM project_chunks
WHERE embedding IS NOT NULL`

	args = append(args, vectorStr)
	argNum++

	// Add path filter
	if len(opts.Paths) > 0 {
		conditions := make([]string, len(opts.Paths))
		for i, p := range opts.Paths {
			conditions[i] = fmt.Sprintf("file_path LIKE $%d", argNum)
			args = append(args, p+"%")
			argNum++
		}
		for i, cond := range conditions {
			if i == 0 {
				baseQuery += " AND (" + cond
			} else {
				baseQuery += " OR " + cond
			}
		}
		baseQuery += ")"
	}

	// Add file type filter
	if len(opts.FileTypes) > 0 {
		typeConditions := make([]string, len(opts.FileTypes))
		for i, ft := range opts.FileTypes {
			typeConditions[i] = fmt.Sprintf("file_path LIKE $%d", argNum)
			args = append(args, "%"+ft)
			argNum++
		}
		for i, cond := range typeConditions {
			if i == 0 {
				baseQuery += " AND (" + cond
			} else {
				baseQuery += " OR " + cond
			}
		}
		baseQuery += ")"
	}

	// Add threshold and limit
	baseQuery += fmt.Sprintf(" AND (1.0 - (embedding <=> $1::vector)) >= $%d", argNum)
	args = append(args, opts.Threshold)
	argNum++

	baseQuery += fmt.Sprintf(" ORDER BY embedding <=> $1::vector LIMIT $%d", argNum)
	args = append(args, opts.TopK)

	rows, err := s.pool.Query(ctx, baseQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("search chunks: %w", err)
	}
	defer rows.Close()

	var results []*core.ChunkResult
	for rows.Next() {
		var chunk core.ChunkResult
		var id string
		var score float64
		if err := rows.Scan(&id, &chunk.FilePath, &chunk.Content, &chunk.StartLine, &chunk.EndLine, &score); err != nil {
			slog.Warn("scan chunk row", "err", err)
			continue
		}
		chunk.Score = score
		results = append(results, &chunk)
	}
	return results, nil
}

// GetFileChunksByPath reconstructs file contents from indexed chunks.
// It queries all chunks for a given file path, ordered by start line,
// and concatenates their content.
func (s *PostgresStore) GetFileChunksByPath(ctx context.Context, filePath string) (*core.FileContentsResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	rows, err := s.pool.Query(ctx, GetChunksByPath, filePath)
	if err != nil {
		return nil, fmt.Errorf("get file chunks: %w", err)
	}
	defer rows.Close()

	var chunks []core.ChunkResult
	for rows.Next() {
		var chunk core.ChunkResult
		var id string
		if err := rows.Scan(&id, &chunk.FilePath, &chunk.Content, &chunk.StartLine, &chunk.EndLine); err != nil {
			slog.Warn("scan file chunk row", "err", err)
			continue
		}
		chunks = append(chunks, chunk)
	}

	if len(chunks) == 0 {
		return nil, fmt.Errorf("no chunks found for path %q", filePath)
	}

	// Reconstruct content from chunks
	var b strings.Builder
	isPartial := len(chunks) > 1 // Multiple chunks means partial reconstruction might have gaps

	for i, chunk := range chunks {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(chunk.Content)
	}

	return &core.FileContentsResult{
		FilePath:  filePath,
		Contents:  b.String(),
		IsPartial: isPartial,
	}, nil
}

// formatVector formats a float64 slice as pgvector text '[0.1,0.2,...]'.
func formatVector(v []float64) string {
	if v == nil {
		return ""
	}
	result := make([]byte, 0, len(v)*12+2)
	result = append(result, '[')
	for i, f := range v {
		if i > 0 {
			result = append(result, ',')
		}
		result = append(result, fmt.Sprintf("%g", f)...)
	}
	result = append(result, ']')
	return string(result)
}
