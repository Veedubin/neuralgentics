// Package graph provides memory relationship management and graph traversal
// for the neuralgentics memory system. It operates exclusively on the core.Store
// interface — never on the concrete PostgresStore.
package graph

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
)

// validRelationshipTypes lists allowed relationship type values.
var validRelationshipTypes = map[string]bool{
	"SUPERSEDES":     true,
	"RELATED_TO":     true,
	"CONTRADICTS":    true,
	"DERIVED_FROM":   true,
	"PARTIAL_UPDATE": true,
}

// RelationshipManager provides high-level operations on memory relationships.
// It wraps the core.Store interface with validation and enrichment logic.
type RelationshipManager struct {
	store core.Store
}

// NewRelationshipManager creates a RelationshipManager backed by the given store.
func NewRelationshipManager(store core.Store) *RelationshipManager {
	return &RelationshipManager{store: store}
}

// CreateRelationship creates a new relationship between two memories.
// relType must be one of: SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM, PARTIAL_UPDATE.
// If confidence is <= 0, it defaults to 1.0.
// Returns the ID of the newly created relationship.
func (rm *RelationshipManager) CreateRelationship(
	ctx context.Context,
	sourceID, targetID, relType string,
	confidence float64,
) (string, error) {
	if !validRelationshipTypes[relType] {
		return "", fmt.Errorf("invalid relationship type %q: must be one of SUPERSEDES, RELATED_TO, CONTRADICTS, DERIVED_FROM, PARTIAL_UPDATE", relType)
	}

	if confidence <= 0 {
		confidence = 1.0
	}

	id, err := rm.store.CreateRelationship(ctx, sourceID, targetID, relType, confidence)
	if err != nil {
		return "", fmt.Errorf("create relationship: %w", err)
	}
	return id, nil
}

// DeleteRelationship removes a relationship by its ID.
func (rm *RelationshipManager) DeleteRelationship(ctx context.Context, id string) error {
	if err := rm.store.DeleteRelationship(ctx, id); err != nil {
		return fmt.Errorf("delete relationship: %w", err)
	}
	return nil
}

// GetRelatedMemories returns memories related to the given memoryID.
// If relType is non-empty, only relationships of that type are included.
// Results are deduplicated and limited to the requested count.
func (rm *RelationshipManager) GetRelatedMemories(
	ctx context.Context,
	memoryID, relType string,
	limit int,
) ([]*core.MemoryEntry, error) {
	rels, err := rm.store.GetRelationships(ctx, memoryID)
	if err != nil {
		return nil, fmt.Errorf("get relationships: %w", err)
	}

	// Deduplicate memory IDs and collect the "other" side of each relationship.
	seen := make(map[string]bool)
	var otherIDs []string
	for _, rel := range rels {
		// Filter by type if specified
		if relType != "" && rel.RelationshipType != relType {
			continue
		}

		otherID := rel.TargetID
		if rel.SourceID == memoryID {
			otherID = rel.TargetID
		} else if rel.TargetID == memoryID {
			otherID = rel.SourceID
		} else {
			// Should not happen, but skip if the memoryID isn't either end
			continue
		}

		if !seen[otherID] {
			seen[otherID] = true
			otherIDs = append(otherIDs, otherID)
		}
	}

	// Apply limit
	if limit > 0 && len(otherIDs) > limit {
		otherIDs = otherIDs[:limit]
	}

	// Fetch each related memory
	var results []*core.MemoryEntry
	for _, id := range otherIDs {
		entry, err := rm.store.GetMemory(ctx, id, true)
		if err != nil {
			continue // skip memories that can't be fetched
		}
		results = append(results, entry)
	}

	return results, nil
}

// GetRelationshipSummary returns a summary of relationships grouped by type
// for the given memory.
func (rm *RelationshipManager) GetRelationshipSummary(
	ctx context.Context,
	memoryID string,
) (*core.RelationshipSummary, error) {
	summary, err := rm.store.GetRelationshipSummary(ctx, memoryID)
	if err != nil {
		return nil, fmt.Errorf("get relationship summary: %w", err)
	}
	return summary, nil
}
