package thought

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// mockThoughtStore implements core.Store with in-memory storage for unit tests.
type mockThoughtStore struct {
	mu       sync.Mutex
	chains   map[string]*core.ThoughtChain
	thoughts map[string]*core.Thought
	memories map[string]*core.MemoryEntry
	counter  int
}

func newMockThoughtStore() *mockThoughtStore {
	return &mockThoughtStore{
		chains:   make(map[string]*core.ThoughtChain),
		thoughts: make(map[string]*core.Thought),
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (m *mockThoughtStore) nextID() int {
	m.counter++
	return m.counter
}

// --- Thought chain methods ---

func (m *mockThoughtStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := fmt.Sprintf("chain-%d", m.nextID())
	now := time.Now()
	tc := &core.ThoughtChain{
		ID:            id,
		SessionID:     sessionID,
		ParentChainID: parentChainID,
		Status:        "active",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	m.chains[id] = tc
	return id, nil
}

func (m *mockThoughtStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if thought.ID == "" {
		thought.ID = fmt.Sprintf("thought-%d", m.nextID())
	}
	thought.ChainID = chainID
	if thought.CreatedAt.IsZero() {
		thought.CreatedAt = time.Now()
	}
	m.thoughts[thought.ID] = thought
	return thought.ID, nil
}

func (m *mockThoughtStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tc, ok := m.chains[chainID]
	if !ok {
		return nil, fmt.Errorf("chain %s not found", chainID)
	}
	// Attach thoughts, sorted by ThoughtNumber
	var thoughts []core.Thought
	for _, t := range m.thoughts {
		if t.ChainID == chainID {
			thoughts = append(thoughts, *t)
		}
	}
	// Sort by ThoughtNumber for deterministic ordering
	sort.Slice(thoughts, func(i, j int) bool {
		return thoughts[i].ThoughtNumber < thoughts[j].ThoughtNumber
	})
	tc.Thoughts = thoughts
	return tc, nil
}

func (m *mockThoughtStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Simple text match for testing
	var results []*core.ThoughtChain
	for _, tc := range m.chains {
		if len(results) >= limit {
			break
		}
		for _, t := range m.thoughts {
			if t.ChainID == tc.ID && t.Text == query {
				results = append(results, tc)
				break
			}
		}
	}
	return results, nil
}

func (m *mockThoughtStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Find original thought
	var original *core.Thought
	for _, t := range m.thoughts {
		if t.ChainID == chainID && t.ThoughtNumber == thoughtNumber {
			original = t
			break
		}
	}
	if original == nil {
		return nil, fmt.Errorf("thought number %d not found in chain %s", thoughtNumber, chainID)
	}
	// Create revision
	revision := &core.Thought{
		ID:                fmt.Sprintf("thought-%d", m.nextID()),
		ChainID:           chainID,
		Text:              revisedText,
		ThoughtNumber:     original.ThoughtNumber,
		TotalThoughts:     original.TotalThoughts,
		NextThoughtNeeded: original.NextThoughtNeeded,
		IsRevision:        true,
		RevisesThoughtID:  original.ID,
		ContentHash:       contentHash(revisedText),
		CreatedAt:         time.Now(),
	}
	m.thoughts[revision.ID] = revision
	return revision, nil
}

func (m *mockThoughtStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Find original thought
	var original *core.Thought
	for _, t := range m.thoughts {
		if t.ChainID == chainID && t.ThoughtNumber == fromThoughtNumber {
			original = t
			break
		}
	}
	if original == nil {
		return nil, fmt.Errorf("thought number %d not found in chain %s", fromThoughtNumber, chainID)
	}

	totalThoughts := original.TotalThoughts
	nextNeeded := original.NextThoughtNeeded

	branch := &core.Thought{
		ID:                  fmt.Sprintf("thought-%d", m.nextID()),
		ChainID:             chainID,
		Text:                text,
		ThoughtNumber:       original.ThoughtNumber + 1,
		TotalThoughts:       totalThoughts,
		NextThoughtNeeded:   nextNeeded,
		BranchFromThoughtID: original.ID,
		BranchID:            branchID,
		ContentHash:         contentHash(text),
		CreatedAt:           time.Now(),
	}
	m.thoughts[branch.ID] = branch
	return branch, nil
}

func (m *mockThoughtStore) PauseThoughtChain(ctx context.Context, chainID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tc, ok := m.chains[chainID]
	if !ok {
		return fmt.Errorf("chain %s not found", chainID)
	}
	tc.Status = "paused"
	tc.UpdatedAt = time.Now()
	return nil
}

func (m *mockThoughtStore) ResumeThoughtChain(ctx context.Context, chainID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tc, ok := m.chains[chainID]
	if !ok {
		return fmt.Errorf("chain %s not found", chainID)
	}
	tc.Status = "active"
	tc.UpdatedAt = time.Now()
	return nil
}

func (m *mockThoughtStore) AbandonThoughtChain(ctx context.Context, chainID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	tc, ok := m.chains[chainID]
	if !ok {
		return fmt.Errorf("chain %s not found", chainID)
	}
	tc.Status = "abandoned"
	tc.UpdatedAt = time.Now()
	return nil
}

// --- Memory methods (needed by MemoryBridge) ---

func (m *mockThoughtStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
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

func (m *mockThoughtStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.memories {
		if e.ContentHash == contentHash {
			return true, nil
		}
	}
	return false, nil
}

func (m *mockThoughtStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if e.Content == query && e.SourceType == "thought" {
			clone := *e
			results = append(results, &clone)
		}
	}
	return results, nil
}

func (m *mockThoughtStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return fmt.Sprintf("rel-%d", m.nextID()), nil
}

// --- Stub implementations for remaining core.Store methods ---

func (m *mockThoughtStore) Initialize(ctx context.Context) error { return nil }
func (m *mockThoughtStore) Close(ctx context.Context) error      { return nil }
func (m *mockThoughtStore) Ping(ctx context.Context) error       { return nil }
func (m *mockThoughtStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}
func (m *mockThoughtStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	clone := *e
	return &clone, nil
}
func (m *mockThoughtStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	clone := *entry
	m.memories[entry.ID] = &clone
	return nil
}
func (m *mockThoughtStore) DeleteMemory(ctx context.Context, id string) error {
	return nil
}
func (m *mockThoughtStore) CountMemories(ctx context.Context) (int64, error) { return 0, nil }
func (m *mockThoughtStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
	return nil
}
func (m *mockThoughtStore) IncrementRetrievalCount(ctx context.Context, id string) error { return nil }
func (m *mockThoughtStore) DeleteRelationship(ctx context.Context, id string) error      { return nil }
func (m *mockThoughtStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockThoughtStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockThoughtStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockThoughtStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	return nil
}
func (m *mockThoughtStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockThoughtStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockThoughtStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockThoughtStore) UpdatePeerLastActive(ctx context.Context, id string) error { return nil }
func (m *mockThoughtStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	return nil
}
func (m *mockThoughtStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return nil, nil
}
func (m *mockThoughtStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}
func (m *mockThoughtStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return nil
}
func (m *mockThoughtStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) DeleteChunksByPath(ctx context.Context, path string) error { return nil }
func (m *mockThoughtStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetFileChunksByPath(ctx context.Context, filePath string) (*core.FileContentsResult, error) {
	return nil, nil
}

// v0.7.0 1024-dim methods
func (m *mockThoughtStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockThoughtStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", nil
}
func (m *mockThoughtStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockThoughtStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockThoughtStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// --- Tests ---

func TestStartChain(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, err := cm.StartChain(context.Background(), "session-1", "")
	if err != nil {
		t.Fatalf("StartChain returned error: %v", err)
	}
	if chainID == "" {
		t.Fatal("StartChain returned empty chain ID")
	}

	// Verify chain was stored
	tc, err := store.GetThoughtChain(context.Background(), chainID)
	if err != nil {
		t.Fatalf("GetThoughtChain returned error: %v", err)
	}
	if tc.Status != "active" {
		t.Errorf("chain status = %q, want 'active'", tc.Status)
	}
	if tc.SessionID != "session-1" {
		t.Errorf("chain sessionID = %q, want 'session-1'", tc.SessionID)
	}
}

func TestStartChainWithParent(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	parentID, _ := cm.StartChain(context.Background(), "session-1", "")
	childID, err := cm.StartChain(context.Background(), "session-1", parentID)
	if err != nil {
		t.Fatalf("StartChain with parent returned error: %v", err)
	}
	if childID == "" {
		t.Fatal("StartChain returned empty chain ID")
	}

	tc, _ := store.GetThoughtChain(context.Background(), childID)
	if tc.ParentChainID != parentID {
		t.Errorf("parentChainID = %q, want %q", tc.ParentChainID, parentID)
	}
}

func TestAddThought(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")
	thoughtID, err := cm.AddThought(context.Background(), chainID, "I should consider X", 1, 3, true)
	if err != nil {
		t.Fatalf("AddThought returned error: %v", err)
	}
	if thoughtID == "" {
		t.Fatal("AddThought returned empty thought ID")
	}
}

func TestGetChain(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")
	cm.AddThought(context.Background(), chainID, "First thought", 1, 2, true)
	cm.AddThought(context.Background(), chainID, "Second thought", 2, 2, false)

	tc, err := cm.GetChain(context.Background(), chainID)
	if err != nil {
		t.Fatalf("GetChain returned error: %v", err)
	}
	if tc.ID != chainID {
		t.Errorf("chain ID = %q, want %q", tc.ID, chainID)
	}
	if len(tc.Thoughts) != 2 {
		t.Fatalf("expected 2 thoughts, got %d", len(tc.Thoughts))
	}
	// Thoughts should be ordered by thought_number
	if tc.Thoughts[0].ThoughtNumber != 1 {
		t.Errorf("first thought number = %d, want 1", tc.Thoughts[0].ThoughtNumber)
	}
	if tc.Thoughts[1].ThoughtNumber != 2 {
		t.Errorf("second thought number = %d, want 2", tc.Thoughts[1].ThoughtNumber)
	}
}

func TestGetChainNotFound(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	_, err := cm.GetChain(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent chain, got nil")
	}
}

func TestReviseThought(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")
	origID, _ := cm.AddThought(context.Background(), chainID, "Initial hypothesis", 1, 2, true)

	_ = origID // We don't need the ID directly, we revise by thought number

	revised, err := cm.ReviseThought(context.Background(), chainID, 1, "Revised hypothesis")
	if err != nil {
		t.Fatalf("ReviseThought returned error: %v", err)
	}
	if !revised.IsRevision {
		t.Error("revised thought should have IsRevision=true")
	}
	if revised.Text != "Revised hypothesis" {
		t.Errorf("revised text = %q, want 'Revised hypothesis'", revised.Text)
	}
	// The mock store sets RevisesThoughtID
	if revised.RevisesThoughtID == "" {
		t.Error("revised thought should have RevisesThoughtID set")
	}
}

func TestBranchThought(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")
	cm.AddThought(context.Background(), chainID, "Original line of thought", 1, 2, true)

	branch, err := cm.BranchThought(context.Background(), chainID, 1, "branch-a", "Alternative approach")
	if err != nil {
		t.Fatalf("BranchThought returned error: %v", err)
	}
	if branch.BranchFromThoughtID == "" {
		t.Error("branch thought should have BranchFromThoughtID set")
	}
	if branch.BranchID != "branch-a" {
		t.Errorf("branch BranchID = %q, want 'branch-a'", branch.BranchID)
	}
	if branch.Text != "Alternative approach" {
		t.Errorf("branch text = %q, want 'Alternative approach'", branch.Text)
	}
}

func TestPauseResumeChain(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")

	// Pause
	if err := cm.PauseChain(context.Background(), chainID); err != nil {
		t.Fatalf("PauseChain returned error: %v", err)
	}
	tc, _ := cm.GetChain(context.Background(), chainID)
	if tc.Status != "paused" {
		t.Errorf("after pause, status = %q, want 'paused'", tc.Status)
	}

	// Resume
	if err := cm.ResumeChain(context.Background(), chainID); err != nil {
		t.Fatalf("ResumeChain returned error: %v", err)
	}
	tc, _ = cm.GetChain(context.Background(), chainID)
	if tc.Status != "active" {
		t.Errorf("after resume, status = %q, want 'active'", tc.Status)
	}
}

func TestAbandonChain(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	chainID, _ := cm.StartChain(context.Background(), "session-1", "")

	if err := cm.AbandonChain(context.Background(), chainID); err != nil {
		t.Fatalf("AbandonChain returned error: %v", err)
	}
	tc, _ := cm.GetChain(context.Background(), chainID)
	if tc.Status != "abandoned" {
		t.Errorf("after abandon, status = %q, want 'abandoned'", tc.Status)
	}
}

func TestGetRelatedChains(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)

	// Create a chain with a thought
	chainID, _ := cm.StartChain(context.Background(), "session-1", "")
	cm.AddThought(context.Background(), chainID, "Machine learning optimization", 1, 1, false)

	// Search for related chains
	results, err := cm.GetRelatedChains(context.Background(), "Machine learning optimization", 5)
	if err != nil {
		t.Fatalf("GetRelatedChains returned error: %v", err)
	}
	if len(results) == 0 {
		t.Error("expected at least one related chain, got 0")
	}
}

func TestBridgeThought(t *testing.T) {
	store := newMockThoughtStore()
	bridge := NewMemoryBridge(store)

	thought := &core.Thought{
		ID:                "thought-1",
		ChainID:           "chain-1",
		Text:              "This is a thought",
		ThoughtNumber:     1,
		TotalThoughts:     1,
		NextThoughtNeeded: false,
		ContentHash:       contentHash("This is a thought"),
	}

	memID, err := bridge.BridgeThought(context.Background(), thought)
	if err != nil {
		t.Fatalf("BridgeThought returned error: %v", err)
	}
	if memID == "" {
		t.Fatal("BridgeThought returned empty memory ID")
	}

	// Verify the memory was stored
	mem, err := store.GetMemory(context.Background(), memID, false)
	if err != nil {
		t.Fatalf("GetMemory returned error: %v", err)
	}
	if mem.SourceType != "thought" {
		t.Errorf("memory sourceType = %q, want 'thought'", mem.SourceType)
	}
	if mem.Content != "This is a thought" {
		t.Errorf("memory content = %q, want 'This is a thought'", mem.Content)
	}
}

func TestBridgeThoughtAlreadyBridged(t *testing.T) {
	store := newMockThoughtStore()
	bridge := NewMemoryBridge(store)

	thought := &core.Thought{
		ID:                "thought-1",
		ChainID:           "chain-1",
		Text:              "This is a thought",
		ThoughtNumber:     1,
		TotalThoughts:     1,
		NextThoughtNeeded: false,
		ContentHash:       contentHash("This is a thought"),
		MemoryID:          "existing-mem-id",
	}

	memID, err := bridge.BridgeThought(context.Background(), thought)
	if err != nil {
		t.Fatalf("BridgeThought returned error: %v", err)
	}
	if memID != "existing-mem-id" {
		t.Errorf("BridgeThought returned %q, want 'existing-mem-id' (should not duplicate)", memID)
	}
}

func TestBridgeThoughtNil(t *testing.T) {
	store := newMockThoughtStore()
	bridge := NewMemoryBridge(store)

	_, err := bridge.BridgeThought(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error for nil thought, got nil")
	}
}

func TestCreateContradictsRelationship(t *testing.T) {
	store := newMockThoughtStore()
	bridge := NewMemoryBridge(store)

	relID, err := bridge.CreateContradictsRelationship(context.Background(), "mem-original", "mem-revised")
	if err != nil {
		t.Fatalf("CreateContrADICTSRelationship returned error: %v", err)
	}
	if relID == "" {
		t.Fatal("expected relationship ID, got empty string")
	}
}

func TestCreateContradictsRelationshipEmptyIDs(t *testing.T) {
	store := newMockThoughtStore()
	bridge := NewMemoryBridge(store)

	_, err := bridge.CreateContradictsRelationship(context.Background(), "", "mem-revised")
	if err == nil {
		t.Fatal("expected error for empty original memory ID, got nil")
	}

	_, err = bridge.CreateContradictsRelationship(context.Background(), "mem-original", "")
	if err == nil {
		t.Fatal("expected error for empty revised memory ID, got nil")
	}
}

func TestContentHash(t *testing.T) {
	h1 := contentHash("hello")
	h2 := contentHash("hello")
	h3 := contentHash("world")
	if h1 != h2 {
		t.Error("same input should produce same hash")
	}
	if h1 == h3 {
		t.Error("different inputs should produce different hashes")
	}
}

func TestFullWorkflow(t *testing.T) {
	store := newMockThoughtStore()
	cm := NewChainsManager(store, nil)
	ctx := context.Background()

	// 1. Start a chain
	chainID, err := cm.StartChain(ctx, "test-session", "")
	if err != nil {
		t.Fatalf("StartChain: %v", err)
	}

	// 2. Add thoughts
	_, err = cm.AddThought(ctx, chainID, "First observation", 1, 3, true)
	if err != nil {
		t.Fatalf("AddThought 1: %v", err)
	}
	_, err = cm.AddThought(ctx, chainID, "Second observation", 2, 3, true)
	if err != nil {
		t.Fatalf("AddThought 2: %v", err)
	}
	_, err = cm.AddThought(ctx, chainID, "Final conclusion", 3, 3, false)
	if err != nil {
		t.Fatalf("AddThought 3: %v", err)
	}

	// 3. Get chain with thoughts
	tc, err := cm.GetChain(ctx, chainID)
	if err != nil {
		t.Fatalf("GetChain: %v", err)
	}
	if len(tc.Thoughts) != 3 {
		t.Fatalf("expected 3 thoughts, got %d", len(tc.Thoughts))
	}

	// 4. Revise thought 1
	revised, err := cm.ReviseThought(ctx, chainID, 1, "Revised first observation")
	if err != nil {
		t.Fatalf("ReviseThought: %v", err)
	}
	if !revised.IsRevision {
		t.Error("revision should have IsRevision=true")
	}

	// 5. Branch from thought 2
	branch, err := cm.BranchThought(ctx, chainID, 2, "alt-branch", "Alternative second path")
	if err != nil {
		t.Fatalf("BranchThought: %v", err)
	}
	if branch.BranchID != "alt-branch" {
		t.Errorf("branch BranchID = %q, want 'alt-branch'", branch.BranchID)
	}

	// 6. Pause, resume, abandon lifecycle
	if err := cm.PauseChain(ctx, chainID); err != nil {
		t.Fatalf("PauseChain: %v", err)
	}
	tc, _ = cm.GetChain(ctx, chainID)
	if tc.Status != "paused" {
		t.Errorf("status after pause = %q, want 'paused'", tc.Status)
	}

	if err := cm.ResumeChain(ctx, chainID); err != nil {
		t.Fatalf("ResumeChain: %v", err)
	}
	tc, _ = cm.GetChain(ctx, chainID)
	if tc.Status != "active" {
		t.Errorf("status after resume = %q, want 'active'", tc.Status)
	}

	if err := cm.AbandonChain(ctx, chainID); err != nil {
		t.Fatalf("AbandonChain: %v", err)
	}
	tc, _ = cm.GetChain(ctx, chainID)
	if tc.Status != "abandoned" {
		t.Errorf("status after abandon = %q, want 'abandoned'", tc.Status)
	}
}

// Phase 2 part 1 stubs for new core.Store interface methods

func (m *mockThoughtStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	return nil, nil
}

func (m *mockThoughtStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	return nil
}

func (m *mockThoughtStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockThoughtStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}

func (m *mockThoughtStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}

func (m *mockThoughtStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
