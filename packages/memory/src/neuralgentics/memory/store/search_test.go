package store

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestQueryMemoriesByVector_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.QueryMemoriesByVector(context.Background(), []float64{0.1, 0.2, 0.3}, nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("QueryMemoriesByVector nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestQueryMemoriesByVector_DefaultOptions(t *testing.T) {
	// Verify that nil opts are handled without panic — even with nil pool,
	// the nil-check should fire before we access opts fields.
	s := NewPostgresStore(nil)
	_, err := s.QueryMemoriesByVector(context.Background(), []float64{0.1}, nil)
	if err == nil {
		t.Fatal("expected error for nil pool with nil opts")
	}
}

func TestSearchMemoriesText_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.SearchMemoriesText(context.Background(), "test query", nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("SearchMemoriesText nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestSearchMemoriesText_DefaultOptions(t *testing.T) {
	// Verify that nil opts don't cause a panic before pool check.
	s := NewPostgresStore(nil)
	_, err := s.SearchMemoriesText(context.Background(), "another query", nil)
	if err == nil {
		t.Fatal("expected error for nil pool with nil opts")
	}
}

func TestGetSimilar_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSimilar(context.Background(), "mem-123", nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetSimilar nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetSimilar_DefaultOptions(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSimilar(context.Background(), "mem-456", nil)
	if err == nil {
		t.Fatal("expected error for nil pool with nil opts")
	}
}

// ─── Option defaults tests ────────────────────────────────────────────────

func TestQueryMemoriesByVector_TopKZero(t *testing.T) {
	// When TopK is 0 or negative, it should default to 10.
	// With nil pool this fires an error, but we verify it doesn't panic.
	s := NewPostgresStore(nil)
	opts := &core.SearchOptions{TopK: 0, Threshold: 0.5}
	_, err := s.QueryMemoriesByVector(context.Background(), []float64{0.1}, opts)
	if err == nil {
		t.Fatal("expected error for nil pool")
	}
}

func TestSearchMemoriesText_TopKZero(t *testing.T) {
	// TopK 0 should default to 10 without panic.
	s := NewPostgresStore(nil)
	opts := &core.SearchOptions{TopK: 0}
	_, err := s.SearchMemoriesText(context.Background(), "test", opts)
	if err == nil {
		t.Fatal("expected error for nil pool")
	}
}

func TestGetSimilar_TopKZero(t *testing.T) {
	// TopK 0 should default to 10 without panic.
	s := NewPostgresStore(nil)
	opts := &core.SearchOptions{TopK: 0}
	_, err := s.GetSimilar(context.Background(), "mem-789", opts)
	if err == nil {
		t.Fatal("expected error for nil pool")
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestQueryMemoriesByVector_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Insert a memory first (no embedding — vector search should return empty)
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "vector search integration test",
		SourceType:  "session",
		ContentHash: "vec-test-hash-001",
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}
	t.Logf("AddMemory returned ID: %s", memID)

	// Search with a small vector — should work even if no similarity match
	results, err := pgStore.QueryMemoriesByVector(ctx, []float64{0.1, 0.2, 0.3}, &core.SearchOptions{
		TopK:      5,
		Threshold: 0.0, // accept everything
	})
	if err != nil {
		t.Fatalf("QueryMemoriesByVector failed: %v", err)
	}
	t.Logf("QueryMemoriesByVector returned %d results", len(results))
}

func TestSearchMemoriesText_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectStoreWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	// Insert a memory with known text
	_, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "unique text search integration test content",
		SourceType:  "session",
		ContentHash: "text-search-test-hash-001",
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Search for it
	results, err := pgStore.SearchMemoriesText(ctx, "unique text search integration", &core.SearchOptions{TopK: 5})
	if err != nil {
		t.Fatalf("SearchMemoriesText failed: %v", err)
	}
	if len(results) == 0 {
		t.Log("SearchMemoriesText returned no results (may need GIN index)")
	}
	t.Logf("SearchMemoriesText returned %d results", len(results))
}
