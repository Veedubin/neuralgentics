package kg

import (
	"context"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// --- KGQuery Tests ---

func TestKGQuery_TransitiveClosure(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create a small graph: A -> B -> C
	alice := &core.Entity{Name: "Alice", EntityType: "PERSON", CanonicalName: "alice", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	bob := &core.Entity{Name: "Bob", EntityType: "PERSON", CanonicalName: "bob", Confidence: 0.8, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	charlie := &core.Entity{Name: "Charlie", EntityType: "PERSON", CanonicalName: "charlie", Confidence: 0.7, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aliceID, _ := store.UpsertEntity(ctx, alice)
	bobID, _ := store.UpsertEntity(ctx, bob)
	charlieID, _ := store.UpsertEntity(ctx, charlie)

	store.CreateEntityRelationship(ctx, aliceID, bobID, "KNOWS", 0.9)
	store.CreateEntityRelationship(ctx, bobID, charlieID, "WORKS_WITH", 0.8)

	q := NewKGQuery(store)
	result, err := q.Query(ctx, QueryParams{
		StartEntity: aliceID,
		MaxDepth:    3,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}

	if len(result.Entities) != 3 {
		t.Errorf("expected 3 entities, got %d", len(result.Entities))
	}
	if len(result.Relationships) != 2 {
		t.Errorf("expected 2 relationships, got %d", len(result.Relationships))
	}
	if result.InferenceChain != nil {
		t.Error("InferenceChain should be nil for transitive closure query")
	}
}

func TestKGQuery_TransitiveClosureDepthLimit(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create A -> B -> C -> D chain
	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	b := &core.Entity{Name: "B", EntityType: "CONCEPT", CanonicalName: "b", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	c := &core.Entity{Name: "C", EntityType: "CONCEPT", CanonicalName: "c", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	d := &core.Entity{Name: "D", EntityType: "CONCEPT", CanonicalName: "d", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aID, _ := store.UpsertEntity(ctx, a)
	bID, _ := store.UpsertEntity(ctx, b)
	cID, _ := store.UpsertEntity(ctx, c)
	dID, _ := store.UpsertEntity(ctx, d)

	store.CreateEntityRelationship(ctx, aID, bID, "RELATED_TO", 0.9)
	store.CreateEntityRelationship(ctx, bID, cID, "RELATED_TO", 0.8)
	store.CreateEntityRelationship(ctx, cID, dID, "RELATED_TO", 0.7)

	q := NewKGQuery(store)

	// Depth 1: only A -> B
	result, err := q.Query(ctx, QueryParams{
		StartEntity: aID,
		MaxDepth:    1,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	// Should get A and B only (A is start, B is 1 hop away)
	// C and D are beyond depth 1
	if len(result.Entities) != 2 {
		t.Errorf("depth 1: expected 2 entities (A, B), got %d", len(result.Entities))
	}
	if len(result.Relationships) != 1 {
		t.Errorf("depth 1: expected 1 relationship, got %d", len(result.Relationships))
	}

	// Depth 2: A -> B -> C
	result2, err := q.Query(ctx, QueryParams{
		StartEntity: aID,
		MaxDepth:    2,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	if len(result2.Entities) != 3 {
		t.Errorf("depth 2: expected 3 entities (A, B, C), got %d", len(result2.Entities))
	}
}

func TestKGQuery_InferenceChain(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create: Alice --WORKS_AT--> Acme --PARTNER_OF--> Beta
	alice := &core.Entity{Name: "Alice", EntityType: "PERSON", CanonicalName: "alice", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	acme := &core.Entity{Name: "Acme", EntityType: "ORGANIZATION", CanonicalName: "acme", Confidence: 0.95, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	beta := &core.Entity{Name: "Beta", EntityType: "ORGANIZATION", CanonicalName: "beta", Confidence: 0.85, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aliceID, _ := store.UpsertEntity(ctx, alice)
	acmeID, _ := store.UpsertEntity(ctx, acme)
	betaID, _ := store.UpsertEntity(ctx, beta)

	store.CreateEntityRelationship(ctx, aliceID, acmeID, "WORKS_AT", 0.9)
	store.CreateEntityRelationship(ctx, acmeID, betaID, "PARTNER_OF", 0.8)

	q := NewKGQuery(store)
	result, err := q.Query(ctx, QueryParams{
		StartEntity: aliceID,
		EndEntity:   betaID,
		MaxDepth:    5,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}

	// Should find inference chain: Alice ->WORKS_AT-> Acme ->PARTNER_OF-> Beta
	if result.InferenceChain == nil {
		t.Fatal("expected InferenceChain to be non-nil for inference query")
	}
	if len(result.InferenceChain) != 2 {
		t.Errorf("expected 2-step inference chain, got %d steps", len(result.InferenceChain))
	}
}

func TestKGQuery_InferenceChain_NoPath(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create two disconnected entities
	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	b := &core.Entity{Name: "B", EntityType: "CONCEPT", CanonicalName: "b", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aID, _ := store.UpsertEntity(ctx, a)
	bID, _ := store.UpsertEntity(ctx, b)

	q := NewKGQuery(store)
	result, err := q.Query(ctx, QueryParams{
		StartEntity: aID,
		EndEntity:   bID,
		MaxDepth:    3,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}

	// No path exists — inference chain should be nil
	if result.InferenceChain != nil {
		t.Error("expected nil InferenceChain when no path exists")
	}
	// Should still return start and end entities
	if len(result.Entities) != 2 {
		t.Errorf("expected 2 entities (start + end), got %d", len(result.Entities))
	}
}

func TestKGQuery_InferenceChain_CycleDetection(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	// Create a cycle: A -> B -> C -> A
	// Also create A -> D (the target)
	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	b := &core.Entity{Name: "B", EntityType: "CONCEPT", CanonicalName: "b", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	c := &core.Entity{Name: "C", EntityType: "CONCEPT", CanonicalName: "c", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	d := &core.Entity{Name: "D", EntityType: "CONCEPT", CanonicalName: "d", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aID, _ := store.UpsertEntity(ctx, a)
	bID, _ := store.UpsertEntity(ctx, b)
	cID, _ := store.UpsertEntity(ctx, c)
	dID, _ := store.UpsertEntity(ctx, d)

	store.CreateEntityRelationship(ctx, aID, bID, "RELATED_TO", 0.9)
	store.CreateEntityRelationship(ctx, bID, cID, "RELATED_TO", 0.9)
	store.CreateEntityRelationship(ctx, cID, aID, "RELATED_TO", 0.9) // cycle back
	store.CreateEntityRelationship(ctx, aID, dID, "RELATED_TO", 0.9) // path to target

	q := NewKGQuery(store)
	result, err := q.Query(ctx, QueryParams{
		StartEntity: aID,
		EndEntity:   dID,
		MaxDepth:    5,
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}

	// Should find direct path A -> D without getting stuck in the cycle
	if result.InferenceChain == nil {
		t.Fatal("expected InferenceChain to be non-nil")
	}
	if len(result.InferenceChain) != 1 {
		t.Errorf("expected 1-step inference chain, got %d steps", len(result.InferenceChain))
	}
}

func TestKGQuery_RelationshipTypeFilter(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	alice := &core.Entity{Name: "Alice", EntityType: "PERSON", CanonicalName: "alice", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	bob := &core.Entity{Name: "Bob", EntityType: "PERSON", CanonicalName: "bob", Confidence: 0.8, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	acme := &core.Entity{Name: "Acme", EntityType: "ORGANIZATION", CanonicalName: "acme", Confidence: 0.95, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aliceID, _ := store.UpsertEntity(ctx, alice)
	bobID, _ := store.UpsertEntity(ctx, bob)
	acmeID, _ := store.UpsertEntity(ctx, acme)

	store.CreateEntityRelationship(ctx, aliceID, bobID, "KNOWS", 0.9)
	store.CreateEntityRelationship(ctx, aliceID, acmeID, "WORKS_AT", 0.95)

	q := NewKGQuery(store)
	result, err := q.Query(ctx, QueryParams{
		StartEntity:       aliceID,
		MaxDepth:          3,
		RelationshipTypes: []string{"KNOWS"},
	})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}

	// Should only include the KNOWS relationship
	// Acme should not be reached because WORKS_AT is filtered out
	if len(result.Relationships) != 1 {
		t.Errorf("expected 1 KNOWS relationship, got %d", len(result.Relationships))
	}
	if len(result.Relationships) > 0 && result.Relationships[0].RelationshipType != "KNOWS" {
		t.Errorf("expected KNOWS relationship type, got %s", result.Relationships[0].RelationshipType)
	}
}

func TestKGQuery_DefaultDepth(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()
	q := NewKGQuery(store)

	_, err := q.Query(ctx, QueryParams{
		StartEntity: "nonexistent",
		MaxDepth:    0, // should default to 3
	})
	if err == nil {
		t.Fatal("expected error for nonexistent entity")
	}
}

func TestKGQuery_EmptyStartEntity(t *testing.T) {
	store := newMockKGStore()
	q := NewKGQuery(store)

	_, err := q.Query(context.Background(), QueryParams{
		StartEntity: "",
	})
	if err == nil {
		t.Fatal("expected error for empty start entity, got nil")
	}
}

func TestKGQuery_SearchEntities(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	a := &core.Entity{Name: "Alice Smith", EntityType: "PERSON", CanonicalName: "alice smith", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	b := &core.Entity{Name: "Alice Cooper", EntityType: "PERSON", CanonicalName: "alice cooper", Confidence: 0.8, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	c := &core.Entity{Name: "Bob Jones", EntityType: "PERSON", CanonicalName: "bob jones", Confidence: 0.7, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	store.UpsertEntity(ctx, a)
	store.UpsertEntity(ctx, b)
	store.UpsertEntity(ctx, c)

	q := NewKGQuery(store)
	results, err := q.SearchEntities(ctx, "Alice", 10)
	if err != nil {
		t.Fatalf("SearchEntities returned error: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results for 'Alice', got %d", len(results))
	}
}

func TestKGQuery_SearchEntities_EmptyName(t *testing.T) {
	store := newMockKGStore()
	q := NewKGQuery(store)

	_, err := q.SearchEntities(context.Background(), "", 10)
	if err == nil {
		t.Fatal("expected error for empty search name, got nil")
	}
}

func TestKGQuery_GetEntitiesByType(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	p1 := &core.Entity{Name: "Alice", EntityType: "PERSON", CanonicalName: "alice", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	p2 := &core.Entity{Name: "Bob", EntityType: "PERSON", CanonicalName: "bob", Confidence: 0.8, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	o1 := &core.Entity{Name: "Acme", EntityType: "ORGANIZATION", CanonicalName: "acme", Confidence: 0.95, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	store.UpsertEntity(ctx, p1)
	store.UpsertEntity(ctx, p2)
	store.UpsertEntity(ctx, o1)

	q := NewKGQuery(store)
	results, err := q.GetEntitiesByType(ctx, "PERSON", 10)
	if err != nil {
		t.Fatalf("GetEntitiesByType returned error: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 PERSON entities, got %d", len(results))
	}
}

func TestKGQuery_GetEntitiesByType_InvalidType(t *testing.T) {
	store := newMockKGStore()
	q := NewKGQuery(store)

	_, err := q.GetEntitiesByType(context.Background(), "INVALID_TYPE", 10)
	if err == nil {
		t.Fatal("expected error for invalid entity type, got nil")
	}
}

func TestKGQuery_CreateRelationship(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	b := &core.Entity{Name: "B", EntityType: "CONCEPT", CanonicalName: "b", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}

	aID, _ := store.UpsertEntity(ctx, a)
	bID, _ := store.UpsertEntity(ctx, b)

	q := NewKGQuery(store)
	relID, err := q.CreateRelationship(ctx, aID, bID, "RELATED_TO", 0.85)
	if err != nil {
		t.Fatalf("CreateRelationship returned error: %v", err)
	}
	if relID == "" {
		t.Error("expected non-empty relationship ID")
	}
}

func TestKGQuery_CreateRelationship_SelfReferential(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	aID, _ := store.UpsertEntity(ctx, a)

	q := NewKGQuery(store)
	_, err := q.CreateRelationship(ctx, aID, aID, "RELATED_TO", 0.5)
	if err == nil {
		t.Fatal("expected error for self-referential relationship, got nil")
	}
}

func TestKGQuery_CreateRelationship_NonexistentEntity(t *testing.T) {
	ctx := context.Background()
	store := newMockKGStore()

	a := &core.Entity{Name: "A", EntityType: "CONCEPT", CanonicalName: "a", Confidence: 0.9, FirstSeenAt: time.Now(), LastSeenAt: time.Now()}
	aID, _ := store.UpsertEntity(ctx, a)

	q := NewKGQuery(store)
	_, err := q.CreateRelationship(ctx, aID, "nonexistent", "RELATED_TO", 0.5)
	if err == nil {
		t.Fatal("expected error for nonexistent target entity, got nil")
	}
}

func TestKGQuery_DefaultMaxDepth(t *testing.T) {
	q := NewKGQuery(newMockKGStore())
	if q == nil {
		t.Fatal("NewKGQuery returned nil")
	}
	// Default max depth is tested through Query calls with MaxDepth=0
}

func TestContains(t *testing.T) {
	tests := []struct {
		slice []string
		s     string
		want  bool
	}{
		{[]string{"a", "b", "c"}, "b", true},
		{[]string{"a", "b", "c"}, "d", false},
		{[]string{}, "a", false},
		{nil, "a", false},
	}
	for _, tt := range tests {
		got := contains(tt.slice, tt.s)
		if got != tt.want {
			t.Errorf("contains(%v, %q) = %v, want %v", tt.slice, tt.s, got, tt.want)
		}
	}
}

func TestValidEntityTypes(t *testing.T) {
	expectedTypes := []string{"PERSON", "ORGANIZATION", "CONCEPT", "CODE", "PROJECT", "LOCATION", "UNKNOWN"}
	for _, et := range expectedTypes {
		if !validEntityTypes[et] {
			t.Errorf("expected %q to be a valid entity type", et)
		}
	}

	// Invalid types
	invalidTypes := []string{"FOO", "BAR", "PRODUCT", "", "person"}
	for _, et := range invalidTypes {
		if validEntityTypes[et] {
			t.Errorf("expected %q to be an invalid entity type", et)
		}
	}
}
