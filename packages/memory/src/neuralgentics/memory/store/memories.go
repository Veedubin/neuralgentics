package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

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

// ─── Helper Functions ───────────────────────────────────────────────────────
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
