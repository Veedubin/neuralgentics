package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// TestIntegration_UpsertEntity tests adding an entity to the knowledge graph
// and verifying it persists correctly (store-level CRUD, no LLM required).
func TestIntegration_UpsertEntity(t *testing.T) {
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

	// Upsert a CONCEPT entity
	entityID, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       "dark-mode",
		EntityType: "CONCEPT",
		Confidence: 0.95,
	})
	if err != nil {
		t.Fatalf("failed to upsert entity: %v", err)
	}
	if entityID == "" {
		t.Fatal("expected non-empty entity ID")
	}
	t.Logf("created entity: %s", entityID)

	// Retrieve and verify
	entity, err := pgStore.GetEntity(ctx, entityID)
	if err != nil {
		t.Fatalf("failed to get entity: %v", err)
	}
	if entity.Name != "dark-mode" {
		t.Fatalf("expected entity name 'dark-mode', got: %s", entity.Name)
	}
	if entity.EntityType != "CONCEPT" {
		t.Fatalf("expected entity type 'CONCEPT', got: %s", entity.EntityType)
	}
	if entity.Confidence != 0.95 {
		t.Fatalf("expected confidence 0.95, got %f", entity.Confidence)
	}
	if entity.MentionCount < 1 {
		t.Fatalf("expected mention_count >= 1, got %d", entity.MentionCount)
	}

	// Upsert same entity again (should increment mention_count via ON CONFLICT)
	entityID2, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       "dark-mode",
		EntityType: "CONCEPT",
		Confidence: 0.97,
	})
	if err != nil {
		t.Fatalf("failed to upsert entity again: %v", err)
	}
	if entityID2 != entityID {
		t.Fatalf("expected same entity ID on upsert, got %s != %s", entityID2, entityID)
	}

	// Verify mention count increased and confidence used the greater value
	entity, err = pgStore.GetEntity(ctx, entityID)
	if err != nil {
		t.Fatalf("failed to get entity after second upsert: %v", err)
	}
	if entity.MentionCount != 2 {
		t.Fatalf("expected mention_count 2 after second upsert, got %d", entity.MentionCount)
	}
	if entity.Confidence != 0.97 {
		t.Fatalf("expected confidence 0.97 (GREATEST), got %f", entity.Confidence)
	}
}

// TestIntegration_CreateEntityRelationship tests linking two entities
// and verifying the relationship is persisted and retrievable.
func TestIntegration_CreateEntityRelationship(t *testing.T) {
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

	// Create two entities
	entityA, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       "user",
		EntityType: "PERSON",
		Confidence: 0.9,
	})
	if err != nil {
		t.Fatalf("failed to upsert entity A: %v", err)
	}

	entityB, err := pgStore.UpsertEntity(ctx, &core.Entity{
		Name:       "dark-mode-feature",
		EntityType: "CONCEPT",
		Confidence: 0.9,
	})
	if err != nil {
		t.Fatalf("failed to upsert entity B: %v", err)
	}

	// Link them with "PREFERS" relationship type
	relID, err := pgStore.CreateEntityRelationship(ctx, entityA, entityB, "PREFERS", 0.85)
	if err != nil {
		t.Fatalf("failed to create entity relationship: %v", err)
	}
	if relID == "" {
		t.Fatal("expected non-empty relationship ID")
	}
	t.Logf("created entity relationship: %s", relID)

	// Get relationships for entity A
	rels, err := pgStore.GetEntityRelationships(ctx, entityA)
	if err != nil {
		t.Fatalf("failed to get entity relationships: %v", err)
	}
	if len(rels) == 0 {
		t.Fatal("expected at least 1 entity relationship")
	}

	found := false
	for _, rel := range rels {
		if rel.RelationshipType == "PREFERS" &&
			rel.SourceEntityID == entityA &&
			rel.TargetEntityID == entityB {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected PREFERS relationship from entity A to entity B")
	}

	// Get relationships for entity B
	relsB, err := pgStore.GetEntityRelationships(ctx, entityB)
	if err != nil {
		t.Fatalf("failed to get entity relationships for B: %v", err)
	}
	if len(relsB) == 0 {
		t.Fatal("expected at least 1 entity relationship for B")
	}
}

// TestIntegration_SearchEntities tests searching entities by name using
// case-insensitive ILIKE matching.
func TestIntegration_SearchEntities(t *testing.T) {
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

	// Add multiple entities
	entities := []core.Entity{
		{Name: "code-review-process", EntityType: "CONCEPT", Confidence: 0.9},
		{Name: "type-checking", EntityType: "CONCEPT", Confidence: 0.85},
		{Name: "user-authentication", EntityType: "CONCEPT", Confidence: 0.95},
		{Name: "dark-mode-toggle", EntityType: "CONCEPT", Confidence: 0.8},
		{Name: "database-schema", EntityType: "CONCEPT", Confidence: 0.9},
	}

	entityIDs := make(map[string]string)
	for _, e := range entities {
		id, err := pgStore.UpsertEntity(ctx, &e)
		if err != nil {
			t.Fatalf("failed to upsert entity %q: %v", e.Name, err)
		}
		entityIDs[e.Name] = id
	}

	// Search by partial name
	results, err := pgStore.SearchEntities(ctx, "code", 10)
	if err != nil {
		t.Fatalf("failed to search entities: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected at least 1 result for search 'code'")
	}

	// Verify "code-review-process" is in results
	found := false
	for _, r := range results {
		if r.Name == "code-review-process" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected 'code-review-process' in search results for 'code'")
	}
	t.Logf("search for 'code' returned %d results", len(results))

	// Search by non-existent name
	results, err = pgStore.SearchEntities(ctx, "nonexistent-xyzzy", 10)
	if err != nil {
		t.Fatalf("failed to search non-existent: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 results for non-existent search, got %d", len(results))
	}
}
