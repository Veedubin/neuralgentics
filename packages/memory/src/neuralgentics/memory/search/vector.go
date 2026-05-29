package search

import (
	"context"
	"fmt"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// VectorSearcher implements core.Searcher's VectorSearch method
// by delegating to the PostgresStore's QueryMemoriesByVector.
type VectorSearcher struct {
	store *store.PostgresStore
}

// NewVectorSearcher creates a new VectorSearcher backed by the given store.
func NewVectorSearcher(s *store.PostgresStore) *VectorSearcher {
	return &VectorSearcher{store: s}
}

// Query performs a semantic search: embed the query text, then search by vector.
func (v *VectorSearcher) Query(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, fmt.Errorf("VectorSearcher.Query requires an embedder; use HybridSearcher instead")
}

// VectorSearch searches memories by vector similarity.
func (v *VectorSearcher) VectorSearch(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return v.store.QueryMemoriesByVector(ctx, vector, opts)
}

// TextSearch is not supported by VectorSearcher; use BM25Searcher instead.
func (v *VectorSearcher) TextSearch(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return v.store.SearchMemoriesText(ctx, query, opts)
}

// HybridSearch is not supported by VectorSearcher; use HybridSearcher instead.
func (v *VectorSearcher) HybridSearch(ctx context.Context, query string, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, fmt.Errorf("HybridSearch: use search.HybridSearcher instead")
}

// GetSimilar returns memories similar to a given memory ID.
func (v *VectorSearcher) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return v.store.GetSimilar(ctx, memoryID, opts)
}
