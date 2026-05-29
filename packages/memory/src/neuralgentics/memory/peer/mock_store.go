package peer

import (
	"context"
	"fmt"
	"sync"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockStore implements core.Store with in-memory storage for peer tests.
// Only peer-related and memory-related methods are functional; unused methods panic.
type mockStore struct {
	mu            sync.Mutex
	peers         map[string]*core.PeerProfile
	memories      map[string]*core.MemoryEntry
	shares        []shareEntry
	peerCounter   int
	memoryCounter int
}

type shareEntry struct {
	id         string
	memoryID   string
	peerID     string
	permission string
	grantedBy  string
	createdAt  time.Time
}

func newMockStore() *mockStore {
	return &mockStore{
		peers:    make(map[string]*core.PeerProfile),
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (m *mockStore) nextPeerID() int {
	m.peerCounter++
	return m.peerCounter
}

func (m *mockStore) nextMemoryID() int {
	m.memoryCounter++
	return m.memoryCounter
}

// --- Peer Store methods ---

func (m *mockStore) AddPeer(_ context.Context, peer *core.PeerProfile) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if peer.ID == "" {
		peer.ID = fmt.Sprintf("peer-%d", m.nextPeerID())
	}
	if peer.CreatedAt.IsZero() {
		peer.CreatedAt = time.Now()
	}
	clone := *peer
	m.peers[clone.ID] = &clone
	return clone.ID, nil
}

func (m *mockStore) GetPeer(_ context.Context, id string) (*core.PeerProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.peers[id]
	if !ok {
		return nil, fmt.Errorf("peer %s not found", id)
	}
	clone := *p
	return &clone, nil
}

func (m *mockStore) ListPeers(_ context.Context, limit int) ([]*core.PeerProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.PeerProfile
	for _, p := range m.peers {
		clone := *p
		results = append(results, &clone)
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (m *mockStore) UpdatePeerLastActive(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.peers[id]
	if !ok {
		return fmt.Errorf("peer %s not found", id)
	}
	now := time.Now()
	p.LastActiveAt = &now
	return nil
}

// --- Memory Store methods ---

func (m *mockStore) AddMemory(_ context.Context, entry *core.MemoryEntry) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry.ID == "" {
		entry.ID = fmt.Sprintf("mem-%d", m.nextMemoryID())
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
		entry.UpdatedAt = time.Now()
	}
	clone := *entry
	m.memories[clone.ID] = &clone
	return clone.ID, nil
}

func (m *mockStore) GetMemory(_ context.Context, id string, _ bool) (*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	clone := *entry
	return &clone, nil
}

func (m *mockStore) ListMemories(_ context.Context, _ *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if e.IsArchived {
			continue
		}
		clone := *e
		results = append(results, &clone)
	}
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// --- Sharing Store methods ---

func (m *mockStore) ShareMemory(_ context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	shareID := fmt.Sprintf("share-%d", len(m.shares)+1)
	m.shares = append(m.shares, shareEntry{
		id:         shareID,
		memoryID:   memoryID,
		peerID:     peerID,
		permission: permission,
		grantedBy:  grantedBy,
		createdAt:  time.Now(),
	})
	return shareID, nil
}

func (m *mockStore) RevokeShareMemory(_ context.Context, memoryID, peerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	found := false
	filtered := m.shares[:0]
	for _, s := range m.shares {
		if s.memoryID == memoryID && s.peerID == peerID {
			found = true
			continue
		}
		filtered = append(filtered, s)
	}
	m.shares = filtered
	if !found {
		return fmt.Errorf("share not found for memory %s and peer %s", memoryID, peerID)
	}
	return nil
}

func (m *mockStore) GetSharedMemories(_ context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, s := range m.shares {
		if s.peerID == peerID && (s.permission == "SHARED" || s.permission == "INHERITED") {
			mem, ok := m.memories[s.memoryID]
			if ok && !mem.IsArchived {
				clone := *mem
				results = append(results, &clone)
			}
		}
		if limit > 0 && len(results) >= limit {
			break
		}
	}
	return results, nil
}

func (m *mockStore) GetPeerMemories(_ context.Context, peerID, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, mem := range m.memories {
		if mem.PeerID == peerID && !mem.IsArchived {
			clone := *mem
			results = append(results, &clone)
		}
	}
	return results, nil
}

// --- Stub implementations for unused core.Store methods (panic) ---

func (m *mockStore) Initialize(_ context.Context) error { panic("stub") }
func (m *mockStore) Close(_ context.Context) error      { panic("stub") }
func (m *mockStore) Ping(_ context.Context) error       { panic("stub") }
func (m *mockStore) Stats(_ context.Context) (*core.StatusResult, error) {
	panic("stub")
}
func (m *mockStore) UpdateMemory(_ context.Context, _ *core.MemoryEntry) error {
	panic("stub")
}
func (m *mockStore) DeleteMemory(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) CountMemories(_ context.Context) (int64, error) { panic("stub") }
func (m *mockStore) ContentExists(_ context.Context, _ string) (bool, error) {
	panic("stub")
}
func (m *mockStore) QueryMemoriesByVector(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) SearchMemoriesText(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) GetSimilar(_ context.Context, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) UpdateTrustFields(_ context.Context, _ string, _ float64, _ bool) error {
	panic("stub")
}
func (m *mockStore) IncrementRetrievalCount(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockStore) DeleteRelationship(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	panic("stub")
}
func (m *mockStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	panic("stub")
}
func (m *mockStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	panic("stub")
}
func (m *mockStore) GetSuperseded(_ context.Context, _ string) (string, error) { panic("stub") }
func (m *mockStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	panic("stub")
}
func (m *mockStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) { panic("stub") }
func (m *mockStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	panic("stub")
}
func (m *mockStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	panic("stub")
}
func (m *mockStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { panic("stub") }
func (m *mockStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	panic("stub")
}
func (m *mockStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	panic("stub")
}
func (m *mockStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	panic("stub")
}
func (m *mockStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	panic("stub")
}
func (m *mockStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	panic("stub")
}
func (m *mockStore) PauseThoughtChain(_ context.Context, _ string) error   { panic("stub") }
func (m *mockStore) ResumeThoughtChain(_ context.Context, _ string) error  { panic("stub") }
func (m *mockStore) AbandonThoughtChain(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	panic("stub")
}
func (m *mockStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	panic("stub")
}
func (m *mockStore) LogTrustAdjustment(_ context.Context, _ *core.TrustAdjustment) (string, error) {
	panic("stub")
}
func (m *mockStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	panic("stub")
}
func (m *mockStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { panic("stub") }
func (m *mockStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	panic("stub")
}
func (m *mockStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	panic("stub")
}
func (m *mockStore) DeleteChunksByPath(_ context.Context, _ string) error { panic("stub") }
func (m *mockStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	panic("stub")
}
func (m *mockStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}
