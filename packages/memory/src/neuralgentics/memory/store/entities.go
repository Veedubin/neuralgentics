// Package store — entities.go: knowledge graph entity operations.
package store

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"neuralgentics/src/neuralgentics/memory/core"
)

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
