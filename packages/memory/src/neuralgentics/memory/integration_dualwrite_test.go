package memory

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // pgx driver for database/sql

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/embed"
	"neuralgentics/src/neuralgentics/memory/search"
	"neuralgentics/src/neuralgentics/memory/store"
)

const podPingTimeout = 5 * time.Second

// sharedTestDBURL is the connection string for the shared test database.
const sharedTestDBURL = "postgresql://postgres:testpassword@localhost:6000/neuralgentics_test?sslmode=require"

// connectSharedDB attempts to connect to the shared test database on port 6000.
// Returns nil if the shared DB is unavailable.
func connectSharedDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", sharedTestDBURL)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), podPingTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil
	}
	return db
}

// connectWithFallback tries the shared DB first; if unavailable, spins up a
// testcontainers pgvector container. Returns a cleanup function.
func connectWithFallback(t *testing.T) (connStr string, cleanup func()) {
	t.Helper()

	// Try shared DB first
	db := connectSharedDB(t)
	if db != nil {
		// Verify the memories_1024 table exists (schema must be migrated)
		ctx := context.Background()
		var tableName string
		err := db.QueryRowContext(ctx, `
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'memories_1024'
		`).Scan(&tableName)
		db.Close()

		if err == nil && tableName == "memories_1024" {
			t.Log("using shared test database on port 6000")
			return sharedTestDBURL, func() {}
		}

		// Shared DB exists but missing schema — use testcontainers
		t.Log("shared DB reachable but missing memories_1024 table; falling back to testcontainers")
	}

	// Fall back to testcontainers
	ctx := context.Background()
	pgContainer, connStr := startTestDB(t, ctx)
	return connStr, func() { pgContainer.Terminate(ctx) }
}

// TestIntegration_DualWrite verifies that AddMemory in auto embedding mode
// writes a row to both the memories (384-dim) and memories_1024 tables,
// that the FK reference is correct, and that both rows are retrievable.
func TestIntegration_DualWrite(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectWithFallback(t)
	t.Cleanup(cleanup)

	// Create a MemorySystem in auto mode with NoOp embedder.
	// The NoOp embedder returns zero vectors of dim 384 for Embed() and
	// dim 1024 for Embed1024(). In auto mode, AddMemory will call both
	// and write to both tables.
	cfg := &core.Config{
		DatabaseURL:   connStr,
		EmbeddingAddr: "noop",
		EmbeddingMode: core.EmbeddingModeAuto,
	}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	t.Cleanup(func() { mem.Close(ctx) })

	// Verify system is ready
	status, err := mem.GetStatus(ctx)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if !status.Ready {
		t.Fatal("memory system not ready")
	}

	// Use a unique content hash to avoid collisions in shared DB
	contentHash := fmt.Sprintf("dualwrite-test-%d", time.Now().UnixNano())

	// Add a memory via MemorySystem (triggers dual-write in auto+noop mode)
	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "test dual-write from Go integration test",
		SourceType:  "session",
		ContentHash: contentHash,
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty memory ID")
	}
	t.Logf("added memory with ID: %s", id)

	// Cleanup: delete the memory (CASCADE will delete row in memories_1024)
	t.Cleanup(func() {
		if err := mem.DeleteMemory(ctx, id); err != nil {
			t.Logf("warning: failed to cleanup memory %s: %v", id, err)
		}
	})

	// ── Verify 384-dim row in memories table ─────────────────────────────
	entry, err := mem.GetMemory(ctx, id)
	if err != nil {
		t.Fatalf("failed to get memory from 384 table: %v", err)
	}
	if entry.Content != "test dual-write from Go integration test" {
		t.Fatalf("expected content match, got: %s", entry.Content)
	}
	t.Logf("384-dim row verified: id=%s content=%q", entry.ID, entry.Content)

	// ── Verify 1024-dim row in memories_1024 table ──────────────────────
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store for 1024 verification: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	entry1024, err := pgStore.GetMemory1024(ctx, id)
	if err != nil {
		t.Fatalf("failed to get 1024-dim entry: %v", err)
	}
	if entry1024.ID != id {
		t.Fatalf("expected 1024 entry memory_id %s, got %s", id, entry1024.ID)
	}
	t.Logf("1024-dim row verified: memory_id=%s", entry1024.ID)

	// ── Verify 1024 sidecar count ───────────────────────────────────────
	count1024, err := pgStore.CountMemories1024(ctx)
	if err != nil {
		t.Fatalf("failed to count memories_1024: %v", err)
	}
	if count1024 < 1 {
		t.Fatalf("expected at least 1 row in memories_1024, got %d", count1024)
	}
	t.Logf("memories_1024 row count: %d (>=1 as expected)", count1024)

	// ── Verify 1024-dim vector is 1024 elements via direct DB query ────
	// Note: GetMemory1024 returns the parent MemoryEntry from the JOIN,
	// which has 384-dim Vector (from memories.embedding). The actual 1024-dim
	// vector lives in memories_1024.embedding and must be queried directly.
	var vecDim int
	err = pgStore.Pool().QueryRow(ctx,
		"SELECT array_length(embedding::real[], 1) FROM memories_1024 WHERE memory_id = $1", id,
	).Scan(&vecDim)
	if err != nil {
		t.Fatalf("failed to query 1024-dim vector dimension: %v", err)
	}
	if vecDim != 1024 {
		t.Fatalf("expected 1024-dim vector in memories_1024, got %d-dim", vecDim)
	}
	t.Logf("1024-dim vector dimension verified: %d", vecDim)

	// ── Verify direct DB query: FK reference in memories_1024 ───────────
	pool := pgStore.Pool()
	var dbMemoryID string
	err = pool.QueryRow(ctx,
		"SELECT memory_id FROM memories_1024 WHERE memory_id = $1", id,
	).Scan(&dbMemoryID)
	if err != nil {
		t.Fatalf("failed to query memories_1024 FK: %v", err)
	}
	if dbMemoryID != id {
		t.Fatalf("expected FK memory_id %s, got %s", id, dbMemoryID)
	}
	t.Logf("FK reference verified: memories_1024.memory_id == memories.id == %s", id)

	// ── Verify QueryMemories1024 can execute (zero-vector search may return 0 hits
	//     due to cosine distance being NaN, but the query must not error) ───────
	noopEmb := embed.NewNoOpEmbedder()
	vec1024, err := noopEmb.Embed1024(ctx, "test dual-write from Go integration test")
	if err != nil {
		t.Fatalf("failed to embed 1024 query: %v", err)
	}
	results, err := pgStore.QueryMemories1024(ctx, vec1024, &core.SearchOptions{
		TopK:      5,
		Threshold: 0.0,
	})
	if err != nil {
		t.Fatalf("QueryMemories1024 returned an error: %v", err)
	}
	t.Logf("QueryMemories1024 returned %d results (note: zero-vector cosine similarity may be NaN, so 0 hits is expected)", len(results))

	// ── Verify HybridSearch can use both tables in auto mode ─────────────
	srch := search.NewHybridSearcherWithConfig(pgStore, noopEmb, core.EmbeddingModeAuto, 60)
	vector, err := noopEmb.Embed(ctx, "test dual-write from Go integration test")
	if err != nil {
		t.Fatalf("failed to embed query for hybrid search: %v", err)
	}
	hybridResults, err := srch.HybridSearch(ctx, "test dual-write from Go integration test", vector, &core.SearchOptions{
		TopK:      5,
		Threshold: 0.0,
	})
	if err != nil {
		t.Fatalf("failed hybrid search: %v", err)
	}
	if len(hybridResults) == 0 {
		t.Fatal("expected at least one result from HybridSearch, got none")
	}
	t.Logf("HybridSearch returned %d results", len(hybridResults))

	t.Log("✓ dual-write integration test passed: both tables populated, FK correct, queries work")
}

