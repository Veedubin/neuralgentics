// Package store — project_chunks.go: project file chunk indexing operations.
package store

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Project Indexer Operations ──────────────────────────────────────────────

// AddProjectChunk adds a file chunk to the project_chunks table.
func (s *PostgresStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	if s.pool == nil {
		return "", fmt.Errorf("database pool not initialized")
	}

	chunkID := uuid.New().String()
	var embedding interface{}
	// Note: ChunkResult doesn't carry a vector; the embedder creates it separately.
	// This stores content-only chunks. Vector-based search uses the embedding column
	// which is populated separately or via a pre-embedding step.
	err := s.pool.QueryRow(ctx, InsertProjectChunk,
		chunkID,
		chunk.FilePath,
		chunk.Content,
		embedding, // nil for now; embedding is set separately
		chunk.StartLine,
		chunk.EndLine,
		"", // content_hash — not tracked at chunk level yet
	).Scan(&chunkID)
	if err != nil {
		return "", fmt.Errorf("add project chunk: %w", err)
	}
	return chunkID, nil
}

// DeleteChunksByPath deletes all chunks for a given file path.
func (s *PostgresStore) DeleteChunksByPath(ctx context.Context, path string) error {
	if s.pool == nil {
		return fmt.Errorf("database pool not initialized")
	}
	_, err := s.pool.Exec(ctx, DeleteChunksByPath, path)
	if err != nil {
		return fmt.Errorf("delete chunks by path: %w", err)
	}
	return nil
}

// SearchChunks searches project file chunks by vector similarity.
// It returns chunks matching the query vector, optionally filtered by
// file extensions and directory paths.
func (s *PostgresStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	if opts == nil {
		opts = &core.SearchProjectOptions{TopK: 10, Threshold: 0.5}
	}
	if opts.TopK <= 0 {
		opts.TopK = 10
	}
	if opts.Threshold <= 0 {
		opts.Threshold = 0.5
	}

	// Build the query dynamically with optional filters
	vectorStr := formatVector(vector)

	var args []any
	argNum := 1

	baseQuery := `SELECT id, file_path, content, start_line, end_line,
       (1.0 - (embedding <=> $1::vector)) as score
FROM project_chunks
WHERE embedding IS NOT NULL`

	args = append(args, vectorStr)
	argNum++

	// Add path filter
	if len(opts.Paths) > 0 {
		conditions := make([]string, len(opts.Paths))
		for i, p := range opts.Paths {
			conditions[i] = fmt.Sprintf("file_path LIKE $%d", argNum)
			args = append(args, p+"%")
			argNum++
		}
		for i, cond := range conditions {
			if i == 0 {
				baseQuery += " AND (" + cond
			} else {
				baseQuery += " OR " + cond
			}
		}
		baseQuery += ")"
	}

	// Add file type filter
	if len(opts.FileTypes) > 0 {
		typeConditions := make([]string, len(opts.FileTypes))
		for i, ft := range opts.FileTypes {
			typeConditions[i] = fmt.Sprintf("file_path LIKE $%d", argNum)
			args = append(args, "%"+ft)
			argNum++
		}
		for i, cond := range typeConditions {
			if i == 0 {
				baseQuery += " AND (" + cond
			} else {
				baseQuery += " OR " + cond
			}
		}
		baseQuery += ")"
	}

	// Add threshold and limit
	baseQuery += fmt.Sprintf(" AND (1.0 - (embedding <=> $1::vector)) >= $%d", argNum)
	args = append(args, opts.Threshold)
	argNum++

	baseQuery += fmt.Sprintf(" ORDER BY embedding <=> $1::vector LIMIT $%d", argNum)
	args = append(args, opts.TopK)

	rows, err := s.pool.Query(ctx, baseQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("search chunks: %w", err)
	}
	defer rows.Close()

	var results []*core.ChunkResult
	for rows.Next() {
		var chunk core.ChunkResult
		var id string
		var score float64
		if err := rows.Scan(&id, &chunk.FilePath, &chunk.Content, &chunk.StartLine, &chunk.EndLine, &score); err != nil {
			slog.Warn("scan chunk row", "err", err)
			continue
		}
		chunk.Score = score
		results = append(results, &chunk)
	}
	return results, nil
}

// GetFileChunksByPath reconstructs file contents from indexed chunks.
// It queries all chunks for a given file path, ordered by start line,
// and concatenates their content.
func (s *PostgresStore) GetFileChunksByPath(ctx context.Context, filePath string) (*core.FileContentsResult, error) {
	if s.pool == nil {
		return nil, fmt.Errorf("database pool not initialized")
	}

	rows, err := s.pool.Query(ctx, GetChunksByPath, filePath)
	if err != nil {
		return nil, fmt.Errorf("get file chunks: %w", err)
	}
	defer rows.Close()

	var chunks []core.ChunkResult
	for rows.Next() {
		var chunk core.ChunkResult
		var id string
		if err := rows.Scan(&id, &chunk.FilePath, &chunk.Content, &chunk.StartLine, &chunk.EndLine); err != nil {
			slog.Warn("scan file chunk row", "err", err)
			continue
		}
		chunks = append(chunks, chunk)
	}

	if len(chunks) == 0 {
		return nil, fmt.Errorf("no chunks found for path %q", filePath)
	}

	// Reconstruct content from chunks
	var b strings.Builder
	isPartial := len(chunks) > 1 // Multiple chunks means partial reconstruction might have gaps

	for i, chunk := range chunks {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(chunk.Content)
	}

	return &core.FileContentsResult{
		FilePath:  filePath,
		Contents:  b.String(),
		IsPartial: isPartial,
	}, nil
}
