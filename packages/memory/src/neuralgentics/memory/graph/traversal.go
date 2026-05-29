package graph

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Traversal provides graph traversal operations on memory relationships,
// including supersession chains and inference path finding.
type Traversal struct {
	store core.Store
}

// NewTraversal creates a Traversal backed by the given store.
func NewTraversal(store core.Store) *Traversal {
	return &Traversal{store: store}
}

// GetSupersessionChain returns the full supersession chain for a memory,
// ordered newest-first (the SQL CTE already orders by created_at_ms DESC).
// If maxDepth <= 0, it defaults to 10.
func (t *Traversal) GetSupersessionChain(
	ctx context.Context,
	memoryID string,
	maxDepth int,
) ([]*core.MemoryEntry, error) {
	if maxDepth <= 0 {
		maxDepth = 10
	}

	ids, err := t.store.GetSupersessionChain(ctx, memoryID, maxDepth)
	if err != nil {
		return nil, fmt.Errorf("get supersession chain: %w", err)
	}

	if len(ids) == 0 {
		return nil, nil
	}

	var results []*core.MemoryEntry
	for _, id := range ids {
		entry, err := t.store.GetMemory(ctx, id, true)
		if err != nil {
			continue // skip missing memories
		}
		results = append(results, entry)
	}

	return results, nil
}

// GetSuperseded returns the ID of the memory that the given memory supersedes.
// Returns an empty string if no superseded memory exists.
func (t *Traversal) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	id, err := t.store.GetSuperseded(ctx, memoryID)
	if err != nil {
		return "", fmt.Errorf("get superseded: %w", err)
	}
	return id, nil
}

// FindInferencePaths finds relationship paths between startID and endID
// using BFS traversal over memory_relationships. It returns the sequence
// of relationships forming the shortest path, or an empty slice if no path exists.
// If maxDepth <= 0, it defaults to 5.
func (t *Traversal) FindInferencePaths(
	ctx context.Context,
	startID, endID string,
	maxDepth int,
) ([]core.Relationship, error) {
	if maxDepth <= 0 {
		maxDepth = 5
	}

	type node struct {
		id   string
		path []core.Relationship
	}

	visited := make(map[string]bool)
	queue := []node{{id: startID, path: nil}}
	visited[startID] = true

	for len(queue) > 0 && maxDepth > 0 {
		maxDepth--
		levelSize := len(queue)

		for i := 0; i < levelSize; i++ {
			current := queue[0]
			queue = queue[1:]

			if current.id == endID {
				return current.path, nil
			}

			rels, err := t.store.GetRelationships(ctx, current.id)
			if err != nil {
				continue // skip nodes whose relationships can't be fetched
			}

			for _, rel := range rels {
				// Determine the neighbor ID
				neighborID := rel.TargetID
				if rel.SourceID != current.id {
					neighborID = rel.SourceID
				}

				if visited[neighborID] {
					continue
				}
				visited[neighborID] = true

				newPath := make([]core.Relationship, len(current.path)+1)
				copy(newPath, current.path)
				newPath[len(current.path)] = rel

				queue = append(queue, node{id: neighborID, path: newPath})
			}
		}
	}

	// No path found
	return nil, nil
}
