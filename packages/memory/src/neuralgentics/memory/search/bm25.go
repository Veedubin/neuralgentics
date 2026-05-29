package search

import (
	"context"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// BM25Searcher implements full-text search using PostgreSQL's tsvector + websearch_to_tsquery.
type BM25Searcher struct {
	store *store.PostgresStore
}

// NewBM25Searcher creates a new BM25Searcher backed by the given store.
func NewBM25Searcher(s *store.PostgresStore) *BM25Searcher {
	return &BM25Searcher{store: s}
}

// Query performs a full-text search.
func (b *BM25Searcher) Query(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return b.TextSearch(ctx, query, opts)
}

// VectorSearch is not supported by BM25Searcher.
func (b *BM25Searcher) VectorSearch(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// TextSearch performs PostgreSQL full-text search using ts_rank.
func (b *BM25Searcher) TextSearch(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return b.store.SearchMemoriesText(ctx, query, opts)
}

// HybridSearch is not supported by BM25Searcher alone.
func (b *BM25Searcher) HybridSearch(ctx context.Context, query string, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// GetSimilar is not supported by BM25Searcher.
func (b *BM25Searcher) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
