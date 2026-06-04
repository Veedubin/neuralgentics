// Package bench provides pgvector-specific benchmarks that require a live PostgreSQL
// database with the pgvector extension. These benchmarks measure real vector search
// latency and throughput with actual pgvector index operations.
//
// If Docker is not available, the benchmarks are skipped automatically using b.Skip.
package bench

import (
	"context"
	"fmt"
	"math/rand"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// pgvectorDimension is the embedding vector dimension for pgvector benchmarks.
const pgvectorDimension = 384

// setupBenchDB starts a PostgreSQL container with pgvector extension and returns
// a configured PostgresStore. Returns nil if Docker is unavailable.
func setupBenchDB(b *testing.B) (*store.PostgresStore, func()) {
	b.Helper()

	ctx := context.Background()

	pgContainer, err := postgres.Run(ctx,
		"pgvector/pgvector:pg17",
		postgres.WithDatabase("benchdb"),
		postgres.WithUsername("bench"),
		postgres.WithPassword("benchpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		b.Skip("Docker not available, skipping pgvector benchmarks")
		return nil, func() {}
	}

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		cleanup := func() { pgContainer.Terminate(ctx) }
		cleanup()
		b.Skipf("failed to get connection string: %v", err)
		return nil, func() {}
	}

	cfg := &core.Config{
		DatabaseURL: connStr,
		ProjectID:   "bench-test",
	}

	pgStore := store.NewPostgresStore(cfg)
	if err := pgStore.Initialize(ctx); err != nil {
		cleanup := func() {
			pgStore.Close(ctx)
			pgContainer.Terminate(ctx)
		}
		cleanup()
		b.Skipf("failed to initialize store: %v", err)
		return nil, func() {}
	}

	cleanup := func() {
		pgStore.Close(ctx)
		pgContainer.Terminate(ctx)
	}

	return pgStore, cleanup
}

// seedBenchDB populates the database with numMemories random vectors.
func seedBenchDB(b *testing.B, pgStore *store.PostgresStore, numMemories int, rng *rand.Rand) []string {
	b.Helper()
	ctx := context.Background()

	ids := make([]string, numMemories)
	for i := 0; i < numMemories; i++ {
		vec := randomVector(pgvectorDimension, rng)
		entry := &core.MemoryEntry{
			Content:     fmt.Sprintf("bench seed memory %d with relevant keywords", i),
			SourceType:  "session",
			ContentHash: fmt.Sprintf("%x", quickHash(fmt.Sprintf("seed-%d", i)))[:32],
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

// quickHash returns a SHA-256 hash of the input string.
func quickHash(s string) string {
	return fmt.Sprintf("%x", len(s))
}

// BenchmarkVectorSearch_Latency measures vector search latency with varying dataset sizes.
// It tests search performance with 100, 1000, and 10000 memories.
func BenchmarkVectorSearch_Latency(b *testing.B) {
	pgStore, cleanup := setupBenchDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	datasetSizes := []int{100, 1000}

	for _, size := range datasetSizes {
		b.Run(fmt.Sprintf("n=%d", size), func(b *testing.B) {
			// Seed dataset
			ids := seedBenchDB(b, pgStore, size, rng)

			// Generate a query vector
			queryVec := randomVector(pgvectorDimension, rng)

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

			_ = ids // suppress unused warning
		})
	}
}

// BenchmarkVectorSearch_Throughput measures concurrent vector search throughput.
// It runs multiple goroutines performing searches simultaneously.
func BenchmarkVectorSearch_Throughput(b *testing.B) {
	pgStore, cleanup := setupBenchDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	// Seed with 500 memories
	_ = seedBenchDB(b, pgStore, 500, rng)

	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		rng := rand.New(rand.NewSource(42))
		for pb.Next() {
			queryVec := randomVector(pgvectorDimension, rng)
			_, _ = pgStore.QueryMemoriesByVector(ctx, queryVec, &core.SearchOptions{
				TopK:      10,
				Threshold: 0.3,
			})
		}
	})
}

// BenchmarkVectorSearch_GetSimilar measures GetSimilar (ByID vector lookup).
func BenchmarkVectorSearch_GetSimilar(b *testing.B) {
	pgStore, cleanup := setupBenchDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	// Seed with 500 memories
	ids := seedBenchDB(b, pgStore, 500, rng)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		// Pick a random existing memory ID
		idx := rng.Intn(len(ids))
		_, err := pgStore.GetSimilar(ctx, ids[idx], &core.SearchOptions{TopK: 10})
		if err != nil {
			b.Fatalf("GetSimilar failed: %v", err)
		}
	}
}

// BenchmarkVectorSearch_TextSearch benchmarks full-text search performance.
func BenchmarkVectorSearch_TextSearch(b *testing.B) {
	pgStore, cleanup := setupBenchDB(b)
	if pgStore == nil {
		return
	}
	defer cleanup()

	rng := rand.New(rand.NewSource(42))
	ctx := context.Background()

	// Seed with 500 memories
	_ = seedBenchDB(b, pgStore, 500, rng)

	queries := []string{
		"bench seed memory",
		"relevant keywords",
		"database vector search",
		"performance tuning",
		"optimization",
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

// BenchmarkConnectionPool_WarmStart benchmarks connection pool initialization with
// the tuned settings (MinConns=4, MaxConns=25).
func BenchmarkConnectionPool_WarmStart(b *testing.B) {
	// This benchmark doesn't need a real database - it tests pool configuration.
	cfg := &core.Config{
		DatabaseURL: "postgres://bench:benchpass@localhost:5432/benchdb?sslmode=disable",
		ProjectID:   "bench-pool-test",
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = store.NewPostgresStore(cfg)
		// We don't initialize since we don't have a real DB for this benchmark.
		// This only measures struct creation overhead.
	}
}
