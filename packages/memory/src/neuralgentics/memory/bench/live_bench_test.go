//go:build livebench
// +build livebench

// Package bench provides live PostgreSQL 18 benchmarks.
//
// Run with:
//
//	NEURALGENTICS_DB_URL="postgresql://postgres:password@localhost:5434/neuralgentics" \
//	  go test -tags=livebench -benchmem -bench=. -benchtime=3s \
//	  ./src/neuralgentics/memory/bench/
//
// Benchmarks clean up all inserted data after each sub-benchmark.
package bench

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// liveDimension is the embedding vector dimension for live benchmarks (384-d MiniLM).
const liveDimension = 384

// benchTag is a prefix in content to identify benchmark-inserted rows for cleanup.
const benchTag = "[livebench]"

// setupLiveDB connects to the live PostgreSQL instance and returns a configured
// PostgresStore. Skips the benchmark if NEURALGENTICS_DB_URL is not set or if
// the database is unreachable.
func setupLiveDB(b *testing.B) (*store.PostgresStore, func()) {
	b.Helper()

	dbURL := os.Getenv("NEURALGENTICS_DB_URL")
	if dbURL == "" {
		b.Skip("NEURALGENTICS_DB_URL not set; skipping live benchmarks")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cfg := &core.Config{
		DatabaseURL: dbURL,
		ProjectID:   "livebench",
	}

	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		b.Skipf("cannot connect to live PostgreSQL: %v", err)
		return nil, func() {}
	}

	cleanup := func() {
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanCancel()
		// Delete all rows inserted by benchmarks (tagged in content)
		pool := pgStore.Pool()
		if pool != nil {
			tag, _ := pool.Exec(cleanCtx,
				"DELETE FROM memories WHERE content LIKE $1", benchTag+"%")
			_ = tag
		}
		pgStore.Close(cleanCtx)
	}

	return pgStore, cleanup
}

// seedLiveDB populates the live database with numMemories random vectors.
// All inserted rows are tagged with the benchTag prefix for cleanup.
// Returns the IDs of inserted memories.
func seedLiveDB(b *testing.B, pgStore *store.PostgresStore, numMemories int, rng *rand.Rand) []string {
	b.Helper()
	ctx := context.Background()

	ids := make([]string, numMemories)
	for i := 0; i < numMemories; i++ {
		vec := randomVector(liveDimension, rng)
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("%s seed memory %d with relevant keywords algorithm data processing", benchTag, i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("livebench-%d", i))))[:32],
			TrustScore:  0.5 + float64(i%10)*0.05,
			Vector:      vec,
		}
		id, err := pgStore.AddMemory(ctx, entry)
		if err != nil {
			b.Fatalf("seed AddMemory %d failed: %v", i, err)
		}
		ids[i] = id
	}
	return ids
}

// cleanLiveDB deletes all benchmark-tagged rows from the live database.
func cleanLiveDB(b *testing.B, pgStore *store.PostgresStore) {
	b.Helper()
	ctx := context.Background()
	pool := pgStore.Pool()
	if pool != nil {
		_, err := pool.Exec(ctx, "DELETE FROM memory_relationships WHERE source_id IN (SELECT id FROM memories WHERE content LIKE $1)", benchTag+"%")
		if err != nil {
			b.Logf("warning: cleanup relationships failed: %v", err)
		}
		tag, err := pool.Exec(ctx, "DELETE FROM memories WHERE content LIKE $1", benchTag+"%")
		if err != nil {
			b.Logf("warning: cleanup memories failed: %v", err)
		} else {
			b.Logf("cleaned up %d benchmark rows", tag.RowsAffected())
		}
	}
}

// ─── Vector Search Latency ──────────────────────────────────────────────────────

// BenchmarkLive_VectorSearch_Latency measures vector search latency at varying
// dataset sizes (100, 1K, 10K entries).
func BenchmarkLive_VectorSearch_Latency(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	datasetSizes := []int{100, 1000, 10000}

	for _, size := range datasetSizes {
		b.Run(fmt.Sprintf("n=%d", size), func(b *testing.B) {
			ids := seedLiveDB(b, pgStore, size, rng)
			b.Cleanup(func() { cleanLiveDB(b, pgStore) })

			queryVec := randomVector(liveDimension, rng)

			b.ResetTimer()
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, err := pgStore.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{
					TopK:      10,
					Threshold: 0.3,
				})
				if err != nil {
					b.Fatalf("QueryMemoriesByVector failed: %v", err)
				}
			}
			_ = ids
		})
	}
}

// ─── Concurrent Search Throughput ───────────────────────────────────────────────

// BenchmarkLive_VectorSearch_Throughput measures concurrent vector search ops/sec.
func BenchmarkLive_VectorSearch_Throughput(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	_ = seedLiveDB(b, pgStore, 1000, rng)
	b.Cleanup(func() { cleanLiveDB(b, pgStore) })

	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		rng := rand.New(rand.NewSource(42))
		for pb.Next() {
			queryVec := randomVector(liveDimension, rng)
			_, _ = pgStore.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{
				TopK:      10,
				Threshold: 0.3,
			})
		}
	})
}

