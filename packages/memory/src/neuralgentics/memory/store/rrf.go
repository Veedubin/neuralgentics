package store

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"neuralgentics/src/neuralgentics/memory/core"
)

// allowedEmbeddingColumns is the allow-list of embedding column names that may
// be used in RRF search. This prevents SQL injection via column name
// interpolation — any column not in this set causes RRFSearch to return an error.
var allowedEmbeddingColumns = map[string]bool{
	"embedding":           true, // 384-dim MiniLM (or migrated BGE-Large)
	"embedding_bge_m3":    true, // 1024-dim BGE-M3 (added in migration 000006)
	"embedding_bge_large": true, // reserved for future explicit BGE-Large column
}

// RRFScore is the result of RRF fusion: the memory entry plus its RRF score
// and per-model ranking information.
type RRFScore struct {
	Entry        core.MemoryEntry
	RRFScore     float64
	RanksByModel map[string]int // column name → 1-based rank in that model's list
	BestDistance float64        // lowest cosine distance across all models
}

// RRFConfig holds parameters for multi-model RRF search.
type RRFConfig struct {
	K              int      // standard RRF constant (default 60)
	TopKPerModel   int      // how many results to fetch from each model (default 20)
	FinalTopK      int      // how many results to return after fusion (default 10)
	EnabledColumns []string // which embedding columns to search, e.g. ["embedding", "embedding_bge_m3"]
}

// DefaultRRFConfig returns sensible defaults for RRF search.
func DefaultRRFConfig() RRFConfig {
	return RRFConfig{
		K:              60,
		TopKPerModel:   20,
		FinalTopK:      10,
		EnabledColumns: []string{"embedding", "embedding_bge_m3"},
	}
}

// EmbedFn is the callback signature for generating a query vector for a given
// embedding column. The column name maps to a model choice on the sidecar.
// The function returns a float64 slice (will be formatted as pgvector text).
type EmbedFn func(column string) ([]float64, error)

