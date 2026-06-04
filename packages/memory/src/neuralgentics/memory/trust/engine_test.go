package trust

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockStore implements core.Store with in-memory storage for unit tests.
type mockStore struct {
	mu          sync.Mutex
	memories    map[string]*core.MemoryEntry
	adjustments []*core.TrustAdjustment
	counter     int
}

func newMockStore() *mockStore {
	return &mockStore{
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (m *mockStore) nextID() int {
	m.counter++
	return m.counter
}

// --- core.Store interface implementation ---

func (m *mockStore) Initialize(ctx context.Context) error { return nil }
func (m *mockStore) Close(ctx context.Context) error      { return nil }
func (m *mockStore) Ping(ctx context.Context) error       { return nil }
func (m *mockStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}

func (m *mockStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = fmt.Sprintf("mem-%d", m.nextID())
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
		entry.UpdatedAt = time.Now()
	}
	clone := *entry
	m.memories[clone.ID] = &clone
	return clone.ID, nil
}

func (m *mockStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	if !includeArchived && entry.IsArchived {
		return nil, fmt.Errorf("memory %s is archived", id)
	}
	clone := *entry
	return &clone, nil
}

func (m *mockStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.memories[entry.ID]; !ok {
		return fmt.Errorf("memory %s not found", entry.ID)
	}
	clone := *entry
	m.memories[entry.ID] = &clone
	return nil
}

func (m *mockStore) DeleteMemory(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	entry.IsArchived = true
	entry.UpdatedAt = time.Now()
	return nil
}

func (m *mockStore) CountMemories(ctx context.Context) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var count int64
	for _, e := range m.memories {
		if !e.IsArchived {
			count++
		}
	}
	return count, nil
}

func (m *mockStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if filter != nil && filter.IsArchived != nil {
			if e.IsArchived != *filter.IsArchived {
				continue
			}
		}
		clone := *e
		results = append(results, &clone)
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.memories {
		if e.ContentHash == contentHash {
			return true, nil
		}
	}
	return false, nil
}

func (m *mockStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

func (m *mockStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	entry.TrustScore = trustScore
	entry.IsArchived = archived
	entry.UpdatedAt = time.Now()
	return nil
}

func (m *mockStore) IncrementRetrievalCount(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	entry.RetrievalCount++
	return nil
}

func (m *mockStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if adj.ID == "" {
		adj.ID = fmt.Sprintf("adj-%d", m.nextID())
	}
	clone := *adj
	clone.CreatedAt = time.Now()
	m.adjustments = append(m.adjustments, &clone)
	return clone.ID, nil
}

func (m *mockStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.TrustAdjustment
	for _, a := range m.adjustments {
		if a.MemoryID == memoryID {
			clone := *a
			results = append(results, &clone)
		}
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// Stub implementations for the remaining core.Store methods.
// These return empty/nil values since the trust engine doesn't use them.

func (m *mockStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *mockStore) DeleteRelationship(ctx context.Context, id string) error { return nil }
func (m *mockStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *mockStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	return nil, nil
}
func (m *mockStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	return "", nil
}
func (m *mockStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	return "", nil
}
func (m *mockStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	return nil, nil
}
func (m *mockStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *mockStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	return nil
}
func (m *mockStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockStore) UpdatePeerLastActive(ctx context.Context, id string) error { return nil }
func (m *mockStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return "", nil
}
func (m *mockStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	return nil
}
func (m *mockStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	return "", nil
}
func (m *mockStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	return "", nil
}
func (m *mockStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockStore) PauseThoughtChain(ctx context.Context, chainID string) error   { return nil }
func (m *mockStore) ResumeThoughtChain(ctx context.Context, chainID string) error  { return nil }
func (m *mockStore) AbandonThoughtChain(ctx context.Context, chainID string) error { return nil }
func (m *mockStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return nil
}
func (m *mockStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *mockStore) DeleteChunksByPath(ctx context.Context, path string) error { return nil }
func (m *mockStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *mockStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}

// v0.7.0 dual-model RRF methods
func (m *mockStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", fmt.Errorf("stub")
}
func (m *mockStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, fmt.Errorf("stub")
}
func (m *mockStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// --- Helpers ---

// addTestMemory is a helper that adds a memory to the mock store and returns its ID.
func addTestMemory(s *mockStore, trustScore float64, isArchived bool) string {
	id := fmt.Sprintf("test-mem-%d", len(s.memories)+1)
	entry := &core.MemoryEntry{
		ID:             id,
		Content:        "test content",
		SourceType:     "session",
		ContentHash:    "hash-" + id,
		TrustScore:     trustScore,
		IsArchived:     isArchived,
		RetrievalCount: 5,
		Metadata:       map[string]any{"decay_rate": 1.0},
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}
	s.memories[id] = entry
	return id
}

// --- Unit Tests ---

func TestGetTrustScore(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.75, false)
	engine := NewTrustEngine(store)

	result, err := engine.GetTrustScore(context.Background(), id)
	if err != nil {
		t.Fatalf("GetTrustScore returned error: %v", err)
	}
	if result.MemoryID != id {
		t.Errorf("MemoryID = %q, want %q", result.MemoryID, id)
	}
	if result.TrustScore != 0.75 {
		t.Errorf("TrustScore = %f, want 0.75", result.TrustScore)
	}
	if result.RetrievalCount != 5 {
		t.Errorf("RetrievalCount = %d, want 5", result.RetrievalCount)
	}
	if result.IsArchived {
		t.Error("IsArchived = true, want false")
	}
	if result.DecayRate != 1.0 {
		t.Errorf("DecayRate = %f, want 1.0", result.DecayRate)
	}
}

func TestGetTrustScore_NotFound(t *testing.T) {
	store := newMockStore()
	engine := NewTrustEngine(store)

	_, err := engine.GetTrustScore(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent memory, got nil")
	}
}

func TestAdjustTrust_AgentUsed(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.50, false)
	engine := NewTrustEngine(store)

	adj, err := engine.AdjustTrust(context.Background(), id, core.SignalAgentUsed)
	if err != nil {
		t.Fatalf("AdjustTrust returned error: %v", err)
	}
	if adj.OldScore != 0.50 {
		t.Errorf("OldScore = %f, want 0.50", adj.OldScore)
	}
	if adj.NewScore != 0.55 {
		t.Errorf("NewScore = %f, want 0.55", adj.NewScore)
	}
	if adj.Signal != "agent_used" {
		t.Errorf("Signal = %q, want %q", adj.Signal, "agent_used")
	}

	// Verify the memory was updated
	result, _ := engine.GetTrustScore(context.Background(), id)
	if result.TrustScore != 0.55 {
		t.Errorf("trust score after adjust = %f, want 0.55", result.TrustScore)
	}
}

func TestAdjustTrust_UserCorrected(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.05, false)
	engine := NewTrustEngine(store)

	adj, err := engine.AdjustTrust(context.Background(), id, core.SignalUserCorrected)
	if err != nil {
		t.Fatalf("AdjustTrust returned error: %v", err)
	}
	// 0.05 + (-0.10) = -0.05, clamped to 0.0
	if adj.NewScore != 0.0 {
		t.Errorf("NewScore = %f, want 0.0 (clamped from -0.05)", adj.NewScore)
	}
	if adj.OldScore != 0.05 {
		t.Errorf("OldScore = %f, want 0.05", adj.OldScore)
	}

	// Verify the adjustment amount reflects the actual change, not just the signal delta
	if adj.AdjustmentAmount != -0.05 {
		t.Errorf("AdjustmentAmount = %f, want -0.05 (clamped delta)", adj.AdjustmentAmount)
	}
}

func TestAdjustTrust_ClampUpper(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.95, false)
	engine := NewTrustEngine(store)

	adj, err := engine.AdjustTrust(context.Background(), id, core.SignalUserConfirmed)
	if err != nil {
		t.Fatalf("AdjustTrust returned error: %v", err)
	}
	// 0.95 + 0.10 = 1.05, clamped to 1.0
	if adj.NewScore != 1.0 {
		t.Errorf("NewScore = %f, want 1.0 (clamped from 1.05)", adj.NewScore)
	}
}

