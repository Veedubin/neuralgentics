package decay

import (
	"context"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Mock Store ──────────────────────────────────────────────────────────────

// mockStore implements core.Store for testing the decay engine.
type mockStore struct {
	mu sync.RWMutex

	memories       map[string]*core.MemoryEntry
	relationships  []core.Relationship
	trustUpdates   []trustUpdate
	decayRates     map[string]float64
	auditEvents    []*core.AuditEvent
	fadingMemories []*core.MemoryEntry
}

type trustUpdate struct {
	id       string
	score    float64
	archived bool
}

func newMockStore() *mockStore {
	return &mockStore{
		memories:   make(map[string]*core.MemoryEntry),
		decayRates: make(map[string]float64),
	}
}

func (m *mockStore) AddMemory(_ context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = "gen-id"
	}
	m.memories[entry.ID] = entry
	return entry.ID, nil
}

func (m *mockStore) GetMemory(_ context.Context, id string, _ bool) (*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, nil
	}
	return entry, nil
}

func (m *mockStore) UpdateMemory(_ context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.memories[entry.ID] = entry
	return nil
}

func (m *mockStore) DeleteMemory(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.memories, id)
	return nil
}

func (m *mockStore) CountMemories(_ context.Context) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var count int64
	for _, e := range m.memories {
		if !e.IsArchived {
			count++
		}
	}
	return count, nil
}

func (m *mockStore) ListMemories(_ context.Context, filter *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []*core.MemoryEntry
	for _, entry := range m.memories {
		if filter != nil && filter.IsArchived != nil {
			if entry.IsArchived != *filter.IsArchived {
				continue
			}
		}
		if filter != nil && filter.MinTrustScore > 0 {
			if entry.TrustScore < filter.MinTrustScore {
				continue
			}
		}
		results = append(results, entry)
	}
	return results, nil
}

func (m *mockStore) ContentExists(_ context.Context, _ string) (bool, error) {
	return false, nil
}

func (m *mockStore) UpdateTrustFields(_ context.Context, id string, trustScore float64, archived bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.trustUpdates = append(m.trustUpdates, trustUpdate{id: id, score: trustScore, archived: archived})
	if entry, ok := m.memories[id]; ok {
		entry.TrustScore = trustScore
		entry.IsArchived = archived
	}
	return nil
}

func (m *mockStore) IncrementRetrievalCount(_ context.Context, _ string) error { return nil }

func (m *mockStore) CreateRelationship(_ context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	relID := "rel-id"
	m.relationships = append(m.relationships, core.Relationship{
		SourceID: sourceID, TargetID: targetID,
		RelationshipType: relType, Confidence: confidence,
	})
	return relID, nil
}

func (m *mockStore) DeleteRelationship(_ context.Context, _ string) error { return nil }

func (m *mockStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	return nil, nil
}

func (m *mockStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	return nil, nil
}

func (m *mockStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, nil
}

func (m *mockStore) GetSuperseded(_ context.Context, _ string) (string, error) { return "", nil }

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

func (m *mockStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) { return "", nil }

func (m *mockStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) { return nil, nil }

func (m *mockStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) { return nil, nil }

func (m *mockStore) UpdatePeerLastActive(_ context.Context, _ string) error { return nil }

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

func (m *mockStore) PauseThoughtChain(_ context.Context, _ string) error { return nil }

func (m *mockStore) ResumeThoughtChain(_ context.Context, _ string) error { return nil }

func (m *mockStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }

func (m *mockStore) LogAuditEvent(_ context.Context, event *core.AuditEvent) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.auditEvents = append(m.auditEvents, event)
	return "audit-id", nil
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

func (m *mockStore) UpdateDecayRate(_ context.Context, id string, rate float64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.decayRates[id] = rate
	return nil
}