// RRFSearch runs multi-model Reciprocal Rank Fusion search.
//
// For each enabled embedding column:
//  1. Check if any non-archived rows have that column populated (skip if 0).
//  2. Call embedFn to get the query vector for that column's model space.
//  3. Run a top-K vector similarity search against that column.
//  4. Collect per-model ranked lists.
//
// Then fuse the ranked lists using RRF: score(m) = Σ 1/(K + rank_i(m))
// for each model i where m appears. Return the top FinalTopK results by RRF score.
func (s *PostgresStore) RRFSearch(ctx context.Context, cfg RRFConfig, embedFn EmbedFn) ([]RRFScore, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	// Validate config.
	if cfg.K <= 0 {
		cfg.K = 60
	}
	if cfg.TopKPerModel <= 0 {
		cfg.TopKPerModel = 20
	}
	if cfg.FinalTopK <= 0 {
		cfg.FinalTopK = 10
	}
	if len(cfg.EnabledColumns) == 0 {
		cfg.EnabledColumns = []string{"embedding", "embedding_bge_m3"}
	}

	// Validate all column names against the allow-list.
	for _, col := range cfg.EnabledColumns {
		if !allowedEmbeddingColumns[col] {
			return nil, fmt.Errorf("RRFSearch: column %q is not in the allowed embedding column list", col)
		}
	}

	type rankEntry struct {
		entry    core.MemoryEntry
		rank     int
		distance float64
	}

	perModel := make(map[string][]rankEntry)
	modelsQueried := make([]string, 0, len(cfg.EnabledColumns))

	for _, col := range cfg.EnabledColumns {
		// Check if any rows have this column populated.
		countQuery := fmt.Sprintf("SELECT COUNT(*) FROM memories WHERE %s IS NOT NULL AND is_archived = FALSE", col)
		var count int
		if err := s.pool.QueryRow(ctx, countQuery).Scan(&count); err != nil {
			return nil, fmt.Errorf("RRFSearch: count rows for column %s: %w", col, err)
		}
		if count == 0 {
			continue // skip columns with no data
		}

		modelsQueried = append(modelsQueried, col)

		// Embed the query for this column's model space.
		vec, err := embedFn(col)
		if err != nil {
			return nil, fmt.Errorf("RRFSearch: embed for column %s: %w", col, err)
		}
		if len(vec) == 0 {
			continue // no vector — skip this model
		}

		vecStr := float64SliceToVectorText(vec)

		// Build the per-column search query with validated column name.
		searchSQL := fmt.Sprintf(`
			SELECT id, text, embedding_model, source_type, source_path, trust_score,
			       retrieval_count, created_at, updated_at, is_archived,
			       (%s <=> $1::vector) as distance
			FROM memories
			WHERE %s IS NOT NULL AND is_archived = FALSE
			ORDER BY %s <=> $1::vector
			LIMIT $2
		`, col, col, col)

		rows, err := s.pool.Query(ctx, searchSQL, vecStr, cfg.TopKPerModel)
		if err != nil {
			return nil, fmt.Errorf("RRFSearch: query column %s: %w", col, err)
		}

		rank := 0
		for rows.Next() {
			rank++
			var e core.MemoryEntry
			var embeddingModel *string
			var sourcePath *string
			var dist float64

			if err := rows.Scan(
				&e.ID,
				&e.Content,
				&embeddingModel,
				&e.SourceType,
				&sourcePath,
				&e.TrustScore,
				&e.RetrievalCount,
				&e.CreatedAt,
				&e.UpdatedAt,
				&e.IsArchived,
				&dist,
			); err != nil {
				rows.Close()
				return nil, fmt.Errorf("RRFSearch: scan row for column %s: %w", col, err)
			}

			if embeddingModel != nil {
				e.EmbeddingModel = *embeddingModel
			}
			if sourcePath != nil {
				e.SourcePath = sourcePath
			}

			perModel[col] = append(perModel[col], rankEntry{
				entry:    e,
				rank:     rank,
				distance: dist,
			})
		}
		rows.Close()
	}

	// Fuse with RRF.
	scores := make(map[string]*RRFScore)
	for col, entries := range perModel {
		for _, re := range entries {
			if existing, ok := scores[re.entry.ID]; ok {
				existing.RRFScore += 1.0 / float64(cfg.K+re.rank)
				existing.RanksByModel[col] = re.rank
				if re.distance < existing.BestDistance {
					existing.BestDistance = re.distance
				}
			} else {
				ranks := make(map[string]int)
				ranks[col] = re.rank
				scores[re.entry.ID] = &RRFScore{
					Entry:        re.entry,
					RRFScore:     1.0 / float64(cfg.K+re.rank),
					RanksByModel: ranks,
					BestDistance: re.distance,
				}
			}
		}
	}

	// Sort by RRF score descending.
	all := make([]RRFScore, 0, len(scores))
	for _, s := range scores {
		all = append(all, *s)
	}
	sort.Slice(all, func(i, j int) bool {
		return all[i].RRFScore > all[j].RRFScore
	})

	if len(all) > cfg.FinalTopK {
		all = all[:cfg.FinalTopK]
	}

	return all, nil
}

// float64SliceToVectorText formats a float64 slice as a pgvector literal
// "[0.1,0.2,...]" suitable for binding as $1::vector in SQL queries.
func float64SliceToVectorText(v []float64) string {
	if len(v) == 0 {
		return "[]"
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatFloat(f, 'f', -1, 64))
	}
	sb.WriteByte(']')
	return sb.String()
}

// scanRRFRow is a helper for scanning a single row from the RRF per-model search.
// It is kept as a standalone function for testability (though the inline scan
// in RRFSearch is the production path).
func scanRRFRow(row pgx.Row) (core.MemoryEntry, float64, error) {
	var e core.MemoryEntry
	var embeddingModel *string
	var sourcePath *string
	var dist float64

	err := row.Scan(
		&e.ID,
		&e.Content,
		&embeddingModel,
		&e.SourceType,
		&sourcePath,
		&e.TrustScore,
		&e.RetrievalCount,
		&e.CreatedAt,
		&e.UpdatedAt,
		&e.IsArchived,
		&dist,
	)
	if err != nil {
		return e, 0, err
	}

	if embeddingModel != nil {
		e.EmbeddingModel = *embeddingModel
	}
	if sourcePath != nil {
		e.SourcePath = sourcePath
	}
	return e, dist, nil
}

// Ensure time import is used (CreatedAt/UpdatedAt scanning references time.Time).
var _ = time.Time{}