func TestAdjustTrust_UnknownSignal(t *testing.T) {
	store := newMockStore()
	engine := NewTrustEngine(store)

	_, err := engine.AdjustTrust(context.Background(), "any-id", core.TrustSignal("unknown_signal"))
	if err == nil {
		t.Fatal("expected error for unknown signal, got nil")
	}
}

func TestListArchived(t *testing.T) {
	store := newMockStore()
	engine := NewTrustEngine(store)

	// Add one active and one archived memory
	activeID := addTestMemory(store, 0.8, false)
	_ = activeID
	archivedID := addTestMemory(store, 0.2, true)
	_ = archivedID

	// Another active memory
	_ = addTestMemory(store, 0.6, false)

	results, err := engine.ListArchived(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListArchived returned error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("ListArchived returned %d results, want 1", len(results))
	}
	if !results[0].IsArchived {
		t.Error("expected archived memory, got active memory")
	}
}

func TestPromoteMemory(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.3, true) // start archived
	engine := NewTrustEngine(store)

	// Verify initially archived
	result, _ := engine.GetTrustScore(context.Background(), id)
	if !result.IsArchived {
		t.Fatal("memory should start archived")
	}

	// Promote
	if err := engine.PromoteMemory(context.Background(), id); err != nil {
		t.Fatalf("PromoteMemory returned error: %v", err)
	}

	// Verify un-archived, trust score preserved
	result, _ = engine.GetTrustScore(context.Background(), id)
	if result.IsArchived {
		t.Error("memory should be un-archived after promotion")
	}
	if result.TrustScore != 0.3 {
		t.Errorf("trust score = %f, want 0.3 (preserved)", result.TrustScore)
	}
}

func TestPromoteMemory_AlreadyActive(t *testing.T) {
	store := newMockStore()
	id := addTestMemory(store, 0.8, false) // already active
	engine := NewTrustEngine(store)

	// Promote should be a no-op
	if err := engine.PromoteMemory(context.Background(), id); err != nil {
		t.Fatalf("PromoteMemory on active memory returned error: %v", err)
	}

	result, _ := engine.GetTrustScore(context.Background(), id)
	if result.IsArchived {
		t.Error("active memory should not become archived")
	}
	if result.TrustScore != 0.8 {
		t.Errorf("trust score = %f, want 0.8", result.TrustScore)
	}
}

func TestClamp(t *testing.T) {
	tests := []struct {
		v, min, max, want float64
	}{
		{0.5, 0.0, 1.0, 0.5},
		{-0.1, 0.0, 1.0, 0.0},
		{1.5, 0.0, 1.0, 1.0},
		{0.0, 0.0, 1.0, 0.0},
		{1.0, 0.0, 1.0, 1.0},
		{0.5, -1.0, 2.0, 0.5},
	}
	for _, tt := range tests {
		got := clamp(tt.v, tt.min, tt.max)
		if got != tt.want {
			t.Errorf("clamp(%f, %f, %f) = %f, want %f", tt.v, tt.min, tt.max, got, tt.want)
		}
	}
}

// Phase 2 part 1 stubs for new core.Store interface methods

func (m *mockStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	return nil, nil
}

func (m *mockStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	return nil
}

func (m *mockStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}

func (m *mockStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}

func (m *mockStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
