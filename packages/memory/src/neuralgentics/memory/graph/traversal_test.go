package graph

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

func TestGetSupersessionChain(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// Add memories for chain: mem3 -> mem2 -> mem1 (mem3 supersedes mem2, mem2 supersedes mem1)
	store.memories["mem1"] = &core.MemoryEntry{ID: "mem1", Content: "original"}
	store.memories["mem2"] = &core.MemoryEntry{ID: "mem2", Content: "updated"}
	store.memories["mem3"] = &core.MemoryEntry{ID: "mem3", Content: "latest"}

	// Create SUPERSEDES relationships
	store.CreateRelationship(ctx, "mem2", "mem1", "SUPERSEDES", 1.0)
	store.CreateRelationship(ctx, "mem3", "mem2", "SUPERSEDES", 1.0)

	chain, err := traversal.GetSupersessionChain(ctx, "mem3", 10)
	if err != nil {
		t.Fatalf("GetSupersessionChain returned error: %v", err)
	}

	if len(chain) != 2 {
		t.Fatalf("expected 2 memories in chain, got %d", len(chain))
	}

	// The chain should include mem2 and mem1 (superseded by mem3)
	ids := make(map[string]bool)
	for _, m := range chain {
		ids[m.ID] = true
	}
	if !ids["mem2"] {
		t.Error("expected mem2 in chain")
	}
	if !ids["mem1"] {
		t.Error("expected mem1 in chain")
	}
}

func TestGetSupersessionChain_DefaultDepth(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// Empty chain should return nil
	chain, err := traversal.GetSupersessionChain(ctx, "nonexistent", 0)
	if err != nil {
		t.Fatalf("GetSupersessionChain returned error: %v", err)
	}

	// Should return nil (no chain found)
	if chain != nil {
		t.Errorf("expected nil chain for nonexistent memory, got %v", chain)
	}
}

func TestGetSuperseded(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// Create SUPERSEDES relationship
	store.CreateRelationship(ctx, "mem2", "mem1", "SUPERSEDES", 1.0)

	supersededID, err := traversal.GetSuperseded(ctx, "mem2")
	if err != nil {
		t.Fatalf("GetSuperseded returned error: %v", err)
	}

	if supersededID != "mem1" {
		t.Errorf("expected superseded ID mem1, got %s", supersededID)
	}
}

func TestGetSuperseded_NotFound(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	supersededID, err := traversal.GetSuperseded(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("GetSuperseded returned error: %v", err)
	}

	if supersededID != "" {
		t.Errorf("expected empty string for nonexistent memory, got %s", supersededID)
	}
}

func TestFindInferencePaths(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// Build a path: mem1 -> mem2 -> mem3
	//   mem1 RELATED_TO mem2
	//   mem2 RELATED_TO mem3
	store.CreateRelationship(ctx, "mem1", "mem2", "RELATED_TO", 0.9)
	store.CreateRelationship(ctx, "mem2", "mem3", "RELATED_TO", 0.8)

	path, err := traversal.FindInferencePaths(ctx, "mem1", "mem3", 5)
	if err != nil {
		t.Fatalf("FindInferencePaths returned error: %v", err)
	}

	if len(path) != 2 {
		t.Fatalf("expected path with 2 relationships, got %d", len(path))
	}

	// First edge: mem1 -> mem2
	if path[0].SourceID != "mem1" || path[0].TargetID != "mem2" {
		t.Errorf("first edge: expected mem1->mem2, got %s->%s", path[0].SourceID, path[0].TargetID)
	}

	// Second edge: mem2 -> mem3
	if path[1].SourceID != "mem2" || path[1].TargetID != "mem3" {
		t.Errorf("second edge: expected mem2->mem3, got %s->%s", path[1].SourceID, path[1].TargetID)
	}
}

func TestFindInferencePaths_NoPath(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// Create isolated memories with no connecting relationship
	store.CreateRelationship(ctx, "mem1", "mem2", "RELATED_TO", 0.9)
	store.CreateRelationship(ctx, "mem3", "mem4", "RELATED_TO", 0.8)

	path, err := traversal.FindInferencePaths(ctx, "mem1", "mem4", 5)
	if err != nil {
		t.Fatalf("FindInferencePaths returned error: %v", err)
	}

	if path != nil {
		t.Errorf("expected nil path for disconnected nodes, got %v", path)
	}
}

func TestFindInferencePaths_DefaultDepth(t *testing.T) {
	store := newMockStore()
	traversal := NewTraversal(store)
	ctx := context.Background()

	// maxDepth=0 should default to 5
	path, err := traversal.FindInferencePaths(ctx, "mem1", "mem2", 0)
	if err != nil {
		t.Fatalf("FindInferencePaths returned error: %v", err)
	}
	// No path exists, should return nil
	if path != nil {
		t.Errorf("expected nil path with no data, got %v", path)
	}
}
