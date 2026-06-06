// Package store — relationships.go: knowledge graph relationship operations.
package store

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"neuralgentics/src/neuralgentics/memory/core"
)

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
