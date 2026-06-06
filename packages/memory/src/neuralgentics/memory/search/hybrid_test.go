package search

import (
	"fmt"
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

// ─── Additional RRF fusion tests ────────────────────────────────────────────

func TestRRFMerge_KParameter(t *testing.T) {
	// Lower k gives higher weight to top ranks; higher k flattens scores.
	vectorResults := []*core.MemoryEntry{
		{ID: "top", Content: "top result", Score: floatPtr(0.95)},
		{ID: "mid", Content: "mid result", Score: floatPtr(0.8)},
	}

	hsK1 := &HybridSearcher{k: 1}
	mergedK1 := hsK1.rrfMerge(vectorResults, nil)
	scoresK1 := scoreMap(mergedK1)

	hsK100 := &HybridSearcher{k: 100}
	mergedK100 := hsK100.rrfMerge(vectorResults, nil)
	scoresK100 := scoreMap(mergedK100)

	// With k=1: top (rank 0) gets 1/(1+0+1)=0.5, mid (rank 1) gets 1/(1+1+1)=0.333
	// With k=100: top (rank 0) gets 1/(100+0+1)≈0.0099, mid (rank 1) gets 1/(100+1+1)≈0.0098
	// The gap between top and mid should be larger with k=1
	gapK1 := scoresK1["top"] - scoresK1["mid"]
	gapK100 := scoresK100["top"] - scoresK100["mid"]

	if gapK1 <= gapK100 {
		t.Errorf("lower k should produce larger rank gaps: gapK1=%f, gapK100=%f", gapK1, gapK100)
	}
}

func TestRRFMerge_AllIdentical(t *testing.T) {
	hs := &HybridSearcher{k: 60}

	// Same items in both lists, same order — every item gets double contribution
	items := []*core.MemoryEntry{
		{ID: "a", Content: "alpha", Score: floatPtr(0.9)},
		{ID: "b", Content: "beta", Score: floatPtr(0.8)},
	}

	merged := hs.rrfMerge(items, items)

	if len(merged) != 2 {
		t.Fatalf("expected 2 deduped results, got %d", len(merged))
	}

	scores := scoreMap(merged)
	// a at rank 0 in both: 2 * 1/(60+0+1) = 2/61
	// b at rank 1 in both: 2 * 1/(60+1+1) = 2/62
	scoreA := scores["a"]
	scoreB := scores["b"]

	expectedA := 2.0 / 61.0
	if diff := scoreA - expectedA; diff < -0.001 || diff > 0.001 {
		t.Errorf("score(a) = %f, want ~%f", scoreA, expectedA)
	}
	if scoreA <= scoreB {
		t.Errorf("rank-0 item should score higher than rank-1: a=%f, b=%f", scoreA, scoreB)
	}
}

func TestRRFMerge_LargeList(t *testing.T) {
	hs := &HybridSearcher{k: 60}

	// Create a large list of 100 items to verify O(n) performance doesn't error
	vectorResults := make([]*core.MemoryEntry, 100)
	for i := 0; i < 100; i++ {
		vectorResults[i] = &core.MemoryEntry{
			ID:      fmt.Sprintf("mem-%03d", i),
			Content: "test content",
			Score:   floatPtr(1.0 - float64(i)*0.01),
		}
	}

	merged := hs.rrfMerge(vectorResults, nil)
	if len(merged) != 100 {
		t.Errorf("expected 100 results, got %d", len(merged))
	}
	// Each item should have RRF score = 1/(60+rank+1).
	// The first item in input order is "mem-000" at rank 0 → 1/(60+0+1) = 1/61.
	scores := scoreMap(merged)
	firstID := "mem-000"
	first, ok := scores[firstID]
	if !ok {
		t.Fatalf("expected to find %q in merged results", firstID)
	}
	expected := 1.0 / 61.0
	if diff := first - expected; diff < -0.001 || diff > 0.001 {
		t.Errorf("large list rank-0 score = %f, want ~%f", first, expected)
	}
}

func TestRRFMerge_OnlyTextResults(t *testing.T) {
	hs := &HybridSearcher{k: 60}

	textResults := []*core.MemoryEntry{
		{ID: "t1", Content: "text result 1", Score: floatPtr(0.8)},
		{ID: "t2", Content: "text result 2", Score: floatPtr(0.6)},
	}

	// When vector results are nil, text results should still get scored correctly
	merged := hs.rrfMerge(nil, textResults)
	if len(merged) != 2 {
		t.Fatalf("expected 2 results, got %d", len(merged))
	}

	scores := scoreMap(merged)
	// t1 at rank 0: 1/(60+0+1) = 1/61
	// t2 at rank 1: 1/(60+1+1) = 1/62
	if scores["t1"] <= scores["t2"] {
		t.Errorf("rank-0 should score higher than rank-1: t1=%f, t2=%f", scores["t1"], scores["t2"])
	}
}

func TestRRFMerge_ScoreOverridesOriginal(t *testing.T) {
	hs := &HybridSearcher{k: 60}

	// Original scores (from vector/text search) should be replaced by RRF scores
	vectorResults := []*core.MemoryEntry{
		{ID: "v1", Content: "v content", Score: floatPtr(0.99)},
	}

	merged := hs.rrfMerge(vectorResults, nil)
	if len(merged) != 1 {
		t.Fatalf("expected 1 result, got %d", len(merged))
	}

	// RRF score should NOT be 0.99 — it should be 1/(60+0+1) ≈ 0.01639
	if merged[0].Score == nil {
		t.Fatal("expected score to be set")
	}
	rrfScore := *merged[0].Score
	if rrfScore > 0.02 {
		t.Errorf("RRF should override original score: got %f, want ~0.0164", rrfScore)
	}
}

// scoreMap extracts a map of ID → Score from merged results.
func scoreMap(entries []*core.MemoryEntry) map[string]float64 {
	m := make(map[string]float64, len(entries))
	for _, e := range entries {
		if e.Score != nil {
			m[e.ID] = *e.Score
		}
	}
	return m
}

func floatPtr(f float64) *float64 {
	return &f
}
