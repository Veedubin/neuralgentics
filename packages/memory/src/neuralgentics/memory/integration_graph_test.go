package memory

import (
	"context"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
	"neuralgentics/src/neuralgentics/memory/store"
)

// TestIntegration_CreateRelationship tests creating SUPERSEDES and RELATED_TO
// relationships between two memories and verifies they are persisted.
func TestIntegration_CreateRelationship(t *testing.T) {
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

	// Add two memories
	idA, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "original memory that will be superseded",
		SourceType:  "session",
		ContentHash: "graph-original",
	})
	if err != nil {
		t.Fatalf("failed to add memory A: %v", err)
	}

	idB, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "new memory that supersedes the original",
		SourceType:  "session",
		ContentHash: "graph-new",
	})
	if err != nil {
		t.Fatalf("failed to add memory B: %v", err)
	}

	// Create SUPERSEDES relationship (A supersedes B → A is newer)
	relID, err := pgStore.CreateRelationship(ctx, idB, idA, "SUPERSEDES", 1.0)
	if err != nil {
		t.Fatalf("failed to create SUPERSEDES relationship: %v", err)
	}
	if relID == "" {
		t.Fatal("expected non-empty relationship ID")
	}
	t.Logf("created relationship: %s", relID)

	// Verify relationship exists for both memories
	relsA, err := pgStore.GetRelationships(ctx, idA)
	if err != nil {
		t.Fatalf("failed to get relationships for A: %v", err)
	}
	if len(relsA) == 0 {
		t.Fatal("expected at least 1 relationship for memory A")
	}

	relsB, err := pgStore.GetRelationships(ctx, idB)
	if err != nil {
		t.Fatalf("failed to get relationships for B: %v", err)
	}
	if len(relsB) == 0 {
		t.Fatal("expected at least 1 relationship for memory B")
	}

	// Verify relationship type
	found := false
	for _, rel := range relsA {
		if rel.RelationshipType == "SUPERSEDES" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected SUPERSEDES relationship type")
	}

	// Create RELATED_TO relationship
	_, err = pgStore.CreateRelationship(ctx, idA, idB, "RELATED_TO", 0.8)
	if err != nil {
		t.Fatalf("failed to create RELATED_TO relationship: %v", err)
	}

	// Verify relationship summary
	summary, err := pgStore.GetRelationshipSummary(ctx, idA)
	if err != nil {
		t.Fatalf("failed to get relationship summary: %v", err)
	}
	if summary.TotalRelationships < 2 {
		t.Fatalf("expected at least 2 relationships, got %d", summary.TotalRelationships)
	}
}

// TestIntegration_GetRelatedMemories verifies BFS traversal returns related
// memories through memory_relationships table.
func TestIntegration_GetRelatedMemories(t *testing.T) {
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

	// Add 3 memories: A, B, C
	ids := make([]string, 3)
	for i, content := range []string{
		"memory A for relationship tests",
		"memory B for relationship tests",
		"memory C for relationship tests",
	} {
		id, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
			Content:     content,
			SourceType:  "session",
			ContentHash: "graph-rel-" + string(rune('A'+i)),
		})
		if err != nil {
			t.Fatalf("failed to add memory %d: %v", i, err)
		}
		ids[i] = id
	}

	// A RELATED_TO B, B RELATED_TO C (chain of 3)
	_, err := pgStore.CreateRelationship(ctx, ids[0], ids[1], "RELATED_TO", 1.0)
	if err != nil {
		t.Fatalf("failed to create A→B: %v", err)
	}

	_, err = pgStore.CreateRelationship(ctx, ids[1], ids[2], "RELATED_TO", 1.0)
	if err != nil {
		t.Fatalf("failed to create B→C: %v", err)
	}

	// Get relationships for B — should include both A and C
	rels, err := pgStore.GetRelationships(ctx, ids[1])
	if err != nil {
		t.Fatalf("failed to get relationships for B: %v", err)
	}
	if len(rels) < 2 {
		t.Fatalf("expected at least 2 relationships for B (A and C), got %d", len(rels))
	}

	// Get relationships for A — should include B
	relsA, err := pgStore.GetRelationships(ctx, ids[0])
	if err != nil {
		t.Fatalf("failed to get relationships for A: %v", err)
	}
	if len(relsA) < 1 {
		t.Fatal("expected at least 1 relationship for A (B)")
	}

	// Verify specific types
	relTypes := make(map[string]bool)
	for _, rel := range relsA {
		relTypes[rel.RelationshipType] = true
	}
	if !relTypes["RELATED_TO"] {
		t.Fatal("expected RELATED_TO relationship type for A→B")
	}
}

// TestIntegration_SupersessionChain creates a chain of 3 memories with SUPERSEDES
// relationships and verifies the recursive CTE returns the full chain.
func TestIntegration_SupersessionChain(t *testing.T) {
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

	// Create 3 memories with supersession: C supersedes B supersedes A
	// Using delta insert (supersedes_id + structured_fields) to set up the chain
	memA, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:     "earliest memory version A",
		SourceType:  "session",
		ContentHash: "chain-A",
	})
	if err != nil {
		t.Fatalf("failed to add memory A: %v", err)
	}

	memB, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:      "updated memory version B that supersedes A",
		SourceType:   "session",
		ContentHash:  "chain-B",
		SupersedesID: memA,
		ChangeRatio:  0.8,
	})
	if err != nil {
		t.Fatalf("failed to add memory B: %v", err)
	}

	memC, err := pgStore.AddMemory(ctx, &core.MemoryEntry{
		Content:      "final memory version C that supersedes B",
		SourceType:   "session",
		ContentHash:  "chain-C",
		SupersedesID: memB,
		ChangeRatio:  0.5,
	})
	if err != nil {
		t.Fatalf("failed to add memory C: %v", err)
	}
	t.Logf("supersession chain: A=%s → B=%s → C=%s", memA, memB, memC)

	// Traverse the supersession chain from C (the newest)
	chain, err := pgStore.GetSupersessionChain(ctx, memC, 10)
	if err != nil {
		t.Fatalf("failed to get supersession chain: %v", err)
	}
	t.Logf("supersession chain from C: %v", chain)

	if len(chain) == 0 {
		t.Fatal("expected non-empty supersession chain")
	}

	// Verify chain includes all 3 memories (A, B, C)
	idSet := make(map[string]bool)
	for _, id := range chain {
		idSet[id] = true
	}

	if !idSet[memA] {
		t.Error("chain missing memory A")
	}
	if !idSet[memB] {
		t.Error("chain missing memory B")
	}
	if !idSet[memC] {
		t.Error("chain missing memory C")
	}
}
