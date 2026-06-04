package search

import (
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

func TestRRFFuseMultiList_BasicFusion(t *testing.T) {
	// Two ranked lists with shared items: "a" and "b" appear in both,
	// so they should get higher fused scores than single-list items.
	listA := []string{"a", "b", "c"}
	listB := []string{"b", "a", "d"}

	result := rrfFuseMultiList([][]string{listA, listB}, 60)

	// "b" and "a" appear in both lists at rank 0 or 1, so they score highest.
	// "c" and "d" appear in only one list, so lower.
	if len(result) != 4 {
		t.Fatalf("expected 4 fused results, got %d", len(result))
	}

	// Top 2 should be "a" or "b" (exact order depends on ranks)
	topSet := map[string]bool{result[0]: true, result[1]: true}
	if !topSet["a"] || !topSet["b"] {
		t.Errorf("expected top 2 to be {a, b}, got %v", result[:2])
	}
}

func TestRRFFuseMultiList_SingleList(t *testing.T) {
	list := []string{"x", "y", "z"}
	result := rrfFuseMultiList([][]string{list}, 60)

	if len(result) != 3 {
		t.Fatalf("expected 3 results, got %d", len(result))
	}
	if result[0] != "x" || result[1] != "y" || result[2] != "z" {
		t.Errorf("expected [x y z], got %v", result)
	}
}

func TestRRFFuseMultiList_Empty(t *testing.T) {
	result := rrfFuseMultiList(nil, 60)
	if len(result) != 0 {
		t.Errorf("expected 0 results for nil input, got %d", len(result))
	}

	result = rrfFuseMultiList([][]string{}, 60)
	if len(result) != 0 {
		t.Errorf("expected 0 results for empty input, got %d", len(result))
	}
}

func TestRRFFuseMultiList_DedupWithinList(t *testing.T) {
	// Duplicates within a single list should be counted only at first occurrence
	list := []string{"a", "b", "a", "c"}
	result := rrfFuseMultiList([][]string{list}, 60)

	if len(result) != 3 {
		t.Fatalf("expected 3 dedup'd results, got %d", len(result))
	}
}

func TestRRFFuseMultiList_StableSort(t *testing.T) {
	// Two non-overlapping lists: RRF scores are equal for items at different
	// ranks in different lists, but first-seen order should break ties.
	listA := []string{"x"}
	listB := []string{"y"}

	result := rrfFuseMultiList([][]string{listA, listB}, 60)
	if len(result) != 2 {
		t.Fatalf("expected 2 results, got %d", len(result))
	}
	// "x" was seen first (in listA), so it should come first
	if result[0] != "x" || result[1] != "y" {
		t.Errorf("expected [x y], got %v", result)
	}
}

func TestRRFFuseMultiList_ThreeLists(t *testing.T) {
	listA := []string{"a", "b"}
	listB := []string{"b", "c"}
	listC := []string{"c", "a"}

	result := rrfFuseMultiList([][]string{listA, listB, listC}, 60)
	if len(result) != 3 {
		t.Fatalf("expected 3 results, got %d", len(result))
	}
	// All three items appear in at least 2 lists; exact order is deterministic
}

func TestHybridSearcher_AutoModeConfig(t *testing.T) {
	// Verify that NewHybridSearcherWithConfig accepts all three embedding modes
	tests := []struct {
		name string
		mode core.EmbeddingMode
	}{
		{"cpu", core.EmbeddingModeCPU},
		{"auto", core.EmbeddingModeAuto},
		{"gpu", core.EmbeddingModeGPU},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewHybridSearcherWithConfig(nil, nil, tt.mode, 60)
			if s == nil {
				t.Error("expected non-nil searcher")
			}
			if s.embeddingMode != tt.mode {
				t.Errorf("expected mode %s, got %s", tt.mode, s.embeddingMode)
			}
		})
	}
}

func TestHybridSearcher_DefaultK(t *testing.T) {
	s := NewHybridSearcherWithConfig(nil, nil, core.EmbeddingModeCPU, 0)
	if s.k != DefaultRRFConstant {
		t.Errorf("expected default RRF k=%d, got %d", DefaultRRFConstant, s.k)
	}
}
