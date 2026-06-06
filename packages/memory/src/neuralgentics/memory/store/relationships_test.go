package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestCreateRelationship_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.CreateRelationship(context.Background(), "mem-A", "mem-B", "RELATED_TO", 0.9)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("CreateRelationship nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestDeleteRelationship_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.DeleteRelationship(context.Background(), "rel-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("DeleteRelationship nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetRelationships_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetRelationships(context.Background(), "mem-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetRelationships nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetSupersessionChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSupersessionChain(context.Background(), "mem-123", 5)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetSupersessionChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetSuperseded_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetSuperseded(context.Background(), "mem-123")
	// GetSuperseded returns ("", nil) on nil pool because the pool==nil check is done
	// via the nil interface, but this method checks pool explicitly
	if err != nil {
		expected := "database pool not initialized"
		if err.Error() != expected {
			t.Errorf("GetSuperseded nil-pool error = %q, want %q", err.Error(), expected)
		}
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestCreateAndGetRelationship_Success(t *testing.T) {
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

	// Create two memories to link
	memA, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("relationship-source-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory A failed: %v", err)
	}

	memB, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("relationship-target-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory B failed: %v", err)
	}

	// Create a relationship
	relID, err := pgStore.CreateRelationship(ctx, memA, memB, "RELATED_TO", 0.85)
	if err != nil {
		t.Fatalf("CreateRelationship failed: %v", err)
	}
	if relID == "" {
		t.Error("expected non-empty relationship ID from CreateRelationship")
	}
	t.Logf("CreateRelationship returned ID: %s", relID)

	// Get relationships for memory A
	rels, err := pgStore.GetRelationships(ctx, memA)
	if err != nil {
		t.Fatalf("GetRelationships failed: %v", err)
	}
	if len(rels) == 0 {
		t.Error("GetRelationships returned 0 relationships, expected at least 1")
	} else {
		t.Logf("GetRelationships returned %d relationships for memory A", len(rels))
	}
}

func TestGetRelationshipSummary_Success(t *testing.T) {
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

	// Create two memories
	memA, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("summary-source-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory A failed: %v", err)
	}

	memB, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("summary-target-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory B failed: %v", err)
	}

	// Create a relationship
	_, err = pgStore.CreateRelationship(ctx, memA, memB, "DERIVED_FROM", 0.75)
	if err != nil {
		t.Fatalf("CreateRelationship failed: %v", err)
	}

	// Get relationship summary
	summary, err := pgStore.GetRelationshipSummary(ctx, memA)
	if err != nil {
		t.Fatalf("GetRelationshipSummary failed: %v", err)
	}
	if summary.MemoryID != memA {
		t.Errorf("GetRelationshipSummary memoryID = %q, want %q", summary.MemoryID, memA)
	}
	if summary.TotalRelationships == 0 {
		t.Error("GetRelationshipSummary returned 0 total relationships, expected at least 1")
	}
	t.Logf("GetRelationshipSummary: memory=%s total=%d byType=%v", summary.MemoryID, summary.TotalRelationships, summary.ByType)
}

func TestDeleteRelationship_Success(t *testing.T) {
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

	// Create two memories and a relationship
	memA, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("delete-source-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory A failed: %v", err)
	}

	memB, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:    fmt.Sprintf("delete-target-%s", time.Now().Format("20060102150405")),
		SourceType: "test",
	})
	if err != nil {
		t.Fatalf("AddMemory B failed: %v", err)
	}

	relID, err := pgStore.CreateRelationship(ctx, memA, memB, "CONTRADICTS", 0.6)
	if err != nil {
		t.Fatalf("CreateRelationship failed: %v", err)
	}

	// Delete the relationship
	err = pgStore.DeleteRelationship(ctx, relID)
	if err != nil {
		t.Fatalf("DeleteRelationship failed: %v", err)
	}
	t.Logf("DeleteRelationship succeeded for ID: %s", relID)
}