// TestIntegration_DualWrite_DeleteCascades verifies that deleting a memory
// from the 384 table cascades to the 1024 sidecar.
func TestIntegration_DualWrite_DeleteCascades(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()
	connStr, cleanup := connectWithFallback(t)
	t.Cleanup(cleanup)

	cfg := &core.Config{
		DatabaseURL:   connStr,
		EmbeddingAddr: "noop",
		EmbeddingMode: core.EmbeddingModeAuto,
	}
	mem, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("failed to create memory system: %v", err)
	}
	t.Cleanup(func() { mem.Close(ctx) })

	// Add a memory
	id, err := mem.AddMemory(ctx, core.MemoryEntry{
		Content:     "test cascade delete from Go integration test",
		SourceType:  "session",
		ContentHash: fmt.Sprintf("cascade-test-%d", time.Now().UnixNano()),
	})
	if err != nil {
		t.Fatalf("failed to add memory: %v", err)
	}
	t.Logf("added memory with ID: %s", id)

	// Verify 1024 sidecar exists
	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize store: %v", err)
	}
	t.Cleanup(func() { pgStore.Close(ctx) })

	_, err = pgStore.GetMemory1024(ctx, id)
	if err != nil {
		t.Fatalf("expected 1024 sidecar to exist before delete, got error: %v", err)
	}

	// Delete the memory (should CASCADE to memories_1024)
	if err := mem.DeleteMemory(ctx, id); err != nil {
		t.Fatalf("failed to delete memory: %v", err)
	}

	// Verify 1024 sidecar is gone (CASCADE)
	_, err = pgStore.GetMemory1024(ctx, id)
	if err == nil {
		t.Fatal("expected 1024 sidecar to be deleted via CASCADE, but it still exists")
	}
	t.Logf("1024 sidecar correctly cascaded on delete of memory %s", id)

	// Verify DeleteMemory1024 is idempotent (no error if already gone)
	if err := pgStore.DeleteMemory1024(ctx, id); err != nil {
		t.Fatalf("DeleteMemory1024 should be idempotent, got error: %v", err)
	}

	t.Log("✓ cascade delete integration test passed")
}
