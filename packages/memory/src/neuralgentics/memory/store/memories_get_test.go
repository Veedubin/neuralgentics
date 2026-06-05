package store

import (
	"context"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// TestGetMemory_IncludeArchived verifies that GetMemory correctly filters
// archived memories based on the includeArchived bool flag.
//
// Regression test for coverage gap Gap #1 (store/memories.go CRUD at 5.5%).
// The reviewer's finding #3 flagged this as potentially incorrect, but on
// closer inspection the code correctly branches:
//   - includeArchived=true:  uses GetMemoryByIDIncludeArchived (WHERE id=$1)
//   - includeArchived=false: uses GetMemoryByID (WHERE id=$1 AND ($2 OR is_archived=FALSE))
func TestGetMemory_IncludeArchived(t *testing.T) {
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

	// Step 1: Add a memory and capture its ID.
	contentHash := "get-test-archived-" + time.Now().Format("20060102150405.000000000")
	id, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "Test memory for includeArchived regression test",
		SourceType:  "session",
		ContentHash: contentHash,
	})
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}
	t.Logf("inserted memory: %s", id)

	// Step 2: GetMemory with includeArchived=false should succeed (memory is active).
	entry, err := pgStore.GetMemory(ctx, id, false)
	if err != nil {
		t.Fatalf("GetMemory(id, false) on active memory failed: %v", err)
	}
	if entry == nil {
		t.Fatal("GetMemory(id, false) returned nil entry")
	}
	if entry.IsArchived {
		t.Error("expected active memory to have IsArchived=false")
	}

	// Step 3: Archive the memory via DeleteMemory (soft-delete: sets is_archived=TRUE).
	if err := pgStore.DeleteMemory(ctx, id); err != nil {
		t.Fatalf("DeleteMemory failed: %v", err)
	}

	// Step 4: GetMemory with includeArchived=false should fail (memory is archived).
	_, err = pgStore.GetMemory(ctx, id, false)
	if err == nil {
		t.Error("expected error when GetMemory(id, false) on archived memory, got nil")
	}
	t.Logf("GetMemory(id, false) on archived memory returned error (expected): %v", err)

	// Step 5: GetMemory with includeArchived=true should succeed (include archived).
	entry, err = pgStore.GetMemory(ctx, id, true)
	if err != nil {
		t.Fatalf("GetMemory(id, true) on archived memory failed: %v", err)
	}
	if entry == nil {
		t.Fatal("GetMemory(id, true) returned nil entry")
	}
	if !entry.IsArchived {
		t.Error("expected archived memory to have IsArchived=true")
	}
	if entry.Content != "Test memory for includeArchived regression test" {
		t.Errorf("unexpected content: got %q, want %q", entry.Content, "Test memory for includeArchived regression test")
	}
}
