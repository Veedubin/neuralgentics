package memory

import (
	"context"
	"fmt"
	"testing"

	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// startTestDB starts a pgvector PostgreSQL container for integration tests.
func startTestDB(t *testing.T, ctx context.Context) (*tcpostgres.PostgresContainer, string) {
	t.Helper()

	pgContainer, err := tcpostgres.Run(ctx,
		"pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("neuralgentics"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("testpassword"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("failed to start postgres container: %v", err)
	}

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		pgContainer.Terminate(ctx)
		t.Fatalf("failed to get connection string: %v", err)
	}

	return pgContainer, connStr
}

// TestIntegration_AddAndQueryMemory tests the full add → query → verify cycle
// against a real PostgreSQL database using testcontainers-go.
func TestIntegration_AddAndQueryMemory(t *testing.T) {
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

	// Verify health
	status, err := mem.GetStatus(ctx)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if !status.Ready {
		t.Fatal("memory system not ready")
	}
	if status.Dimension != 384 {
		t.Fatalf("expected dimension 384, got %d", status.Dimension)
	}

	// Add a memory
	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "The user prefers dark mode for the code editor",
		SourceType:  "session",
		ContentHash: "abc123",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty memory ID")
	}
	t.Logf("added memory with ID: %s", id)

	// Retrieve the memory
	entry, err := mem.GetMemory(ctx, id)
	if err != nil {
		t.Fatalf("failed to get memory: %v", err)
	}
	if entry.Content != "The user prefers dark mode for the code editor" {
		t.Fatalf("expected content match, got: %s", entry.Content)
	}
	if entry.SourceType != "session" {
		t.Fatalf("expected source_type 'session', got: %s", entry.SourceType)
	}

	// Count memories
	count, err := mem.CountMemories(ctx)
	if err != nil {
		t.Fatalf("failed to count memories: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 memory, got %d", count)
	}

	// Delete the memory
	if err := mem.DeleteMemory(ctx, id); err != nil {
		t.Fatalf("failed to delete memory: %v", err)
	}

	// Verify deletion (soft delete)
	_, err = mem.GetMemory(ctx, id)
	if err == nil {
		t.Fatal("expected error getting deleted memory, got nil")
	}

	count, err = mem.CountMemories(ctx)
	if err != nil {
		t.Fatalf("failed to count after delete: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 memories after delete, got %d", count)
	}
}

// TestIntegration_FullTextSearch tests PostgreSQL full-text search.
func TestIntegration_FullTextSearch(t *testing.T) {
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

	// Add memories with different content
	memories := []core.MemoryEntry{
		{Content: "The user prefers dark mode for the code editor", SourceType: "session", ContentHash: "h1"},
		{Content: "Project uses TypeScript with strict type checking", SourceType: "session", ContentHash: "h2"},
		{Content: "The code review process requires two approvals", SourceType: "session", ContentHash: "h3"},
	}
	for _, m := range memories {
		if _, err := mem.AddMemory(ctx, m); err != nil {
			t.Fatalf("failed to add memory: %v", err)
		}
	}

	// Text-only search
	results, err := mem.QueryMemories(ctx, "dark mode editor", &core.SearchOptions{
		TopK:     5,
		Strategy: "text_only",
	})
	if err != nil {
		t.Fatalf("failed to text search: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected at least one text search result")
	}
	t.Logf("text search returned %d results", len(results))
	if results[0].Content != "The user prefers dark mode for the code editor" {
		t.Fatalf("expected 'dark mode' memory first, got: %s", results[0].Content)
	}
}

// TestIntegration_ContentExists tests content deduplication check.
func TestIntegration_ContentExists(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	defer pgContainer.Terminate(ctx)

	cfg := &core.Config{DatabaseURL: connStr}
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	defer pgStore.Close(ctx)

	// Before adding: content should not exist
	exists, err := pgStore.ContentExists(ctx, "hash123")
	if err != nil {
		t.Fatalf("content exists check failed: %v", err)
	}
	if exists {
		t.Fatal("expected content to not exist before adding")
	}

	// Add a memory with known hash
	_, err = pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "test content",
		SourceType:  "session",
		ContentHash: "hash123",
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}

	// After adding: content should exist
	exists, err = pgStore.ContentExists(ctx, "hash123")
	if err != nil {
		t.Fatalf("content exists check failed: %v", err)
	}
	if !exists {
		t.Fatal("expected content to exist after adding")
	}
	fmt.Printf("ContentExists verified: hash123 exists = %v\n", exists)
}
