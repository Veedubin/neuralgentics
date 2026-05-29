package kg

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
)

// KGQuery provides knowledge graph query operations including
// transitive closure BFS and inference chain finding.
type KGQuery struct {
	store core.Store
}

// NewKGQuery creates a KGQuery backed by the given store.
func NewKGQuery(store core.Store) *KGQuery {
	return &KGQuery{store: store}
}

// QueryParams controls how a KG query is executed.
type QueryParams struct {
	StartEntity       string   // Starting entity ID (required)
	EndEntity         string   // Target entity ID for inference chains (optional)
	RelationshipTypes []string // Filter to these relationship types (empty = all)
	MaxDepth          int      // Maximum traversal depth (0 → default of 3)
	Limit             int      // Maximum results (0 → no limit)
}

// QueryResult holds the results of a KG query.
type QueryResult struct {
	Entities       []*core.Entity
	Relationships  []core.EntityRelationship
	InferenceChain []core.EntityRelationship // non-nil only when EndEntity is set
}

// Query performs a knowledge graph traversal starting from the given entity.
// If EndEntity is set, it finds the shortest inference chain between start and end.
// If EndEntity is empty, it does a transitive closure BFS to the given depth.
// Uses cycle detection via a visited set to prevent infinite loops.
func (q *KGQuery) Query(ctx context.Context, params QueryParams) (*QueryResult, error) {
	if params.StartEntity == "" {
		return nil, fmt.Errorf("start entity is required")
	}

	// Apply defaults
	maxDepth := params.MaxDepth
	if maxDepth <= 0 {
		maxDepth = 3
	}

	// Verify start entity exists
	start, err := q.store.GetEntity(ctx, params.StartEntity)
	if err != nil {
		return nil, fmt.Errorf("get start entity %s: %w", params.StartEntity, err)
	}

	// If EndEntity is specified, find inference chain
	if params.EndEntity != "" {
		return q.findInferenceChain(ctx, start, params, maxDepth)
	}

	// Otherwise, do transitive closure BFS
	return q.transitiveClosure(ctx, start, params, maxDepth)
}

// findInferenceChain uses BFS to find the shortest path of relationships
// from start entity to end entity, with cycle detection.
func (q *KGQuery) findInferenceChain(
	ctx context.Context,
	start *core.Entity,
	params QueryParams,
	maxDepth int,
) (*QueryResult, error) {
	// Verify end entity exists
	end, err := q.store.GetEntity(ctx, params.EndEntity)
	if err != nil {
		return nil, fmt.Errorf("get end entity %s: %w", params.EndEntity, err)
	}

	type bfsNode struct {
		entityID string
		path     []core.EntityRelationship
		depth    int
	}

	visited := make(map[string]bool)
	visited[start.ID] = true
	queue := []bfsNode{{entityID: start.ID, path: nil, depth: 0}}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		if current.depth >= maxDepth {
			continue
		}

		rels, err := q.store.GetEntityRelationships(ctx, current.entityID)
		if err != nil {
			continue
		}

		for _, rel := range rels {
			// Filter by relationship type if specified
			if len(params.RelationshipTypes) > 0 && !contains(params.RelationshipTypes, rel.RelationshipType) {
				continue
			}

			neighborID := rel.TargetEntityID
			if rel.SourceEntityID != current.entityID {
				neighborID = rel.SourceEntityID
			}

			// Build new path
			newPath := make([]core.EntityRelationship, len(current.path)+1)
			copy(newPath, current.path)
			newPath[len(current.path)] = rel

			// Check if we reached the target
			if neighborID == end.ID {
				// Collect all unique entities in the path
				result, err := q.buildResultFromChain(ctx, newPath)
				if err != nil {
					return nil, err
				}
				result.InferenceChain = newPath
				return result, nil
			}

			if visited[neighborID] {
				continue
			}
			visited[neighborID] = true

			queue = append(queue, bfsNode{
				entityID: neighborID,
				path:     newPath,
				depth:    current.depth + 1,
			})
		}
	}

	// No path found — return empty result with just start and end entities
	return &QueryResult{
		Entities:       []*core.Entity{start, end},
		Relationships:  nil,
		InferenceChain: nil,
	}, nil
}

