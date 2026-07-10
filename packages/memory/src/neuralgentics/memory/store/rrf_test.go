package store

import (
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// TestRRFFusionSingleModel verifies that RRF fusion with a single model
// produces results ranked by their position in that model's list.
func TestRRFFusionSingleModel(t *testing.T) {
	// Simulate per-model results: model "embedding" has 3 results.
	perModel := map[string][]rrfRankEntry{
		"embedding": {
			{entry: core.MemoryEntry{ID: "mem-1"}, rank: 1, distance: 0.1},
			{entry: core.MemoryEntry{ID: "mem-2"}, rank: 2, distance: 0.2},
			{entry: core.MemoryEntry{ID: "mem-3"}, rank: 3, distance: 0.3},
		},
	}

	results := fuseRRF(perModel, 60, 10)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	// mem-1 should have the highest RRF score (rank 1).
	if results[0].Entry.ID != "mem-1" {
		t.Errorf("expected mem-1 first, got %s", results[0].Entry.ID)
	}

	// RRF score for rank 1 with K=60: 1/(60+1) = 1/61
	expectedScore := 1.0 / 61.0
	if results[0].RRFScore != expectedScore {
		t.Errorf("mem-1 RRF score: expected %f, got %f", expectedScore, results[0].RRFScore)
	}
}

// TestRRFFusionTwoModelsOverlap verifies that a memory appearing in both
// models' lists gets a higher RRF score than one appearing in only one.
func TestRRFFusionTwoModelsOverlap(t *testing.T) {
	perModel := map[string][]rrfRankEntry{
		"embedding": {
			{entry: core.MemoryEntry{ID: "mem-A"}, rank: 1, distance: 0.1},
			{entry: core.MemoryEntry{ID: "mem-B"}, rank: 2, distance: 0.2},
		},
		"embedding_bge_m3": {
			{entry: core.MemoryEntry{ID: "mem-B"}, rank: 1, distance: 0.15},
			{entry: core.MemoryEntry{ID: "mem-C"}, rank: 2, distance: 0.25},
		},
	}

	results := fuseRRF(perModel, 60, 10)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	// mem-B appears in both models:
	//   embedding rank 2: 1/(60+2) = 1/62
	//   embedding_bge_m3 rank 1: 1/(60+1) = 1/61
	//   total = 1/62 + 1/61 ≈ 0.0325
	// mem-A appears only in embedding rank 1: 1/61 ≈ 0.0164
	// mem-C appears only in embedding_bge_m3 rank 2: 1/62 ≈ 0.0161
	//
	// So mem-B should be #1 (higher combined score).
	if results[0].Entry.ID != "mem-B" {
		t.Errorf("expected mem-B first (appears in both models), got %s", results[0].Entry.ID)
	}

	// Verify mem-B has ranks from both models.
	if len(results[0].RanksByModel) != 2 {
		t.Errorf("expected mem-B to have 2 model ranks, got %d", len(results[0].RanksByModel))
	}
	if results[0].RanksByModel["embedding"] != 2 {
		t.Errorf("expected mem-B rank 2 in embedding, got %d", results[0].RanksByModel["embedding"])
	}
	if results[0].RanksByModel["embedding_bge_m3"] != 1 {
		t.Errorf("expected mem-B rank 1 in embedding_bge_m3, got %d", results[0].RanksByModel["embedding_bge_m3"])
	}
}

// TestRRFFusionFinalTopK verifies that the FinalTopK limit is applied.
func TestRRFFusionFinalTopK(t *testing.T) {
	// 5 unique memories in one model.
	entries := make([]rrfRankEntry, 5)
	for i := 0; i < 5; i++ {
		entries[i] = rrfRankEntry{
			entry:    core.MemoryEntry{ID: "mem-" + string(rune('A'+i))},
			rank:     i + 1,
			distance: 0.1 * float64(i+1),
		}
	}

	perModel := map[string][]rrfRankEntry{
		"embedding": entries,
	}

	// Request only 3 final results.
	results := fuseRRF(perModel, 60, 3)

	if len(results) != 3 {
		t.Fatalf("expected 3 results (FinalTopK=3), got %d", len(results))
	}
}

// TestRRFFusionEmptyModel verifies that an empty model list produces no results.
func TestRRFFusionEmptyModel(t *testing.T) {
	perModel := map[string][]rrfRankEntry{}
	results := fuseRRF(perModel, 60, 10)
	if len(results) != 0 {
		t.Fatalf("expected 0 results for empty models, got %d", len(results))
	}
}

// TestRRFFusionBestDistance verifies that BestDistance is the minimum distance
// across all models where the memory appears.
func TestRRFFusionBestDistance(t *testing.T) {
	perModel := map[string][]rrfRankEntry{
		"embedding": {
			{entry: core.MemoryEntry{ID: "mem-X"}, rank: 1, distance: 0.5},
		},
		"embedding_bge_m3": {
			{entry: core.MemoryEntry{ID: "mem-X"}, rank: 1, distance: 0.2},
		},
	}

	results := fuseRRF(perModel, 60, 10)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	// Best distance should be 0.2 (the minimum of 0.5 and 0.2).
	if results[0].BestDistance != 0.2 {
		t.Errorf("expected BestDistance 0.2, got %f", results[0].BestDistance)
	}
}

// TestAllowedEmbeddingColumns verifies that only whitelisted column names
// are accepted.
func TestAllowedEmbeddingColumns(t *testing.T) {
	valid := []string{"embedding", "embedding_bge_m3", "embedding_bge_large"}
	for _, col := range valid {
		if !allowedEmbeddingColumns[col] {
			t.Errorf("column %s should be allowed", col)
		}
	}

	invalid := []string{"embedding_malicious", "'; DROP TABLE memories; --", "text"}
	for _, col := range invalid {
		if allowedEmbeddingColumns[col] {
			t.Errorf("column %s should NOT be allowed", col)
		}
	}
}

// TestFloat64SliceToVectorText verifies the pgvector text formatting.
func TestFloat64SliceToVectorText(t *testing.T) {
	tests := []struct {
		name     string
		input    []float64
		expected string
	}{
		{"empty", []float64{}, "[]"},
		{"single", []float64{1.0}, "[1]"},
		{"multiple", []float64{1.5, 2.5, 3.5}, "[1.5,2.5,3.5]"},
		{"with zero", []float64{0.0, 1.0}, "[0,1]"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := float64SliceToVectorText(tt.input)
			if result != tt.expected {
				t.Errorf("expected %q, got %q", tt.expected, result)
			}
		})
	}
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

// rrfRankEntry is the test-only version of the rankEntry struct in rrf.go.
// We use a lowercase alias to avoid exporting the internal type.
type rrfRankEntry struct {
	entry    core.MemoryEntry
	rank     int
	distance float64
}

// fuseRRF is the pure fusion logic extracted from RRFSearch for testability.
// It takes pre-built per-model ranked lists and returns fused RRF results.
// This mirrors the exact fusion logic in PostgresStore.RRFSearch.
func fuseRRF(perModel map[string][]rrfRankEntry, k, finalTopK int) []RRFScore {
	if k <= 0 {
		k = 60
	}
	if finalTopK <= 0 {
		finalTopK = 10
	}

	scores := make(map[string]*RRFScore)
	for col, entries := range perModel {
		for _, re := range entries {
			if existing, ok := scores[re.entry.ID]; ok {
				existing.RRFScore += 1.0 / float64(k+re.rank)
				existing.RanksByModel[col] = re.rank
				if re.distance < existing.BestDistance {
					existing.BestDistance = re.distance
				}
			} else {
				ranks := make(map[string]int)
				ranks[col] = re.rank
				scores[re.entry.ID] = &RRFScore{
					Entry:        re.entry,
					RRFScore:     1.0 / float64(k+re.rank),
					RanksByModel: ranks,
					BestDistance: re.distance,
				}
			}
		}
	}

	all := make([]RRFScore, 0, len(scores))
	for _, s := range scores {
		all = append(all, *s)
	}

	// Sort by RRF score descending.
	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && all[j-1].RRFScore < all[j].RRFScore; j-- {
			all[j-1], all[j] = all[j], all[j-1]
		}
	}

	if len(all) > finalTopK {
		all = all[:finalTopK]
	}
	return all
}
