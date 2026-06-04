package dialectic

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// ─── Mock Store ─────────────────────────────────────────────────────────────────

// mockDialecticStore implements core.Store with in-memory storage for dialectic tests.
type mockDialecticStore struct {
	mu            sync.Mutex
	memories      map[string]*core.MemoryEntry
	relationships []core.Relationship
	counter       int
}

func newMockDialecticStore() *mockDialecticStore {
	return &mockDialecticStore{
		memories: make(map[string]*core.MemoryEntry),
	}
}

func (m *mockDialecticStore) nextID() int {
	m.counter++
	return m.counter
}

// Core lifecycle
func (m *mockDialecticStore) Initialize(ctx context.Context) error { return nil }
func (m *mockDialecticStore) Close(ctx context.Context) error      { return nil }
func (m *mockDialecticStore) Ping(ctx context.Context) error       { return nil }
func (m *mockDialecticStore) Stats(ctx context.Context) (*core.StatusResult, error) {
	return &core.StatusResult{}, nil
}

// Memory CRUD
func (m *mockDialecticStore) AddMemory(ctx context.Context, entry *core.MemoryEntry) (string, error) {
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

func (m *mockDialecticStore) GetMemory(ctx context.Context, id string, includeArchived bool) (*core.MemoryEntry, error) {
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

func (m *mockDialecticStore) UpdateMemory(ctx context.Context, entry *core.MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.memories[entry.ID]; !ok {
		return fmt.Errorf("memory %s not found", entry.ID)
	}
	clone := *entry
	m.memories[entry.ID] = &clone
	return nil
}

func (m *mockDialecticStore) DeleteMemory(ctx context.Context, id string) error {
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

func (m *mockDialecticStore) CountMemories(ctx context.Context) (int64, error) {
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

func (m *mockDialecticStore) ListMemories(ctx context.Context, filter *core.SearchFilter, limit int) ([]*core.MemoryEntry, error) {
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

func (m *mockDialecticStore) ContentExists(ctx context.Context, contentHash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.memories {
		if e.ContentHash == contentHash {
			return true, nil
		}
	}
	return false, nil
}

// Vector search
func (m *mockDialecticStore) QueryMemoriesByVector(ctx context.Context, vector []float64, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockDialecticStore) SearchMemoriesText(ctx context.Context, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	// Simple mock: return memories whose content contains the query string.
	m.mu.Lock()
	defer m.mu.Unlock()
	var results []*core.MemoryEntry
	for _, e := range m.memories {
		if strings.Contains(strings.ToLower(e.Content), strings.ToLower(query)) {
			clone := *e
			results = append(results, &clone)
		}
	}
	if opts != nil && opts.TopK > 0 && len(results) > opts.TopK {
		results = results[:opts.TopK]
	}
	return results, nil
}
func (m *mockDialecticStore) GetSimilar(ctx context.Context, memoryID string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// Trust fields
func (m *mockDialecticStore) UpdateTrustFields(ctx context.Context, id string, trustScore float64, archived bool) error {
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
func (m *mockDialecticStore) IncrementRetrievalCount(ctx context.Context, id string) error {
	return nil
}

// Relationships
func (m *mockDialecticStore) CreateRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := fmt.Sprintf("rel-%d", m.nextID())
	m.relationships = append(m.relationships, core.Relationship{
		SourceID:         sourceID,
		TargetID:         targetID,
		RelationshipType: relType,
		Confidence:       confidence,
		Source:           "manual",
	})
	return id, nil
}
func (m *mockDialecticStore) DeleteRelationship(ctx context.Context, id string) error { return nil }
func (m *mockDialecticStore) GetRelationships(ctx context.Context, memoryID string) ([]core.Relationship, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result []core.Relationship
	for _, rel := range m.relationships {
		if rel.SourceID == memoryID || rel.TargetID == memoryID {
			result = append(result, rel)
		}
	}
	return result, nil
}
func (m *mockDialecticStore) GetRelationshipSummary(ctx context.Context, memoryID string) (*core.RelationshipSummary, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetSupersessionChain(ctx context.Context, memoryID string, maxDepth int) ([]string, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetSuperseded(ctx context.Context, memoryID string) (string, error) {
	return "", nil
}

// Entity CRUD (KG)
func (m *mockDialecticStore) UpsertEntity(ctx context.Context, entity *core.Entity) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetEntity(ctx context.Context, id string) (*core.Entity, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetEntitiesByType(ctx context.Context, entityType string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockDialecticStore) SearchEntities(ctx context.Context, name string, limit int) ([]*core.Entity, error) {
	return nil, nil
}
func (m *mockDialecticStore) CreateEntityRelationship(ctx context.Context, sourceID, targetID, relType string, confidence float64) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetEntityRelationships(ctx context.Context, entityID string) ([]core.EntityRelationship, error) {
	return nil, nil
}
func (m *mockDialecticStore) ResolveEntityGraph(ctx context.Context, entityID string, depth int) error {
	return nil
}
func (m *mockDialecticStore) InferenceChain(ctx context.Context, startEntity, endEntity string, maxDepth int) ([]core.EntityRelationship, error) {
	return nil, nil
}

// Peer CRUD
func (m *mockDialecticStore) AddPeer(ctx context.Context, peer *core.PeerProfile) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetPeer(ctx context.Context, id string) (*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockDialecticStore) ListPeers(ctx context.Context, limit int) ([]*core.PeerProfile, error) {
	return nil, nil
}
func (m *mockDialecticStore) UpdatePeerLastActive(ctx context.Context, id string) error { return nil }

// Memory Sharing
func (m *mockDialecticStore) ShareMemory(ctx context.Context, memoryID, peerID, permission, grantedBy string) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) RevokeShareMemory(ctx context.Context, memoryID, peerID string) error {
	return nil
}
func (m *mockDialecticStore) GetSharedMemories(ctx context.Context, peerID string, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetPeerMemories(ctx context.Context, peerID, query string, opts *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// Thought Chains
func (m *mockDialecticStore) StartThoughtChain(ctx context.Context, sessionID, parentChainID string) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) AddThought(ctx context.Context, chainID string, thought *core.Thought) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetThoughtChain(ctx context.Context, chainID string) (*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetRelatedChains(ctx context.Context, query string, limit int) ([]*core.ThoughtChain, error) {
	return nil, nil
}
func (m *mockDialecticStore) ReviseThought(ctx context.Context, chainID string, thoughtNumber int, revisedText string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockDialecticStore) BranchThought(ctx context.Context, chainID string, fromThoughtNumber int, branchID, text string) (*core.Thought, error) {
	return nil, nil
}
func (m *mockDialecticStore) PauseThoughtChain(ctx context.Context, chainID string) error { return nil }
func (m *mockDialecticStore) ResumeThoughtChain(ctx context.Context, chainID string) error {
	return nil
}
func (m *mockDialecticStore) AbandonThoughtChain(ctx context.Context, chainID string) error {
	return nil
}

// Audit
func (m *mockDialecticStore) LogAuditEvent(ctx context.Context, event *core.AuditEvent) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetAuditEvents(ctx context.Context, sessionID, eventType string, limit int) ([]*core.AuditEvent, error) {
	return nil, nil
}

// Trust Adjustments
func (m *mockDialecticStore) LogTrustAdjustment(ctx context.Context, adj *core.TrustAdjustment) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) GetTrustAdjustments(ctx context.Context, memoryID string, limit int) ([]*core.TrustAdjustment, error) {
	return nil, nil
}

// Decay
func (m *mockDialecticStore) UpdateDecayRate(ctx context.Context, memoryID string, rate float64) error {
	return nil
}
func (m *mockDialecticStore) ListFadingMemories(ctx context.Context, threshold float64, limit int) ([]*core.MemoryEntry, error) {
	return nil, nil
}

// Project indexer
func (m *mockDialecticStore) AddProjectChunk(ctx context.Context, chunk *core.ChunkResult) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) DeleteChunksByPath(ctx context.Context, path string) error { return nil }
func (m *mockDialecticStore) SearchChunks(ctx context.Context, vector []float64, opts *core.SearchProjectOptions) ([]*core.ChunkResult, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetFileChunksByPath(ctx context.Context, filePath string) (*core.FileContentsResult, error) {
	return nil, nil
}

func (m *mockDialecticStore) Has1024Support(_ context.Context) bool { return false }
func (m *mockDialecticStore) AddMemory1024(_ context.Context, _ string, _ []float64) (string, error) {
	return "", nil
}
func (m *mockDialecticStore) QueryMemories1024(_ context.Context, _ []float64, _ *core.SearchOptions) ([]*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockDialecticStore) GetMemory1024(_ context.Context, _ string) (*core.MemoryEntry, error) {
	return nil, nil
}
func (m *mockDialecticStore) CountMemories1024(_ context.Context) (int64, error) { return 0, nil }
func (m *mockDialecticStore) DeleteMemory1024(_ context.Context, _ string) error { return nil }

// ─── Mock LLM Client ────────────────────────────────────────────────────────────

// mockLLMClient implements core.LLMClient with configurable responses.
type mockLLMClient struct {
	chatResponse    string
	chatError       error
	embedResponse   []float64
	embedError      error
	lastMessages    []core.ConversationMessage
	lastTemperature float64
	mu              sync.Mutex
}

func (m *mockLLMClient) Chat(ctx context.Context, messages []core.ConversationMessage, temperature float64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastMessages = messages
	m.lastTemperature = temperature
	if m.chatError != nil {
		return "", m.chatError
	}
	return m.chatResponse, nil
}

func (m *mockLLMClient) Embed(ctx context.Context, text string) ([]float64, error) {
	if m.embedError != nil {
		return nil, m.embedError
	}
	return m.embedResponse, nil
}

func (m *mockLLMClient) Health(ctx context.Context) error { return nil }
func (m *mockLLMClient) Close(ctx context.Context) error  { return nil }

// ─── Helper: add a memory to the mock store ─────────────────────────────────────

func addMem(store *mockDialecticStore, id, content string, trustScore float64) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.memories[id] = &core.MemoryEntry{
		ID:          id,
		Content:     content,
		SourceType:  "session",
		ContentHash: "hash-" + id,
		TrustScore:  trustScore,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
}

func addRel(store *mockDialecticStore, sourceID, targetID, relType string, confidence float64) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.relationships = append(store.relationships, core.Relationship{
		SourceID:         sourceID,
		TargetID:         targetID,
		RelationshipType: relType,
		Confidence:       confidence,
		Source:           "auto",
	})
}

// ─── Tests: FindContradictions ──────────────────────────────────────────────────

func TestFindContradictions_WithExplicitRelationship(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	// Add two contradictory memories
	addMem(store, "mem-a", "The project uses React", 0.8)
	addMem(store, "mem-b", "The project uses Vue", 0.7)
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.9)

	results, err := engine.FindContradictions(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("FindContradictions returned error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 contradiction, got %d", len(results))
	}

	c := results[0]
	// Verify canonical ordering (smaller ID first)
	if c.MemoryA != "mem-a" || c.MemoryB != "mem-b" {
		t.Errorf("expected MemoryA=mem-a, MemoryB=mem-b, got MemoryA=%s, MemoryB=%s", c.MemoryA, c.MemoryB)
	}
	if c.Severity != "high" {
		t.Errorf("expected severity=high for confidence 0.9, got %s", c.Severity)
	}
	if c.Status != "open" {
		t.Errorf("expected status=open, got %s", c.Status)
	}
}

func TestFindContradictions_EmptyResult(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	results, err := engine.FindContradictions(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("FindContradictions returned error: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 contradictions, got %d", len(results))
	}
}

func TestFindContradictions_ImplicitSearch(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	// Add memories with overlapping content
	addMem(store, "mem-a", "The project uses React for the frontend", 0.8)
	addMem(store, "mem-b", "The project uses Vue for the frontend", 0.7)

	// No explicit CONTRADICTS relationship — implicit search should find
	// them via text similarity since both contain "project uses"
	// The mock SearchMemoriesText does a single-substring search,
	// so we use "project" which appears in both memories.
	results, err := engine.FindContradictions(context.Background(), "project", 10)
	if err != nil {
		t.Fatalf("FindContradictions returned error: %v", err)
	}
	// With mock SearchMemoriesText (which does substring matching),
	// both memories will contain "project" and should generate a potential contradiction
	if len(results) < 1 {
		t.Errorf("expected at least 1 implicit contradiction, got %d", len(results))
	}
}

func TestFindContradictions_Limit(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	// Add 3 pairs of contradictory memories
	addMem(store, "mem-a", "Uses React", 0.8)
	addMem(store, "mem-b", "Uses Vue", 0.7)
	addMem(store, "mem-c", "Uses TypeScript", 0.9)
	addMem(store, "mem-d", "Uses JavaScript", 0.6)
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.9)
	addRel(store, "mem-c", "mem-d", "CONTRADICTS", 0.8)

	results, err := engine.FindContradictions(context.Background(), "", 1)
	if err != nil {
		t.Fatalf("FindContradictions returned error: %v", err)
	}
	if len(results) > 1 {
		t.Errorf("expected at most 1 contradiction with limit=1, got %d", len(results))
	}
}

func TestFindContradictions_Deduplication(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	addMem(store, "mem-a", "Uses React", 0.8)
	addMem(store, "mem-b", "Uses Vue", 0.7)
	// Add the same contradiction from both sides
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.9)
	addRel(store, "mem-b", "mem-a", "CONTRADICTS", 0.9)

	results, err := engine.FindContradictions(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("FindContradictions returned error: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 deduplicated contradiction, got %d", len(results))
	}
}

func TestFindContradictions_SeverityMapping(t *testing.T) {
	tests := []struct {
		confidence float64
		expected   string
	}{
		{0.9, "high"},
		{0.6, "medium"},
		{0.3, "low"},
	}

	for _, tt := range tests {
		result := severityFromConfidence(tt.confidence)
		if result != tt.expected {
			t.Errorf("severityFromConfidence(%f) = %q, want %q", tt.confidence, result, tt.expected)
		}
	}
}

// ─── Tests: ResolveContradiction ────────────────────────────────────────────────

func TestResolveContradiction_WithMockLLM(t *testing.T) {
	store := newMockDialecticStore()

	// Prepare mock LLM response for arguments, then resolution
	argsJSON := `{
		"pro_a_arguments": [{"memoryId": "mem-a", "text": "React is well-supported", "confidence": 0.8, "evidence": ["docs"]}],
		"pro_b_arguments": [{"memoryId": "mem-b", "text": "Vue is simpler", "confidence": 0.7, "evidence": ["tutorials"]}],
		"analysis": "Both frameworks are valid choices",
		"preferred_memory": "A",
		"confidence": 0.75
	}`
	resolutionJSON := `{
		"resolution": "React appears more appropriate given project requirements",
		"winner": "A",
		"reasoning": "React has broader ecosystem support",
		"confidence": 0.8,
		"recommendations": ["Standardise on React", "Update documentation"]
	}`

	llm := &mockLLMClient{}

	addMem(store, "mem-a", "The project uses React", 0.8)
	addMem(store, "mem-b", "The project uses Vue", 0.7)

	// First call is for arguments, second for resolution.
	// We'll set up the LLM to return args JSON first.
	llm.chatResponse = argsJSON
	args, err := GenerateArguments(context.Background(), llm,
		store.memories["mem-a"], store.memories["mem-b"])
	if err != nil {
		t.Fatalf("GenerateArguments returned error: %v", err)
	}
	if len(args.ProA) != 1 {
		t.Errorf("expected 1 pro-A argument, got %d", len(args.ProA))
	}
	if args.PreferredMemory != "A" {
		t.Errorf("expected preferred_memory=A, got %s", args.PreferredMemory)
	}

	// Now test resolution
	contradiction := &core.Contradiction{
		ID:      "mem-a|mem-b",
		MemoryA: "mem-a",
		MemoryB: "mem-b",
		Status:  "open",
	}
	llm.chatResponse = resolutionJSON
	resolution, err := SynthesizeResolution(context.Background(), llm, contradiction, args)
	if err != nil {
		t.Fatalf("SynthesizeResolution returned error: %v", err)
	}
	if resolution.WinnerMemory != "A" {
		t.Errorf("expected winnerMemory=A, got %s", resolution.WinnerMemory)
	}
	if resolution.Explanation == "" {
		t.Error("expected non-empty explanation")
	}
	if resolution.Confidence != 0.8 {
		t.Errorf("expected confidence=0.8, got %f", resolution.Confidence)
	}
}

func TestResolveContradiction_InvalidID(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, err := engine.ResolveContradiction(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty contradiction ID, got nil")
	}
}

func TestResolveContradiction_ParseIDDialect(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-a", "Uses React", 0.8)
	addMem(store, "mem-b", "Uses Vue", 0.7)
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	memA, memB, err := engine.parseContradictionID(context.Background(), "mem-a|mem-b")
	if err != nil {
		t.Fatalf("parseContradictionID returned error: %v", err)
	}
	if memA != "mem-a" || memB != "mem-b" {
		t.Errorf("expected mem-a, mem-b; got %s, %s", memA, memB)
	}
}

func TestResolveContradiction_ParseIDFallback(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-a", "Uses React", 0.8)
	addMem(store, "mem-b", "Uses Vue", 0.7)
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.9)

	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	// Without pipe or colon, should fall back to relationship lookup
	memA, memB, err := engine.parseContradictionID(context.Background(), "mem-a")
	if err != nil {
		t.Fatalf("parseContradictionID returned error: %v", err)
	}
	if memA != "mem-a" || memB != "mem-b" {
		t.Errorf("expected mem-a, mem-b; got %s, %s", memA, memB)
	}
}

func TestResolveContradiction_ParseIDNoRelationship(t *testing.T) {
	store := newMockDialecticStore() // empty store
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, _, err := engine.parseContradictionID(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent memory with no pipe/colon, got nil")
	}
}

// ─── Tests: GenerateArguments ────────────────────────────────────────────────────

func TestGenerateArguments_ValidResponse(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: `{
			"pro_a_arguments": [
				{"memoryId": "a", "text": "Argument for A", "confidence": 0.8, "evidence": ["e1"]}
			],
			"pro_b_arguments": [
				{"memoryId": "b", "text": "Argument for B", "confidence": 0.6, "evidence": []}
			],
			"analysis": "A is slightly better",
			"preferred_memory": "A",
			"confidence": 0.7
		}`,
	}

	memA := &core.MemoryEntry{ID: "a", Content: "Memory A content"}
	memB := &core.MemoryEntry{ID: "b", Content: "Memory B content"}

	result, err := GenerateArguments(context.Background(), llm, memA, memB)
	if err != nil {
		t.Fatalf("GenerateArguments returned error: %v", err)
	}
	if len(result.ProA) != 1 {
		t.Errorf("expected 1 pro-A argument, got %d", len(result.ProA))
	}
	if result.PreferredMemory != "A" {
		t.Errorf("expected preferred_memory=A, got %s", result.PreferredMemory)
	}
	if result.Confidence != 0.7 {
		t.Errorf("expected confidence=0.7, got %f", result.Confidence)
	}
}

func TestGenerateArguments_NilMemory(t *testing.T) {
	llm := &mockLLMClient{}
	_, err := GenerateArguments(context.Background(), llm, nil, &core.MemoryEntry{ID: "b", Content: "B"})
	if err == nil {
		t.Fatal("expected error for nil memory A, got nil")
	}
}

func TestGenerateArguments_LLMError(t *testing.T) {
	llm := &mockLLMClient{
		chatError: fmt.Errorf("LLM unavailable"),
	}
	memA := &core.MemoryEntry{ID: "a", Content: "Memory A content"}
	memB := &core.MemoryEntry{ID: "b", Content: "Memory B content"}

	_, err := GenerateArguments(context.Background(), llm, memA, memB)
	if err == nil {
		t.Fatal("expected error from LLM failure, got nil")
	}
}

func TestGenerateArguments_MarkdownFenceStripping(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: "```json\n{\"pro_a_arguments\":[{\"memoryId\":\"a\",\"text\":\"Arg A\",\"confidence\":0.8,\"evidence\":[]}],\"pro_b_arguments\":[],\"analysis\":\"Test\",\"preferred_memory\":\"A\",\"confidence\":0.6}\n```",
	}

	memA := &core.MemoryEntry{ID: "a", Content: "Memory A content"}
	memB := &core.MemoryEntry{ID: "b", Content: "Memory B content"}

	result, err := GenerateArguments(context.Background(), llm, memA, memB)
	if err != nil {
		t.Fatalf("GenerateArguments with markdown fences returned error: %v", err)
	}
	if result.PreferredMemory != "A" {
		t.Errorf("expected preferred_memory=A, got %s", result.PreferredMemory)
	}
}

func TestGenerateArguments_InvalidJSON(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: "this is not json",
	}

	memA := &core.MemoryEntry{ID: "a", Content: "A"}
	memB := &core.MemoryEntry{ID: "b", Content: "B"}

	_, err := GenerateArguments(context.Background(), llm, memA, memB)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

// ─── Tests: SynthesizeResolution ────────────────────────────────────────────────

func TestSynthesizeResolution_ValidResponse(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: `{
			"resolution": "React is the better choice",
			"winner": "A",
			"reasoning": "React has broader ecosystem",
			"confidence": 0.85,
			"recommendations": ["Standardise on React"]
		}`,
	}

	contradiction := &core.Contradiction{
		ID:      "test-123",
		MemoryA: "mem-a",
		MemoryB: "mem-b",
	}
	args := &ArgumentsResult{
		ProA:            []core.Argument{{MemoryID: "mem-a", Text: "A is better", Confidence: 0.8}},
		ProB:            []core.Argument{{MemoryID: "mem-b", Text: "B is simpler", Confidence: 0.6}},
		Analysis:        "Both are valid",
		PreferredMemory: "A",
		Confidence:      0.75,
	}

	resolution, err := SynthesizeResolution(context.Background(), llm, contradiction, args)
	if err != nil {
		t.Fatalf("SynthesizeResolution returned error: %v", err)
	}
	if resolution.WinnerMemory != "A" {
		t.Errorf("expected winnerMemory=A, got %s", resolution.WinnerMemory)
	}
	if resolution.Explanation != "React has broader ecosystem" {
		t.Errorf("expected reasoning as explanation, got %s", resolution.Explanation)
	}
	if len(resolution.Recommendations) != 1 {
		t.Errorf("expected 1 recommendation, got %d", len(resolution.Recommendations))
	}
}

func TestSynthesizeResolution_NilContradiction(t *testing.T) {
	llm := &mockLLMClient{}
	_, err := SynthesizeResolution(context.Background(), llm, nil, &ArgumentsResult{})
	if err == nil {
		t.Fatal("expected error for nil contradiction, got nil")
	}
}

func TestSynthesizeResolution_NilArgs(t *testing.T) {
	llm := &mockLLMClient{}
	_, err := SynthesizeResolution(context.Background(), llm, &core.Contradiction{ID: "test"}, nil)
	if err == nil {
		t.Fatal("expected error for nil args, got nil")
	}
}

func TestSynthesizeResolution_WinnerNormalisation(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"A", "A"},
		{"a", "A"},
		{"B", "B"},
		{"b", "B"},
		{"inconclusive", "inconclusive"},
		{"neither", "inconclusive"},
		{"", "inconclusive"},
	}

	for _, tt := range tests {
		result := normaliseWinner(tt.input)
		if result != tt.expected {
			t.Errorf("normaliseWinner(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

// ─── Tests: ChallengeMemory ─────────────────────────────────────────────────────

func TestChallengeMemory_ValidChallenge(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-x", "The sky is green", 0.5)

	challengeJSON := `{
		"response": "The sky is actually blue, not green",
		"memory_status": "adjusted",
		"confidence_change": -0.2,
		"reasoning": "Overwhelming evidence that the sky is blue"
	}`

	llm := &mockLLMClient{chatResponse: challengeJSON}
	engine := NewEngine(store, llm)

	event, err := engine.ChallengeMemory(context.Background(), "mem-x", "challenger-1", "The sky is blue, not green")
	if err != nil {
		t.Fatalf("ChallengeMemory returned error: %v", err)
	}
	if event.MemoryID != "mem-x" {
		t.Errorf("expected MemoryID=mem-x, got %s", event.MemoryID)
	}
	if event.ChallengerID != "challenger-1" {
		t.Errorf("expected ChallengerID=challenger-1, got %s", event.ChallengerID)
	}
	if event.Status != "accepted" {
		t.Errorf("expected status=accepted (from adjusted), got %s", event.Status)
	}
	if event.ConfidenceChange != -0.2 {
		t.Errorf("expected confidenceChange=-0.2, got %f", event.ConfidenceChange)
	}
}

func TestChallengeMemory_EmptyMemoryID(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, err := engine.ChallengeMemory(context.Background(), "", "challenger-1", "challenge text")
	if err == nil {
		t.Fatal("expected error for empty memory ID, got nil")
	}
}

func TestChallengeMemory_EmptyChallengeText(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-x", "Content", 0.5)
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, err := engine.ChallengeMemory(context.Background(), "mem-x", "challenger-1", "")
	if err == nil {
		t.Fatal("expected error for empty challenge text, got nil")
	}
}

func TestChallengeMemory_NonexistentMemory(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, err := engine.ChallengeMemory(context.Background(), "nonexistent", "challenger-1", "challenge")
	if err == nil {
		t.Fatal("expected error for nonexistent memory, got nil")
	}
}

func TestChallengeMemory_TrustAdjustment(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-x", "The sky is green", 0.5)

	challengeJSON := `{
		"response": "Challenge accepted",
		"memory_status": "superseded",
		"confidence_change": -0.3,
		"reasoning": "Clear evidence"
	}`

	llm := &mockLLMClient{chatResponse: challengeJSON}
	engine := NewEngine(store, llm)

	event, err := engine.ChallengeMemory(context.Background(), "mem-x", "challenger-1", "Challenge text")
	if err != nil {
		t.Fatalf("ChallengeMemory returned error: %v", err)
	}

	// Verify trust was adjusted (0.5 + (-0.3) = 0.2)
	updatedMem, _ := store.GetMemory(context.Background(), "mem-x", true)
	if updatedMem.TrustScore != 0.2 {
		t.Errorf("expected trust score 0.2 after challenge, got %f", updatedMem.TrustScore)
	}

	_ = event // suppress unused var
}

func TestChallengeMemory_TrustAdjustment_ClampedLow(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-x", "The sky is green", 0.1) // low trust base

	challengeJSON := `{
		"response": "Challenge accepted",
		"memory_status": "superseded",
		"confidence_change": -0.3,
		"reasoning": "Clear evidence"
	}`

	llm := &mockLLMClient{chatResponse: challengeJSON}
	engine := NewEngine(store, llm)

	_, err := engine.ChallengeMemory(context.Background(), "mem-x", "challenger-1", "Challenge text")
	if err != nil {
		t.Fatalf("ChallengeMemory returned error: %v", err)
	}

	// Verify trust was clamped to 0 (0.1 + (-0.3) = -0.2 → 0.0)
	updatedMem, _ := store.GetMemory(context.Background(), "mem-x", true)
	if updatedMem.TrustScore != 0.0 {
		t.Errorf("expected trust score clamped to 0.0, got %f", updatedMem.TrustScore)
	}
}

// ─── Tests: GetDialecticHistory ─────────────────────────────────────────────────

func TestGetDialecticHistory_WithRelationships(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-a", "Content A", 0.8)
	addMem(store, "mem-b", "Content B", 0.7)
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.9)
	// Also add a non-CONTRADICTS relationship
	addRel(store, "mem-a", "mem-c", "RELATED_TO", 0.5)

	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	events, err := engine.GetDialecticHistory(context.Background(), "mem-a", 10)
	if err != nil {
		t.Fatalf("GetDialecticHistory returned error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 dialectic event (CONTRADICTS only), got %d", len(events))
	}
	if events[0].EventType != "contradiction_found" {
		t.Errorf("expected eventType=contradiction_found, got %s", events[0].EventType)
	}
}

func TestGetDialecticHistory_EmptyResult(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	events, err := engine.GetDialecticHistory(context.Background(), "nonexistent", 10)
	if err != nil {
		t.Fatalf("GetDialecticHistory returned error: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("expected 0 events for nonexistent memory, got %d", len(events))
	}
}

func TestGetDialecticHistory_EmptyMemoryID(t *testing.T) {
	store := newMockDialecticStore()
	llm := &mockLLMClient{}
	engine := NewEngine(store, llm)

	_, err := engine.GetDialecticHistory(context.Background(), "", 10)
	if err == nil {
		t.Fatal("expected error for empty memory ID, got nil")
	}
}

// ─── Tests: ProcessChallenge ─────────────────────────────────────────────────────

func TestProcessChallenge_ValidChallenge(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: `{
			"response": "The sky is blue",
			"memory_status": "adjusted",
			"confidence_change": -0.15,
			"reasoning": "Scientific evidence confirms skies are blue"
		}`,
	}

	memory := &core.MemoryEntry{
		ID:      "mem-1",
		Content: "The sky is green",
	}

	event, err := ProcessChallenge(context.Background(), llm, memory, "The sky is blue", nil)
	if err != nil {
		t.Fatalf("ProcessChallenge returned error: %v", err)
	}
	if event.Status != "accepted" {
		t.Errorf("expected status=accepted (from adjusted), got %s", event.Status)
	}
	if event.ConfidenceChange != -0.15 {
		t.Errorf("expected confidenceChange=-0.15, got %f", event.ConfidenceChange)
	}
	if event.ResponseText == "" {
		t.Error("expected non-empty response text")
	}
}

func TestProcessChallenge_NilMemory(t *testing.T) {
	llm := &mockLLMClient{}
	_, err := ProcessChallenge(context.Background(), llm, nil, "challenge", nil)
	if err == nil {
		t.Fatal("expected error for nil memory, got nil")
	}
}

func TestProcessChallenge_EmptyChallenge(t *testing.T) {
	llm := &mockLLMClient{}
	memory := &core.MemoryEntry{ID: "mem-1", Content: "Content"}
	_, err := ProcessChallenge(context.Background(), llm, memory, "", nil)
	if err == nil {
		t.Fatal("expected error for empty challenge text, got nil")
	}
}

func TestProcessChallenge_ClampedConfidenceChange(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: `{
			"response": "Extreme challenge",
			"memory_status": "superseded",
			"confidence_change": -0.9,
			"reasoning": "Test"
		}`,
	}

	memory := &core.MemoryEntry{ID: "mem-1", Content: "Test content"}
	event, err := ProcessChallenge(context.Background(), llm, memory, "Challenge", nil)
	if err != nil {
		t.Fatalf("ProcessChallenge returned error: %v", err)
	}
	// -0.9 should be clamped to -0.3
	if event.ConfidenceChange != -0.3 {
		t.Errorf("expected confidenceChange=-0.3 (clamped), got %f", event.ConfidenceChange)
	}
}

func TestProcessChallenge_WithHistory(t *testing.T) {
	llm := &mockLLMClient{
		chatResponse: `{
			"response": "Based on prior challenges, memory is still valid",
			"memory_status": "maintained",
			"confidence_change": 0.05,
			"reasoning": "Prior challenges didn't disprove the memory"
		}`,
	}

	memory := &core.MemoryEntry{ID: "mem-1", Content: "The project uses Go"}
	history := []core.ChallengeEvent{
		{ChallengerID: "user-1", ChallengeText: "It uses Python", Status: "rejected"},
	}

	event, err := ProcessChallenge(context.Background(), llm, memory, "It uses Rust", history)
	if err != nil {
		t.Fatalf("ProcessChallenge returned error: %v", err)
	}
	if event.Status != "rejected" {
		t.Errorf("expected status=rejected (from maintained), got %s", event.Status)
	}
}

func TestProcessChallenge_LLMError(t *testing.T) {
	llm := &mockLLMClient{
		chatError: fmt.Errorf("LLM unavailable"),
	}
	memory := &core.MemoryEntry{ID: "mem-1", Content: "Content"}

	_, err := ProcessChallenge(context.Background(), llm, memory, "challenge", nil)
	if err == nil {
		t.Fatal("expected error from LLM failure, got nil")
	}
}

// ─── Tests: normalisePreferredMemory ─────────────────────────────────────────────

func TestNormalisePreferredMemory(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"A", "A"},
		{"a", "A"},
		{"B", "B"},
		{"b", "B"},
		{"neither", "neither"},
		{"NEITHER", "neither"},
		{"", "neither"},
		{"unknown", "neither"},
	}

	for _, tt := range tests {
		result := normalisePreferredMemory(tt.input)
		if result != tt.expected {
			t.Errorf("normalisePreferredMemory(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

// ─── Tests: normalisePair ────────────────────────────────────────────────────────

func TestNormalisePair(t *testing.T) {
	tests := []struct {
		a, b     string
		expected [2]string
	}{
		{"aaa", "bbb", [2]string{"aaa", "bbb"}},
		{"bbb", "aaa", [2]string{"aaa", "bbb"}},
		{"same", "same", [2]string{"same", "same"}},
	}

	for _, tt := range tests {
		a, b := normalisePair(tt.a, tt.b)
		if a != tt.expected[0] || b != tt.expected[1] {
			t.Errorf("normalisePair(%q, %q) = (%q, %q), want (%q, %q)",
				tt.a, tt.b, a, b, tt.expected[0], tt.expected[1])
		}
	}
}

// ─── Tests: stripMarkdownFences ──────────────────────────────────────────────────

func TestStripMarkdownFences(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{`{"key": "value"}`, `{"key": "value"}`},
		{"```json\n{\"key\": \"value\"}\n```", `{"key": "value"}`},
		{"```\n{\"key\": \"value\"}\n```", `{"key": "value"}`},
		{"  some text  ", "some text"},
	}

	for _, tt := range tests {
		result := stripMarkdownFences(tt.input)
		if result != tt.expected {
			t.Errorf("stripMarkdownFences(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

// ─── Tests: formatArguments ──────────────────────────────────────────────────────

func TestFormatArguments(t *testing.T) {
	tests := []struct {
		name     string
		args     []core.Argument
		expected string
	}{
		{
			name:     "empty",
			args:     nil,
			expected: "(none)",
		},
		{
			name: "single argument",
			args: []core.Argument{
				{MemoryID: "mem-a", Text: "Good point", Confidence: 0.8, Evidence: []string{"doc1"}},
			},
			expected: "- [mem-a] Good point (confidence: 0.80, evidence: doc1)",
		},
		{
			name: "no evidence",
			args: []core.Argument{
				{MemoryID: "mem-a", Text: "Good point", Confidence: 0.8, Evidence: nil},
			},
			expected: "- [mem-a] Good point (confidence: 0.80, evidence: (no evidence))",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatArguments(tt.args)
			if result != tt.expected {
				t.Errorf("formatArguments() = %q, want %q", result, tt.expected)
			}
		})
	}
}

// ─── Tests: clampFloat ───────────────────────────────────────────────────────────

func TestClampFloat(t *testing.T) {
	tests := []struct {
		v, min, max, want float64
	}{
		{0.5, -0.3, 0.3, 0.3},
		{-0.5, -0.3, 0.3, -0.3},
		{0.1, -0.3, 0.3, 0.1},
		{-0.1, -0.3, 0.3, -0.1},
		{0.3, -0.3, 0.3, 0.3},
		{-0.3, -0.3, 0.3, -0.3},
	}

	for _, tt := range tests {
		got := clampFloat(tt.v, tt.min, tt.max)
		if got != tt.want {
			t.Errorf("clampFloat(%f, %f, %f) = %f, want %f", tt.v, tt.min, tt.max, got, tt.want)
		}
	}
}

// ─── Integration-style test: End-to-end dialectic flow ───────────────────────────

func TestEndToEndDialecticFlow(t *testing.T) {
	store := newMockDialecticStore()
	addMem(store, "mem-a", "The project uses React for the frontend", 0.8)
	addMem(store, "mem-b", "The project uses Vue for the frontend", 0.7)
	addRel(store, "mem-a", "mem-b", "CONTRADICTS", 0.85)

	// LLM returns arguments first, then resolution
	argsJSON := `{
		"pro_a_arguments": [{"memoryId": "mem-a", "text": "React has larger ecosystem", "confidence": 0.85, "evidence": ["npm trends"]}],
		"pro_b_arguments": [{"memoryId": "mem-b", "text": "Vue has simpler learning curve", "confidence": 0.7, "evidence": ["survey data"]}],
		"analysis": "React and Vue serve similar purposes but have different strengths",
		"preferred_memory": "A",
		"confidence": 0.75
	}`

	llm := &mockLLMClient{chatResponse: argsJSON}
	engine := NewEngine(store, llm)

	// Step 1: Find contradictions
	contradictions, err := engine.FindContradictions(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("FindContradictions error: %v", err)
	}
	if len(contradictions) != 1 {
		t.Fatalf("expected 1 contradiction, got %d", len(contradictions))
	}

	// Step 2: Resolve contradiction
	resolution, err := engine.ResolveContradiction(context.Background(), "mem-a|mem-b")
	if err != nil {
		t.Fatalf("ResolveContradiction error: %v", err)
	}
	if resolution.ContradictionID != "mem-a|mem-b" {
		t.Errorf("expected contradictionId=mem-a|mem-b, got %s", resolution.ContradictionID)
	}

	// Step 3: Get dialectic history
	events, err := engine.GetDialecticHistory(context.Background(), "mem-a", 10)
	if err != nil {
		t.Fatalf("GetDialecticHistory error: %v", err)
	}
	if len(events) < 1 {
		t.Error("expected at least 1 dialectic event")
	}
}

// ─── Test: Verify JSON round-trip for dialectic types ────────────────────────────

func TestContradictionJSONRoundTrip(t *testing.T) {
	now := time.Now()
	c := &core.Contradiction{
		ID:          "contra-1",
		MemoryA:     "mem-a",
		MemoryB:     "mem-b",
		Description: "Test contradiction",
		Severity:    "high",
		Status:      "open",
		CreatedAt:   now,
	}

	data, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("json.Marshal error: %v", err)
	}

	var decoded core.Contradiction
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal error: %v", err)
	}
	if decoded.ID != "contra-1" {
		t.Errorf("ID mismatch: got %q, want %q", decoded.ID, "contra-1")
	}
	if decoded.MemoryA != "mem-a" {
		t.Errorf("MemoryA mismatch: got %q, want %q", decoded.MemoryA, "mem-a")
	}
	if decoded.Severity != "high" {
		t.Errorf("Severity mismatch: got %q, want %q", decoded.Severity, "high")
	}
}

func TestResolutionJSONRoundTrip(t *testing.T) {
	r := &core.Resolution{
		ID:              "res-1",
		ContradictionID: "contra-1",
		WinnerMemory:    "A",
		Explanation:     "React is more suitable",
		Confidence:      0.85,
		Recommendations: []string{"Standardise on React", "Update docs"},
		CreatedAt:       time.Now(),
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("json.Marshal error: %v", err)
	}

	var decoded core.Resolution
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal error: %v", err)
	}
	if decoded.ContradictionID != "contra-1" {
		t.Errorf("ContradictionID mismatch: got %q, want %q", decoded.ContradictionID, "contra-1")
	}
	if decoded.WinnerMemory != "A" {
		t.Errorf("WinnerMemory mismatch: got %q, want %q", decoded.WinnerMemory, "A")
	}
}

func TestChallengeEventJSONRoundTrip(t *testing.T) {
	ce := &core.ChallengeEvent{
		ID:               "challenge-1",
		MemoryID:         "mem-a",
		ChallengerID:     "user-1",
		ChallengeText:    "This is wrong",
		ResponseText:     "Challenge accepted",
		Status:           "accepted",
		ConfidenceChange: -0.15,
		CreatedAt:        time.Now(),
	}

	data, err := json.Marshal(ce)
	if err != nil {
		t.Fatalf("json.Marshal error: %v", err)
	}

	var decoded core.ChallengeEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal error: %v", err)
	}
	if decoded.ChallengerID != "user-1" {
		t.Errorf("ChallengerID mismatch: got %q, want %q", decoded.ChallengerID, "user-1")
	}
	if decoded.ConfidenceChange != -0.15 {
		t.Errorf("ConfidenceChange mismatch: got %f, want %f", decoded.ConfidenceChange, -0.15)
	}
}

func TestDialecticEventJSONRoundTrip(t *testing.T) {
	de := &core.DialecticEvent{
		ID:              "event-1",
		ContradictionID: "contra-1",
		EventType:       "contradiction_found",
		Description:     "Found contradiction between mem-a and mem-b",
		CreatedAt:       time.Now(),
	}

	data, err := json.Marshal(de)
	if err != nil {
		t.Fatalf("json.Marshal error: %v", err)
	}

	var decoded core.DialecticEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal error: %v", err)
	}
	if decoded.EventType != "contradiction_found" {
		t.Errorf("EventType mismatch: got %q, want %q", decoded.EventType, "contradiction_found")
	}
}

// Phase 2 part 1 stubs for new core.Store interface methods

func (m *mockDialecticStore) GetUserProfile(ctx context.Context, peerID string) (*core.UserProfile, error) {
	return nil, nil
}

func (m *mockDialecticStore) UpsertUserProfile(ctx context.Context, profile *core.UserProfile) error {
	return nil
}

func (m *mockDialecticStore) GetSecuritySummary(ctx context.Context, hours int) (*core.SecuritySummary, error) {
	return &core.SecuritySummary{}, nil
}

// Phase 3 stubs for agent_tools interface methods
func (m *mockDialecticStore) RecordToolRequest(ctx context.Context, peerID, toolServer, toolName string) error {
	return nil
}

func (m *mockDialecticStore) IncrementToolUse(ctx context.Context, peerID, toolServer, toolName string) (bool, error) {
	return false, nil
}

func (m *mockDialecticStore) GetAgentTools(ctx context.Context, peerID string) ([]*core.ToolRecord, error) {
	return nil, nil
}