// transitiveClosure performs BFS from the start entity to the given depth,
// collecting all reachable entities and relationships with cycle detection.
func (q *KGQuery) transitiveClosure(
	ctx context.Context,
	start *core.Entity,
	params QueryParams,
	maxDepth int,
) (*QueryResult, error) {
	type bfsNode struct {
		entityID string
		depth    int
	}

	visited := make(map[string]bool)
	visited[start.ID] = true
	queue := []bfsNode{{entityID: start.ID, depth: 0}}

	entityMap := make(map[string]*core.Entity)
	entityMap[start.ID] = start

	seenRels := make(map[string]bool)
	var allRels []core.EntityRelationship

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		if current.depth >= maxDepth {
			continue
		}

		rels, err := q.store.GetEntityRelationships(ctx, current.entityID)
		if err != nil {
			continue
		}

		for _, rel := range rels {
			// Filter by relationship type if specified
			if len(params.RelationshipTypes) > 0 && !contains(params.RelationshipTypes, rel.RelationshipType) {
				continue
			}

			if seenRels[rel.ID] {
				continue
			}
			seenRels[rel.ID] = true
			allRels = append(allRels, rel)

			neighborID := rel.TargetEntityID
			if rel.SourceEntityID != current.entityID {
				neighborID = rel.SourceEntityID
			}

			if visited[neighborID] {
				continue
			}
			visited[neighborID] = true

			neighbor, err := q.store.GetEntity(ctx, neighborID)
			if err != nil {
				continue
			}
			entityMap[neighborID] = neighbor

			queue = append(queue, bfsNode{
				entityID: neighborID,
				depth:    current.depth + 1,
			})
		}
	}

	// Apply limit
	var entities []*core.Entity
	for _, e := range entityMap {
		entities = append(entities, e)
	}
	if params.Limit > 0 && len(entities) > params.Limit {
		entities = entities[:params.Limit]
	}
	if params.Limit > 0 && len(allRels) > params.Limit {
		allRels = allRels[:params.Limit]
	}

	return &QueryResult{
		Entities:       entities,
		Relationships:  allRels,
		InferenceChain: nil,
	}, nil
}

// buildResultFromChain collects all unique entities referenced in a chain of relationships.
func (q *KGQuery) buildResultFromChain(
	ctx context.Context,
	chain []core.EntityRelationship,
) (*QueryResult, error) {
	entityMap := make(map[string]*core.Entity)
	var relationships []core.EntityRelationship

	for _, rel := range chain {
		relationships = append(relationships, rel)

		for _, id := range []string{rel.SourceEntityID, rel.TargetEntityID} {
			if _, seen := entityMap[id]; !seen {
				entity, err := q.store.GetEntity(ctx, id)
				if err != nil {
					continue
				}
				entityMap[id] = entity
			}
		}
	}

	var entities []*core.Entity
	for _, e := range entityMap {
		entities = append(entities, e)
	}

	return &QueryResult{
		Entities:      entities,
		Relationships: relationships,
	}, nil
}

// SearchEntities searches for entities by name using the store's search capability.
func (q *KGQuery) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	if name == "" {
		return nil, fmt.Errorf("search name must not be empty")
	}
	if limit <= 0 {
		limit = 10
	}
	return q.store.SearchEntities(ctx, name, limit)
}

// GetEntitiesByType retrieves entities of a specific type.
func (q *KGQuery) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	if !validEntityTypes[entityType] {
		return nil, fmt.Errorf("invalid entity type %q", entityType)
	}
	if limit <= 0 {
		limit = 10
	}
	return q.store.GetEntitiesByType(ctx, entityType, limit)
}

// CreateRelationship creates a relationship between two entities with validation.
func (q *KGQuery) CreateRelationship(
	ctx context.Context,
	sourceID, targetID, relType string,
	confidence float64,
) (string, error) {
	if sourceID == "" || targetID == "" {
		return "", fmt.Errorf("source and target entity IDs are required")
	}
	if sourceID == targetID {
		return "", fmt.Errorf("self-referential relationships are not allowed")
	}
	if confidence <= 0 {
		confidence = 1.0
	}
	if confidence > 1.0 {
		confidence = 1.0
	}

	// Verify both entities exist
	if _, err := q.store.GetEntity(ctx, sourceID); err != nil {
		return "", fmt.Errorf("source entity %s not found: %w", sourceID, err)
	}
	if _, err := q.store.GetEntity(ctx, targetID); err != nil {
		return "", fmt.Errorf("target entity %s not found: %w", targetID, err)
	}

	return q.store.CreateEntityRelationship(ctx, sourceID, targetID, relType, confidence)
}

// contains checks if a string is in a slice.
func contains(slice []string, s string) bool {
	for _, item := range slice {
		if item == s {
			return true
		}
	}
	return false
}