// ─── Memory Add Latency ─────────────────────────────────────────────────────────

// BenchmarkLive_AddMemory measures single memory insertion latency.
func BenchmarkLive_AddMemory(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	var ids []string

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("%s bench add %d", benchTag, i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("livebench-add-%d", i))))[:32],
			TrustScore:  0.5,
			Vector:      randomVector(liveDimension, rng),
		}
		id, err := pgStore.AddMemory(ctx, entry)
		if err != nil {
			b.Fatalf("AddMemory failed: %v", err)
		}
		ids = append(ids, id)
	}
	b.StopTimer()

	// Cleanup inserted rows
	cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cleanCancel()
	pool := pgStore.Pool()
	if pool != nil {
		for _, id := range ids {
			_ = pgStore.DeleteMemory(cleanCtx, id)
		}
	}
}

// ─── Connection Pool Warm-up ────────────────────────────────────────────────────

// BenchmarkLive_ConnectionPool_WarmUp measures time to initialize the connection
// pool and establish MinConns=4 connections.
func BenchmarkLive_ConnectionPool_WarmUp(b *testing.B) {
	dbURL := os.Getenv("NEURALGENTICS_DB_URL")
	if dbURL == "" {
		b.Skip("NEURALGENTICS_DB_URL not set")
	}

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		cfg := &core.Config{
			DatabaseURL: dbURL,
			ProjectID:   "livebench-pool",
		}
		pgStore := store.NewPostgresStore(cfg)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := pgStore.Initialize(ctx); err != nil {
			cancel()
			b.Fatalf("Initialize failed: %v", err)
		}
		pgStore.Close(ctx)
		cancel()
	}
}

// ─── BM25 Full-Text Search ──────────────────────────────────────────────────────

// BenchmarkLive_TextSearch measures full-text search (tsvector + websearch_to_tsquery).
func BenchmarkLive_TextSearch(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	_ = seedLiveDB(b, pgStore, 1000, rng)
	b.Cleanup(func() { cleanLiveDB(b, pgStore) })

	queries := []string{
		"algorithm optimization",
		"relevant keywords data",
		"memory processing neural",
		"vector search database",
		"benchmark performance tuning",
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		query := queries[i%len(queries)]
		_, err := pgStore.SearchMemoriesText(ctx, query, &core.SearchOptions{TopK: 10})
		if err != nil {
			b.Fatalf("SearchMemoriesText failed: %v", err)
		}
	}
}

// ─── Hybrid (RRF) Search ───────────────────────────────────────────────────────

// BenchmarkLive_HybridSearch simulates hybrid search by running vector + text
// searches in sequence (the Go backend combines them client-side with RRF).
func BenchmarkLive_HybridSearch(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	_ = seedLiveDB(b, pgStore, 1000, rng)
	b.Cleanup(func() { cleanLiveDB(b, pgStore) })

	textQueries := []string{
		"algorithm optimization",
		"relevant keywords data",
		"memory processing neural",
		"vector search database",
		"benchmark performance tuning",
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		queryVec := randomVector(liveDimension, rng)
		textQuery := textQueries[i%len(textQueries)]

		// Vector search
		vecResults, err := pgStore.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{
			TopK:      10,
			Threshold: 0.3,
		})
		if err != nil {
			b.Fatalf("vector search failed: %v", err)
		}

		// Text search
		textResults, err := pgStore.SearchMemoriesText(ctx, textQuery, &core.SearchOptions{TopK: 10})
		if err != nil {
			b.Fatalf("text search failed: %v", err)
		}

		// RRF-like merge (simplified — just count to prevent dead-code elimination)
		_ = len(vecResults) + len(textResults)
	}
}

// ─── GetSimilar (ByID lookup) ───────────────────────────────────────────────────

// BenchmarkLive_GetSimilar measures similarity lookup by existing memory ID.
func BenchmarkLive_GetSimilar(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	ids := seedLiveDB(b, pgStore, 1000, rng)
	b.Cleanup(func() { cleanLiveDB(b, pgStore) })

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		idx := rng.Intn(len(ids))
		_, err := pgStore.GetSimilar(ctx, ids[idx], &core.SearchOptions{TopK: 10})
		if err != nil {
			b.Fatalf("GetSimilar failed: %v", err)
		}
	}
}

// ─── GetMemory (ByID) ───────────────────────────────────────────────────────────

// BenchmarkLive_GetMemory measures primary-key lookup latency.
func BenchmarkLive_GetMemory(b *testing.B) {
	pgStore, cleanup := setupLiveDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	ids := seedLiveDB(b, pgStore, 1000, rng)
	b.Cleanup(func() { cleanLiveDB(b, pgStore) })

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		idx := rng.Intn(len(ids))
		_, err := pgStore.GetMemory(ctx, ids[idx], false)
		if err != nil {
			b.Fatalf("GetMemory failed: %v", err)
		}
	}
}
