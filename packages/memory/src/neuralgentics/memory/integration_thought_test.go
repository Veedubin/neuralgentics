package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// TestIntegration_StartThoughtChain creates a thought chain and verifies it
// persists and can be retrieved.
func TestIntegration_StartThoughtChain(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	// Start a thought chain
	chainID, err := mem.StartThoughtChain(ctx, "test-session-1", "")
	if err != nil {
		t.Fatalf("failed to start thought chain: %v", err)
	}
	if chainID == "" {
		t.Fatal("expected non-empty chain ID")
	}
	t.Logf("started thought chain: %s", chainID)

	// Retrieve the chain
	chain, err := mem.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("failed to get thought chain: %v", err)
	}
	if chain.ID != chainID {
		t.Fatalf("chain ID mismatch: %s vs %s", chain.ID, chainID)
	}
	if chain.Status != "active" {
		t.Fatalf("expected status 'active', got: %s", chain.Status)
	}
	if chain.SessionID != "test-session-1" {
		t.Fatalf("expected session_id 'test-session-1', got: %s", chain.SessionID)
	}

	// Verify we can start a child chain
	childChainID, err := mem.StartThoughtChain(ctx, "test-session-1", chainID)
	if err != nil {
		t.Fatalf("failed to start child thought chain: %v", err)
	}
	childChain, err := mem.GetThoughtChain(ctx, childChainID)
	if err != nil {
		t.Fatalf("failed to get child chain: %v", err)
	}
	if childChain.ParentChainID != chainID {
		t.Fatalf("expected parent chain ID %s, got: %s", chainID, childChain.ParentChainID)
	}
}

// TestIntegration_AddThought tests adding thoughts to a chain and verifying
// they are retrievable in order.
func TestIntegration_AddThought(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	chainID, err := mem.StartThoughtChain(ctx, "thought-test", "")
	if err != nil {
		t.Fatalf("failed to start chain: %v", err)
	}

	// Add multiple thoughts
	thoughts := []struct {
		text       string
		num        int
		total      int
		nextNeeded bool
	}{
		{"First thought: problem statement", 1, 3, true},
		{"Second thought: analysis", 2, 3, true},
		{"Third thought: conclusion", 3, 3, false},
	}

	for _, tData := range thoughts {
		thoughtID, err := mem.AddThought(ctx, chainID, tData.text, tData.num, tData.total, tData.nextNeeded)
		if err != nil {
			t.Fatalf("failed to add thought %d: %v", tData.num, err)
		}
		if thoughtID == "" {
			t.Fatalf("expected non-empty thought ID for thought %d", tData.num)
		}
	}

	// Retrieve chain and verify all thoughts present in order
	chain, err := mem.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("failed to get chain: %v", err)
	}
	if len(chain.Thoughts) != 3 {
		t.Fatalf("expected 3 thoughts, got %d", len(chain.Thoughts))
	}

	for i, tData := range thoughts {
		actual := chain.Thoughts[i]
		if actual.Text != tData.text {
			t.Fatalf("thought %d text mismatch: expected %q, got %q", i, tData.text, actual.Text)
		}
		if actual.ThoughtNumber != tData.num {
			t.Fatalf("thought %d number mismatch: expected %d, got %d", i, tData.num, actual.ThoughtNumber)
		}
		if actual.NextThoughtNeeded != tData.nextNeeded {
			t.Fatalf("thought %d nextNeeded mismatch", i)
		}
	}
}

// TestIntegration_ReviseThought tests revising a thought in a chain and
// verifying the revision is tracked correctly.
func TestIntegration_ReviseThought(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	chainID, err := mem.StartThoughtChain(ctx, "revise-test", "")
	if err != nil {
		t.Fatalf("failed to start chain: %v", err)
	}

	// Add original thought
	_, err = mem.AddThought(ctx, chainID, "Original thought content", 1, 1, false)
	if err != nil {
		t.Fatalf("failed to add original thought: %v", err)
	}

	// Revise it
	revision, err := mem.ReviseThought(ctx, chainID, 1, "Revised thought content")
	if err != nil {
		t.Fatalf("failed to revise thought: %v", err)
	}
	if revision == nil {
		t.Fatal("expected non-nil revision")
	}
	if !revision.IsRevision {
		t.Fatal("expected revised thought to have IsRevision=true")
	}
	if revision.RevisesThoughtID == "" {
		t.Fatal("expected revises_thought_id to be set")
	}
	if revision.ThoughtNumber != 1 {
		t.Fatalf("expected thought number 1, got %d", revision.ThoughtNumber)
	}

	// Get chain and verify both versions exist
	chain, err := mem.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("failed to get chain: %v", err)
	}
	if len(chain.Thoughts) < 1 {
		t.Fatalf("expected at least 1 thought, got %d", len(chain.Thoughts))
	}
}

// TestIntegration_BranchThought tests creating a branch from an existing
// thought and verifying the branch metadata is correct.
func TestIntegration_BranchThought(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	defer mem.Close(ctx)

	chainID, err := mem.StartThoughtChain(ctx, "branch-test", "")
	if err != nil {
		t.Fatalf("failed to start chain: %v", err)
	}

	// Add base thought
	_, err = mem.AddThought(ctx, chainID, "Base thought to branch from", 1, 3, true)
	if err != nil {
		t.Fatalf("failed to add base thought: %v", err)
	}

	// Add second thought
	_, err = mem.AddThought(ctx, chainID, "Continuing on main path", 2, 3, true)
	if err != nil {
		t.Fatalf("failed to add second thought: %v", err)
	}

	// Branch from thought 1 with an "alternative-exploration" branch
	branch, err := mem.BranchThought(ctx, chainID, 1, "alternative-exploration", "Alternative exploration path")
	if err != nil {
		t.Fatalf("failed to branch thought: %v", err)
	}
	if branch == nil {
		t.Fatal("expected non-nil branch thought")
	}
	if branch.BranchID != "alternative-exploration" {
		t.Fatalf("expected branch_id 'alternative-exploration', got: %s", branch.BranchID)
	}
	if branch.BranchFromThoughtID == "" {
		t.Fatal("expected branch_from_thought_id to be set")
	}
	if branch.ThoughtNumber != 2 {
		t.Fatalf("expected thought number 2 (original+1), got %d", branch.ThoughtNumber)
	}
}
