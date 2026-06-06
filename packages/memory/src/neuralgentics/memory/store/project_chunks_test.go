package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestAddProjectChunk_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.AddProjectChunk(context.Background(), &core.ChunkResult{
		FilePath:  "test.go",
		Content:   "package main",
		StartLine: 1,
		EndLine:   5,
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("AddProjectChunk nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestDeleteChunksByPath_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.DeleteChunksByPath(context.Background(), "test.go")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("DeleteChunksByPath nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestSearchChunks_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.SearchChunks(context.Background(), []float64{0.1, 0.2}, nil)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("SearchChunks nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestAddProjectChunk_Success(t *testing.T) {
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

	filePath := fmt.Sprintf("test_project_%s/main.go", time.Now().Format("20060102150405.000000000"))

	chunkID, err := pgStore.AddProjectChunk(ctx, &core.ChunkResult{
		FilePath:  filePath,
		Content:   "package main\n\nfunc main() {}",
		StartLine: 1,
		EndLine:   3,
	})
	if err != nil {
		t.Fatalf("AddProjectChunk failed: %v", err)
	}
	if chunkID == "" {
		t.Error("expected non-empty chunk ID from AddProjectChunk")
	}
	t.Logf("AddProjectChunk returned ID: %s", chunkID)

	// Clean up the chunk so the test is idempotent
	_ = pgStore.DeleteChunksByPath(ctx, filePath)
}

func TestDeleteChunksByPath_Success(t *testing.T) {
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

	filePath := fmt.Sprintf("test_project_%s/util.go", time.Now().Format("20060102150405.000000000"))

	// Add a chunk first
	_, err := pgStore.AddProjectChunk(ctx, &core.ChunkResult{
		FilePath:  filePath,
		Content:   "package util\n\nfunc Helper() {}",
		StartLine: 1,
		EndLine:   3,
	})
	if err != nil {
		t.Fatalf("AddProjectChunk failed: %v", err)
	}

	// Delete all chunks for that path
	err = pgStore.DeleteChunksByPath(ctx, filePath)
	if err != nil {
		t.Fatalf("DeleteChunksByPath failed: %v", err)
	}
	t.Logf("DeleteChunksByPath succeeded for path: %s", filePath)

	// Verify GetFileChunksByPath returns error after deletion
	_, err = pgStore.GetFileChunksByPath(ctx, filePath)
	if err == nil {
		t.Error("expected error from GetFileChunksByPath after deletion, got nil")
	}
}
