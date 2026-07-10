package store

import (
	"context"
	"database/sql"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // pgx driver for database/sql

	"neuralgentics/src/neuralgentics/memory/core"

	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
)

const storeTestDBURL = "postgresql://postgres:testpassword@localhost:6200/neuralgentics_test?sslmode=require"

// connectStoreSharedDB attempts to connect to the shared test database on port 6200.
func connectStoreSharedDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", storeTestDBURL)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil
	}
	return db
}

// connectStoreWithFallback tries the shared DB first; if unavailable, spins up a
// testcontainers pgvector container. Returns (connectionString, cleanup).
func connectStoreWithFallback(t *testing.T) (string, func()) {
	t.Helper()

	db := connectStoreSharedDB(t)
	if db != nil {
		// Verify the memories table exists (schema must be migrated)
		ctx := context.Background()
		var tableName string
		err := db.QueryRowContext(ctx, `
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'memories'
		`).Scan(&tableName)
		db.Close()

		if err == nil && tableName == "memories" {
			t.Log("using shared test database on port 6200")
			return storeTestDBURL, func() {}
		}

		t.Log("shared DB reachable but missing memories table; falling back to testcontainers")
	}

	ctx := context.Background()
	pgContainer, connStr := startStoreTestDB(t, ctx)
	return connStr, func() { pgContainer.Terminate(ctx) }
}

// startStoreTestDB starts a pgvector PostgreSQL container for store-level tests.
func startStoreTestDB(t *testing.T, ctx context.Context) (*tcpostgres.PostgresContainer, string) {
	t.Helper()

	pgContainer, err := tcpostgres.Run(ctx,
		"pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("neuralgentics_test"),
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

// TestCountMemories_Regression verifies that CountMemories returns the correct
// count of active (non-archived) memories. This is a regression test for the bug
// where GetMemoryCount returned 3 columns (total, active, archived) but the Scan
// used nil pointers, which is invalid in pgx and always errors at runtime.
func TestCountMemories_Regression(t *testing.T) {
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

	// Baseline: count should be >= 0
	initial, err := pgStore.CountMemories(ctx)
	if err != nil {
		t.Fatalf("CountMemories failed on empty/initial DB: %v", err)
	}
	t.Logf("initial count: %d", initial)

	// Insert 5 active memories
	inserted := make([]string, 0, 5)
	for i := 0; i < 5; i++ {
		id, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
			Content:     "regression test memory",
			SourceType:  "session",
			ContentHash: "count-test-active-" + time.Now().Format("20060102150405.000000") + "-" + string(rune('A'+i)),
		})
		if err != nil {
			t.Fatalf("failed to add active memory %d: %v", i, err)
		}
		inserted = append(inserted, id)
	}

	// Verify count increased by 5
	afterActive, err := pgStore.CountMemories(ctx)
	if err != nil {
		t.Fatalf("CountMemories failed after adding active memories: %v", err)
	}
	if afterActive != initial+5 {
		t.Errorf("expected count %d (initial %d + 5), got %d", initial+5, initial, afterActive)
	}

	// Archive (soft-delete) 2 of the 5 active memories
	for i := 0; i < 2; i++ {
		if err := pgStore.DeleteMemory(ctx, inserted[i]); err != nil {
			t.Fatalf("failed to archive memory %s: %v", inserted[i], err)
		}
	}

	// Verify count decreased by 2 (only active memories counted)
	afterArchive, err := pgStore.CountMemories(ctx)
	if err != nil {
		t.Fatalf("CountMemories failed after archiving: %v", err)
	}
	expectedAfterArchive := initial + 5 - 2
	if afterArchive != expectedAfterArchive {
		t.Errorf("expected count %d (initial %d + 5 - 2 archived), got %d", expectedAfterArchive, initial, afterArchive)
	}

	t.Logf("final count: %d (initial=%d, +5 active, -2 archived, expected=%d)",
		afterArchive, initial, expectedAfterArchive)
}
