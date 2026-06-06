package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Nil-pool error path tests (no DB required) ──────────────────────────────

func TestUpsertEntity_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.UpsertEntity(context.Background(), &core.Entity{
		Name:       "test-entity",
		EntityType: "CONCEPT",
	})
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("UpsertEntity nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetEntity_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetEntity(context.Background(), "entity-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetEntity nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestSearchEntities_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.SearchEntities(context.Background(), "test", 10)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("SearchEntities nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestResolveEntityGraph_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	err := s.ResolveEntityGraph(context.Background(), "entity-123", 3)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("ResolveEntityGraph nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestInferenceChain_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.InferenceChain(context.Background(), "entity-A", "entity-B", 3)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("InferenceChain nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetEntitiesByType_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetEntitiesByType(context.Background(), "PERSON", 10)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetEntitiesByType nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestCreateEntityRelationship_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.CreateEntityRelationship(context.Background(), "entity-A", "entity-B", "RELATED_TO", 0.9)
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("CreateEntityRelationship nil-pool error = %q, want %q", err.Error(), expected)
	}
}

func TestGetEntityRelationships_NoPool(t *testing.T) {
	s := NewPostgresStore(nil)
	_, err := s.GetEntityRelationships(context.Background(), "entity-123")
	if err == nil {
		t.Fatal("expected error for nil pool, got nil")
	}
	expected := "database pool not initialized"
	if err.Error() != expected {
		t.Errorf("GetEntityRelationships nil-pool error = %q, want %q", err.Error(), expected)
	}
}

// ─── Integration tests (require running DB) ──────────────────────────────────

func TestUpsertAndGetEntity_Success(t *testing.T) {
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

	// Upsert an entity
	entityName := fmt.Sprintf("test-entity-%s", time.Now().Format("20060102150405"))
	entityID, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:          entityName,
		EntityType:    "CONCEPT",
		CanonicalName: "Test Concept",
		Confidence:    0.85,
	})
	if err != nil {
		t.Fatalf("UpsertEntity failed: %v", err)
	}
	if entityID == "" {
		t.Error("expected non-empty entity ID from UpsertEntity")
	}
	t.Logf("UpsertEntity returned ID: %s", entityID)

	// Retrieve the entity
	retrieved, err := pgStore.GetEntity(ctx, entityID)
	if err != nil {
		t.Fatalf("GetEntity failed: %v", err)
	}
	if retrieved.Name != entityName {
		t.Errorf("GetEntity name = %q, want %q", retrieved.Name, entityName)
	}
	if retrieved.EntityType != "CONCEPT" {
		t.Errorf("GetEntity type = %q, want %q", retrieved.EntityType, "CONCEPT")
	}
	t.Logf("GetEntity returned: id=%s name=%s type=%s confidence=%.2f", retrieved.ID, retrieved.Name, retrieved.EntityType, retrieved.Confidence)
}

func TestInferenceChain_Success(t *testing.T) {
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

	// Create two entities
	entityA := fmt.Sprintf("chain-a-%s", time.Now().Format("20060102150405"))
	entityB := fmt.Sprintf("chain-b-%s", time.Now().Format("20060102150405"))

	idA, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       entityA,
		EntityType: "CONCEPT",
		Confidence: 0.9,
	})
	if err != nil {
		t.Fatalf("UpsertEntity A failed: %v", err)
	}

	idB, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       entityB,
		EntityType: "CONCEPT",
		Confidence: 0.9,
	})
	if err != nil {
		t.Fatalf("UpsertEntity B failed: %v", err)
	}

	// Create a relationship between them
	_, err = pgStore.CreateEntityRelationship(ctx, idA, idB, "RELATED_TO", 0.8)
	if err != nil {
		t.Fatalf("CreateEntityRelationship failed: %v", err)
	}

	// InferenceChain: find path from A to B with depth 3
	path, err := pgStore.InferenceChain(ctx, idA, idB, 3)
	if err != nil {
		t.Fatalf("InferenceChain failed: %v", err)
	}
	if path == nil {
		t.Error("expected a path from A to B, got nil (no path found)")
	} else {
		t.Logf("InferenceChain found path with %d relationships", len(path))
	}

	// Also test: no path from A to A itself (same entity)
	// Note: InferenceChain returns nil path when start == end and path is empty
	samePath, err := pgStore.InferenceChain(ctx, idA, idA, 3)
	if err != nil {
		t.Fatalf("InferenceChain self-path failed: %v", err)
	}
	t.Logf("InferenceChain self-path: %d relationships (expected 0 or nil for trivial self-referencing)", len(samePath))
}
