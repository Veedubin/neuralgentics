package graph

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockStore implements core.Store for unit tests. Only relationship-relevant
// methods are implemented; all others return zero values.
type mockStore struct {
	mu             sync.Mutex
	relationships  []core.Relationship
	memories       map[string]*core.MemoryEntry
	relationshipID int
}

func newMockStore() *mockStore {
	return &mockStore{
		memories: make(map[string]*core.MemoryEntry),
	}
}

// ─── Relationship-related Store interface methods ──────────────────────────────

func (m *mockStore) CreateRelationship(_ context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.relationshipID++
	id := fmt.Sprintf("rel-%d", m.relationshipID)
	m.relationships = append(m.relationships, core.Relationship{
		SourceID:         sourceID,
		TargetID:         targetID,
		RelationshipType: relType,
		Confidence:       confidence,
	})
	return id, nil
}

func (m *mockStore) DeleteRelationship(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	// In this mock we don't track by ID, so just remove the first relationship
	if len(m.relationships) > 0 {
		m.relationships = m.relationships[1:]
	}
	return nil
}

func (m *mockStore) GetRelationships(_ context.Context, memoryID string) ([]core.Relationship, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result []core.Relationship
	for _, r := range m.relationships {
		if r.SourceID == memoryID || r.TargetID == memoryID {
			result = append(result, r)
		}
	}
	return result, nil
}

func (m *mockStore) GetRelationshipSummary(_ context.Context, memoryID string) (*core.RelationshipSummary, error) {
	rels, _ := m.GetRelationships(context.Background(), memoryID)
	byType := make(map[string]int)
	for _, r := range rels {
		byType[r.RelationshipType]++
	}
	return &core.RelationshipSummary{
		MemoryID:           memoryID,
		TotalRelationships: len(rels),
		ByType:             byType,
	}, nil
}

func (m *mockStore) GetSupersessionChain(_ context.Context, memoryID string, maxDepth int) ([]string, error) {
	// Walk the SUPERSEDES chain starting from memoryID
	m.mu.Lock()
	defer m.mu.Unlock()
	if maxDepth <= 0 {
		maxDepth = 10
	}
	var chain []string
	current := memoryID
	for i := 0; i < maxDepth; i++ {
		found := false
		for _, r := range m.relationships {
			if r.SourceID == current && r.RelationshipType == "SUPERSEDES" {
				chain = append(chain, r.TargetID)
				current = r.TargetID
				found = true
				break
			}
		}
		if !found {
			break
		}
	}
	return chain, nil
}

func (m *mockStore) GetSuperseded(_ context.Context, memoryID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.relationships {
		if r.SourceID == memoryID && r.RelationshipType == "SUPERSEDES" {
			return r.TargetID, nil
		}
	}
	return "", nil
}

func (m *mockStore) GetMemory(_ context.Context, id string, _ bool) (*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory not found: %s", id)
	}
	return entry, nil
}

// We need fmt for mockStore
// ─── Stub methods for the rest of core.Store ──────────────────────────────────

