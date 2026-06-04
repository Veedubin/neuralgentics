package memory

import (
	"context"
	"fmt"
	"testing"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockPeerStore implements core.Store with only peer-related methods functional.
// All other methods panic to ensure only peer code paths are tested.
type mockPeerStore struct {
	peers    map[string]*core.PeerProfile
	memories map[string]*core.MemoryEntry
	shares   []mockShare
	peerSeq  int
}

type mockShare struct {
	id         string
	memoryID   string
	peerID     string
	permission string
	grantedBy  string
}

func newMockPeerStore() *mockPeerStore {
	return &mockPeerStore{
		peers:    make(map[string]*core.PeerProfile),
		memories: make(map[string]*core.MemoryEntry),
	}
}

// --- Peer Store methods ---

func (m *mockPeerStore) AddPeer(_ context.Context, peer *core.PeerProfile) (string, error) {
	m.peerSeq++
	if peer.ID == "" {
		peer.ID = fmt.Sprintf("peer-%d", m.peerSeq)
	}
	peer.IsActive = true
	clone := *peer
	m.peers[clone.ID] = &clone
	return clone.ID, nil
}

func (m *mockPeerStore) GetPeer(_ context.Context, id string) (*core.PeerProfile, error) {
	p, ok := m.peers[id]
	if !ok {
		return nil, nil
	}
	return p, nil
}

func (m *mockPeerStore) ListPeers(_ context.Context, limit int) ([]*core.PeerProfile, error) {
	var results []*core.PeerProfile
	for _, p := range m.peers {
		results = append(results, p)
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockPeerStore) UpdatePeerLastActive(_ context.Context, id string) error {
	return nil
}

func (m *mockPeerStore) ShareMemory(_ context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	shareID := "share-1"
	m.shares = append(m.shares, mockShare{
		id: shareID, memoryID: memoryID, peerID: peerID,
		permission: permission, grantedBy: grantedBy,
	})
	return shareID, nil
}

func (m *mockPeerStore) RevokeShareMemory(_ context.Context, memoryID, peerID string) error {
	return nil
}

func (m *mockPeerStore) GetSharedMemories(_ context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	var results []*core.MemoryEntry
	for _, s := range m.shares {
		if s.peerID == peerID {
			if mem, ok := m.memories[s.memoryID]; ok {
				results = append(results, mem)
			}
		}
	}
	return results, nil
}

func (m *mockPeerStore) GetPeerMemories(_ context.Context, peerID, query string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	var results []*core.MemoryEntry
	for _, mem := range m.memories {
		if mem.PeerID == peerID {
			results = append(results, mem)
		}
	}
	return results, nil
}

// --- Stub implementations for unused core.Store methods (panic) ---

func (m *mockPeerStore) Initialize(_ context.Context) error { panic("stub") }
func (m *mockPeerStore) Close(_ context.Context) error      { panic("stub") }
func (m *mockPeerStore) Ping(_ context.Context) error       { panic("stub") }
func (m *mockPeerStore) Stats(_ context.Context) (*core.StatusResult, error) {
	panic("stub")
}
func (m *mockPeerStore) AddMemory(_ context.Context, _ *core.MemoryEntry) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetMemory(_ context.Context, _ string, _ bool) (*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error {
	panic("stub")
}
func (m *mockPeerStore) DeleteMemory(_ context.Context, _ string) error { panic("stub") }
func (m *mockPeerStore) CountMemories(_ context.Context) (int64, error) { panic("stub") }
func (m *mockPeerStore) ListMemories(_ context.Context, _ *core.SearchFilter, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) ContentExists(_ context.Context, _ string) (bool, error) { panic("stub") }
func (m *mockPeerStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	panic("stub")
}
func (m *mockPeerStore) IncrementRetrievalCount(_ context.Context, _ string) error { panic("stub") }
func (m *mockPeerStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) DeleteRelationship(_ context.Context, _ string) error { panic("stub") }
func (m *mockPeerStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	panic("stub")
}
func (m *mockPeerStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	panic("stub")
}
func (m *mockPeerStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetSuperseded(_ context.Context, _ string) (string, error) { panic("stub") }
func (m *mockPeerStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) { panic("stub") }
func (m *mockPeerStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockPeerStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockPeerStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockPeerStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { panic("stub") }
func (m *mockPeerStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockPeerStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockPeerStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockPeerStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockPeerStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockPeerStore) PauseThoughtChain(_ context.Context, _ string) error   { panic("stub") }
func (m *mockPeerStore) ResumeThoughtChain(_ context.Context, _ string) error  { panic("stub") }
func (m *mockPeerStore) AbandonThoughtChain(_ context.Context, _ string) error { panic("stub") }
func (m *mockPeerStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	panic("stub")
}
func (m *mockPeerStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	panic("stub")
}
func (m *mockPeerStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { panic("stub") }
func (m *mockPeerStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockPeerStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	panic("stub")
}
func (m *mockPeerStore) DeleteChunksByPath(_ context.Context, _ string) error { panic("stub") }
func (m *mockPeerStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	panic("stub")
}
func (m *mockPeerStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}
func (m *mockPeerStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", nil
}
func (m *mockPeerStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockPeerStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockPeerStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockPeerStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// ─── User Profile + Security Summary stubs ───────────────────────────────────

func (m *mockPeerStore) GetUserProfile(_ context.Context, _ string) (*core.UserProfile, error) {
	return nil, nil
}
func (m *mockPeerStore) UpsertUserProfile(_ context.Context, _ *core.UserProfile) error {
	return nil
}
func (m *mockPeerStore) GetSecuritySummary(_ context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{
		TotalEvents:    0,
		CriticalCount:  0,
		EventsPerType:  map[string]int{},
		EventsPerAgent: map[string]int{},
		SeverityCounts: map[string]int{},
	}, nil
}

// ─── Peer Facade Unit Tests ────────────────────────────────────────────────────

func TestListPeers(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	// Add peers directly to the store
	id1, _ := store.AddPeer(ctx, &core.PeerProfile{Name: "agent-1", Role: "OWNER", TrustLevel: 1.0})
	id2, _ := store.AddPeer(ctx, &core.PeerProfile{Name: "agent-2", Role: "COLLABORATOR", TrustLevel: 0.8})

	peers, err := mem.ListPeers(ctx, 10)
	if err != nil {
		t.Fatalf("ListPeers returned error: %v", err)
	}
	if len(peers) != 2 {
		t.Fatalf("expected 2 peers, got %d", len(peers))
	}

	// Verify both peers are present
	names := map[string]bool{peers[0].Name: true, peers[1].Name: true}
	if !names["agent-1"] || !names["agent-2"] {
		t.Fatalf("expected agent-1 and agent-2, got %v", peers)
	}
	_ = id1
	_ = id2
}

func TestListPeers_DefaultLimit(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	// Calling with limit <= 0 should use default limit of 100
	// Empty store returns nil slice, which is valid
	peers, err := mem.ListPeers(ctx, 0)
	if err != nil {
		t.Fatalf("ListPeers with limit=0 returned error: %v", err)
	}
	// Empty store returns nil from the mock — that's OK
	if peers != nil && len(peers) != 0 {
		t.Fatalf("expected empty or nil peers, got %d", len(peers))
	}
}

func TestAddPeer(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	peer := &core.PeerProfile{
		Name:       "test-agent",
		Role:       "CODER",
		TrustLevel: 0.5,
		IsActive:   true,
	}

	id, err := mem.AddPeer(ctx, peer)
	if err != nil {
		t.Fatalf("AddPeer returned error: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty peer ID")
	}

	// Verify peer was stored
	stored, err := store.GetPeer(ctx, id)
	if err != nil {
		t.Fatalf("GetPeer returned error: %v", err)
	}
	if stored.Name != "test-agent" {
		t.Fatalf("expected peer name 'test-agent', got '%s'", stored.Name)
	}
}

func TestShareMemory(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	shareID, err := mem.ShareMemory(ctx, "mem-1", "peer-1", "shared", "owner-1")
	if err != nil {
		t.Fatalf("ShareMemory returned error: %v", err)
	}
	if shareID == "" {
		t.Fatal("expected non-empty share ID")
	}
}

func TestGetPeerMemories(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	// Add a peer and a memory owned by that peer
	store.AddPeer(ctx, &core.PeerProfile{Name: "peer-1", Role: "OWNER", TrustLevel: 1.0})

	// Add memory directly via store (peer_id not set in mock; GetPeerMemories
	// checks mem.PeerID == peerID, so we need a memory with that field set)
	store.memories["mem-1"] = &core.MemoryEntry{
		ID:      "mem-1",
		Content: "test content",
		PeerID:  "peer-1",
	}

	results, err := mem.GetPeerMemories(ctx, "peer-1", "", &core.SearchOptions{TopK: 10})
	if err != nil {
		t.Fatalf("GetPeerMemories returned error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 memory, got %d", len(results))
	}
	if results[0].Content != "test content" {
		t.Fatalf("expected 'test content', got '%s'", results[0].Content)
	}
}

func TestGetSharedMemories(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	// Share a memory with a peer
	store.AddPeer(ctx, &core.PeerProfile{Name: "owner", Role: "OWNER", TrustLevel: 1.0})
	store.AddPeer(ctx, &core.PeerProfile{Name: "recipient", Role: "GUEST", TrustLevel: 0.3})

	// Add a memory and share it
	store.memories["mem-1"] = &core.MemoryEntry{
		ID:      "mem-1",
		Content: "shared content",
	}
	mem.ShareMemory(ctx, "mem-1", "peer-1", "shared", "owner-1")

	results, err := mem.GetSharedMemories(ctx, "peer-1", 10)
	if err != nil {
		t.Fatalf("GetSharedMemories returned error: %v", err)
	}
	// The mock store should find the share
	if len(results) < 1 {
		t.Fatalf("expected at least 1 shared memory, got %d", len(results))
	}
}

func TestGetSharedMemories_DefaultLimit(t *testing.T) {
	store := newMockPeerStore()
	mem := NewWithComponents(store, nil, nil, &core.Config{})
	ctx := context.Background()

	// Calling with limit <= 0 should use default limit of 100
	results, err := mem.GetSharedMemories(ctx, "peer-1", 0)
	if err != nil {
		t.Fatalf("GetSharedMemories with limit=0 returned error: %v", err)
	}
	// Empty shares is fine — nil or empty slice both acceptable
	if results != nil && len(results) != 0 {
		t.Fatalf("expected empty or nil results, got %d", len(results))
	}
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockPeerStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}
func (m *mockPeerStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}
func (m *mockPeerStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
