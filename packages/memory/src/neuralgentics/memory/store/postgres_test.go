package store

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestPing_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.Ping(context.Background())
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("Ping nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestStats_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.Stats(context.Background())
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("Stats nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestClose_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	// Close on a nil-pool store should not panic and should return nil
	err := s.Close(context.Background())
	if err != nil {
		t.Errorf("Close on nil-pool store should return nil, got %v", err)
	}
}

func TestDetectVectorscale_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	// detectVectorscale should return false with no pool
	if s.detectVectorscale(context.Background()) {
		t.Error("detectVectorscale should return false with nil pool")
	}
}

func TestNewPostgresStore_NilConfig(t *testing.T) {
	s := NewPostgresStore(nil)
	if s == nil {
		t.Fatal("NewPostgresStore(nil) should return non-nil store")
	}
	if s.pool != nil {
		t.Error("NewPostgresStore(nil) should have nil pool")
	}
	if s.config != nil {
		t.Error("NewPostgresStore(nil) should have nil config")
	}
}

func TestNewPostgresStore_WithConfig(t *testing.T) {
	cfg := &core.Config{DatabaseURL: "postgresql://user:pass@localhost:5432/testdb"}
	s := NewPostgresStore(cfg)
	if s == nil {
		t.Fatal("NewPostgresStore with config should return non-nil store")
	}
	if s.config != cfg {
		t.Error("NewPostgresStore should store the provided config")
	}
	if s.pool != nil {
		t.Error("NewPostgresStore should not initialize pool until Initialize()")
	}
	if s.initialized {
		t.Error("NewPostgresStore should not be initialized until Initialize() is called")
	}
}

func TestPool_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	if s.Pool() != nil {
		t.Error("Pool() should return nil when store has no pool")
	}
}

func TestIndexType(t *testing.T) {
	tests := []struct {
		name           string
		useVectorscale bool
		expected       string
	}{
		{name: "pgvector default", useVectorscale: false, expected: "pgvector"},
		{name: "pgvectorScale enabled", useVectorscale: true, expected: "pgvectorScale"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &PostgresStore{useVectorscale: tt.useVectorscale}
			result := s.indexType()
			if result != tt.expected {
				t.Errorf("indexType() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestUseVectorscale(t *testing.T) {
	s := &PostgresStore{useVectorscale: true}
	if !s.UseVectorscale() {
		t.Error("UseVectorscale() should return true when flag is set")
	}

	s2 := &PostgresStore{useVectorscale: false}
	if s2.UseVectorscale() {
		t.Error("UseVectorscale() should return false when flag is not set")
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestInitialize_Integration(t *testing.T) {
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

	if !pgStore.initialized {
		t.Error("store should be initialized after Initialize()")
	}
	if pgStore.Pool() == nil {
		t.Error("pool should not be nil after Initialize()")
	}

	// Ping should succeed after initialization
	if err := pgStore.Ping(ctx); err != nil {
		t.Errorf("Ping failed after initialization: %v", err)
	}
}

func TestStats_Integration(t *testing.T) {
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

	stats, err := pgStore.Stats(ctx)
	if err != nil {
		t.Fatalf("Stats failed: %v", err)
	}
	if stats == nil {
		t.Fatal("Stats should return non-nil result")
	}
	if !stats.Initialized {
		t.Error("Stats should report initialized=true")
	}
	if !stats.Ready {
		t.Error("Stats should report ready=true")
	}
	if stats.Dimension != 384 {
		t.Errorf("Stats.Dimension = %d, want 384", stats.Dimension)
	}
	// VectorStyle should be either pgvector or pgvectorScale
	if stats.VectorStyle != "pgvector" && stats.VectorStyle != "pgvectorScale" {
		t.Errorf("Stats.VectorStyle = %q, want pgvector or pgvectorScale", stats.VectorStyle)
	}
	t.Logf("Stats: memory=%d, entities=%d, peers=%d, chains=%d, style=%s",
		stats.MemoryCount, stats.EntityCount, stats.PeerCount, stats.ChainCount, stats.VectorStyle)
}
