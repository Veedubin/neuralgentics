package search

import (
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockStore is a lightweight mock for store.PostgresStore used in hybrid search tests.
// Since the search package depends on the concrete PostgresStore (not the interface),
// these tests focus on the pure logic: RRF merge algorithm.

func TestRRFConstant(t *testing.T) {
	if DefaultRRFConstant != 60 {
		t.Errorf("DefaultRRFConstant = %d, want 60", DefaultRRFConstant)
	}
}

func TestHybridSearcherDefaults(t *testing.T) {
	// Verify the defaults are set correctly
	hs := &HybridSearcher{
		store: nil,
		k:     DefaultRRFConstant,
	}
	if hs.k != 60 {
		t.Errorf("HybridSearcher.k = %d, want 60", hs.k)
	}
}

func TestRRFMergeLogic(t *testing.T) {
	hs := &HybridSearcher{k: DefaultRRFConstant}

	// Create vector results (rank 0, 1, 2)
	vectorResults := []*core.MemoryEntry{
		{ID: "mem1", Content: "dark mode preference", Score: floatPtr(0.95)},
		{ID: "mem2", Content: "typescript strict mode", Score: floatPtr(0.85)},
		{ID: "mem3", Content: "code review rules", Score: floatPtr(0.75)},
	}

	// Create text results (rank 0, 1, 2) where mem2 and mem3 overlap
	textResults := []*core.MemoryEntry{
		{ID: "mem2", Content: "typescript strict mode", Score: floatPtr(0.9)},
		{ID: "mem3", Content: "code review rules", Score: floatPtr(0.8)},
		{ID: "mem4", Content: "project structure", Score: floatPtr(0.7)},
	}

	merged := hs.rrfMerge(vectorResults, textResults)

	if len(merged) != 4 {
		t.Fatalf("rrfMerge returned %d results, want 4", len(merged))
	}

	// Build a map of ID → RRF score
	scores := make(map[string]float64)
	for _, entry := range merged {
		if entry.Score != nil {
			scores[entry.ID] = *entry.Score
		}
	}

	// mem1: only in vector results (rank 0)
	// RRF score = 1/(60+0+1) = 1/61 ≈ 0.01639
	mem1Score := scores["mem1"]
	if mem1Score < 0.016 || mem1Score > 0.017 {
		t.Errorf("mem1 RRF score = %f, want ~0.0164", mem1Score)
	}

	// mem2: in vector (rank 1) + text (rank 0)
	// RRF score = 1/(60+1+1) + 1/(60+0+1) = 1/62 + 1/61 ≈ 0.01613 + 0.01639 ≈ 0.03252
	mem2Score := scores["mem2"]
	if mem2Score < 0.032 || mem2Score > 0.034 {
		t.Errorf("mem2 RRF score = %f, want ~0.0325", mem2Score)
	}

	// mem4: only in text results (rank 2)
	// RRF score = 1/(60+2+1) = 1/63 ≈ 0.01587
	mem4Score := scores["mem4"]
	if mem4Score < 0.015 || mem4Score > 0.017 {
		t.Errorf("mem4 RRF score = %f, want ~0.0159", mem4Score)
	}

	// mem2 should score highest (appears in both lists)
	// mem1 and mem3 should be next (each appears once but at high ranks)
	// mem4 should be lowest (appears once at low rank)
	if mem2Score <= mem1Score || mem2Score <= mem4Score {
		t.Error("mem2 (appears in both) should have highest RRF score")
	}
}

func TestRRFMergeEmptyResults(t *testing.T) {
	hs := &HybridSearcher{k: DefaultRRFConstant}

	// Both empty
	merged := hs.rrfMerge(nil, nil)
	if len(merged) != 0 {
		t.Errorf("rrfMerge(nil, nil) = %d results, want 0", len(merged))
	}

	// Vector empty, text has results
	textResults := []*core.MemoryEntry{
		{ID: "mem1", Content: "test", Score: floatPtr(0.9)},
	}
	merged = hs.rrfMerge(nil, textResults)
	if len(merged) != 1 {
		t.Errorf("rrfMerge(nil, textResults) = %d results, want 1", len(merged))
	}

	// Text empty, vector has results
	vectorResults := []*core.MemoryEntry{
		{ID: "mem2", Content: "test 2", Score: floatPtr(0.8)},
	}
	merged = hs.rrfMerge(vectorResults, nil)
	if len(merged) != 1 {
		t.Errorf("rrfMerge(vectorResults, nil) = %d results, want 1", len(merged))
	}
}

func TestRRFMergeDeduplication(t *testing.T) {
	hs := &HybridSearcher{k: DefaultRRFConstant}

	// Same memory in both lists
	vectorResults := []*core.MemoryEntry{
		{ID: "shared", Content: "shared memory", Score: floatPtr(0.95)},
	}
	textResults := []*core.MemoryEntry{
		{ID: "shared", Content: "shared memory", Score: floatPtr(0.9)},
	}

	merged := hs.rrfMerge(vectorResults, textResults)

	// Should deduplicate: 1 unique ID, not 2
	if len(merged) != 1 {
		t.Errorf("rrfMerge with duplicates returned %d results, want 1", len(merged))
	}

	// The shared memory should have a combined RRF score
	if merged[0].Score == nil {
		t.Error("merged result should have a score")
	}

	// Combined: 1/(60+0+1) + 1/(60+0+1) = 2/61 ≈ 0.03279
	expectedScore := 2.0 / 61.0
	diff := *merged[0].Score - expectedScore
	if diff < -0.001 || diff > 0.001 {
		t.Errorf("shared memory RRF score = %f, want ~%f", *merged[0].Score, expectedScore)
	}
}

func floatPtr(f float64) *float64 {
	return &f
}
