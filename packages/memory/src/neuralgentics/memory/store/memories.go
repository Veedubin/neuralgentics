package store

import (
	"context"
	"encoding/json"
	"fmt"

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

		embeddingModel := entry.EmbeddingModel
		if embeddingModel == "" {
			embeddingModel = "bge-large-en-v1.5"
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
			embeddingModel,
		).Scan(&memoryID)
		if err != nil {
			return "", fmt.Errorf("insert memory (delta): %w", err)
		}
	} else {
		embeddingModel := entry.EmbeddingModel
		if embeddingModel == "" {
			embeddingModel = "bge-large-en-v1.5"
		}

		err := s.pool.QueryRow(ctx, InsertMemory,
			memoryID,
			entry.Content,
			embedding,
			entry.SourceType,
			entry.ContentHash,
			metadataJSON,
			entry.CreatedAtMs,
			embeddingModel,
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
