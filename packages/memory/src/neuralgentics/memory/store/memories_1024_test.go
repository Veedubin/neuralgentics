package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestAddMemory1024_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.AddMemory1024(context.Background(), "test-id", []float64{0.1, 0.2})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("AddMemory1024 nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestQueryMemories1024_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.QueryMemories1024(context.Background(), []float64{0.1}, nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("QueryMemories1024 nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetMemory1024_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetMemory1024(context.Background(), "test-id")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetMemory1024 nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestCountMemories1024_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.CountMemories1024(context.Background())
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("CountMemories1024 nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestDeleteMemory1024_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.DeleteMemory1024(context.Background(), "test-id")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("DeleteMemory1024 nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestAddMemory1024_Success(t *testing.T) {
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

	// First, add a parent memory so we have a valid memoryID
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "test memory for 1024-dim ops",
		SourceType:  "session",
		ContentHash: fmt.Sprintf("add-1024-test-%s", time.Now().Format("20060102150405.000000000")),
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}
	t.Logf("inserted parent memory: %s", memID)

	// Add a 1024-dim vector for the parent memory
	vector := make([]float64, 1024)
	for i := range vector {
		vector[i] = float64(i) * 0.001
	}

	returnedID, err := pgStore.AddMemory1024(ctx, memID, vector)
	if err != nil {
		t.Fatalf("AddMemory1024 failed: %v", err)
	}
	t.Logf("AddMemory1024 returned ID: %s", returnedID)

	if returnedID == "" {
		t.Error("expected non-empty returned ID from AddMemory1024")
	}
}

func TestAddMemory1024_MissingMemory(t *testing.T) {
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

	// Try adding 1024 entry for a non-existent memoryID
	vector := make([]float64, 1024)
	_, err := pgStore.AddMemory1024(ctx, "nonexistent-memory-id-12345", vector)
	if err == nil {
		t.Error("expected error when adding 1024 entry for nonexistent memory, got nil")
	}
	t.Logf("AddMemory1024 for missing parent returned expected error: %v", err)
}

func TestQueryMemories1024_VectorSearch(t *testing.T) {
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

	// Add a parent memory + 1024 vector
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "test memory for 1024 query",
		SourceType:  "session",
		ContentHash: fmt.Sprintf("query-1024-test-%s", time.Now().Format("20060102150405.000000000")),
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	vector := make([]float64, 1024)
	for i := range vector {
		vector[i] = float64(i) * 0.001
	}

	_, err = pgStore.AddMemory1024(ctx, memID, vector)
	if err != nil {
		t.Fatalf("AddMemory1024 failed: %v", err)
	}

	// Query with the same vector — should find the memory
	results, err := pgStore.QueryMemories1024(ctx, vector, &core.SearchOptions{TopK: 10, Threshold: 0.01})
	if err != nil {
		t.Fatalf("QueryMemories1024 failed: %v", err)
	}
	t.Logf("QueryMemories1024 returned %d results", len(results))

	// With a very low threshold, we should find at least the memory we just added
	if len(results) == 0 {
		t.Error("expected at least 1 result from QueryMemories1024, got 0")
	}
}

func TestCountMemories1024_Empty(t *testing.T) {
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

	// Count should return >= 0 even on an empty/initial DB
	count, err := pgStore.CountMemories1024(ctx)
	if err != nil {
		t.Fatalf("CountMemories1024 failed: %v", err)
	}
	t.Logf("CountMemories1024: %d", count)
	if count < 0 {
		t.Errorf("expected count >= 0, got %d", count)
	}
}

func TestDeleteMemory1024_Success(t *testing.T) {
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

	// Add parent memory + 1024 entry
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "test memory for 1024 delete",
		SourceType:  "session",
		ContentHash: fmt.Sprintf("del-1024-test-%s", time.Now().Format("20060102150405.000000000")),
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	vector := make([]float64, 1024)
	for i := range vector {
		vector[i] = float64(i) * 0.001
	}

	_, err = pgStore.AddMemory1024(ctx, memID, vector)
	if err != nil {
		t.Fatalf("AddMemory1024 failed: %v", err)
	}

	// Verify count increased
	beforeCount, err := pgStore.CountMemories1024(ctx)
	if err != nil {
		t.Fatalf("CountMemories1024 before delete failed: %v", err)
	}

	// Delete the 1024 entry
	err = pgStore.DeleteMemory1024(ctx, memID)
	if err != nil {
		t.Fatalf("DeleteMemory1024 failed: %v", err)
	}

	// Verify count decreased
	afterCount, err := pgStore.CountMemories1024(ctx)
	if err != nil {
		t.Fatalf("CountMemories1024 after delete failed: %v", err)
	}
	if afterCount >= beforeCount {
		t.Errorf("expected count to decrease after delete (before=%d, after=%d)", beforeCount, afterCount)
	}

	// Deleting a nonexistent ID should be idempotent (no error)
	err = pgStore.DeleteMemory1024(ctx, "nonexistent-id-for-delete-test")
	if err != nil {
		t.Errorf("DeleteMemory1024 on nonexistent ID should be idempotent, got error: %v", err)
	}
}

func TestGetMemory1024_Success(t *testing.T) {
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

	// Add parent memory + 1024 entry
	memID, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "test memory for 1024 get",
		SourceType:  "session",
		ContentHash: fmt.Sprintf("get-1024-test-%s", time.Now().Format("20060102150405.000000000")),
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	vector := make([]float64, 1024)
	for i := range vector {
		vector[i] = float64(i) * 0.001
	}

	_, err = pgStore.AddMemory1024(ctx, memID, vector)
	if err != nil {
		t.Fatalf("AddMemory1024 failed: %v", err)
	}

	// Get the memory via 1024 endpoint
	entry, err := pgStore.GetMemory1024(ctx, memID)
	if err != nil {
		t.Fatalf("GetMemory1024 failed: %v", err)
	}
	if entry == nil {
		t.Fatal("GetMemory1024 returned nil entry")
	}
	if entry.ID != memID {
		t.Errorf("GetMemory1024 returned ID %q, want %q", entry.ID, memID)
	}
	t.Logf("GetMemory1024 returned entry with ID: %s", entry.ID)
}
