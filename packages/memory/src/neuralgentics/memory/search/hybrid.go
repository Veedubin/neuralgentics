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
//
// v0.7.0+ adds dual-model RRF support: when the embedding mode is "auto"
// and 1024-dim support is available, Query() fuses results from both the
// 384-dim and 1024-dim vector indexes for improved recall.
type HybridSearcher struct {
	store         *store.PostgresStore
	embedder      core.Embedder
	k             int // RRF constant
	embeddingMode core.EmbeddingMode
}

// NewHybridSearcher creates a new HybridSearcher.
func NewHybridSearcher(s *store.PostgresStore, emb core.Embedder) *HybridSearcher {
	return &HybridSearcher{
		store:    s,
		embedder: emb,
		k:        DefaultRRFConstant,
	}
}

// NewHybridSearcherWithConfig creates a HybridSearcher with explicit config for
// dual-model RRF mode dispatch.
func NewHybridSearcherWithConfig(s *store.PostgresStore, emb core.Embedder, mode core.EmbeddingMode, rrfK int) *HybridSearcher {
	if rrfK <= 0 {
		rrfK = DefaultRRFConstant
	}
	return &HybridSearcher{
		store:         s,
		embedder:      emb,
		k:             rrfK,
		embeddingMode: mode,
	}
}

// Query performs a search using the configured embedding mode:
//   - cpu: 384-dim vector + text hybrid
//   - gpu: 1024-dim vector only (no text fusion in gpu mode)
//   - auto: dual-model RRF (384 vector + 1024 vector + text)
func (h *HybridSearcher) Query(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	if opts == nil {
		opts = &core.SearchOptions{TopK: 10, Threshold: 0.7}
	}

	switch h.embeddingMode {
	case core.EmbeddingModeGPU:
		return h.gpuQuery(ctx, query, opts)
	case core.EmbeddingModeAuto:
		return h.autoQuery(ctx, query, opts)
	default: // cpu or unset
		return h.cpuQuery(ctx, query, opts)
	}
}

// cpuQuery performs standard 384-dim vector + text hybrid search via RRF.
func (h *HybridSearcher) cpuQuery(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	vector, err := h.embedder.Embed(ctx, query)
	if err != nil {
		return nil, err
	}
	return h.HybridSearch(ctx, query, vector, opts)
}

// gpuQuery performs 1024-dim vector-only search.
func (h *HybridSearcher) gpuQuery(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	vector, err := h.embedder.Embed1024(ctx, query)
	if err != nil {
		return nil, err
	}

	// Use permissive threshold for 1024-only
	gpuOpts := &core.SearchOptions{
		TopK:      opts.TopK,
		Threshold: 0.9, // permissive: 1024 dim returns fewer matches
		Strategy:  opts.Strategy,
	}
	return h.store.QueryMemories1024(ctx, vector, gpuOpts)
}

// autoQuery performs dual-model RRF: fuses 384-dim vector, 1024-dim vector,
// and text search results using RRF to produce a single ranked list.
func (h *HybridSearcher) autoQuery(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	// Over-fetch to ensure enough candidates for RRF fusion
	expandedTopK := opts.TopK * 2
	if expandedTopK < opts.TopK+5 {
		expandedTopK = opts.TopK + 5
	}

	// Generate both embeddings
	vector384, err384 := h.embedder.Embed(ctx, query)
	vector1024, err1024 := h.embedder.Embed1024(ctx, query)

	// Build search options for each dimension
	opts384 := &core.SearchOptions{TopK: expandedTopK, Threshold: opts.Threshold}
	opts1024 := &core.SearchOptions{TopK: expandedTopK, Threshold: 0.9} // permissive

	// Run 384 search + text search
	var results384, resultsText, results1024 []*core.MemoryEntry
	var errT error

	if err384 == nil {
		results384, err384 = h.store.QueryMemoriesByVector(ctx, vector384, opts384)
	}
	resultsText, errT = h.store.SearchMemoriesText(ctx, query, &core.SearchOptions{TopK: expandedTopK})

	// Run 1024 search (best-effort)
	if err1024 == nil {
		results1024, _ = h.store.QueryMemories1024(ctx, vector1024, opts1024)
	}

	// Build ranked lists for RRF: 384 vector, text, 1024 vector
	rankedLists := make([][]string, 0, 3)
	entryMap := make(map[string]*core.MemoryEntry)

	if err384 == nil {
		ids384 := make([]string, len(results384))
		for i, e := range results384 {
			ids384[i] = e.ID
			entryMap[e.ID] = e
		}
		rankedLists = append(rankedLists, ids384)
	}
	if errT == nil {
		idsText := make([]string, len(resultsText))
		for i, e := range resultsText {
			idsText[i] = e.ID
			if _, ok := entryMap[e.ID]; !ok {
				entryMap[e.ID] = e
			}
		}
		rankedLists = append(rankedLists, idsText)
	}
	if len(results1024) > 0 {
		ids1024 := make([]string, len(results1024))
		for i, e := range results1024 {
			ids1024[i] = e.ID
			if _, ok := entryMap[e.ID]; !ok {
				entryMap[e.ID] = e
			}
		}
		rankedLists = append(rankedLists, ids1024)
	}

	// If only one list, return it directly
	if len(rankedLists) <= 1 {
		var results []*core.MemoryEntry
		if err384 == nil {
			results = results384
		} else {
			results = resultsText
		}
		if len(results) > opts.TopK {
			results = results[:opts.TopK]
		}
		return results, nil
	}

	// Run RRF multi-list fusion
	fusedIDs := rrfFuseMultiList(rankedLists, h.k)
	if len(fusedIDs) > opts.TopK {
		fusedIDs = fusedIDs[:opts.TopK]
	}

	// Rebuild results in RRF order
	var merged []*core.MemoryEntry
	for _, id := range fusedIDs {
		if entry, ok := entryMap[id]; ok {
			merged = append(merged, entry)
		}
	}

	return merged, nil
}

// rrfFuseMultiList fuses multiple ranked lists using Reciprocal Rank Fusion.
// Returns item IDs sorted by descending RRF score.
func rrfFuseMultiList(rankedLists [][]string, k int) []string {
	scores := make(map[string]float64)
	firstSeen := make([]string, 0)
	seen := make(map[string]bool)

	for _, list := range rankedLists {
		listSeen := make(map[string]bool)
		for rank, id := range list {
			if listSeen[id] {
				continue
			}
			listSeen[id] = true
			contribution := 1.0 / float64(k+rank)
			scores[id] += contribution
			if !seen[id] {
				seen[id] = true
				firstSeen = append(firstSeen, id)
			}
		}
	}

	// Sort by RRF score descending, then first-seen order
	sort.Slice(firstSeen, func(i, j int) bool {
		si, sj := scores[firstSeen[i]], scores[firstSeen[j]]
		if si != sj {
			return si > sj
		}
		return i < j
	})

	return firstSeen
}

// VectorSearch searches by 384-dim vector similarity only.
func (h *HybridSearcher) VectorSearch(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return h.store.QueryMemoriesByVector(ctx, vector, opts)
}

// VectorSearch1024 searches by 1024-dim vector similarity only.
func (h *HybridSearcher) VectorSearch1024(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return h.store.QueryMemories1024(ctx, vector, opts)
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