func (m *mockStore) AddMemory(_ context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = fmt.Sprintf("mem-%d", len(m.memories)+1)
	}
	m.memories[entry.ID] = entry
	return entry.ID, nil
}
func (m *mockStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error { return nil }
func (m *mockStore) DeleteMemory(_ context.Context, _ string) error            { return nil }
func (m *mockStore) CountMemories(_ context.Context) (int64, error) {
	return int64(len(m.memories)), nil
}
func (m *mockStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) ContentExists(_ context.Context, _ string) (bool, error) { return false, nil }
func (m *mockStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	return nil
}
func (m *mockStore) IncrementRetrievalCount(_ context.Context, _ string) error { return nil }
func (m *mockStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	return "", nil
}
func (m *mockStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) { return nil, nil }
func (m *mockStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return "", nil
}
func (m *mockStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { return nil }
func (m *mockStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) { return nil, nil }
func (m *mockStore) UpdatePeerLastActive(_ context.Context, _ string) error          { return nil }
func (m *mockStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	return "", nil
}
func (m *mockStore) RevokeShareMemory(_ context.Context, _, _ string) error { return nil }
func (m *mockStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (m *mockStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	return "", nil
}
func (m *mockStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockStore) PauseThoughtChain(_ context.Context, _ string) error   { return nil }
func (m *mockStore) ResumeThoughtChain(_ context.Context, _ string) error  { return nil }
func (m *mockStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }
func (m *mockStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *mockStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { return nil }
func (m *mockStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *mockStore) DeleteChunksByPath(_ context.Context, _ string) error { return nil }
func (m *mockStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *mockStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}
func (m *mockStore) Initialize(_ context.Context) error { return nil }
func (m *mockStore) Close(_ context.Context) error      { return nil }
func (m *mockStore) Ping(_ context.Context) error       { return nil }
func (m *mockStore) Stats(_ context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

func TestCreateRelationship(t *testing.T) {
	store := newMockStore()
	rm := NewRelationshipManager(store)
	ctx := context.Background()

	t.Run("valid types", func(t *testing.T) {
		types := []string{"SUPERSEDES", "RELATED_TO", "CONTRADICTS", "DERIVED_FROM", "PARTIAL_UPDATE"}
		for _, typ := range types {
			id, err := rm.CreateRelationship(ctx, "mem1", "mem2", typ, 0.8)
			if err != nil {
				t.Errorf("CreateRelationship(%q) returned error: %v", typ, err)
			}
			if id == "" {
				t.Errorf("CreateRelationship(%q) returned empty ID", typ)
			}
		}
	})

	t.Run("default confidence", func(t *testing.T) {
		freshStore := newMockStore()
		freshRM := NewRelationshipManager(freshStore)
		_, err := freshRM.CreateRelationship(ctx, "a", "b", "RELATED_TO", 0)
		if err != nil {
			t.Fatalf("CreateRelationship with confidence=0 returned error: %v", err)
		}
		// Verify confidence was defaulted to 1.0
		rels, _ := freshStore.GetRelationships(ctx, "a")
		if len(rels) == 0 {
			t.Fatal("expected at least one relationship")
		}
		if rels[0].Confidence != 1.0 {
			t.Errorf("confidence = %f, want 1.0", rels[0].Confidence)
		}
	})

	t.Run("invalid type", func(t *testing.T) {
		_, err := rm.CreateRelationship(ctx, "mem1", "mem2", "INVALID_TYPE", 0.5)
		if err == nil {
			t.Error("expected error for invalid relationship type, got nil")
		}
	})
}

func TestDeleteRelationship(t *testing.T) {
	store := newMockStore()
	rm := NewRelationshipManager(store)
	ctx := context.Background()

	err := rm.DeleteRelationship(ctx, "rel-1")
	if err != nil {
		t.Errorf("DeleteRelationship returned error: %v", err)
	}
}

func TestGetRelatedMemories(t *testing.T) {
	store := newMockStore()
	rm := NewRelationshipManager(store)
	ctx := context.Background()

	// Add memories
	store.memories["mem1"] = &core.MemoryEntry{ID: "mem1", Content: "memory 1"}
	store.memories["mem2"] = &core.MemoryEntry{ID: "mem2", Content: "memory 2"}
	store.memories["mem3"] = &core.MemoryEntry{ID: "mem3", Content: "memory 3"}
	store.memories["mem4"] = &core.MemoryEntry{ID: "mem4", Content: "memory 4"}

	// Create relationships
	rm.CreateRelationship(ctx, "mem1", "mem2", "RELATED_TO", 0.9)
	rm.CreateRelationship(ctx, "mem1", "mem3", "SUPERSEDES", 1.0)
	rm.CreateRelationship(ctx, "mem4", "mem1", "DERIVED_FROM", 0.7)

	t.Run("filter by type", func(t *testing.T) {
		results, err := rm.GetRelatedMemories(ctx, "mem1", "RELATED_TO", 10)
		if err != nil {
			t.Fatalf("GetRelatedMemories returned error: %v", err)
		}
		// mem2 is RELATED_TO from mem1
		if len(results) != 1 {
			t.Errorf("expected 1 result, got %d", len(results))
		}
		if len(results) > 0 && results[0].ID != "mem2" {
			t.Errorf("expected mem2, got %s", results[0].ID)
		}
	})

	t.Run("all types", func(t *testing.T) {
		results, err := rm.GetRelatedMemories(ctx, "mem1", "", 10)
		if err != nil {
			t.Fatalf("GetRelatedMemories returned error: %v", err)
		}
		// mem1 links to: mem2 (RELATED_TO), mem3 (SUPERSEDES), and mem4 links to mem1 (DERIVED_FROM)
		// So we expect 3 related memories: mem2, mem3, mem4
		if len(results) != 3 {
			t.Errorf("expected 3 results, got %d", len(results))
		}
	})

	t.Run("with limit", func(t *testing.T) {
		results, err := rm.GetRelatedMemories(ctx, "mem1", "", 2)
		if err != nil {
			t.Fatalf("GetRelatedMemories returned error: %v", err)
		}
		if len(results) > 2 {
			t.Errorf("expected at most 2 results, got %d", len(results))
		}
	})
}

func TestGetRelationshipSummary(t *testing.T) {
	store := newMockStore()
	rm := NewRelationshipManager(store)
	ctx := context.Background()

	rm.CreateRelationship(ctx, "mem1", "mem2", "RELATED_TO", 0.9)
	rm.CreateRelationship(ctx, "mem1", "mem3", "SUPERSEDES", 1.0)

	summary, err := rm.GetRelationshipSummary(ctx, "mem1")
	if err != nil {
		t.Fatalf("GetRelationshipSummary returned error: %v", err)
	}

	if summary.MemoryID != "mem1" {
		t.Errorf("expected MemoryID mem1, got %s", summary.MemoryID)
	}
	if summary.TotalRelationships != 2 {
		t.Errorf("expected 2 total relationships, got %d", summary.TotalRelationships)
	}
	if summary.ByType["RELATED_TO"] != 1 {
		t.Errorf("expected 1 RELATED_TO, got %d", summary.ByType["RELATED_TO"])
	}
	if summary.ByType["SUPERSEDES"] != 1 {
		t.Errorf("expected 1 SUPERSEDES, got %d", summary.ByType["SUPERSEDES"])
	}
}
