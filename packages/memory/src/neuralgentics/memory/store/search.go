package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// PreparedSearch provides typed access to frequently used search methods on PostgresStore.
//
// pgx v5 Prepared Statement Caching:
//
// pgx v5 caches prepared statements automatically per connection within the pool.
// When the same SQL query string is executed via pool.Query(), pool.QueryRow(), or
// pool.Exec(), pgx prepares the statement on first use and reuses the prepared
// statement descriptor on subsequent invocations. This provides the same performance
// benefit as manual prepared statement caching without requiring explicit management.
//
// Key queries that benefit from automatic caching:
//   - SearchMemoriesVector (cosine distance search)
//   - SearchMemoriesText (full-text search with ts_rank)
//   - GetSimilarMemories (similarity lookup by ID)
//   - InsertMemory / InsertMemoryDelta (frequent writes)
//   - GetMemoryByID (frequent reads)
//
// No manual PreparedSearch struct is needed — pgx handles this transparently.
// If future pgx changes remove automatic caching, add a PreparedSearch struct
// with pgx.PreparedStatementCache or explicit conn.Prepare() calls.

// QueryMemoriesByVector performs cosine distance similarity search against stored embeddings.
// The <=> operator returns cosine distance (lower = closer). We convert to similarity (1 - distance).
func (s *PostgresStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}

	// pgvector <=> returns cosine distance; convert similarity threshold to distance threshold
	distanceThreshold := 1.0 - opts.Threshold

	// Format vector as pgvector text for binding
	vectorStr := formatVector(vector)

	var rows pgx.Rows
	var err error

	if opts.ExactSearch {
		// Disable DiskANN index for exact results via local SET in transaction
		tx, txErr := s.pool.Begin(ctx)
		if txErr != nil {
			return nil, fmt.Errorf("begin transaction: %w", txErr)
		}
		defer tx.Rollback(ctx)

		if _, execErr := tx.Exec(ctx, "SET LOCAL enable_indexscan = off"); execErr != nil {
			return nil, fmt.Errorf("disable index scan: %w", execErr)
		}

		rows, err = tx.Query(ctx, SearchMemoriesVector, vectorStr, distanceThreshold, opts.TopK)
	} else {
		rows, err = s.pool.Query(ctx, SearchMemoriesVector, vectorStr, distanceThreshold, opts.TopK)
	}

	if err != nil {
		return nil, fmt.Errorf("query memories by vector: %w", err)
	}
	defer rows.Close()

	return scanVectorSearchRows(rows)
}

// SearchMemoriesText performs full-text search using PostgreSQL tsvector + websearch_to_tsquery.
func (s *PostgresStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if opts == nil {
		opts = &core.SearchOptions{TopK: 10}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}

	rows, err := s.pool.Query(ctx, SearchMemoriesText, query, opts.TopK)
	if err != nil {
		return nil, fmt.Errorf("search memories text: %w", err)
	}
	defer rows.Close()

	return scanTextSearchRows(rows)
}

// GetSimilar returns memories similar to the given memory ID using its embedding.
func (s *PostgresStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if opts == nil {
		opts = &core.SearchOptions{TopK: 10}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}

	rows, err := s.pool.Query(ctx, GetSimilarMemories, memoryID, opts.TopK)
	if err != nil {
		return nil, fmt.Errorf("get similar memories: %w", err)
	}
	defer rows.Close()

	return scanVectorSearchRows(rows)
}

// scanVectorSearchRows scans all rows from a vector search query (includes distance column).
func scanVectorSearchRows(rows pgx.Rows) ([]*core.MemoryEntry, error) {
	var results []*core.MemoryEntry
	for rows.Next() {
		var entry core.MemoryEntry
		var metadataJSON []byte
		var structuredFieldsJSON []byte
		var distance float64
		var supersedesID *string

		err := rows.Scan(
			&entry.ID,
			&entry.Content,
			&entry.SourceType,
			&entry.TrustScore,
			&entry.RetrievalCount,
			&entry.IsArchived,
			&metadataJSON,
			new(string), // embedding — skip
			&supersedesID,
			&structuredFieldsJSON,
			&entry.ChangeRatio,
			&entry.CreatedAtMs,
			&entry.CreatedAt,
			&entry.UpdatedAt,
			&entry.ContentHash,
			&entry.SourcePath,
			&distance,
		)
		if err != nil {
			slog.Warn("scan vector search row", "err", err)
			continue
		}

		if supersedesID != nil {
			entry.SupersedesID = *supersedesID
		}
		if metadataJSON != nil {
			var m map[string]any
			if json.Unmarshal(metadataJSON, &m) == nil {
				entry.Metadata = m
			}
		}
		if structuredFieldsJSON != nil {
			var sf map[string]any
			if json.Unmarshal(structuredFieldsJSON, &sf) == nil {
				entry.StructuredFields = sf
			}
		}

		score := 1.0 - distance
		entry.Score = &score
		results = append(results, &entry)
	}
	return results, nil
}

// scanTextSearchRows scans all rows from a full-text search query (includes rank column).
func scanTextSearchRows(rows pgx.Rows) ([]*core.MemoryEntry, error) {
	var results []*core.MemoryEntry
	for rows.Next() {
		var entry core.MemoryEntry
		var metadataJSON []byte
		var structuredFieldsJSON []byte
		var rank float64
		var supersedesID *string

		err := rows.Scan(
			&entry.ID,
			&entry.Content,
			&entry.SourceType,
			&entry.TrustScore,
			&entry.RetrievalCount,
			&entry.IsArchived,
			&metadataJSON,
			&entry.ContentHash,
			&supersedesID,
			&structuredFieldsJSON,
			&entry.ChangeRatio,
			&entry.CreatedAtMs,
			&entry.CreatedAt,
			&entry.UpdatedAt,
			&rank,
		)
		if err != nil {
			slog.Warn("scan text search row", "err", err)
			continue
		}

		if supersedesID != nil {
			entry.SupersedesID = *supersedesID
		}
		if metadataJSON != nil {
			var m map[string]any
			if json.Unmarshal(metadataJSON, &m) == nil {
				entry.Metadata = m
			}
		}
		if structuredFieldsJSON != nil {
			var sf map[string]any
			if json.Unmarshal(structuredFieldsJSON, &sf) == nil {
				entry.StructuredFields = sf
			}
		}

		entry.Score = &rank
		results = append(results, &entry)
	}
	return results, nil
}
