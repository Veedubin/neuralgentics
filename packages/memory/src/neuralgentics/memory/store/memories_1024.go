package store

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Dual-Model RRF: 1024-dim Operations (v0.7.0+ port) ─────────────────────

// AddMemory1024 inserts a 1024-dim vector entry for an existing memory.
func (s *PostgresStore) AddMemory1024(ctx context.Context, memoryID string, vector []float64) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}
	embedding := formatVector(vector)
	var returnedID string
	err := s.pool.QueryRow(ctx, InsertMemory1024, memoryID, embedding).Scan(&returnedID)
	if err != nil {
		return "", fmt.Errorf("insert memory 1024: %w", err)
	}
	return returnedID, nil
}

// QueryMemories1024 searches the 1024-dim index for the given vector.
func (s *PostgresStore) QueryMemories1024(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}

	vectorStr := formatVector(vector)

	rows, err := s.pool.Query(ctx, SearchMemories1024Vector, vectorStr, opts.Threshold, opts.TopK)
	if err != nil {
		return nil, fmt.Errorf("query memories 1024: %w", err)
	}
	defer rows.Close()

	var results []*core.MemoryEntry
	for rows.Next() {
		entry, scanErr := scanMemoryEntryWithDistance(rows)
		if scanErr != nil {
			continue
		}
		results = append(results, entry)
	}
	return results, nil
}

// GetMemory1024 retrieves a 1024-dim entry by the parent memory ID.
func (s *PostgresStore) GetMemory1024(ctx context.Context, memoryID string) (*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// We return the parent memory entry (from the JOIN) since callers
	// typically want the full entry, not just the 1024 row.
	row := s.pool.QueryRow(ctx, `
		SELECT m.id, m.text, m.embedding, m.source_type, m.content_hash, m.metadata,
		       m.trust_score, m.retrieval_count, m.is_archived, m.last_accessed_at,
		       m.source_path, m.supersedes_id, m.structured_fields, m.change_ratio,
		       m.created_at_ms, m.created_at, m.updated_at
		FROM memories m
		JOIN memories_1024 m1024 ON m.id = m1024.memory_id
		WHERE m1024.memory_id = $1 AND m.is_archived = FALSE
	`, memoryID)
	return scanMemoryEntry(row)
}

// CountMemories1024 returns the count of entries in the memories_1024 table.
func (s *PostgresStore) CountMemories1024(ctx context.Context) (int64, error) {
	if s.pool == nil {
		return 0, fmt.Errorf("database pool not initialized")
	}
	var count int64
	err := s.pool.QueryRow(ctx, CountMemories1024).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count memories 1024: %w", err)
	}
	return count, nil
}

// DeleteMemory1024 deletes the 1024 entry for a given memory ID.
func (s *PostgresStore) DeleteMemory1024(ctx context.Context, memoryID string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	var deletedMemoryID string
	err := s.pool.QueryRow(ctx, DeleteMemory1024, memoryID).Scan(&deletedMemoryID)
	if err != nil {
		return nil // idempotent — no error if entry didn't exist
	}
	return nil
}
