package orchestrator

import (
	"context"
	"fmt"
	"sync"
	"time"

	"testing"

	"neuralgentics/src/neuralgentics/memory"
	"neuralgentics/src/neuralgentics/memory/core"
)

// ============================================================================
// Mock Store for Testing
// ============================================================================

// testStore implements core.Store with in-memory storage for adapter tests.
// Unlike the peer package's mockStore, this one fully implements all methods
// needed by the adapter's MemoryProvider interface.
type testStore struct {
	mu        sync.Mutex
	memories  map[string]*core.MemoryEntry
	trustAdjs []*core.TrustAdjustment
	idCounter int
}

func newTestStore() *testStore {
	return &testStore{
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (s *testStore) nextID() int {
	s.idCounter++
	return s.idCounter
}

// --- Store Lifecycle ---

func (s *testStore) Initialize(_ context.Context) error { return nil }
func (s *testStore) Close(_ context.Context) error      { return nil }
func (s *testStore) Ping(_ context.Context) error       { return nil }
func (s *testStore) Stats(_ context.Context) (*core.StatusResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &core.StatusResult{MemoryCount: len(s.memories), Ready: true}, nil
}

// --- Memory CRUD ---

func (s *testStore) AddMemory(_ context.Context, entry *core.MemoryEntry) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry.ID == "" {
		entry.ID = fmt.Sprintf("mem-%d", s.nextID())
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now()
		entry.UpdatedAt = time.Now()
	}
	clone := *entry
	s.memories[clone.ID] = &clone
	return clone.ID, nil
}

func (s *testStore) GetMemory(_ context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.memories[id]
	if !ok {
		return nil, fmt.Errorf("memory %s not found", id)
	}
	if entry.IsArchived && !includeArchived {
		return nil, fmt.Errorf("memory %s is archived", id)
	}
	clone := *entry
	return &clone, nil
}

func (s *testStore) UpdateMemory(_ context.Context, entry *core.MemoryEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.memories[entry.ID]; !ok {
		return fmt.Errorf("memory %s not found", entry.ID)
	}
	clone := *entry
	s.memories[entry.ID] = &clone
	return nil
}

func (s *testStore) DeleteMemory(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.memories[id]; !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	delete(s.memories, id)
	return nil
}

func (s *testStore) CountMemories(_ context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int64(len(s.memories)), nil
}

func (s *testStore) ListMemories(_ context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range s.memories {
		if filter != nil && filter.IsArchived != nil {
			if *filter.IsArchived != e.IsArchived {
				continue
			}
		} else if e.IsArchived {
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

func (s *testStore) ContentExists(_ context.Context, hash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.memories {
		if e.ContentHash == hash {
			return true, nil
		}
	}
	return false, nil
}

// --- Vector Search ---

func (s *testStore) QueryMemoriesByVector(_ context.Context, _ []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.listActiveMemories(opts)
}

func (s *testStore) SearchMemoriesText(_ context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.listActiveMemories(opts)
}

func (s *testStore) GetSimilar(_ context.Context, id string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.listActiveMemories(opts)
}

// listActiveMemories is a helper for search methods.
func (s *testStore) listActiveMemories(opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range s.memories {
		if !e.IsArchived {
			clone := *e
			results = append(results, &clone)
		}
	}
	limit := 10
	if opts != nil && opts.TopK > 0 {
		limit = opts.TopK
	}
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// --- Trust Fields ---

func (s *testStore) UpdateTrustFields(_ context.Context, id string, trustScore float64, archived bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.memories[id]
	if !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	entry.TrustScore = trustScore
	entry.IsArchived = archived
	return nil
}

func (s *testStore) IncrementRetrievalCount(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.memories[id]
	if !ok {
		return fmt.Errorf("memory %s not found", id)
	}
	entry.RetrievalCount++
	return nil
}

// --- Relationships ---

func (s *testStore) CreateRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return fmt.Sprintf("rel-%d", s.nextID()), nil
}
func (s *testStore) DeleteRelationship(_ context.Context, _ string) error { return nil }
func (s *testStore) GetRelationships(_ context.Context, _ string) ([]core.Relationship, error) {
	return nil, nil
}
func (s *testStore) GetRelationshipSummary(_ context.Context, _ string) (*core.RelationshipSummary, error) {
	return &core.RelationshipSummary{}, nil
}
func (s *testStore) GetSupersessionChain(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, nil
}
func (s *testStore) GetSuperseded(_ context.Context, _ string) (string, error) {
	return "", nil
}

// --- Entity CRUD ---

func (s *testStore) UpsertEntity(_ context.Context, _ *core.Entity) (string, error) {
	return fmt.Sprintf("ent-%d", s.nextID()), nil
}
func (s *testStore) GetEntity(_ context.Context, _ string) (*core.Entity, error) {
	return nil, fmt.Errorf("not found")
}
func (s *testStore) GetEntitiesByType(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (s *testStore) SearchEntities(_ context.Context, _ string, _ int) ([]*core.Entity, error) {
	return nil, nil
}
func (s *testStore) CreateEntityRelationship(_ context.Context, _, _, _ string, _ float64) (string, error) {
	return fmt.Sprintf("er-%d", s.nextID()), nil
}
func (s *testStore) GetEntityRelationships(_ context.Context, _ string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (s *testStore) ResolveEntityGraph(_ context.Context, _ string, _ int) error { return nil }
func (s *testStore) InferenceChain(_ context.Context, _, _ string, _ int) ([]core.EntityRelationship, error) {
	return nil, nil
}

// --- Peer CRUD ---

func (s *testStore) AddPeer(_ context.Context, _ *core.PeerProfile) (string, error) {
	return fmt.Sprintf("peer-%d", s.nextID()), nil
}
func (s *testStore) GetPeer(_ context.Context, _ string) (*core.PeerProfile, error) {
	return nil, fmt.Errorf("not found")
}
func (s *testStore) ListPeers(_ context.Context, _ int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (s *testStore) UpdatePeerLastActive(_ context.Context, _ string) error { return nil }

// --- Memory Sharing ---

func (s *testStore) ShareMemory(_ context.Context, _, _, _, _ string) (string, error) {
	return fmt.Sprintf("share-%d", s.nextID()), nil
}
func (s *testStore) RevokeShareMemory(_ context.Context, _, _ string) error { return nil }
func (s *testStore) GetSharedMemories(_ context.Context, _ string, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (s *testStore) GetPeerMemories(_ context.Context, _ string, _ string, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// --- Thought Chains ---

func (s *testStore) StartThoughtChain(_ context.Context, _, _ string) (string, error) {
	return fmt.Sprintf("chain-%d", s.nextID()), nil
}
func (s *testStore) AddThought(_ context.Context, _ string, _ *core.Thought) (string, error) {
	return fmt.Sprintf("thought-%d", s.nextID()), nil
}
func (s *testStore) GetThoughtChain(_ context.Context, _ string) (*core.ThoughtChain, error) {
	return nil, fmt.Errorf("not found")
}
func (s *testStore) GetRelatedChains(_ context.Context, _ string, _ int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (s *testStore) ReviseThought(_ context.Context, _ string, _ int, _ string) (*core.Thought, error) {
	return nil, fmt.Errorf("not found")
}
func (s *testStore) BranchThought(_ context.Context, _ string, _ int, _, _ string) (*core.Thought, error) {
	return nil, fmt.Errorf("not found")
}
func (s *testStore) PauseThoughtChain(_ context.Context, _ string) error   { return nil }
func (s *testStore) ResumeThoughtChain(_ context.Context, _ string) error  { return nil }
func (s *testStore) AbandonThoughtChain(_ context.Context, _ string) error { return nil }

// --- Audit Logging ---

func (s *testStore) LogAuditEvent(_ context.Context, _ *core.AuditEvent) (string, error) {
	return fmt.Sprintf("audit-%d", s.nextID()), nil
}
func (s *testStore) GetAuditEvents(_ context.Context, _, _ string, _ int) ([]*core.AuditEvent, error) {
	return nil, nil
}

// --- Trust Adjustments ---

func (s *testStore) LogTrustAdjustment(_ context.Context, adj *core.TrustAdjustment) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if adj.ID == "" {
		adj.ID = fmt.Sprintf("adj-%d", s.nextID())
	}
	s.trustAdjs = append(s.trustAdjs, adj)
	return adj.ID, nil
}
func (s *testStore) GetTrustAdjustments(_ context.Context, _ string, _ int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}

// --- Decay ---

func (s *testStore) UpdateDecayRate(_ context.Context, _ string, _ float64) error { return nil }
func (s *testStore) ListFadingMemories(_ context.Context, _ float64, _ int) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// --- Project Indexer ---

func (s *testStore) AddProjectChunk(_ context.Context, _ *core.ChunkResult) (string, error) {
	return fmt.Sprintf("chunk-%d", s.nextID()), nil
}
func (s *testStore) DeleteChunksByPath(_ context.Context, _ string) error { return nil }
func (s *testStore) SearchChunks(_ context.Context, _ []float64, _ *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (s *testStore) GetFileChunksByPath(_ context.Context, _ string) (*core.FileContentsResult, error) {
	panic("stub")
}

// User Profile methods (Phase 2 Part 1)
func (s *testStore) GetUserProfile(_ context.Context, _ string) (*core.UserProfile, error) {
	return nil, nil
}
func (s *testStore) UpsertUserProfile(_ context.Context, _ *core.UserProfile) error { return nil }

// Security Summary method (Phase 2 Part 1)
func (s *testStore) GetSecuritySummary(_ context.Context, _ int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// v0.7.0 1024-dim methods
func (s *testStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", nil
}
func (s *testStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (s *testStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, nil
}
func (s *testStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (s *testStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// Lazy tool exposure methods (Session 16 Phase 3). The mock doesn't track
// tool exposure — all three return zero values so the orchestrator's lazy
// exposure path is exercised end-to-end without DB state.
func (s *testStore) RecordToolRequest(_ context.Context, _, _, _ string) error {
	return nil
}
func (s *testStore) IncrementToolUse(_ context.Context, _, _, _ string) (bool, error) {
	return false, nil
}
func (s *testStore) GetAgentTools(_ context.Context, _ string) ([]*core.ToolRecord, error) {
	return nil, nil
}

// Verify testStore satisfies core.Store at compile time.
var _ core.Store = (*testStore)(nil)

// ============================================================================
// Mock Searcher for Testing
// ============================================================================

// testSearcher implements core.Searcher for testing.
// It returns all active memories from the store (no real search logic).
type testSearcher struct {
	store *testStore
}

func (s *testSearcher) Query(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.store.listActiveMemories(opts)
}
func (s *testSearcher) VectorSearch(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.store.listActiveMemories(opts)
}
func (s *testSearcher) TextSearch(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.store.listActiveMemories(opts)
}
func (s *testSearcher) HybridSearch(ctx context.Context, query string, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.store.listActiveMemories(opts)
}
func (s *testSearcher) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return s.store.listActiveMemories(opts)
}

// Verify testSearcher satisfies core.Searcher at compile time.
var _ core.Searcher = (*testSearcher)(nil)

// ============================================================================
// Helper: Create a MemorySystem for Testing
// ============================================================================

// newTestMemorySystem creates a MemorySystem with mock components for testing.
func newTestMemorySystem() *memory.MemorySystem {
	store := newTestStore()
	embedder := &testEmbedder{}
	searcher := &testSearcher{store: store}
	cfg := &core.Config{
		DatabaseURL: "postgresql://mock:5432/test",
	}

	return memory.NewWithComponents(store, embedder, searcher, cfg)
}

// testEmbedder implements core.Embedder for testing.
type testEmbedder struct {
	dim int
}

func (e *testEmbedder) Embed(_ context.Context, _ string) ([]float64, error) {
	return make([]float64, 384), nil
}

func (e *testEmbedder) Embed1024(_ context.Context, _ string) ([]float64, error) {
	return make([]float64, 1024), nil
}

func (e *testEmbedder) Dim() int { return 384 }

func (e *testEmbedder) EmbedBatch(_ context.Context, texts []string) ([][]float64, error) {
	if e.dim == 0 {
		e.dim = 384
	}
	result := make([][]float64, len(texts))
	for i := range texts {
		result[i] = make([]float64, e.dim)
	}
	return result, nil
}
func (e *testEmbedder) Health(_ context.Context) error { return nil }
func (e *testEmbedder) Close(_ context.Context) error  { return nil }

// Verify testEmbedder satisfies core.Embedder at compile time.
var _ core.Embedder = (*testEmbedder)(nil)

// ============================================================================
// Adapter Tests
// ============================================================================

func TestMemorySystemAdapter_SatisfiesMemoryProvider(t *testing.T) {
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	// Verify the adapter satisfies the MemoryProvider interface at runtime.
	// (Compile-time check is done via `var _ MemoryProvider = (*MemorySystemAdapter)(nil)`)
	var _ MemoryProvider = adapter
}

func TestMemorySystemAdapter_AddMemory(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	entry := MemoryEntry{
		Content:     "Test memory content about dark mode preferences",
		SourceType:  "session",
		ContentHash: "abc123",
		Metadata:    map[string]any{"key": "value"},
	}

	id, err := adapter.AddMemory(ctx, entry)
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}
	if id == "" {
		t.Fatal("AddMemory returned empty ID")
	}
	t.Logf("AddMemory returned ID: %s", id)
}

func TestMemorySystemAdapter_GetMemory(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	// First add a memory
	entry := MemoryEntry{
		Content:     "The user prefers light theme for documentation",
		SourceType:  "session",
		ContentHash: "def456",
	}
	id, err := adapter.AddMemory(ctx, entry)
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Now retrieve it
	retrieved, err := adapter.GetMemory(ctx, id)
	if err != nil {
		t.Fatalf("GetMemory failed: %v", err)
	}
	if retrieved.Content != entry.Content {
		t.Errorf("GetMemory content = %q, want %q", retrieved.Content, entry.Content)
	}
	if retrieved.SourceType != entry.SourceType {
		t.Errorf("GetMemory sourceType = %q, want %q", retrieved.SourceType, entry.SourceType)
	}
	if retrieved.ID != id {
		t.Errorf("GetMemory ID = %q, want %q", retrieved.ID, id)
	}
}

func TestMemorySystemAdapter_QueryMemories(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	// Add several memories
	contents := []string{
		"Dark mode preferences for code editor",
		"Python testing framework choice",
		"Dark theme for terminal emulator",
	}
	for _, content := range contents {
		_, err := adapter.AddMemory(ctx, MemoryEntry{
			Content:     content,
			SourceType:  "session",
			ContentHash: content,
		})
		if err != nil {
			t.Fatalf("AddMemory failed: %v", err)
		}
	}

	// Query for dark mode memories
	opts := &SearchOptions{TopK: 10, Threshold: 0.5, Strategy: "text_only"}
	results, err := adapter.QueryMemories(ctx, "dark mode", opts)
	if err != nil {
		t.Fatalf("QueryMemories failed: %v", err)
	}
	if len(results) == 0 {
		t.Error("QueryMemories returned no results")
	}
	t.Logf("QueryMemories returned %d results", len(results))
}

func TestMemorySystemAdapter_DeleteMemory(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	entry := MemoryEntry{
		Content:     "Memory to be deleted",
		SourceType:  "session",
		ContentHash: "del123",
	}
	id, err := adapter.AddMemory(ctx, entry)
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Delete the memory
	err = adapter.DeleteMemory(ctx, id)
	if err != nil {
		t.Fatalf("DeleteMemory failed: %v", err)
	}

	// Verify it's gone
	_, err = adapter.GetMemory(ctx, id)
	if err == nil {
		t.Error("GetMemory should fail after DeleteMemory")
	}
}

func TestMemorySystemAdapter_AdjustTrust(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	// Add a memory
	entry := MemoryEntry{
		Content:     "Important architectural decision about API design",
		SourceType:  "project",
		ContentHash: "trust123",
		TrustScore:  0.5,
	}
	id, err := adapter.AddMemory(ctx, entry)
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// Adjust trust with agent_used signal (+0.05)
	adj, err := adapter.AdjustTrust(ctx, id, SignalAgentUsed)
	if err != nil {
		t.Fatalf("AdjustTrust failed: %v", err)
	}
	if adj == nil {
		t.Fatal("AdjustTrust returned nil adjustment")
	}
	if adj.MemoryID != id {
		t.Errorf("AdjustTrust MemoryID = %q, want %q", adj.MemoryID, id)
	}
	if adj.Signal != string(SignalAgentUsed) {
		t.Errorf("AdjustTrust Signal = %q, want %q", adj.Signal, SignalAgentUsed)
	}
	// Trust should increase: 0.5 + 0.05 = 0.55
	if adj.NewScore <= adj.OldScore {
		t.Errorf("AdjustTrust NewScore (%f) should be > OldScore (%f) for agent_used signal", adj.NewScore, adj.OldScore)
	}
	t.Logf("AdjustTrust: %f -> %f (delta: %f, signal: %s)", adj.OldScore, adj.NewScore, adj.AdjustmentAmount, adj.Signal)

	// Adjust trust with user_confirmed signal (+0.10)
	adj2, err := adapter.AdjustTrust(ctx, id, SignalUserConfirmed)
	if err != nil {
		t.Fatalf("AdjustTrust (user_confirmed) failed: %v", err)
	}
	if adj2.NewScore <= adj2.OldScore {
		t.Errorf("AdjustTrust NewScore (%f) should be > OldScore (%f) for user_confirmed signal", adj2.NewScore, adj2.OldScore)
	}
	t.Logf("AdjustTrust (user_confirmed): %f -> %f", adj2.OldScore, adj2.NewScore)
}

func TestMemorySystemAdapter_AdjustTrust_NegativeSignals(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	entry := MemoryEntry{
		Content:     "Ignored memory that user corrected",
		SourceType:  "session",
		ContentHash: "neg123",
		TrustScore:  0.6,
	}
	id, err := adapter.AddMemory(ctx, entry)
	if err != nil {
		t.Fatalf("AddMemory failed: %v", err)
	}

	// agent_ignored signal (-0.05)
	adj, err := adapter.AdjustTrust(ctx, id, SignalAgentIgnored)
	if err != nil {
		t.Fatalf("AdjustTrust (agent_ignored) failed: %v", err)
	}
	if adj.NewScore >= adj.OldScore {
		t.Errorf("AdjustTrust NewScore (%f) should be < OldScore (%f) for agent_ignored signal", adj.NewScore, adj.OldScore)
	}
	t.Logf("AdjustTrust (agent_ignored): %f -> %f", adj.OldScore, adj.NewScore)

	// user_corrected signal (-0.10)
	adj2, err := adapter.AdjustTrust(ctx, id, SignalUserCorrected)
	if err != nil {
		t.Fatalf("AdjustTrust (user_corrected) failed: %v", err)
	}
	if adj2.NewScore >= adj2.OldScore {
		t.Errorf("AdjustTrust NewScore (%f) should be < OldScore (%f) for user_corrected signal", adj2.NewScore, adj2.OldScore)
	}
}

func TestMemorySystemAdapter_Close(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	err := adapter.Close(ctx)
	if err != nil {
		t.Fatalf("Close failed: %v", err)
	}
}

func TestMemorySystemAdapter_WithOrchestrator(t *testing.T) {
	ctx := context.Background()
	mem := newTestMemorySystem()
	adapter := NewMemorySystemAdapter(mem)

	// Create an orchestrator using the adapter
	orch, err := New(&OrchestratorConfig{
		Memory:             adapter,
		ProtocolStrictness: StrictnessLenient,
		MaxConcurrent:      3,
	})
	if err != nil {
		t.Fatalf("New Orchestrator failed: %v", err)
	}

	// Add a memory through the orchestrator's memory provider indirectly
	memoryID, err := adapter.AddMemory(ctx, MemoryEntry{
		Content:     "Orchestrator integration test memory",
		SourceType:  "project",
		ContentHash: "orch-int-123",
		Metadata:    map[string]any{"test": "integration"},
	})
	if err != nil {
		t.Fatalf("AddMemory through adapter failed: %v", err)
	}

	// Verify the orchestrator can use the memory provider
	task := Task{
		ID:          "test-task-1",
		Type:        TaskTypeCodeImpl,
		Description: "Implement feature X",
		UserRequest: "Add feature X to the codebase",
		Priority:    PriorityMedium,
	}

	// HandleTask should be able to use the memory provider without errors
	result, err := orch.HandleTask(ctx, task)
	if err != nil {
		t.Fatalf("HandleTask failed: %v", err)
	}

	if result.Agent != AgentCoder {
		t.Errorf("HandleTask agent = %v, want coder", result.Agent)
	}

	t.Logf("HandleTask succeeded with agent: %s", result.Agent)

	// Verify the memory is retrievable through the adapter
	retrieved, err := adapter.GetMemory(ctx, memoryID)
	if err != nil {
		t.Fatalf("GetMemory after HandleTask failed: %v", err)
	}
	if retrieved.Content != "Orchestrator integration test memory" {
		t.Errorf("Retrieved content = %q, want %q", retrieved.Content, "Orchestrator integration test memory")
	}

	// Clean up
	if err := orch.Close(ctx); err != nil {
		t.Fatalf("Orchestrator Close failed: %v", err)
	}
}

func TestTypeConversion_ToCoreEntry(t *testing.T) {
	entry := MemoryEntry{
		ID:             "test-id",
		Content:        "test content",
		Vector:         []float64{0.1, 0.2, 0.3},
		SourceType:     "session",
		SourcePath:     &[]string{"/path/to/file.go"}[0],
		ContentHash:    "hash123",
		TrustScore:     0.75,
		RetrievalCount: 5,
		IsArchived:     false,
		Metadata:       map[string]any{"key": "value"},
		Score:          nil,
		SupersedesID:   "prev-id",
	}

	coreEntry := toCoreEntry(entry)

	if coreEntry.ID != entry.ID {
		t.Errorf("toCoreEntry ID = %q, want %q", coreEntry.ID, entry.ID)
	}
	if coreEntry.Content != entry.Content {
		t.Errorf("toCoreEntry Content = %q, want %q", coreEntry.Content, entry.Content)
	}
	if coreEntry.SourceType != entry.SourceType {
		t.Errorf("toCoreEntry SourceType = %q, want %q", coreEntry.SourceType, entry.SourceType)
	}
	if coreEntry.SourcePath == nil || entry.SourcePath == nil || *coreEntry.SourcePath != *entry.SourcePath {
		t.Errorf("toCoreEntry SourcePath = %v, want %v", coreEntry.SourcePath, entry.SourcePath)
	}
	if coreEntry.TrustScore != entry.TrustScore {
		t.Errorf("toCoreEntry TrustScore = %f, want %f", coreEntry.TrustScore, entry.TrustScore)
	}
	if coreEntry.SupersedesID != entry.SupersedesID {
		t.Errorf("toCoreEntry SupersedesID = %q, want %q", coreEntry.SupersedesID, entry.SupersedesID)
	}
	// Vector should be preserved
	if len(coreEntry.Vector) != len(entry.Vector) {
		t.Errorf("toCoreEntry Vector length = %d, want %d", len(coreEntry.Vector), len(entry.Vector))
	}
}

func TestTypeConversion_FromCoreEntry(t *testing.T) {
	coreEntry := &core.MemoryEntry{
		ID:               "core-id",
		Content:          "core content",
		Vector:           []float64{0.5, 0.6},
		SourceType:       "file",
		SourcePath:       &[]string{"/path/to/file.ts"}[0],
		ContentHash:      "hash456",
		TrustScore:       0.9,
		RetrievalCount:   10,
		IsArchived:       false,
		Metadata:         map[string]any{"env": "prod"},
		SupersedesID:     "old-id",
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
		PeerID:           "user-1",
		StructuredFields: map[string]any{"field": "value"},
		ChangeRatio:      1.0,
		CreatedAtMs:      1700000000000,
	}

	orchEntry := fromCoreEntry(coreEntry)

	if orchEntry.ID != coreEntry.ID {
		t.Errorf("fromCoreEntry ID = %q, want %q", orchEntry.ID, coreEntry.ID)
	}
	if orchEntry.Content != coreEntry.Content {
		t.Errorf("fromCoreEntry Content = %q, want %q", orchEntry.Content, coreEntry.Content)
	}
	if orchEntry.SourceType != coreEntry.SourceType {
		t.Errorf("fromCoreEntry SourceType = %q, want %q", orchEntry.SourceType, coreEntry.SourceType)
	}
	if orchEntry.TrustScore != coreEntry.TrustScore {
		t.Errorf("fromCoreEntry TrustScore = %f, want %f", orchEntry.TrustScore, coreEntry.TrustScore)
	}
	if orchEntry.SupersedesID != coreEntry.SupersedesID {
		t.Errorf("fromCoreEntry SupersedesID = %q, want %q", orchEntry.SupersedesID, coreEntry.SupersedesID)
	}
	// Core-specific fields should be dropped (not accessible through orchestrator type)
	// This test verifies we don't panic on conversion
}

func TestTypeConversion_ToCoreSearchOptions(t *testing.T) {
	opts := &SearchOptions{TopK: 5, Threshold: 0.8, Strategy: "vector_only"}
	coreOpts := toCoreSearchOptions(opts)

	if coreOpts.TopK != 5 {
		t.Errorf("toCoreSearchOptions TopK = %d, want 5", coreOpts.TopK)
	}
	if coreOpts.Threshold != 0.8 {
		t.Errorf("toCoreSearchOptions Threshold = %f, want 0.8", coreOpts.Threshold)
	}
	if coreOpts.Strategy != "vector_only" {
		t.Errorf("toCoreSearchOptions Strategy = %q, want %q", coreOpts.Strategy, "vector_only")
	}
	if coreOpts.ExactSearch != false {
		t.Errorf("toCoreSearchOptions ExactSearch = %v, want false", coreOpts.ExactSearch)
	}
}

func TestTypeConversion_FromCoreTrustAdjustment(t *testing.T) {
	coreAdj := &core.TrustAdjustment{
		ID:               "adj-1",
		MemoryID:         "mem-1",
		OldScore:         0.5,
		NewScore:         0.55,
		Signal:           "agent_used",
		AdjustmentAmount: 0.05,
		Reason:           "test adjustment",
		CreatedAt:        time.Now(),
	}

	orchAdj := fromCoreTrustAdjustment(coreAdj)

	if orchAdj.ID != coreAdj.ID {
		t.Errorf("fromCoreTrustAdjustment ID = %q, want %q", orchAdj.ID, coreAdj.ID)
	}
	if orchAdj.MemoryID != coreAdj.MemoryID {
		t.Errorf("fromCoreTrustAdjustment MemoryID = %q, want %q", orchAdj.MemoryID, coreAdj.MemoryID)
	}
	if orchAdj.NewScore != coreAdj.NewScore {
		t.Errorf("fromCoreTrustAdjustment NewScore = %f, want %f", orchAdj.NewScore, coreAdj.NewScore)
	}
	if orchAdj.Signal != coreAdj.Signal {
		t.Errorf("fromCoreTrustAdjustment Signal = %q, want %q", orchAdj.Signal, coreAdj.Signal)
	}
}

func TestTypeConversion_NilHandling(t *testing.T) {
	// fromCoreEntry with nil
	if result := fromCoreEntry(nil); result != nil {
		t.Error("fromCoreEntry(nil) should return nil")
	}

	// fromCoreTrustAdjustment with nil
	if result := fromCoreTrustAdjustment(nil); result != nil {
		t.Error("fromCoreTrustAdjustment(nil) should return nil")
	}

	// toCoreSearchOptions with nil
	coreOpts := toCoreSearchOptions(nil)
	if coreOpts == nil {
		t.Error("toCoreSearchOptions(nil) should return default options, not nil")
	}
	if coreOpts.TopK != 10 {
		t.Errorf("toCoreSearchOptions(nil) TopK = %d, want 10", coreOpts.TopK)
	}
}
