package memory

import (
	"context"
	"fmt"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockElevateStore implements core.Store with only the methods needed by
// ElevateMemory: GetMemory, AddMemory1024, UpdateTrustFields.
// All other methods panic.
type mockElevateStore struct {
	memories     map[string]*core.MemoryEntry
	memories1024 map[string]bool // track which memory IDs have been elevated
	trustUpdates map[string]float64
}

func newMockElevateStore() *mockElevateStore {
	return &mockElevateStore{
		memories:     make(map[string]*core.MemoryEntry),
		memories1024: make(map[string]bool),
		trustUpdates: make(map[string]float64),
	}
}

func (m *mockElevateStore) GetMemory(_ context.Context, id string, _ bool) (*core.MemoryEntry, error) {
	entry, ok := m.memories[id]
	if !ok {
		return nil, nil
	}
	return entry, nil
}

func (m *mockElevateStore) AddMemory1024(_ context.Context, memoryID string, _ []float64) (string, error) {
	m.memories1024[memoryID] = true
	return memoryID, nil
}

func (m *mockElevateStore) UpdateTrustFields(_ context.Context, id string, trustScore float64, _ bool) error {
	m.trustUpdates[id] = trustScore
	return nil
}

// --- Unimplemented methods (panic) ---

func (m *mockElevateStore) Initialize(_ context.Context) error { panic("not implemented") }
func (m *mockElevateStore) Close(_ context.Context) error      { panic("not implemented") }
func (m *mockElevateStore) Ping(_ context.Context) error       { panic("not implemented") }
func (m *mockElevateStore) Stats(_ context.Context) (*core.StatusResult, error) {
	panic("not implemented")
}
func (m *mockElevateStore) AddMemory(_ context.Context, _ *core.MemoryEntry) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error {
	panic("not implemented")
}
func (m *mockElevateStore) DeleteMemory(_ context.Context, _ string) error { panic("not implemented") }
func (m *mockElevateStore) CountMemories(_ context.Context) (int64, error) { panic("not implemented") }
func (m *mockElevateStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) ContentExists(_ context.Context, _ string) (bool, error) {
	panic("not implemented")
}
func (m *mockElevateStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) IncrementRetrievalCount(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) DeleteRelationship(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetSuperseded(_ context.Context, _ string) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("not implemented")
}
func (m *mockElevateStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("not implemented")
}
func (m *mockElevateStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	panic("not implemented")
}
func (m *mockElevateStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error {
	panic("not implemented")
}
func (m *mockElevateStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	panic("not implemented")
}
func (m *mockElevateStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) {
	panic("not implemented")
}
func (m *mockElevateStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) {
	panic("not implemented")
}
func (m *mockElevateStore) UpdatePeerLastActive(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) RevokeShareMemory(_ context.Context, _, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetPeerMemories(_ context.Context, _, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	panic("not implemented")
}
func (m *mockElevateStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	panic("not implemented")
}
func (m *mockElevateStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	panic("not implemented")
}
func (m *mockElevateStore) PauseThoughtChain(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) ResumeThoughtChain(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) AbandonThoughtChain(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	panic("not implemented")
}
func (m *mockElevateStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	panic("not implemented")
}
func (m *mockElevateStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error {
	panic("not implemented")
}
func (m *mockElevateStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	panic("not implemented")
}
func (m *mockElevateStore) DeleteChunksByPath(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("not implemented")
}
func (m *mockElevateStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	panic("not implemented")
}
func (m *mockElevateStore) CountMemories1024(_ context.Context) (int64, error) {
	panic("not implemented")
}
func (m *mockElevateStore) DeleteMemory1024(_ context.Context, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) GetUserProfile(_ context.Context, _ string) (*core.UserProfile, error) {
	panic("not implemented")
}
func (m *mockElevateStore) UpsertUserProfile(_ context.Context, _ *core.UserProfile) error {
	panic("not implemented")
}
func (m *mockElevateStore) GetSecuritySummary(_ context.Context, _ int) (*core.SecuritySummary, error) {
	panic("not implemented")
}
func (m *mockElevateStore) RecordToolRequest(_ context.Context, _, _, _ string) error {
	panic("not implemented")
}
func (m *mockElevateStore) IncrementToolUse(_ context.Context, _, _, _ string) (bool, error) {
	panic("not implemented")
}
func (m *mockElevateStore) GetAgentTools(_ context.Context, _ string) ([]*core.ToolRecord, error) {
	panic("not implemented")
}

// --- Helper: build a 384-dim unit vector ---

func makeUnitVector384() []float64 {
	vec := make([]float64, 384)
	vec[0] = 1.0 // unit vector along first dimension
	return vec
}

func makeMemoryEntry(id string, trustScore float64, vector []float64) *core.MemoryEntry {
	return &core.MemoryEntry{
		ID:         id,
		Content:    fmt.Sprintf("test memory %s", id),
		Vector:     vector,
		TrustScore: trustScore,
		SourceType: "session",
	}
}

// --- Tests ---

func TestElevateMemory_Success(t *testing.T) {
	t.Parallel()

	store := newMockElevateStore()
	mem := makeMemoryEntry("mem-1", 0.5, makeUnitVector384())
	store.memories["mem-1"] = mem

	ms := NewWithComponents(store, nil, nil, &core.Config{})

	result, err := ms.ElevateMemory(context.Background(), "mem-1", nil, 0)
	if err != nil {
		t.Fatalf("ElevateMemory: %v", err)
	}

	if result.MemoryID != "mem-1" {
		t.Errorf("memoryId: got %q, want %q", result.MemoryID, "mem-1")
	}
	if !result.Elevated {
		t.Error("elevated: got false, want true")
	}
	if result.VectorDim != 1024 {
		t.Errorf("vectorDim: got %d, want %d", result.VectorDim, 1024)
	}
	// Default trustBoost is 0.10, so 0.5 + 0.10 = 0.6
	if result.TrustScore != 0.6 {
		t.Errorf("trustScore: got %f, want %f", result.TrustScore, 0.6)
	}

	// Verify 1024 entry was created
	if !store.memories1024["mem-1"] {
		t.Error("memory was not added to memories_1024")
	}

	// Verify trust was updated
	if store.trustUpdates["mem-1"] != 0.6 {
		t.Errorf("trust update: got %f, want %f", store.trustUpdates["mem-1"], 0.6)
	}
}

func TestElevateMemory_MemoryNotFound(t *testing.T) {
	t.Parallel()

	store := newMockElevateStore()
	ms := NewWithComponents(store, nil, nil, &core.Config{})

	_, err := ms.ElevateMemory(context.Background(), "nonexistent", nil, 0)
	if err == nil {
		t.Fatal("expected error for nonexistent memory")
	}
	if got := err.Error(); got == "" {
		t.Error("error message should not be empty")
	}
}

func TestElevateMemory_WithCustomVector(t *testing.T) {
	t.Parallel()

	store := newMockElevateStore()
	mem := makeMemoryEntry("mem-2", 0.5, makeUnitVector384())
	store.memories["mem-2"] = mem

	ms := NewWithComponents(store, nil, nil, &core.Config{})

	// Provide a custom 1024-dim vector (all zeros except pos 0)
	customVec := make([]float64, 1024)
	customVec[0] = 1.0

	result, err := ms.ElevateMemory(context.Background(), "mem-2", customVec, 0.20)
	if err != nil {
		t.Fatalf("ElevateMemory: %v", err)
	}

	if result.TrustScore != 0.7 {
		t.Errorf("trustScore: got %f, want %f", result.TrustScore, 0.7)
	}
	if result.VectorDim != 1024 {
		t.Errorf("vectorDim: got %d, want %d", result.VectorDim, 1024)
	}
}

func TestElevateMemory_TrustClamped(t *testing.T) {
	t.Parallel()

	store := newMockElevateStore()
	// Memory already at high trust (0.95)
	mem := makeMemoryEntry("mem-3", 0.95, makeUnitVector384())
	store.memories["mem-3"] = mem

	ms := NewWithComponents(store, nil, nil, &core.Config{})

	// Large trustBoost would push past 1.0; should be clamped
	result, err := ms.ElevateMemory(context.Background(), "mem-3", nil, 0.50)
	if err != nil {
		t.Fatalf("ElevateMemory: %v", err)
	}

	if result.TrustScore != 1.0 {
		t.Errorf("trustScore: got %f, want %f (clamped to 1.0)", result.TrustScore, 1.0)
	}
}

func TestElevateMemory_WrongVectorDim(t *testing.T) {
	t.Parallel()

	store := newMockElevateStore()
	// Memory with wrong-sized vector (128 instead of 384)
	vec128 := make([]float64, 128)
	vec128[0] = 1.0
	mem := makeMemoryEntry("mem-4", 0.5, vec128)
	store.memories["mem-4"] = mem

	ms := NewWithComponents(store, nil, nil, &core.Config{})

	_, err := ms.ElevateMemory(context.Background(), "mem-4", nil, 0)
	if err == nil {
		t.Fatal("expected error for wrong vector dimension")
	}
}
