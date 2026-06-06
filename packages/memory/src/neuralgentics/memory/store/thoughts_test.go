package store

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestStartThoughtChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.StartThoughtChain(context.Background(), "session-1", "")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("StartThoughtChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestAddThought_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.AddThought(context.Background(), "chain-1", &core.Thought{
		ChainID:           "chain-1",
		ThoughtNumber:     1,
		TotalThoughts:     3,
		NextThoughtNeeded: true,
		Text:              "Test thought",
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("AddThought nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetThoughtChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetThoughtChain(context.Background(), "chain-1")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetThoughtChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestPauseThoughtChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.PauseThoughtChain(context.Background(), "chain-1")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("PauseThoughtChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestAbandonThoughtChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.AbandonThoughtChain(context.Background(), "chain-1")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("AbandonThoughtChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestStartThoughtChain_Success(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	chainID, err := pgStore.StartThoughtChain(ctx, "test-session", "")
	if err != nil {
		t.Fatalf("StartThoughtChain failed: %v", err)
	}
	if chainID == "" {
		t.Error("expected non-empty chain ID from StartThoughtChain")
	}
	t.Logf("StartThoughtChain returned ID: %s", chainID)
}

func TestAddThoughtAndGetChain(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Create a chain first
	chainID, err := pgStore.StartThoughtChain(ctx, "test-session-add", "")
	if err != nil {
		t.Fatalf("StartThoughtChain failed: %v", err)
	}

	// Add a thought to the chain
	_, err = pgStore.AddThought(ctx, chainID, &core.Thought{
		ChainID:           chainID,
		ThoughtNumber:     1,
		TotalThoughts:     2,
		NextThoughtNeeded: true,
		Text:              "First thought in chain",
	})
	if err != nil {
		t.Fatalf("AddThought failed: %v", err)
	}

	// Add a second thought
	_, err = pgStore.AddThought(ctx, chainID, &core.Thought{
		ChainID:           chainID,
		ThoughtNumber:     2,
		TotalThoughts:     2,
		NextThoughtNeeded: false,
		Text:              "Second thought in chain",
	})
	if err != nil {
		t.Fatalf("AddThought (2) failed: %v", err)
	}

	// Retrieve and verify the full chain
	tc, err := pgStore.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("GetThoughtChain failed: %v", err)
	}
	if tc.ID != chainID {
		t.Errorf("GetThoughtChain ID = %q, want %q", tc.ID, chainID)
	}
	if tc.Status != "active" {
		t.Errorf("GetThoughtChain Status = %q, want %q", tc.Status, "active")
	}
	if len(tc.Thoughts) != 2 {
		t.Errorf("GetThoughtChain Thoughts length = %d, want 2", len(tc.Thoughts))
	}
	if len(tc.Thoughts) >= 2 {
		if tc.Thoughts[0].Text != "First thought in chain" {
			t.Errorf("First thought text = %q, want %q", tc.Thoughts[0].Text, "First thought in chain")
		}
		if tc.Thoughts[1].Text != "Second thought in chain" {
			t.Errorf("Second thought text = %q, want %q", tc.Thoughts[1].Text, "Second thought in chain")
		}
	}
	t.Logf("GetThoughtChain returned chain with %d thoughts", len(tc.Thoughts))
}

func TestPauseResumeAbandonChain(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Create a chain
	chainID, err := pgStore.StartThoughtChain(ctx, "test-session-status", "")
	if err != nil {
		t.Fatalf("StartThoughtChain failed: %v", err)
	}

	// Pause the chain
	err = pgStore.PauseThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("PauseThoughtChain failed: %v", err)
	}

	// Verify paused state
	tc, err := pgStore.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("GetThoughtChain after pause failed: %v", err)
	}
	if tc.Status != "paused" {
		t.Errorf("Status after pause = %q, want %q", tc.Status, "paused")
	}

	// Resume the chain
	err = pgStore.ResumeThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("ResumeThoughtChain failed: %v", err)
	}

	// Verify resumed state
	tc, err = pgStore.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("GetThoughtChain after resume failed: %v", err)
	}
	if tc.Status != "active" {
		t.Errorf("Status after resume = %q, want %q", tc.Status, "active")
	}

	// Abandon the chain
	err = pgStore.AbandonThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("AbandonThoughtChain failed: %v", err)
	}

	// Verify abandoned state
	tc, err = pgStore.GetThoughtChain(ctx, chainID)
	if err != nil {
		t.Fatalf("GetThoughtChain after abandon failed: %v", err)
	}
	if tc.Status != "abandoned" {
		t.Errorf("Status after abandon = %q, want %q", tc.Status, "abandoned")
	}
	t.Logf("Pause/Resume/Abandon cycle succeeded for chain %s", chainID)
}
