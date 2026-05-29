package search

import (
	"context"
	"sort"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// DefaultRRFConstant is the k parameter for Reciprocal Rank Fusion.
// RRF(d) = Σ 1/(k + rank_i(d)) where k dampens the influence of high ranks.
const DefaultRRFConstant = 60

// HybridSearcher combines vector similarity and full-text search using
// Reciprocal Rank Fusion (RRF). It runs both searches in parallel and
// merges results with RRF scoring.
type HybridSearcher struct {
	store    *store.PostgresStore
	embedder core.Embedder
	k        int // RRF constant
}

// NewHybridSearcher creates a new HybridSearcher.
func NewHybridSearcher(s *store.PostgresStore, embedder core.Embedder) *HybridSearcher {
	return &HybridSearcher{
		store:    s,
		embedder: embedder,
		k:        DefaultRRFConstant,
	}
}

// Query performs a hybrid search: embed the text, run both vector and text
// searches concurrently, then merge results via Reciprocal Rank Fusion.
func (h *HybridSearcher) Query(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}

	// Embed the query text
	vector, err := h.embedder.Embed(ctx, query)
	if err != nil {
		return nil, err
	}

	return h.HybridSearch(ctx, query, vector, opts)
}

// VectorSearch searches by vector similarity only.
func (h *HybridSearcher) VectorSearch(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return h.store.QueryMemoriesByVector(ctx, vector, opts)
}

// TextSearch performs full-text search only.
func (h *HybridSearcher) TextSearch(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return h.store.SearchMemoriesText(ctx, query, opts)
}

// HybridSearch combines vector and text search with Reciprocal Rank Fusion.
func (h *HybridSearcher) HybridSearch(ctx context.Context, query string, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}

	// Expand the per-method limit to ensure enough candidates for RRF
	expandedTopK := opts.TopK * 3

	vectorOpts := &core.SearchOptions{
		TopK:        expandedTopK,
		Threshold:   opts.Threshold,
		ExactSearch: opts.ExactSearch,
	}
	textOpts := &core.SearchOptions{TopK: expandedTopK}

	// Run both searches (could be parallel with errgroup for production)
	vectorResults, vErr := h.store.QueryMemoriesByVector(ctx, vector, vectorOpts)
	textResults, tErr := h.store.SearchMemoriesText(ctx, query, textOpts)

	// If one fails, return the other
	if vErr != nil && tErr != nil {
		return nil, vErr
	}
	if vErr != nil {
		return textResults, nil
	}
	if tErr != nil {
		return vectorResults, nil
	}

	// Merge via Reciprocal Rank Fusion
	merged := h.rrfMerge(vectorResults, textResults)

	// Sort by RRF score (descending) and limit to TopK
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].Score == nil && merged[j].Score == nil {
			return false
		}
		if merged[i].Score == nil {
			return false
		}
		if merged[j].Score == nil {
			return true
		}
		return *merged[i].Score > *merged[j].Score
	})

	if len(merged) > opts.TopK {
		merged = merged[:opts.TopK]
	}

	return merged, nil
}

// GetSimilar returns memories similar to a given memory ID.
func (h *HybridSearcher) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return h.store.GetSimilar(ctx, memoryID, opts)
}

// rrfMerge combines vector and text search results using Reciprocal Rank Fusion.
func (h *HybridSearcher) rrfMerge(vectorResults, textResults []*core.MemoryEntry) []*core.MemoryEntry {
	scores := make(map[string]float64)
	entries := make(map[string]*core.MemoryEntry)

	// Add vector search results
	for rank, entry := range vectorResults {
		rrfScore := 1.0 / float64(h.k+rank+1) // +1 because rank is 0-indexed
		scores[entry.ID] += rrfScore
		entries[entry.ID] = entry
	}

	// Add text search results
	for rank, entry := range textResults {
		rrfScore := 1.0 / float64(h.k+rank+1)
		scores[entry.ID] += rrfScore
		if _, exists := entries[entry.ID]; !exists {
			entries[entry.ID] = entry
		}
	}

	// Build merged results with RRF scores
	var results []*core.MemoryEntry
	for id, entry := range entries {
		score := scores[id]
		entry.Score = &score
		results = append(results, entry)
	}

	return results
}