func (m *mockStore) ListFadingMemories(_ context.Context, threshold float64, _ int) ([]*core.MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.fadingMemories != nil {
		return m.fadingMemories, nil
	}
	// Fallback: compute from memories.
	var results []*core.MemoryEntry
	for _, entry := range m.memories {
		if !entry.IsArchived && entry.TrustScore < threshold {
			results = append(results, entry)
		}
	}
	return results, nil
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

func (m *mockStore) Close(_ context.Context) error { return nil }

func (m *mockStore) Ping(_ context.Context) error { return nil }

func (m *mockStore) Stats(_ context.Context) (*core.StatusResult, error) { return nil, nil }

func (m *mockStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

func (m *mockStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

func (m *mockStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// ─── Tests ────────────────────────────────────────────────────────────────────

func TestExponentialDecay(t *testing.T) {
	// After 30 days (one half-life), score should be ~0.5
	halfLife := 30 * 24 * time.Hour
	score := exponentialDecay(1.0, halfLife, halfLife)
	if score < 0.49 || score > 0.51 {
		t.Errorf("exponentialDecay(1.0, 30d, 30d) = %f, want ~0.5", score)
	}

	// At t=0, score should remain unchanged.
	score = exponentialDecay(0.8, 0, halfLife)
	if score != 0.8 {
		t.Errorf("exponentialDecay(0.8, 0, 30d) = %f, want 0.8", score)
	}

	// After 60 days (2 half-lives), score should be ~0.25.
	score = exponentialDecay(1.0, 60*24*time.Hour, halfLife)
	if score < 0.24 || score > 0.26 {
		t.Errorf("exponentialDecay(1.0, 60d, 30d) = %f, want ~0.25", score)
	}
}

func TestApplyDecay(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	ctx := context.Background()

	now := time.Now()
	entry := &core.MemoryEntry{
		ID:         "mem-1",
		Content:    "test memory",
		TrustScore: 0.8,
		IsArchived: false,
		CreatedAt:  now.Add(-48 * time.Hour), // 2 days old
	}
	store.memories["mem-1"] = entry

	err := engine.ApplyDecay(ctx, "mem-1")
	if err != nil {
		t.Fatalf("ApplyDecay returned error: %v", err)
	}

	// Trust score should have decreased.
	updated := store.memories["mem-1"]
	if updated.TrustScore >= 0.8 {
		t.Errorf("TrustScore should have decreased, got %f", updated.TrustScore)
	}
	if updated.IsArchived {
		t.Error("Memory should not be archived after 2 days of decay")
	}
}

func TestApplyDecay_ArchivesLowTrust(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	ctx := context.Background()

	now := time.Now()
	entry := &core.MemoryEntry{
		ID:         "mem-low",
		Content:    "fading memory",
		TrustScore: 0.05,
		IsArchived: false,
		CreatedAt:  now.Add(-90 * 24 * time.Hour), // 90 days old — very low trust
	}
	store.memories["mem-low"] = entry

	err := engine.ApplyDecay(ctx, "mem-low")
	if err != nil {
		t.Fatalf("ApplyDecay returned error: %v", err)
	}

	// Verify UpdateTrustFields was called with archived=true.
	var found bool
	for _, u := range store.trustUpdates {
		if u.id == "mem-low" && u.archived {
			found = true
		}
	}
	if !found {
		t.Error("Expected memory to be archived (UpdateTrustFields with archived=true)")
	}
}

func TestApplyDecay_SkipsArchived(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	ctx := context.Background()

	entry := &core.MemoryEntry{
		ID:         "mem-archived",
		Content:    "already archived",
		TrustScore: 0.01,
		IsArchived: true,
		CreatedAt:  time.Now().Add(-100 * 24 * time.Hour),
	}
	store.memories["mem-archived"] = entry

	err := engine.ApplyDecay(ctx, "mem-archived")
	if err != nil {
		t.Fatalf("ApplyDecay on archived memory returned error: %v", err)
	}

	// No trust updates should have been made.
	for _, u := range store.trustUpdates {
		if u.id == "mem-archived" {
			t.Error("Archived memory should not have trust updates")
		}
	}
}

func TestAdjustDecayRate(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	ctx := context.Background()

	tests := []struct {
		input    float64
		expected float64
	}{
		{5.0, 5.0},
		{0.05, 0.1},  // clamped to min
		{15.0, 10.0}, // clamped to max
		{0.1, 0.1},
		{10.0, 10.0},
	}

	for _, tt := range tests {
		err := engine.AdjustDecayRate(ctx, "mem-1", tt.input)
		if err != nil {
			t.Errorf("AdjustDecayRate(%f) returned error: %v", tt.input, err)
		}
		if store.decayRates["mem-1"] != tt.expected {
			t.Errorf("AdjustDecayRate(%f): stored rate = %f, want %f", tt.input, store.decayRates["mem-1"], tt.expected)
		}
	}

	// Verify audit event was logged.
	if len(store.auditEvents) != len(tests) {
		t.Errorf("expected %d audit events, got %d", len(tests), len(store.auditEvents))
	}
}

func TestGetDecayStatus(t *testing.T) {
	store := newMockStore()
	engine := NewDecayEngine(store)
	ctx := context.Background()

	now := time.Now()
	// Add a fading memory (trust < 0.3, not archived).
	store.memories["fading-1"] = &core.MemoryEntry{
		ID: "fading-1", Content: "fading", TrustScore: 0.2, IsArchived: false, CreatedAt: now,
	}
	// Add an archived memory.
	store.memories["archived-1"] = &core.MemoryEntry{
		ID: "archived-1", Content: "archived", TrustScore: 0.05, IsArchived: true, CreatedAt: now,
	}

	status, err := engine.GetDecayStatus(ctx)
	if err != nil {
		t.Fatalf("GetDecayStatus returned error: %v", err)
	}

	if !status.Enabled {
		t.Error("Expected Enabled = true")
	}
	if status.HalfLifeDays != 30 {
		t.Errorf("HalfLifeDays = %d, want 30", status.HalfLifeDays)
	}
	if status.FadingCount != 1 {
		t.Errorf("FadingCount = %d, want 1", status.FadingCount)
	}
	if status.ArchivedCount != 1 {
		t.Errorf("ArchivedCount = %d, want 1", status.ArchivedCount)
	}
}
